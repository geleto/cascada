# Sequential and Concurrency-Limited Loop `__waited__` Channel

## Overview

For **sequential loops** (`while`, `each`) and **concurrency-limited loops** (`for ... of N`), the engine uses a `__waited__` channel to track when each iteration's async work is fully complete. This allows the loop iterator to correctly gate the next iteration (sequential: gate every step; limited: gate when the in-flight count reaches the limit).

This document describes the implemented model.

### Current Evaluation

The codebase already contains several important pieces of this design:

- `compile-buffer.js` already has `withOwnWaitedChannel`, `skipOwnWaitedChannel`, and `emitOwnWaitedConcurrencyResolve`.
- `compile-loop.js` already scopes waited-channel compilation for sequential and concurrency-limited loop bodies.
- `compile-inheritance.js` and parts of `compiler.js` already emit waited-channel resolves for some composition boundaries.
- `CommandBuffer.getChannel()` and `Channel.finalSnapshot()` already exist in runtime.
- `STOP_WHILE` and deferred iteration-resolution plumbing have been removed.

The main work was not inventing `__waited__`, but finishing the replacement of the older deferred / `STOP_WHILE` loop-completion path with the cleaner `finalSnapshot()`-driven model described below.

### Final State

1. Loop iteration completion is driven by waited-channel `finalSnapshot()` after explicit child-buffer finishing.
2. `STOP_WHILE` is gone; async while loops return `false` to break and `true` after waited completion.
3. Waited-channel completion is the single authoritative definition of "iteration finished" for sequential and concurrency-limited async loops.
4. Root-expression WRC emission is centralized in `compileExpression(...)`, with explicit opt-out for control/composition roots that should not contribute to waited-root tracking.

---

## Iteration Completion Mechanism

Each iteration runs inside an `asyncBlock` that creates a child buffer. That child buffer also owns the iteration's `__waited__` channel. At the end of the iteration body, after all commands have been added:

1. `childBuffer.markFinishedAndPatchLinks()` is called **explicitly** inside the inner asyncFn. This is not about creating a separate buffer for `__waited__`; it is about marking the iteration's existing child buffer finished early enough for the parent buffer-iterator to start descending into it.
2. `childBuffer.getChannel(waitedChannelName).finalSnapshot()` is returned from the inner asyncFn. This promise resolves only after the buffer-iterator has fully applied all commands in the `__waited__` channel.
3. The `asyncBlock` awaits this promise via `.finally(cleanup)`, so it resolves only when the iteration's `__waited__` work is complete.
4. The loop iterator (`iterateArrayLimited` / `iterateAsyncSequential`) awaits `asyncBlock(...)` directly to gate the next iteration.

The `waitedChannelName` is `node.body._analysis.waitedOutputName`, already computed by compile-time analysis. It is accessed at runtime via `childBuffer.getChannel(waitedChannelName)`. `getChannel` exists on `CommandBuffer` at `src/runtime/command-buffer.js`.

### Why `markFinishedAndPatchLinks` Before `finalSnapshot`

The async block already has its own child buffer, and that child buffer already owns the `__waited__` channel. The important issue is ordering, not ownership.

Without explicit early `markFinishedAndPatchLinks`, there is a deadlock:

- `finalSnapshot()` resolves only after the parent iterator descends into and fully processes the child buffer.
- The parent iterator can only descend after the child buffer is marked finished.
- In the current `asyncBlock` design, `markFinishedAndPatchLinks` runs in `finally`, only after the inner asyncFn's returned promise resolves.
- Circular: the promise cannot resolve until the iterator runs; the iterator cannot run until the promise resolves.

By calling `markFinishedAndPatchLinks()` explicitly before returning `finalSnapshot()`, the child buffer is already marked finished. The parent iterator can start descending immediately, and the waited channel can actually complete. No circular dependency.

