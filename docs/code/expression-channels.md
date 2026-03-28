# Expression Channels: Ordering and Child Buffer Requirements

## Overview

Expressions in async mode can emit commands to the current buffer — not just return promise-valued results. This happens for:

- `!`-sequential path reads and writes (`db!.query()`, `obj!.prop`)
- `caller()` invocations (creates child buffer, adds `WaitResolveCommand` entries to `__caller__`)
- Sequenced channel calls and reads (`data.push(...)`, `data.snapshot()`)

This document analyses when these commands are emitted in the correct buffer order and when they are not.

---

## The Fundamental Mechanism: JS Argument Evaluation Order

`resolveDuo(leftExpr, rightExpr)` and `resolveAll([...exprs])` receive already-evaluated JS values. JavaScript evaluates function arguments left-to-right, synchronously, before calling the function. Any buffer side-effects (command additions) that happen during expression evaluation therefore occur in **source order**, before `resolveDuo`/`resolveAll` is called.

`collectErrors` inside `resolveDuo`/`resolveAll` uses a sequential `for...of` loop with `await` — not `Promise.all`. This means it awaits the first promise before starting the second. However, this does **not** determine execution order. The `BufferIterator` runs independently on the event loop and processes commands as they are added. `collectErrors` just waits for results; the iterator owns the actual execution sequencing.

### Expression types and their emission pattern

The table below covers every expression form compiled in async mode. The key question for each is: **does it emit buffer commands inside a `.then` callback, or only synchronously during argument evaluation?**

| Expression form | Generated pattern | Buffer commands emitted |
|---|---|---|
| `BinOp` (`+`, `*`, etc.) | `resolveDuo(left, right).then(([l,r]) => l OP r)` | Synchronously, as JS args to `resolveDuo` |
| `BinFunc` (`in`, `is`) | `resolveDuo(left, right).then(([l,r]) => f(l,r))` | Synchronously, as JS args |
| `UnaryOp` (`not`, `-`) | `resolveSingle(target).then(t => OP t)` | Synchronously, as JS arg |
| `LookupVal` (standard) | `runtime.memberLookupAsync(target, key, ctx)` | Synchronously (no commands; pure value call) |
| `LookupVal` (`!`-path) | `runtime.sequentialMemberLookupAsyncValue(frame, target, key, pathKey, ..., currentBuffer)` | Synchronously; adds `SequentialPathReadCommand` |
| `Symbol` (var channel) | `currentBuffer.addSnapshot(name, ...)` | Synchronously; adds `SnapshotCommand` (observable) |
| `FunCall` (`!`-path) | `runtime.sequentialCallWrapValue(func, ..., currentBuffer)` | Synchronously; adds `SequentialPathWriteCommand` |
| `FunCall` (direct macro) | `runtime.invokeMacro(name, context, args, currentBuffer)` | Synchronously; macro creates its own child buffer |
| `FunCall` (dynamic/runtime) | `resolveAll([func, ...args]).then(r => runtime.callWrapAsync(r[0], ..., currentBuffer))` | **Inside `.then`**: `callWrapAsync` is called after args resolve |
| `FunCall` (sequence channel) | synchronous IIFE calling `currentBuffer.addSequenceCall(...)` | Synchronously; adds `SequenceCallCommand` |
| `Filter` | `resolveDuo/resolveAll([filterFn, ...args]).then(r => r[0].call(ctx, ...r.slice(1)))` | Synchronously, as JS args; `.then` only calls the filter — no buffer commands |
| `FilterAsync` | Statement: `let symbol = resolveAll([...args]).then(r => filterFn(...r));` | Lifted out of expression context entirely (see below) |
| `Is` (`is error`) | `currentBuffer.addIsError(channel, ...)` | Synchronously; adds `IsErrorCommand` (observable) |
| `Is` (general test) | `resolveAll([left, ...args]).then(async r => testFn(r[0], ...))` | Synchronously, as JS args; `.then` only calls the test |
| `PeekError` (`#`) — general | `runtime.peekError(target)` | Synchronously, as JS arg; no buffer commands |
| `PeekError` (`#`) — script channel | `currentBuffer.addGetError(channelName, ...)` | Synchronously; adds `GetErrorCommand` (observable) |
| **`InlineIf` (ternary)** | `resolveSingle(cond).then(async cond => { if(cond) return body; else return else_; })` | **Inside `.then`**: branch bodies evaluated after condition resolves |
| **`Or` / `And`** | `resolveSingle(left).then(async left => { if(check) return left; return right; })` | **Inside `.then`**: right operand evaluated after left resolves |

