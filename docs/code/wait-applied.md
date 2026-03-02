# Wait-Applied + __waited__ Plan

## Scope

This design is needed only for:

1. Concurrency-limited loop iterations (`of N`).

Regular unbounded loops do not need this mechanism.
Sequential loops do not use `waitApplied` in this phase.

## Problem We Are Solving

Today concurrency-limited loop correctness depends on a compiler timing barrier in async template output (`compileOutput`), which awaits expression completion before command enqueue.

That barrier must be removed, but removing it directly breaks concurrency-limited loop behavior.

We need a replacement that is explicit and runtime-driven.

## Architecture

Use two pieces together:

1. `waitApplied` runtime wait.
2. Internal `__waited__<tmpid>` output per relevant loop iteration async block.

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

## What Gets Added To `__waited__`

Add exactly one waited command per top-level expression result that matters for loop body completion.

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

## waitApplied Runtime Model (Current Constraints)

Constraints for this phase:

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
   - this phase uses a simple per-buffer counter model for iteration buffers; no additional command-tree-wide tracker is required.

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

1. This does not require per-output `finished` in this phase.
2. If per-output `finished` is introduced later, this model can be tightened without changing the compiler plan.
3. Calling `iterationBuffer.waitApplied(...)` at iteration end is required but not sufficient by itself; iterator presence for outputs touched by that iteration buffer must be active/bound before completion is checked.
4. `iterationBuffer.waitApplied(...)` must ensure relevant iterators are bound (or trigger binding) before completion checks.

Nested concurrency-limited loops:

1. Parent loop and nested limited loop should have separate waited outputs.
2. Parent iteration should wait nested-loop completion as one unit.
3. Add a nested-loop completion promise and emit one `WaitResolveCommand` for it in parent `__waited__`.
4. Inner operations remain accounted inside nested loop's own waited output.
5. Nested completion promise resolves only after nested loop has finished its own `waitApplied(childIterationBuffer)` gating.

## Relationship With `waitAllClosures`

Current phase:

1. Keep `waitAllClosures` for transition safety.
2. Add `iterationBuffer.waitApplied(...)` for limited-loop completion correctness without timing barrier.

Future (after value migration is complete):

1. Eliminate `waitAllClosures` after switching from var to value (output based) implementation
2. Keep concurrency-limited loop correctness grounded in `waitApplied` + explicit waited commands.

## Step-by-Step Implementation Plan

Rollout toggle:

1. Use one rollout toggle `USE_WAIT_APPLIED_FOR_LIMITED_LOOPS` to switch between timing-barrier path and wait-applied path (not multiple overlapping toggles).

## Step 1: Runtime primitive

1. Implement `waitApplied` API on command buffer/runtime.
2. Add tests proving it resolves only after apply is done.

## Step 2: Internal waited output

1. Add compiler support for `currentWaitedOutputName`.
2. Create `__waited__<tmpid>` only for concurrency-limited iteration async blocks.
3. Use local save/restore of waited name inside compiler functions (same style as `currentBuffer` handling), with explicit forced-null contexts.
4. Guarantee restore of previous waited name after each forced-null scope, including early returns/errors in helper flows.

## Step 3: Expression-Root Wait Emission (Primary Case)

1. Enter a limited-loop iteration compilation context and set `currentWaitedOutputName = __waited__<tmpid>`.
2. Add a compiler pass-through helper for expression roots:
   - input: compiled expression JS value/expression
   - output: same value/expression semantics for the caller
   - side effect: emits waited command into `currentWaitedOutputName`
3. Use this helper at top-level expression-root sites in loop body, so assignment/output codegen shape is preserved (no forced local `resultId` rewrite everywhere).
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
10. Full-suite regressions are acceptable at this step; boundary/nested wiring is completed in Step 4 before full-suite gating.

## Step 4: Boundary + Nested-Loop Wait Emission

1. Add aggregate-root wait emission in `_compileAggregate` paths:
   - aggregate root in allowed limited-loop iteration context -> `WaitResolveCommand`
   - do not emit for aggregate children/internal aggregate calls/control contexts
2. Add forced-null context specifically for aggregate child-expression compilation and restore immediately after each region.
3. Add focused tests for aggregate-root vs aggregate-child behavior.
4. Nested concurrency-limited inner loop:
   - obtain `nestedCompletionPromise`
   - emit one `WaitResolveCommand(nestedCompletionPromise)` into parent waited output.
5. Include/import/extends/super/block-invocation completion:
   - obtain boundary completion unit
   - emit one `WaitResolveCommand(boundaryCompletionUnit)` into waited output.
   - for `import` that produces multiple returned bindings/promises, first normalize to one aggregate completion unit (resolve-all style), then emit a single `WaitResolveCommand` for that unit.
6. Add focused tests for boundary/nested cases.
## Step 5: Hook block completion

1. In async block finalization for limited loops, call `iterationBuffer.waitApplied(...)` (all outputs in that iteration segment).
2. Keep existing closure waits for now.
3. Wire nested limited-loop completion into parent `__waited__` via a single wait command.

## Step 6: Finalize timing-barrier removal

1. Keep timing barrier removed as default path (or flip/remove temporary rollout flag if used).
2. Keep args unresolved and resolved at apply-time as designed.

## Step 7: Verify

Required suites:

1. `tests/pasync/loop-concurrent-limit.js`
2. `tests/pasync/loops.js`
3. `tests/pasync/race.js`
4. `npm run test:quick`

## Step 8: Test Suite Restructure + New Special-Case Coverage

1. Create a dedicated limited-loop test file in `tests/pasync`: `loop-concurrency-limit.js`.
2. Move existing concurrency-limited loop tests into that file:
   - include currently failing limited-loop tests
   - include any other limited-loop tests currently spread across other files
3. Add required new tests for all special cases covered by this plan:
   - expression-root vs aggregate-root handling under unified `WaitResolveCommand`
   - excluded scopes (control-flow/iterator/condition/aggregate-child/sub-expression)
   - nested limited-loop completion wiring (child completion promise into parent waited output)
   - boundary completion units in limited-loop iterations (`include/import/extends/super/block-invocation`)
   - capture/call/macro-call return handling via `WaitResolveCommand`
4. Keep tests deterministic and assert final semantics (iteration completion/order/limit), not race timing internals unless explicitly testing concurrency behavior.

## Step 9: Cleanup phase (later)

After full value migration:

1. Audit remaining `waitAllClosures` dependencies.
2. Remove only where semantics are fully represented by waited outputs + `waitApplied`.

Deferred optimization (not planned now):

1. Tail-iteration skip of `waitApplied` when scheduler can prove it is unnecessary.
2. Keep always-on `waitApplied` in this phase for correctness.

## Error/Poison Semantics

`WaitResolveCommand` is timing-only synchronization and is not part of functional error propagation:

1. It awaits/settles its input unit for scheduling purposes.
2. It must not poison output state.
3. It must not throw/reject into template/script execution flow.
4. If diagnostics are needed, they are optional side-channel logging only (non-fatal).

## Clarifications

1. `set`/`setval` statement categories are not special-cased here; they are covered by the same expression-root rules.
2. Template output and `do` are also not special categories; both are covered by expression-root rules.
