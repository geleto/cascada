# Sync-First Conversion Plan

Plan for converting remaining accidental async/runtime microtask paths to
sync-first hybrids, following the pattern in
[`sync-first.md`](sync-first.md).

This list was derived by grepping for `async` functions and generated callbacks
that contain no `await` (or only a single awaited value), cross-checked against
the loop / snapshot / macro paths that dominate runtime profiles. It includes
only paths that should be converted; see [Out of scope](#out-of-scope) for paths
deliberately left async.

## Goal

Cascada values may be promises everywhere, but most values are already resolved
at runtime. Hot helpers and generated callbacks should therefore:

1. run synchronously when all consumed values are concrete or poison;
2. return a thenable only when an actual promise or lazy marker must settle;
3. preserve Cascada poison/fatal error semantics exactly;
4. avoid local `await` in generated statement or expression callbacks unless the
   callback genuinely needs more than one asynchronous step.

## Conventions for every pass

These apply to all passes; individual sections list only their deltas.

**Sequencing and payoff.** Passes are ordered by ascending risk, *not* by
payoff. The largest performance return is in Pass 2 (every chain snapshot) and
Pass 3 (every loop); Pass 1's expression conversions are lower-frequency. If
effort gets squeezed, do not drop Pass 2/3 - they are the point of the exercise.

**Measurement and proof.** Conversions should preserve user-visible semantics
unless an error-model correction is explicitly called out. Each pass must add a
test that proves the fast path stays synchronous - e.g. assert the
helper/callback returns a non-thenable for all-concrete inputs, or count
microtasks/promise allocations. Benchmark loop-heavy, macro-heavy, and
snapshot-heavy templates before claiming a measured speedup; do not treat a
sync-shape test as a benchmark result.

**Landing.** Each pass is independently landable: one commit, full suite green,
no behavior change. Do not batch passes into a single change.

**Testing.** Reuse the Test Checklist in [`sync-first.md`](sync-first.md#test-checklist)
(concrete-value / promise / existing-poison / rejected-promise-poison /
non-poison-fatal / generated-source-shape / multi-value error collection). Each
pass below lists only pass-specific test deltas.

## Pass 1: Small Hot-Path Conversions - implemented

Done as one implementation pass. Each item is local, low-risk, and has a clear
generated-source or unit-test signal.

### `WaitResolveCommand.apply`

File: `src/runtime/commands/wait.js`

Current shape: `async apply(...)` always returns a promise, even when
`runtime.resolveAll(args)` returns synchronously.

Target shape:

- make `apply` non-async;
- call `resolveAll(values)`;
- use `thenValue(...)` to preserve sync-first resolved/poison handling and
  delegate actual promises to the async path;
- swallow poison wait failures, but propagate non-poison/fatal failures.

Why: `WaitResolveCommand` is used for limited/sequential loop completion,
caller scheduling, imports/includes in limited loops, and other timing-only
waits. Avoiding a promise for sync waits should reduce overhead in loop-heavy
templates.

Tests:

- existing `tests/pasync/loop-concurrent-limit.js`;
- existing loop and macro caller tests;
- add or update a source-shape assertion only if useful.

### Macro Return IIFE

File: `src/compiler/macro.js`

Current shape: macro return paths emit `(async () => { ... })()` even when
there is no caller block scheduling wait.

Target shape:

- emit a plain IIFE for macros without caller scheduling;
- use `runtime.thenValue(snapshot, ...)` for final snapshot mapping;
- keep the async/thenable path only when caller readiness must be observed.

Why: simple macros are common, and the generated async IIFE forces a promise
even when macro output is fully synchronous.

Tests:

- existing `tests/pasync/macros.js`;
- generated-source assertion that a simple macro does not emit `async () =>`;
- behavior test for caller-capable macros to ensure the scheduling wait remains.

### Inline If Without Linked Parent Mutations

File: `src/compiler/compiler-base-async.js`

Current shape: inline-if without linked parent mutations emits
`runtime.resolveThen(cond, async function(cond) { ... })`.

Target shape:

- emit a plain callback;
- return the selected branch expression directly;
- preserve expression-level poison behavior through `resolveThen`.

Why: inline conditionals are expression-level control flow, and the selected
branch can already return a concrete value or thenable.

Note: "without linked parent mutations" is narrower than "contains no
sequencing." A sequence path read can still run through this shape when it only
observes an existing ordered path. If the inline-if condition or selected branch
mutates a parent-owned ordered path, for example through a `!` sequence call,
analysis sets `boundaryLinkedMutatedChains` and the expression uses the value-boundary
path covered by Pass 4 instead.

Tests:

- `tests/pasync/expressions.js` or `tests/pasync/conditional.js`;
- generated-source assertion for `{{ "a" if cond else "b" }}`.

### `and` / `or` Without Linked Parent Mutations

File: `src/compiler/compiler-base-async.js`

Current shape: short-circuit operators without linked parent mutations emit
`runtime.resolveThen(left, async function(left) { ... })`.

Target shape:

- emit a plain callback;
- return `left` or the right expression directly;
- keep linked-mutating expression boundaries separate.

Why: the short-circuit decision only consumes one value. The right expression is
already a value/thenable boundary.

As with inline-if, sequence reads can still be present here. Sequence calls or
other parent-owned command mutations are excluded from this pass by
`boundaryLinkedMutatedChains` and stay on the value-boundary path.

Tests:

- `tests/pasync/expressions.js`;
- generated-source assertions for `{{ left or right }}` and
  `{{ left and right }}`.

### Single Comparisons

File: `src/compiler/compiler-base-async.js`

Current shape: all comparisons emit an async callback, even `a < b`.

Target shape:

- emit a plain callback when `node.ops.length === 1`;
- keep the current async callback for chained comparisons such as `a < b < c`,
  where later operands currently use local awaited compilation.

Why: single comparisons are common and need no local `await` after
`resolveDuo(...)`.

Tests:

- generated-source assertion for `{{ a < b }}`;
- existing chained-comparison behavior tests to ensure `{{ a < b < c }}` still
  works.

### Component Shared Observation

File: `src/runtime/inheritance/component.js`

Current shape: `observeComponentSharedChain(...)` is `async` but contains no
`await`.

Target shape:

- make it a normal function;
- continue returning `instance.sharedRootBuffer.addCommand(...)`.

Why: small cleanup; avoids promise wrapping for direct shared-chain observation.

Tests:

- existing component shared observation tests.

## Pass 2: Chain Snapshot / Error-State Sync-First - implemented

File: `src/runtime/chains/base.js`

Done as the second implementation pass. `_ensureErrorState()` and
`inspectTargetForErrors(...)` are now sync-first, so base-chain
`finalSnapshot()` can stay synchronous when the chain is complete and the target
contains only concrete values or poison.

This pass is well prepared: the callers of `_ensureErrorState()`
(`_getResultOrThrow`, `_isError`, `_getErrors`) already branch on
`error.then`, so making error state sync-when-possible needs no caller changes.

Target shape:

- split `inspectTargetForErrors` into a single sync traversal that collects sync
  errors *and* a list of pending thenables/markers: if that list is empty,
  return the error state synchronously; otherwise await the pending list in an
  async helper. (Do not scan twice or early-bail on the first pending value -
  that would miss later errors.)
- when a pending branch hits a raw fatal rejection, continue draining already
  discovered and newly discovered pending inspections before throwing the first
  fatal error, so later nested rejections cannot become unhandled.
- make `_ensureErrorState()` non-async and return cached/synchronously inspected
  state directly when possible;
- preserve the "inspect all values before reporting" behavior.
- add direct `_isError()` and `_getErrors()` checks for already-complete chains
  with sync-clean and sync-poison targets, because those methods are the primary
  public consumers of `_ensureErrorState()`.

Note: `finalSnapshot()` has a *second* async gate - `_completionResolved` /
`_completionPromise.then(...)` - independent of error state. Making error
inspection sync does not make `finalSnapshot()` sync unless completion is
already resolved. Scope the test below to the `_completionResolved` case.

Implementation note: script finalization waits for the returned value's own
promise/chain dependencies, not for all outstanding root structural work. Do
not add a root-wide completion lane just to restore the old accidental
microtask delay; unrelated root work may continue after the return value is
ready.

Risks:

- recursive object/array traversal must still avoid cycles;
- promise and marker errors must still be collected and deduplicated;
- text/data/var chain overrides must keep their existing fast paths.

Tests:

- `tests/pasync/chain-errors.js`;
- snapshot/output tests;
- poison aggregation tests;
- a runtime test proving `finalSnapshot()` is not promise-shaped when the chain
  is `_completionResolved` and contains only sync values.
- return tests proving unrelated root work does not delay a ready return value.

## Pass 3: Runtime Loop Dispatcher Sync-First - implemented

File: `src/runtime/loop.js`

Done as the third implementation pass. Top-level `iterate(...)` is now a
sync-first wrapper for the highest-frequency case: concrete parallel arrays
with no sequential advancement, return-chain check, or concurrency limit.
Promised iterables, object loops, async iterators, sequential loops, all
concurrent-limit paths, and scalar validation still delegate to the async
dispatcher. Empty concrete arrays may still return a thenable if the loop-else
body itself starts async work.

`iterateArrayParallel(...)` was already non-async, so this pass avoids the
former loop-level async wrapper without duplicating the object and
concurrent-limit dispatch rules.

Target shape:

- introduce a non-async `iterate(...)` wrapper;
- keep async helpers for async iterators, sequential loops, concurrent limits,
  promise iterables, and validation/error paths;
- use a direct array fast path when the iterable and dispatch path can complete
  synchronously;
- preserve body-poisoning and else-poisoning semantics.

Implementation note: the wrapper is intentionally conservative. It handles
already-concrete, unbounded parallel arrays synchronously and falls back to the
old async dispatcher for object loops, sequential advancement, return-chain
checks, all limit handling, promised values, async iterators, and malformed
object arity cases that should follow the existing fatal path.

Risks:

- **Guard drift.** The async `iterate(...)` does substantial entry work before
  dispatch (poison `arr`, scalar-in-scriptMode, object->`fromIterator`,
  concurrency resolution). The sync wrapper must re-check enough of these to
  choose the fast path; factor those guards into a *shared* helper rather than
  duplicating them, so the sync and async entries cannot diverge.
- loop else handling differs before/after iteration;
- concurrent limits and async iterators are inherently async;
- poison from iterator selection and malformed destructuring must still poison
  the correct body/else targets.

Tests:

- `tests/pasync/loops.js`;
- `tests/pasync/loop-concurrent-limit.js`;
- `tests/poison/handler-poisoning.js`;
- runtime tests proving concrete parallel arrays return non-thenables, while
  promised/object/sequential/limited paths remain thenable;
- generated-source tests are less important here than runtime behavior.

## Pass 4: Linked Expression Control-Flow Boundaries - implemented

Files:

- `src/compiler/compiler-base-async.js`
- `src/compiler/async-boundaries.js`
- `src/runtime/async-boundaries.js`

Done as the fourth implementation pass. This pass is the **linked-mutating
counterpart of Pass 1's inline-if / `and` / `or` work**, reusing the proven
sync-first `resolveThen(...)` continuation design.

Previous shape: inline-if and `and`/`or` expression boundaries that mutate
parent-owned linked chains emit local `await runtime.resolveSingle(...)` inside
`runValueBoundary(...)`.

Implemented shape:

- `runValueBoundary(...)` is sync-first and no longer starts with
  `Promise.resolve().then(...)`;
- callers must treat `runValueBoundary(...)` as returning value-or-thenable,
  with synchronous throws preserved;
- linked-mutating inline-if and `and`/`or` expression callbacks are plain
  functions that call `runtime.resolveThen(...)`;
- `compileValueBoundary(...)` is included in this pass, so imported callable
  value boundaries also use a plain callback plus `runtime.thenValue(...)`
  instead of `return await ...`;
- no expression-specific equivalent of `consumeControlFlowValue(...)` is kept:
  expression boundaries propagate values and rejections to their consumer, so
  plain `resolveThen(...)` / `thenValue(...)` are the correct abstraction;
- child buffers still finish after an actual returned thenable settles, matching
  the old value-boundary cleanup timing without forcing a microtask for sync
  values.

Scope: `compileValueBoundary(...)` (used by `call.js` for imported callable
value boundaries) was converted in this pass once the runner became sync-first.

Preserved semantics:

- expression boundaries must preserve rejection to the expression consumer;
- statement-boundary skipped-chain poisoning must not leak into expression
  semantics.

Tests:

- inline-if and short-circuit expression tests with linked mutations;
- poison and fatal error tests for expression conditions;
- generated-source assertions for absence of local condition awaits.

## Out of scope

Paths that look async-without-await but should stay async, and why:

- `compileAsyncInclude` (`composition.js`) - genuinely needs multiple ordered
  awaits (resolve name, then resolve template) with branching error handling
  between them; cannot collapse into a single `thenValue(...)` continuation.
- Inherently async iterators, sequential loops, concurrent-limit loops, and
  promise iterables in `loop.js` - these always await.

Add any path consciously deferred during implementation here, rather than
leaving it implicitly skipped.