#### `FilterAsync` — the intermediate variable pattern

`FilterAsync` (callback-style async filter, `| asyncFilter`) is compiled as a **statement-level assignment** rather than an inline expression:

```js
let t1 = resolveAll([arg1, arg2]).then(function(result) {
  return env.getFilter("asyncFilter").bind(env)(...result);
});
```

`t1` is now a local variable holding a promise. When `t1` is later referenced in a larger expression, it appears as a plain JS variable reference — no buffer side effects at that point. The async computation is fully lifted out of any expression context. This is safe regardless of what surrounds it.

#### `PeekError` (`#`) — the peek error operator

`expr#` is a postfix operator that inspects a value's error state **without triggering the poison system**. It returns the `PoisonError` if the value is poisoned or its promise rejects, or `null` if the value is healthy. The optional shorthand `expr#message` is syntactic sugar for `(expr#).message` — the parser wraps the `PeekError` node in a `LookupVal` when a symbol immediately follows.

Two compilation paths:

- **General case**: `runtime.peekError(target)` — `target` is a synchronous JS argument. The runtime checks synchronously (`isPoison`) or via `.then`/`.catch` if it is a promise. No buffer commands.
- **Script mode, declared channel target** (via `_getObservedChannelName`): emits `currentBuffer.addGetError(channelName, ...)` synchronously, adding a `GetErrorCommand` (observable) to the buffer. The command resolves with the current channel error or `null`.

Both paths emit any buffer side-effects synchronously — `peekError` behaves like any other unary operator with respect to ordering.

#### Dynamic `FunCall` — the deferred `callWrapAsync` case

For calls where the function is resolved at runtime (`resolveAll([func, ...args]).then(r => callWrapAsync(r[0], ..., currentBuffer))`), `callWrapAsync` is invoked inside the `.then` callback with `currentBuffer` passed in. For regular (non-macro) functions this just calls the function — no buffer commands. For dynamically-dispatched macro calls that happen to reach `invokeMacro`, the macro's child buffer creation happens asynchronously, after sibling operands' commands are already in the parent buffer.

This is not just a side note. It is the same structural problem class as the legacy `asyncBlockValue(...)` wrapper:

- the current boundary has already been established
- but the actual command-emitting macro/caller dispatch is deferred into a `.then(...)`
- so buffer creation and command registration happen too late relative to the owning boundary's finish lifecycle

This is exactly the shape that still shows up in nested `caller()` / call-block failures after the `asyncBlockValue(...)` layer is removed.

---

## Command Emission: Working Cases

### `!`-Sequential Paths

The compiler emits `runtime.sequentialCallWrapValue(func, ..., currentBuffer)` as a JS expression argument. This immediately calls `currentBuffer.addSequentialPathWrite(pathKey, operation, pos, repair)`, which:
- Adds a `SequentialPathWriteCommand` to the buffer synchronously
- Captures `func` and `args` in the `operation` closure — does **not** execute them
- Returns `cmd.promise` (the deferred result)

`SequentialPathWriteCommand` is **mutable** (`isObservable = false`). The `BufferIterator` applies mutable commands one at a time via `_applyMutable`, and suspends `_advanceLoop` when `apply()` returns a promise. The actual call (`callWrapAsync(func, ...)`) happens only inside `apply()` when the iterator reaches the command.

Since JS evaluates arguments left-to-right, two `!`-calls in the same expression have their commands in the buffer in source order, and the iterator applies them serially.

**Correctly ordered.**

### `caller()` Writes to `__caller__`

The compiled `caller()` invocation is a synchronous JS function call that:
1. Creates `invocationBuffer` synchronously, linked to `allCallersBuffer`
2. Adds `WaitResolveCommand` (tracking `invocationFinished` promise) to `bufferId.__caller__`
3. Fires `invokeMacro(...)` — stores the result promise
4. Adds a second `WaitResolveCommand` (tracking `invocationResult` promise) to `bufferId.__caller__`
5. Returns `invocationResult`

