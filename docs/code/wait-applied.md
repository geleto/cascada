# Wait-Applied + __waited__ Plan

## Scope

This design is needed only for:

1. Concurrency-limited loop iterations (`of N`).

Regular unbounded loops do not need this mechanism.
Sequential loops do not use `waitApplied` for this mechanism.

## Problem We Are Solving

Today concurrency-limited loop correctness depends on a compiler timing barrier in async template output (`compileOutput`), which awaits expression completion before command enqueue.

That barrier must be removed, but removing it directly breaks concurrency-limited loop behavior.

We need a replacement that is explicit and runtime-driven.

## Architecture

Use two pieces together:

1. `waitApplied` runtime wait.
2. Internal `__waited__<tmpid>` output per relevant loop iteration async block.
3. Correct buffer finish semantics for late async producers.

Both are strictly per-iteration mechanisms, not whole-loop completion mechanisms.

### 1. `waitApplied`

`waitApplied` waits until commands in a given iteration async-block buffer segment are fully applied (including async apply), across outputs touched by that segment.

This is the runtime primitive that says: "this iteration's output work is actually done."

### 2. `__waited__<tmpid>`

For async blocks that participate in concurrency-limited loop semantics, compiler creates an internal waited output:

- name: `__waited__<tmpid>`
- type: internal wait output (not user-visible)

Compiler inserts wait commands into this output for operations that must count as iteration completion.

`waitApplied` is called on the iteration buffer (all outputs). `__waited__` exists to materialize async obligations that must participate in that buffer-wide apply completion.

### 3. Finish Semantics (Late Producer Safety)

`CommandBuffer.finished` must not become true while async producers that can still reserve/fill slots for that buffer are in flight.

Without this, a parent buffer can finish before a child async producer reserves/fills its slot, causing "add to finished buffer" regressions and ordering/link races.

## Output Tracking Split

Use separate compiler-tracked sets:

1. `usedOutputs`: structural/dependency/linking information.
2. `mutatedOutputs`: timing/wait-effect information.

Rules:

1. Transitional wrapping/timing decisions use `mutatedOutputs`, not `usedOutputs`.
2. Internal `__waited__` commands are timing bookkeeping and must not recursively trigger user-visible mutation wrapping decisions.

## What Gets Added To `__waited__`

Add exactly one waited command per included completion unit that matters for loop-iteration completion.

Rules:

1. Wait top-level compiled expression result.
2. Do not add waits for internal subnodes (`FunCall`, filter, macro call, lookup) inside that expression.
3. For object/array aggregates, do not wait child expressions; wait only aggregate root result once.
4. Include expression results from output-producing statements and side-effect statements in the loop body.

Minimal inclusion set:

1. Any expression-root result not inside aggregate-child compilation and not inside control-flow/iterator compilation.
2. Any aggregate root (object/array aggregate expression as a unit).
3. Completion of any nested concurrency-limited inner loop (as a single promise wait in parent).
4. Capture/call/macro-call returned values as aggregate-capable roots (use `WaitResolveCommand`).
5. Include/import/extends/super/block-invocation boundary completion when executed inside a limited-loop iteration (single waited command per boundary completion unit).

## Wait Command Type

`__waited__` uses one unified command: `WaitResolveCommand`.

Selection rule:

1. Any included root/completion unit emits `WaitResolveCommand`.
2. `WaitResolveCommand` internally uses resolve-single or aggregate-root resolution as needed.
3. Aggregate children are never emitted individually.

Control-flow expressions are excluded:

1. Loop condition expressions (including comparisons used for branch/loop control).
2. Iterator-driving expressions (loop source, iterator stepping, and related control expressions).
3. `concurrentLimit` expressions.
4. Aggregate roots/children that appear inside control-flow/iterator expressions.

Reason:

1. Control-flow/iterator execution already awaits these as part of loop scheduling.
2. Adding them to `__waited__` would duplicate waiting and can over-constrain concurrency.

## Where It Is Enabled

Compiler keeps `currentWaitedOutputName`:

1. Set to `null` for regular loops.
2. Set to `__waited__<tmpid>` for concurrency-limited iteration async blocks.

When `currentWaitedOutputName !== null`, eligible expressions emit wait commands into that output.

## Where It Must Be Forced To `null`

Even when currently inside a concurrency-limited loop, `currentWaitedOutputName` must be forced to `null` for:

1. Inner expression/sub-expression compilation scopes.
2. Aggregate child-expression compilation scopes.
3. Loop/control iterator expressions.
4. Conditional expressions (`if`/`switch`/while conditions).

Then restore previous waited name after those scopes.

Nested loops:

1. Do not force `currentWaitedOutputName` to `null` just because a nested loop is entered.
2. Nested loops inherit parent waited name by default.
3. Exception: if nested loop is concurrency-limited, it owns a new waited output and does not use the parent waited output as its primary completion gate.
4. Nested loops call `waitApplied` only when they are themselves concurrency-limited.

## Runtime Flow

For each concurrency-limited loop iteration:

1. Iteration block runs and emits normal output commands + waited commands into `__waited__`.
2. Iteration buffer is marked finished.
3. Runtime calls `waitApplied` for that iteration buffer (all outputs in that segment).
4. Only then iteration is treated as complete for sequencing/limit accounting.

This completion is per iteration only; overall loop completion is the composition of all iteration completions.

## waitApplied Runtime Model Constraints

Constraints:

1. Observables are ignored for wait-applied completion.
2. Counting is scoped to a single concurrency-limited iteration buffer (not global system-wide).

Model:

1. Track per `buffer` state in iterators:
   - `activeCount` (entered but not fully drained for mutable applies, across outputs)
   - `waitPromise` (nullable deferred promise)
   - `waitResolve` (nullable resolver for `waitPromise`)
2. Increment:
   - on root-entry/bind for that iteration buffer.
   - on `_enterChild(childBuffer)`.
3. Decrement:
   - on `_leaveCurrentToParent()` for that leaving `buffer`
   - on root-finish path for current root `buffer`.
4. Safety basis:
   - mutable apply is awaited before iterator advances/leaves, so leave/finalize transitions are valid decrement points.
5. Tracking scope:
   - this model uses a simple per-buffer counter model for iteration buffers; no additional command-tree-wide tracker is required.

Promise behavior:

1. `waitApplied(buffer)` checks completion first:
   - if `buffer.finished` and `activeCount(buffer) === 0`, return immediately.
2. Otherwise:
   - create `waitPromise`/`waitResolve` if missing,
   - return that promise.
3. On decrement/root-finish, when `buffer` reaches completion:
   - resolve `waitPromise`,
   - clear `waitPromise` and `waitResolve`.

Completion condition for `waitApplied(buffer)`:

1. `buffer.finished === true` (current global finished flag).
2. `activeCount(buffer) === 0`.

Notes:

1. This model does not require per-output `finished`.
2. If per-output `finished` is available, this model can be tightened without changing the compiler plan.
3. Calling `iterationBuffer.waitApplied(...)` at iteration end is required but not sufficient by itself; iterator presence for outputs touched by that iteration buffer must be active/bound before completion is checked.
4. `iterationBuffer.waitApplied(...)` must ensure relevant iterators are bound (or trigger binding) before completion checks.

Nested concurrency-limited loops:

1. Parent loop and nested limited loop should have separate waited outputs.
2. Parent iteration should wait nested-loop completion as one unit.
3. Add a nested-loop completion promise and emit one `WaitResolveCommand` for it in parent `__waited__`.
4. Inner operations remain accounted inside nested loop's own waited output.
5. Nested completion promise resolves only after nested loop has finished its own `waitApplied(childIterationBuffer)` gating.

## Relationship With `waitAllClosures`

1. Keep `waitAllClosures` during the transition.
2. Add `iterationBuffer.waitApplied(...)` for limited-loop completion correctness without timing barrier.
3. Remove `waitAllClosures` when loop completion is fully represented by `waitApplied` + waited commands.

## Regression Triage Baseline

1. Iteration `waitApplied` hookup is expected to fix concurrency-limit oversubscription/sequentiality regressions:
   - bounded loop pool oversubscription
   - `of 1` not behaving sequentially
   - nested-limit isolation collapse
2. Non-limit regressions introduced by Step 2/3 wiring must be fixed first:
   - finished-buffer timing regressions (`Cannot add command to finished CommandBuffer`)
   - lazy deep-resolve behavior regressions
3. After stabilization, remaining failures should be concentrated in limited-concurrency buckets targeted by Step 6.

## Step-by-Step Implementation Plan

## Step 1: Runtime primitive

1. Implement `waitApplied` API on command buffer/runtime.
2. Add tests proving it resolves only after apply is done.

Expected outcome:

1. No major regression reduction yet.
2. `waitApplied` tests pass in isolation.
3. Timing barrier remains.
4. `deferFinish` remains.

## Step 2: Internal waited output

1. Add compiler support for `currentWaitedOutputName`.
2. Create `__waited__<tmpid>` only for concurrency-limited iteration async blocks.
3. Use local save/restore of waited name inside compiler functions (same style as `currentBuffer` handling), with explicit forced-null contexts.
4. Guarantee restore of previous waited name after each forced-null scope, including early returns/errors in helper flows.

Expected outcome:

1. No major regression reduction yet; scaffolding only.
2. Some non-limit regressions may appear if scope wiring is incorrect.
3. Timing barrier remains.
4. `deferFinish` remains.

## Step 3: Expression-Root Wait Emission (Primary Case)

1. Enter a limited-loop iteration compilation context and set `currentWaitedOutputName = __waited__<tmpid>`.
2. Add a compiler pass-through helper for expression roots:
   - input: compiled expression JS value/expression
   - output: same value/expression semantics for the caller
   - side effect: emits waited command into `currentWaitedOutputName`
3. Use this helper at top-level expression-root sites in loop body, so assignment/output codegen shape is preserved (no forced local `resultId` rewrite everywhere).
   - canonical sites for this step: `compileOutput`, `compileSet`, `compileSetval`, `compileDo` (root expression only)
4. Command choice in helper for this step:
   - expression-root result -> `WaitResolveCommand`
5. This step does not add aggregate-root `_compileAggregate` instrumentation yet.
6. Apply forced-null context for:
   - sub-expression compilation
   - iterator/control expression compilation
   - condition expression compilation (including `concurrentLimit`)
7. After each forced-null region, restore previous waited name immediately.
8. Remove `compileOutput` timing barrier in this step (required to validate that expression-root waited commands are effective).
9. Add focused tests for this step only (expression roots + forced-null exclusions), and confirm expected limited-loop regressions start resolving.
10. Full-suite regressions are acceptable at this step; boundary/nested wiring is completed in Step 6/7 before full-suite gating.

Expected outcome:

1. Some limited-concurrency regressions should start improving (especially expression-root driven cases).
2. Remaining limited-loop failures are expected (nested/boundary/aggregate gaps not done yet).
3. Timing barrier is removed in this step.
4. `deferFinish` remains.

## Step 4: Stabilize Step 2/3 Regressions (Non-waitApplied)

1. Fix finished-buffer timing regressions introduced by Step 2/3 wiring (for example, macro/caller path adding commands after buffer finish).
2. Fix lazy deep-resolve behavior regressions introduced by wait-command/resolve refactors.
3. Temporary implementation rule for effectful expressions:
   - keep async-block based handling for known effectful expression sites (`caller`/`Caller`, sequence-lock expressions) so buffer linking/order remains safe during transition.
   - add explicit compiler comments that this is transitional and should move to direct buffer-only linking/evaluation once value-path migration removes remaining async-block dependence.
4. Keep `waitApplied` hookup out of this step; goal is to isolate and restore non-limit semantics first.
5. Exit criteria:
   - `tests/pasync/race.js` macro+caller regression is fixed.
   - `tests/pasync/structures.js` lazy deep-resolve regression is fixed.
   - remaining failures are concentrated in limited-concurrency buckets expected for next step.

Step 4 minimal wrapping substep (effectful expressions):

1. Use `_compileExpression` as the single wrapping decision point.
2. Keep existing `sequential.processExpression(node, frame)` logic unchanged.
3. Add expression-local `mutatedOutputs` delta detection around `processExpression`:
   - capture `frame.mutatedOutputs` before
   - run `processExpression`
   - capture `frame.mutatedOutputs` after
   - if outputs were newly added by this expression, treat it as output-effectful for transition handling.
   - keep `usedOutputs` for structural linking/dependency data only.
4. Keep `deferFinish` while this substep is rolled out; remove only after validation confirms no late-link regressions.
5. After this substep is validated, remove ad-hoc output timing barrier checks in `compileOutput` (`caller`/`Caller`/sequence marker special casing).

Expected outcome:

1. Non-limit regressions introduced by Steps 2/3 are gone.
2. Failure set is mostly limited-concurrency/sequentiality behavior.
3. No timing barrier logic remains in `compileOutput`.
4. `deferFinish` remains.

## Step 5: Fix Finish Semantics For Late Producers

1. Add producer-in-flight lifecycle tracking to command buffers:
   - increment when async producer work that can reserve/fill slots for this buffer starts
   - decrement when that producer has fully reserved/filled (or safely poisoned) its slot
2. Gate `finished` transition on both:
   - finish requested
   - no pending reserved slots
   - no producer-in-flight work
3. Keep this runtime-level and generic (not macro/caller-only), so it closes the omission for all relevant async producer sites.
4. Remove `deferFinish` only after this runtime finish model is in place and validated.
5. Exit criteria:
   - no regressions of type "add command to finished CommandBuffer" in macro/caller and equivalent async producer paths.
   - no ordering/link regressions caused by parent finishing before late child producer linkage.

Expected outcome:

1. Finished-buffer lifecycle regressions from late producers are eliminated.
2. Runtime finish semantics are correct without compiler workaround.
3. `deferFinish` is removed in this step after validation passes.
4. Remaining failures should be limited-concurrency behavior gaps (Step 6/7 scope).

## Step 6: Hook iteration completion

1. In async block finalization for limited loops, call `iterationBuffer.waitApplied(...)` (all outputs in that iteration segment).
2. Keep existing closure waits.
3. Wire nested limited-loop completion into parent `__waited__` via a single wait command.

Expected outcome:

1. Core limited-concurrency regressions (pool oversubscription, `of 1` sequencing, nested isolation basics) drop significantly.
2. Remaining failures are mostly aggregate-root/boundary coverage gaps.
3. Timing barrier remains removed.
4. `deferFinish` remains removed.

## Step 7: Boundary + aggregate expansion

1. Add aggregate-root wait emission in `_compileAggregate` paths:
   - aggregate root in allowed limited-loop iteration context -> `WaitResolveCommand`
   - do not emit for aggregate children/internal aggregate calls/control contexts
2. Add forced-null context specifically for aggregate child-expression compilation and restore immediately after each region.
3. Include/import/extends/super/block-invocation completion:
   - obtain boundary completion unit
   - emit one `WaitResolveCommand(boundaryCompletionUnit)` into waited output.
   - for `import` that produces multiple returned bindings/promises, first normalize to one aggregate completion unit (resolve-all style), then emit a single `WaitResolveCommand` for that unit.
4. Add focused tests for:
   - aggregate-root vs aggregate-child emission behavior
   - boundary completion units

Expected outcome:

1. Remaining limited-concurrency regressions tied to aggregate/boundary completion are resolved.
2. No broad non-limit regressions expected; if present, treat as bugs.
3. Timing barrier remains removed.
4. `deferFinish` remains removed.

## Step 8: Finalize timing-barrier removal

1. Remove remaining timing-barrier leftovers in non-loop paths (if any).
2. Keep args unresolved and resolved at apply-time as designed.
3. Remove `deferFinish` once Step 5 finish semantics are validated and no late-producer finish regressions remain.

Expected outcome:

1. No timing-barrier code remains anywhere.
2. No `deferFinish` usage remains (already removed in Step 5; this step confirms no leftovers).
3. Behavior should be stable with waitApplied + __waited__ + corrected finish semantics.

## Step 9: Verify

Required suites:

1. `tests/pasync/loop-concurrent-limit.js`
2. `tests/pasync/race.js`
3. `npm run test:quick`

Expected outcome:

1. Targeted suites pass.
2. `npm run test:quick` passes, or remaining failures are explicitly outside this plan and triaged.

## Step 10: Test Suite Restructure + New Special-Case Coverage

1. Use `tests/pasync/loop-concurrent-limit.js` as the dedicated file for limited-concurrency loop coverage.
2. Move limited-concurrency tests from other files into `tests/pasync/loop-concurrent-limit.js` where applicable.
3. Add required new tests for all special cases covered by this plan:
   - expression-root vs aggregate-root handling under unified `WaitResolveCommand`
   - excluded scopes (control-flow/iterator/condition/aggregate-child/sub-expression)
   - nested limited-loop completion wiring (in Step 6 hook path)
   - boundary completion units in limited-loop iterations (`include/import/extends/super/block-invocation`) (Step 7)
   - capture/call/macro-call return handling via `WaitResolveCommand`
4. Keep tests deterministic and assert final semantics (iteration completion/order/limit), not race timing internals unless explicitly testing concurrency behavior.

Expected outcome:

1. Concurrency-limit coverage is centralized and easier to maintain.
2. No functional behavior changes; test-only changes.

## Step 11: Cleanup

1. Audit remaining `waitAllClosures` dependencies.
2. Remove only where semantics are fully represented by waited outputs + `waitApplied`.

Optional optimization:

1. Tail-iteration skip of `waitApplied` when scheduler can prove it is unnecessary.
2. Keep always-on `waitApplied` where proof is unavailable.

Expected outcome:

1. Transitional closure waits are removed only where safe.
2. Runtime/compiler flow is simpler, with no dependence on removed timing barriers or `deferFinish`.

## Error/Poison Semantics

`WaitResolveCommand` is timing-only synchronization and is not part of functional error propagation:

1. It awaits/settles its input unit for scheduling purposes.
2. It must not poison output state.
3. It must not throw/reject into template/script execution flow.
4. If diagnostics are needed, they are optional side-channel logging only (non-fatal).

## Clarifications

1. `set`/`setval` statement categories are not special-cased here; they are covered by the same expression-root rules.
2. Template output and `do` are also not special categories; both are covered by expression-root rules.