The `asyncBlock` cleanup calls `markFinishedAndPatchLinks()` again in `finally` (see `async-state.js`). This is safe: the method only sets boolean flags (`_finishAllChannelsRequested`, `_finishRequestedChannels`), so calling it twice is idempotent and needs no guard. The design requirement is therefore not "call `markFinishedAndPatchLinks()` somehow at some point" but "call it before `finalSnapshot()` inside the iteration path, rather than relying only on cleanup timing."

### `finalSnapshot()`

`finalSnapshot()` is an existing method on `Channel` (`src/runtime/output.js`). It returns a Promise that resolves after the channel's `_completionPromise` resolves, meaning after the buffer-iterator has fully applied all commands on that channel. If the channel is already complete, it resolves immediately with the current value.

### While Loop Condition Signal

For `while` loops the body function doubles as the condition check. The inner asyncFn evaluates the condition first:

- **Condition false**: return `false` immediately, before `markFinishedAndPatchLinks()` or `finalSnapshot()` are called. The `asyncBlock` cleanup handles `markFinishedAndPatchLinks()` on the empty child buffer. The asyncBlock resolves with `false`.
- **Condition true**: run the body, then `markFinishedAndPatchLinks()`, then `await finalSnapshot()`, then `return cond` (which is `true`).

The loop iterator checks `if (result === false) break`. Since `false` is our explicit return value, and not the return value of `finalSnapshot()`, it is an unambiguous sentinel. `STOP_WHILE` is no longer needed.

---

## What Adds WRCs (WaitResolveCommand) to `__waited__`

**Summary rule: root expressions inside bodies, and template/script composition operations.**

"Bodies" are any execution scopes that are not condition expressions: `if`/`else`/`elif` bodies, `for` bodies, `while` bodies, macro bodies, and so on. Conditions are excluded because their resolved value gates control flow, but the operations inside the branches and bodies still add the WRCs.

Root expressions are compiled via `compileExpression` (not `_compileExpression`). `compileExpression` is the call site responsible for emitting WRCs for each statement's top-level result promise.

### Included

**Root expressions**: every expression compiled by `compileExpression` adds a WRC for its result promise, except those listed in the Excluded section. The expression root is the single promise representing the entire expression tree for that statement. Subexpressions (arguments, member lookups, filter chains) are internal and do not individually add WRCs; only the outermost result does.

For example: variable assignments (`var x = asyncFetch(item)`), output commands (`@data`, `@text`), and `do` tags all add WRCs via their expression roots without any special per-statement handling.

**Template/script composition**:

- `include`: WRC holds the promise for the included template's output channel resolving.
- `import`: WRC holds a combined promise for all imported values resolving.
- `extends` / `block`: WRC holds the promise for the composed template output resolving.
- The nested child buffer mechanism guarantees ordered output application; the WRC signals to `__waited__` that the composition must complete before the iteration is considered done.

**Non-concurrency-limited nested loops**:

- Their bodies add WRCs recursively up to the enclosing sequential/limited loop's `__waited__` channel, just like operations from any other body node.
- A non-limited nested loop does not break the WRC chain. All root expressions and composition operations inside it contribute WRCs to the parent loop's `__waited__`.

**Concurrency-limited nested loops** (and sequential nested loops):

- Add a single WRC to the parent's `__waited__` with a promise that resolves when the nested loop fully finishes.
- The nested loop manages its own `__waited__` channel internally. Its individual iteration WRCs go to its own `__waited__`, not the parent's.

### Excluded

**Conditions**: the condition expression of `if`, `while`, `for`, and the collection expression of `for`:

- Must be awaited inline because their resolved value gates control flow.
- The bodies of these constructs still add WRCs normally.
- In `compile-loop.js`, conditions are already wrapped in `skipOwnWaitedChannel()` to exclude them.

**Nested sequential/concurrency-limited loop internals**:

- The body of a nested sequential or concurrency-limited loop writes WRCs to its own `__waited__` channel, not the parent's.

---

## Recursion Rule

WRC propagation recurses through all node bodies except:

1. **Conditions** (excluded; awaited inline for control flow)
2. **Nested sequential/concurrency-limited loop bodies** (excluded; they own their `__waited__`)