Both `WaitResolveCommand` entries are added synchronously. `WaitResolveCommand` is mutable (`isObservable` is intentionally `false`). Multiple `caller()` calls in the same expression have all their `WaitResolveCommand` entries in the buffer in source order, and the `__caller__` channel's iterator serializes them.

**Correctly ordered.**

This conclusion depends on one important precondition:

- the generated expression must reach the actual `caller()` invocation synchronously in the current boundary buffer

If the `caller()` expression is wrapped in a legacy async expression helper such as `asyncBlockValue(...)`, the caller setup and `__caller__` entries are no longer emitted synchronously in that boundary. In that case the safety argument above no longer holds, even without ternary / `and` / `or`.

### Sequenced Channel Calls and Reads

`_compileSequenceChannelFunCall` calls `_compileAggregate` with `resolveItems=false`, which always generates a synchronous IIFE regardless of whether args are async:

```js
(function(t1) {
  return currentBuffer.addSequenceCall("data", "push", [], t1, pos);
})([arg1, arg2])
```

`SequenceCallCommand` is mutable (`isObservable = false`). `SequenceGetCommand` (reads, snapshots) is observable (`isObservable = true`) — the iterator fires it immediately and adds it to `_pendingObservables`. A subsequent mutable command on the same channel waits for all pending observables via `Promise.allSettled`, so read-before-write ordering is also maintained.

Args may be promises; `resolveCommandArgumentsForApply` awaits them before `apply()` is called.

**Correctly ordered.**

---

## The Shared Reason All Three Work

| Step | What happens |
|---|---|
| JS argument evaluation | Command added to buffer **synchronously**; operation/closure captured, not executed |
| `resolveDuo` / `resolveAll` receives promises | Already in buffer in source order |
| Iterator applies mutable commands | Serialized — suspends `_advanceLoop` when `apply()` returns a promise |
| `resolveCommandArgumentsForApply` | Awaits promise args before `apply()` is called |
| `collectErrors` awaits promises | Waits for results only; execution order owned by iterator |

The sequential guarantee comes from two properties:
1. **Emission order = source order** — JS evaluates arguments left-to-right synchronously
2. **Mutable commands are serialized** — the iterator suspends on each async apply result before advancing

---

## The Failing Cases: Control-Flow Sub-Expressions

Control-flow expressions — `InlineIf` (ternary `a if cond else b`), `Or` (`a or b`), `And` (`a and b`) — defer branch body evaluation into `.then()` callbacks that fire **asynchronously** after a condition resolves. When such an expression appears as a sub-expression alongside other operands, those sibling operands are evaluated synchronously, adding their commands to the buffer **before** the branch body's commands. This violates source order.

### `InlineIf` (Ternary)

`compileInlineIf` currently generates:

```js
runtime.resolveSingle(asyncCond).then(async function(cond) {
  if (cond) {
    return bodyExpr;   // ← any commands emitted here fire after sibling ops
  } else {
    return elseExpr;   // ← same
  }
})
```

This promise is passed as one argument to a surrounding `resolveDuo` or `resolveAll`. The other arguments to that outer call are evaluated **synchronously at call time**, before the `.then` callback ever fires.

**Concrete example:** `(asyncCond ? a!.method() : b!.method()) + c!.method()`

```js
runtime.resolveDuo(
  // Left: ternary — branch command emitted inside .then (ASYNC)
  runtime.resolveSingle(asyncCond).then(async function(cond) {
    if (cond) return runtime.sequentialCallWrapValue(a, 'method', ..., currentBuffer);
    else       return runtime.sequentialCallWrapValue(b, 'method', ..., currentBuffer);
  }),
  // Right: evaluated synchronously NOW, before .then fires
  runtime.sequentialCallWrapValue(c, 'method', ..., currentBuffer)  // ← cmd_c added here
)
```

Buffer state when `resolveDuo` is called:

```
channel['!c!method']: [WriteCmd_c]    ← already present
```

When the `.then` fires (asynchronously, after `asyncCond` resolves):

```
channel['!a!method'] or ['!b!method']: [WriteCmd_branch]  ← added after c
```

**Source order**: ternary branch first, `c!.method()` second.
**Buffer order**: `c!.method()` first, ternary branch second.

