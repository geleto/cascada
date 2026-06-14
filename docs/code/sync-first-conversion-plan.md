# Sync-First Conversion Plan

Plan for converting remaining accidental async/runtime microtask paths to
sync-first hybrids. This document includes only paths that should be converted.

## Goal

Cascada values may be promises everywhere, but most values are already resolved
at runtime. Hot helpers and generated callbacks should therefore:

1. run synchronously when all consumed values are concrete or poison;
2. return a thenable only when an actual promise or lazy marker must settle;
3. preserve Cascada poison/fatal error semantics exactly;
4. avoid local `await` in generated statement or expression callbacks unless the
   callback genuinely needs more than one asynchronous step.

## Pass 1: Small Hot-Path Conversions

Do these as one implementation pass. Each item is local, low-risk, and has a
clear generated-source or unit-test signal.

### `WaitResolveCommand.apply`

File: `src/runtime/commands/wait.js`

Current shape: `async apply(...)` always returns a promise, even when
`runtime.resolveAll(args)` returns synchronously.

Target shape:

- make `apply` non-async;
- call `resolveAll(values)`;
- use `thenValue(...)` only when the result is promise-like;
- keep the current swallow-on-failure behavior.

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

### Non-Linked Inline If

File: `src/compiler/compiler-base-async.js`

Current shape: non-linked inline-if emits
`runtime.resolveThen(cond, async function(cond) { ... })`.

Target shape:

- emit a plain callback;
- return the selected branch expression directly;
- preserve expression-level poison behavior through `resolveThen`.

Why: inline conditionals are expression-level control flow, and the selected
branch can already return a concrete value or thenable.

Tests:

- `tests/pasync/expressions.js` or `tests/pasync/conditional.js`;
- generated-source assertion for `{{ "a" if cond else "b" }}`.

### Non-Linked `and` / `or`

File: `src/compiler/compiler-base-async.js`

Current shape: non-linked short-circuit operators emit
`runtime.resolveThen(left, async function(left) { ... })`.

Target shape:

- emit a plain callback;
- return `left` or the right expression directly;
- keep linked-mutating expression boundaries separate.

Why: the short-circuit decision only consumes one value. The right expression is
already a value/thenable boundary.

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

## Pass 2: Chain Snapshot / Error-State Sync-First

File: `src/runtime/chains/base.js`

Current shape: `_ensureErrorState()` and `inspectTargetForErrors(...)` are
async. Base-chain `finalSnapshot()` therefore often becomes promise-shaped even
when the target is fully synchronous.

Target shape:

- split error inspection into a sync-first scanner plus async helper;
- return cached or synchronously inspected error state directly when possible;
- delegate to async only when a promise or `RESOLVE_MARKER` is encountered;
- preserve the "inspect all values before reporting" behavior.

Risks:

- recursive object/array traversal must still avoid cycles;
- promise and marker errors must still be collected and deduplicated;
- text/data/var chain overrides must keep their existing fast paths.

Tests:

- `tests/pasync/chain-errors.js`;
- snapshot/output tests;
- poison aggregation tests;
- add a source or runtime test proving a clean sync `finalSnapshot()` is not
  promise-shaped when the chain is finished and contains only sync values.

## Pass 3: Runtime Loop Dispatcher Sync-First

File: `src/runtime/loop.js`

Current shape: top-level `iterate(...)` is async, so even simple async-mode
array loops return a promise from the dispatcher.

Target shape:

- introduce a non-async `iterate(...)` wrapper;
- keep async helpers for async iterators, sequential loops, concurrent limits,
  promise iterables, and async else bodies;
- use direct array/object fast paths when the iterable, limit, and body mode are
  synchronous;
- preserve body-poisoning and else-poisoning semantics.

Risks:

- loop else handling differs before/after iteration;
- concurrent limits and async iterators are inherently async;
- poison from iterator selection and malformed destructuring must still poison
  the correct body/else targets.

Tests:

- `tests/pasync/loops.js`;
- `tests/pasync/loop-concurrent-limit.js`;
- `tests/poison/handler-poisoning.js`;
- generated-source tests are less important here than runtime behavior.

## Pass 4: Linked Expression Control-Flow Boundaries

Files:

- `src/compiler/compiler-base-async.js`
- `src/compiler/async-boundaries.js`
- `src/runtime/async-boundaries.js`

Current shape: linked inline-if and linked `and`/`or` expression boundaries emit
local `await runtime.resolveSingle(...)` inside `runValueBoundary(...)`.

Target shape:

- design a value-boundary equivalent of `consumeControlFlowValue(...)`;
- keep expression rejection semantics distinct from statement skipped-chain
  poisoning;
- remove local awaits from generated expression control-flow callbacks when the
  selected branch can be returned directly.

Risks:

- expression boundaries must preserve rejection to the expression consumer;
- statement-boundary skipped-chain poisoning must not leak into expression
  semantics;
- this probably needs a small runtime helper rather than inlining `.then` logic
  at each compiler site.

Tests:

- inline-if and short-circuit expression tests with linked mutations;
- poison and fatal error tests for expression conditions;
- generated-source assertions for absence of local condition awaits.