Everything else, including `if`/`else`/`elif` bodies, `for` bodies, `while` bodies, macro expansion, and nested non-limited loops, contributes root expression WRCs upward to the enclosing loop's `__waited__` channel.

---

## What This Replaces

This design supersedes the following mechanisms, which are removed:

| Removed | Replaced by |
|---|---|
| `deferredResolveId` / `deferredPromise` (outer loop body) | `asyncBlock(...)` promise returned directly; `await finalSnapshot()` drives resolution |
| `onApplied` callback on `WaitResolveCommand` | Eliminated; no longer needed |
| `onAppliedExpr` parameter in `emitOwnWaitedConcurrencyResolve` | Eliminated |
| `waitAllClosures(1)` as WRC value | Eliminated; buffer-iterator handles nested asyncBlock ordering via child buffer slots, and `finalSnapshot()` resolves after all are processed |
| `runtime.STOP_WHILE` sentinel | Eliminated; while body returns the condition boolean directly and the iterator checks `result === false` |

The previous `waitApplied()` mechanism (removed earlier) attempted to resolve when the buffer-iterator finished, but had a bug: the `_activeWaitAppliedCount` dropped to zero prematurely when the iterator descended into child buffers, causing early resolution. The `onApplied`/deferred approach was an interim fix. This design is the clean replacement.

---

## Resolved Implementation Notes

1. **Current WRC scope is correct**: `emitOwnWaitedConcurrencyResolve` in `compile-loop.js` is already only called when `shouldAwaitLoopBody` is true (`sequentialLoopBody || hasConcurrencyLimit`). It does not add WRCs for unrestricted parallel loops. No change needed to the scope guard.
2. **`markFinishedAndPatchLinks` double-call is safe**: `async-state.js` cleanup calls `markFinishedAndPatchLinks()` in `finally`. The explicit call inside the inner asyncFn means it will be called twice. The implementation uses only boolean flags (`_finishAllChannelsRequested`, `_finishRequestedChannels`), so setting them true a second time is harmless.
3. **`__waited__` channel access**: Use `childBuffer.getChannel(waitedChannelName)` where `waitedChannelName` comes from `node.body._analysis.waitedOutputName`. `getChannel` is defined at `command-buffer.js`.
4. **Non-limited nested loop WRC propagation**: The compiler must track whether it is currently inside a sequential/limited loop body scope when recursing into nested non-limited loop bodies. The existing `withOwnWaitedChannel` / `skipOwnWaitedChannel` infrastructure in `compile-buffer.js` is the mechanism for this. The scope is set when entering a sequential/limited loop body and unset only when entering a nested sequential/limited loop body.

---

## Implementation Status

### Completed Work

#### Step 1: Audit the current partial implementation

Review the existing waited-loop paths in:

- `src/compiler/compile-loop.js`
- `src/compiler/compile-buffer.js`
- `src/compiler/compile-inheritance.js`
- `src/compiler/compiler.js`
- `src/runtime/loop.js`
- `src/runtime/async-state.js`
- `src/runtime/command-buffer.js`

Confirm:

1. which parts already match this design,
2. which code paths still use `deferredResolveId`, deferred promises, closure waits, or `runtime.STOP_WHILE`,
3. where waited-command emission coverage is incomplete or inconsistent.

Status:

- completed

#### Step 2: Make iteration completion use waited-channel snapshots

For sequential and concurrency-limited loop iteration async blocks:

1. explicitly call `childBuffer.markFinishedAndPatchLinks()` inside the inner async function after the body has emitted commands,
2. then read `childBuffer.getChannel(waitedChannelName).finalSnapshot()` from that same child buffer,
3. return or await that snapshot promise as the iteration completion signal.

Goal:

- make waited-channel completion, not deferred outer promises, define when an iteration is done.

Status:

- completed

#### Step 3: Remove deferred iteration-resolution plumbing

Delete the transitional loop-body completion mechanism:

1. `deferredResolveId`
2. `deferredPromise`
3. `onApplied` callback usage on `WaitResolveCommand`
4. `onAppliedExpr` plumbing in `emitOwnWaitedConcurrencyResolve`

Goal:

- reduce loop completion to one model: `markFinishedAndPatchLinks()` plus `finalSnapshot()`.

Status:

- completed

#### Step 4: Replace `STOP_WHILE` with boolean loop-body completion

Change while-loop compilation/runtime so:

1. condition false returns `false` directly from the iteration body,
2. condition true runs the body, waits for waited-channel completion, then returns `true`,
3. the iterator breaks on `result === false`.

Goal:

- remove `runtime.STOP_WHILE` from compiler/runtime loop coordination.

Status:

- completed

#### Step 5: Reconcile waited-command emission coverage

Audit and adjust compiler emission so the rules in this document are true in practice:

1. root expressions inside bodies emit WRCs,
2. conditions and iterator-driving expressions do not,
3. nested sequential / concurrency-limited loops own their own `__waited__`,
4. nested unrestricted loops propagate upward into the enclosing waited scope,
5. composition boundaries (`include`, `import`, `extends`, `block`) emit one completion unit each.

Goal:

- ensure waited-channel semantics are deliberate and complete, not accidental.

Status:

- completed for the currently-implemented rule set

#### Step 6: Add focused regression tests

Add or update tests for:

1. sequential `while` and `each` gating,
2. `for ... of N` concurrency limiting,
3. nested limited-loop ownership,
4. nested unrestricted-loop propagation,
5. composition operations inside waited loops,
6. while-loop false-condition exit without `STOP_WHILE`,
7. poison/error-path behavior for waited iterations.

Goal:

- verify both success-path completion semantics and failure-path behavior.

### Concrete Cases To Keep Tested

The following cases are worth keeping explicitly covered, because they encode the intended root-expression rule and its exclusions:

1. **Template output root** inside `for ... of N` emits one WRC for the expression root plus the closure-anchor WRC.
2. **Aggregate root** inside `for ... of N` emits one WRC for the aggregate as a whole, not one per child expression.
3. **`set` root** inside `for ... of N` emits one WRC for the assigned expression root.
4. **`do` root** inside `for ... of N` emits one WRC for the called expression root.
5. **Script `var` root** inside `for ... of N` emits one WRC for the assigned expression root.
6. **`return` root** inside a waited-loop-owned body emits one WRC for the returned expression root.
7. **Async var-channel initializer root** emits one WRC when compiled inside a waited-loop-owned body.
8. **Condition expressions** for `if`, `while`, `for`, and `elif` do not emit WRCs.
9. **Iterator-driving expressions** such as loop source and `concurrentLimit` do not emit WRCs.
10. **Nested unlimited loops** propagate their root-expression WRCs upward into the enclosing waited scope.
11. **Nested sequential / limited loops** do not leak per-expression WRCs upward; they contribute one nested-loop completion unit to the parent.
12. **Composition boundaries** (`include`, `import`, `from import`, block invocation, `super`) emit one waited completion unit in waited-loop scope and none outside it.
13. **While false-exit path** returns `false` directly and must not depend on `STOP_WHILE`.
14. **While true path** waits for the child buffer's waited-channel `finalSnapshot()` before returning `true`.
15. **Poison / rejection paths** still poison the correct outputs and preserve else-body poisoning behavior.

### Remaining Cleanup

#### Step 7: Remove dead code and refresh docs

Status:

- completed

Completed cleanup:

1. obsolete deferred / `STOP_WHILE` loop-completion code was removed,
2. comments were aligned with the centralized `compileExpression(...)` root-WRC model,
3. root call sites were moved to `compileExpression(...)`; remaining direct `_compileExpression(...)` usage is limited to subexpressions and recursive/internal compilation,
4. this document was refreshed to describe the implemented model.

Ongoing maintenance:

1. keep the concrete regression matrix above in sync as new waited-loop cases are added.