The iterator applies `c!.method()` before the ternary branch result. For `!`-sequential paths, this is a semantic error — a later source operation executes before an earlier one. For sequenced channels, the mutation order is wrong.

The same failure applies to `SequenceCallCommand` entries, `WaitResolveCommand` entries from `caller()`, and any other command-emitting expression inside a ternary branch.

### `Or` and `And` (Short-Circuit)

`_compileBinOpShortCircuit` generates:

```js
runtime.resolveSingle(left).then(async function(left) {
  if (isOr ? left : !left) {
    return left;
  } else {
    return rightExpr;  // ← commands in rightExpr emitted ASYNC, inside .then
  }
})
```

The right operand is only evaluated inside the `.then`. If the right operand contains command-emitting expressions, those commands are emitted asynchronously — after the `.then` fires. Any synchronous sibling operand in the surrounding expression has its commands in the buffer first.

**Example:** `(a or db!.fallback()) + c!.operation()`

- `c!.operation()` adds its write command synchronously (second arg to outer `resolveDuo`)
- `db!.fallback()` adds its write command only if `a` is falsy, inside the `.then`

Even if `a` is synchronously falsy (resolves immediately), the `.then` fires as a microtask — after the current synchronous evaluation completes. `c!.operation()`'s command is already in the buffer before `db!.fallback()`'s command is added.

### `wrapInAsyncBlock` — Legacy Code, To Be Removed

The `wrapInAsyncBlock` flag is set on AST nodes by `compile-sequential.js`'s `_assignAsyncWrappersAndReleases`. When `compile()` sees the flag it wraps the node in `emit.asyncBlockValue(...)`, which generates an `astate.asyncBlock(async (astate, frame, currentBuffer) => { ... })` wrapper — the legacy mechanism that `channels-refactor.md` is explicitly removing.

`_assignAsyncWrappersAndReleases` sets the flag on:
- `InlineIf` branch bodies and `Or`/`And` right operands that participate in sequenced paths
- `LookupVal` nodes whose target relies on a sequenced symbol
- `FunCall` nodes whose callee path is sequence-locked
- Other nodes participating in sequence-path coordination without contention

**This mechanism no longer does what was intended and should be removed entirely.** For the non-control-flow cases (`LookupVal`, `FunCall`), commands are already emitted synchronously and the iterator handles ordering — the `astate.asyncBlock` wrapper was never needed in the new model. For the control-flow cases (`InlineIf` branches, `Or`/`And` right operand), the wrapper is checked in `compileInlineIf` and `_compileBinOpShortCircuit` to nest an `asyncBlockValue` inside the already-deferred `.then` callback — this does not fix the root ordering problem (the branch is still deferred relative to sibling operands in the outer expression) and simply adds an extra layer of the legacy mechanism on top of the broken pattern.

It is also not just redundant overhead. For command-emitting expressions such as `caller()`, `asyncBlockValue(...)` can let command/channel writes happen after the enclosing boundary buffer has already reached `markFinishedAndPatchLinks()`. That makes it a structural correctness bug, not just an optimization target.

The correct fix for all these cases is the child buffer approach described below, which makes `wrapInAsyncBlock` and `_assignAsyncWrappersAndReleases` entirely redundant.

---

## The Required Fix

Control-flow sub-expressions that may emit commands need the same treatment as control-flow statements: a **child `CommandBuffer`** whose slot is reserved in the parent channel array **synchronously**, before any sibling operands are evaluated.

The pattern is analogous to `runControlFlowBoundary` for statements:

1. A child buffer is created and linked into the parent's channel arrays synchronously — reserving positional slots
2. The async fn awaits the condition and emits branch body commands into the child buffer
3. Sibling operands evaluated after the control-flow sub-expression emit their commands into the parent buffer, after the already-reserved child buffer slot
4. The `BufferIterator` descends into the child buffer before advancing past it, maintaining source order

The child buffer approach also resolves the poison propagation case: if the condition itself is poison or rejects, the child buffer receives `addPoison(...)` for all affected channels instead of emitting branch commands — exactly as `runControlFlowBoundary` does for `if`/`for`/`switch`.

Before this control-flow rewrite, two prerequisite cleanups are needed:

- remove legacy `wrapInAsyncBlock` / `asyncBlockValue(...)` wrapping from command-emitting non-control-flow expressions
- remove deferred macro/caller dispatch through `.then(... callWrapAsync(...))` for command-emitting non-control-flow expression paths

Those expressions are only safe under the "synchronous command emission during JS argument evaluation" argument if they actually emit in the current boundary synchronously. The legacy wrapper and deferred `.then(... callWrapAsync(...))` dispatch both break that assumption.

### Scope of the Fix

The fix applies only to:
- `compileInlineIf` — when `node.isAsync` and the expression appears in a context with sibling command-emitting operands
- `_compileBinOpShortCircuit` (`compileOr`, `compileAnd`) — right operand, same condition

**Not affected:** all non-control-flow expression forms (`BinOp`, `FunCall` arguments, `Filter`, `LookupVal`, unary ops). These evaluate all operands synchronously as JS arguments, so commands are always emitted in source order without any child buffer.

### What `usedChannels` the Child Buffer Must Cover

The child buffer must be linked into every channel that the branch bodies can write to:
- The sequential path channels (`!`-keys) touched by `!`-calls in either branch
- The `__caller__` channel if `caller()` appears in either branch
- The sequence channels (`data`, `text`, named sequence channels) if sequence calls appear in either branch

This is the same `node._analysis.usedChannels` (minus locally-declared channels) already computed by the analysis pass — the same set used by `runControlFlowBoundary` for statement-level control flow.

Current status:
- async `compileInlineIf` now uses a control-flow child buffer when the expression mutates channels
- async `_compileBinOpShortCircuit` (`and` / `or`) now does the same
- root command-emitting `do` expressions now lower through a structural child buffer boundary instead of relying on caller-local wait hacks
- sequence-expression metadata is now computed in analysis; compiler-side `processExpression(...)` no longer drives legacy wrapper assignment
- pure value-only async cases still stay on the lighter `.then(...)` path for now

---

## Implementation Plan

1. Remove legacy async expression wrapping from command-emitting non-control-flow expressions.
   - Stop relying on `wrapInAsyncBlock` / `emit.asyncBlockValue(...)` for cases that are already safe under synchronous JS argument evaluation.
   - In particular, make sure command-emitting expressions such as `caller()`, sequence-path operations, and sequence-channel operations are reached synchronously in the current boundary.

2. Remove deferred macro/caller dispatch from non-control-flow expression paths.
   - Do not route command-emitting macro/caller dispatch through `resolve...().then(... callWrapAsync(...))`.
   - If the callee path can resolve to a macro/caller boundary, the structural dispatch must happen synchronously in the current boundary with raw promise-valued arguments, not in a later `.then(...)`.
   - Macro arguments themselves must remain unresolved on that path. Only ordinary non-macro function-call consumption should resolve argument values.
   - Immediate target: the dynamic `compileFunCall(...)` lowering in `compiler-base.js`.
   - Keep the command-emitting call dispatch helper next to the owning boundary implementation. The current `caller()` fix uses a caller-specific helper in `compile-macro.js` to compile raw args once, emit direct caller-boundary dispatch in the current buffer, and keep a normal `callWrapAsync(...)` fallback when no caller block exists.
   - Direct `caller()` dispatch is now in place for both template and script call-block paths. The remaining work in this area is to keep other command-emitting dynamic call paths on the same immediate-dispatch model without regressing raw macro-argument semantics.
   - Treat other expression `.then(...)` sites such as arithmetic/unary operators, `is` tests, and aggregate resolution as value-only for now. They may still need cleanup later, but they are not the current boundary-ordering blocker unless they start dispatching command-emitting operations.

3. Delete `_assignAsyncWrappersAndReleases` in `compile-sequential.js`.
   - The current wrapper-assignment pass should no longer force async expression wrapping for `LookupVal`, `FunCall`, or similar command-emitting forms.
   - The control-flow expression rewrite should replace this mechanism rather than coexist with it.
   - ✅ Legacy wrapper assignment is gone. The remaining useful sequence facts now come from analysis metadata instead of compiler-time `processExpression(...)` calls.

4. Audit `_compileExpression(..., forceWrap)` call sites.
   - Remove forced expression wrapping where the enclosing statement/boundary already provides the required structure.
   - In particular, ensure boundary helpers such as structural text output / capture do not launch nested command-emitting expression work through `asyncBlockValue(...)` without a child buffer.
   - Include root expression statements (`compileDo`, expression-valued statement positions, and similar sites) in this audit. These currently still rely on `asyncBlockValue(...)` / `wrapInAsyncBlock` semantics for some command-emitting async work, especially sequence side-effect calls.
   - Prioritize the `compileTextBoundary(...)` / `compileCaptureBoundary(...)` call chains, since those are the currently reproduced macro/caller boundary failures.

4a. Rewrite root command-emitting expression statements to own their structure directly.
   - `compileDo` should not depend on legacy expression wrappers or caller-local completion hacks.
   - If a root async expression statement emits commands, its structural child-buffer ownership must come from the normal expression / statement lowering path, not from `astate.waitAllClosures()` or an ad hoc local `__waited__` replacement.
   - Sequence side-effect calls (`path!.method(...)`, `path.method!(...)`) are the key regression probe here: removing `wrapInAsyncBlock` must still preserve their completion and ordering both in ordinary templates and inside caller bodies.
   - ✅ `compileDo` now uses a real structural child boundary for command-emitting async statement roots. The boundary is linked into the enclosing text stream so source-order traversal cannot step past async side effects, and awaited statement results suppress only expected `PoisonError`-style completion failures.

5. Rewrite `compileInlineIf`.
   - Replace the current `.then(...)` branch evaluation model with a child-buffer structural boundary when either branch may emit commands.
   - Keep the simpler value-only path for pure non-command-emitting branches.
   - ✅ Command-emitting async ternary/inline-if paths now use a control-flow child buffer.

6. Rewrite `_compileBinOpShortCircuit` (`compileOr` / `compileAnd`).
   - Use the same child-buffer boundary approach for a command-emitting right operand.
   - Keep the existing simple value-only path when the right operand cannot emit commands.
   - ✅ Command-emitting async `and` / `or` paths now use a control-flow child buffer.

7. Audit consumption sites to prefer resolve helpers over raw `await`.
   - When a value is being consumed as a Cascada value, use `resolveSingle(...)`, `resolveDuo(...)`, or `resolveAll(...)` rather than ad hoc `await`.
   - This preserves `RESOLVE_MARKER` behavior for lazy arrays/objects and keeps poison/value normalization centralized.
   - Include container-level consumption cases such as promised or `RESOLVE_MARKER`-backed argument arrays/objects, not just plain scalar values.
   - Keep macro invocation as the exception: macro arguments should stay raw, while ordinary function-call consumption can use the resolve helpers on argument values.
   - Reserve raw `await` for non-Cascada control values or helper-internal mechanics that are not consuming ordinary language values.

7. Preserve and reuse existing analysis.
   - Use `node._analysis.usedChannels` (filtered as usual) to determine which parent channels the child expression boundary must be linked into.
   - Do not introduce expression-specific runtime channel/linking rules if the existing analysis already provides the required structural information.

8. Remove obsolete legacy helpers once the new paths are in place.
   - Remove remaining `wrapInAsyncBlock` checks and dead `asyncBlockValue(...)` call sites that were only serving the old expression-ordering workaround.
   - Keep any still-needed value-only async helper only if it does not defer command emission past the owning boundary.
   - The intended end state is that command-emitting expression roots no longer depend on either `wrapInAsyncBlock` or `asyncBlockValue(...)`; if one of them is still needed during the transition, treat it as temporary technical debt and keep it documented by call site.
   - Current baseline: root command-emitting statement positions no longer need the legacy wrapper path. The remaining documented debt is in generic recursive expression compilation and any value-only helper that still exists outside structural boundaries.

9. Verify with both ordering and boundary-timing regressions.
   - Control-flow expression ordering:
     - ternary with `!` operations
     - `or` / `and` with command-emitting right side
     - sequence-channel operations inside those expressions
   - Boundary timing:
     - `caller()` inside expression output paths
     - nested caller/call-block dispatch reached through imported-callable async boundaries
     - macro/caller composition cases that previously relied on `waitAllClosures()`
     - command-emitting `do` / root expression statements with sequence side effects
     - any case where a deferred expression could add commands after an enclosing buffer called `markFinishedAndPatchLinks()`
