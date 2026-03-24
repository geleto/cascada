# Async Compilation Refactor: Sequential Commands & Control-Flow Buffers

## Overview

The historical compilation model wrapped far too many operations in async blocks, awaited things that did not need awaiting, and relied on closure-counting machinery (`astate`, `waitAllClosures`) to paper over timing problems in command emission. This document describes the target architecture, records the implementation progress so far, and captures the main lessons learned while migrating real compiler paths.

## Current Status

The refactor is now partially implemented, not just planned.

Implemented and validated:
- `runControlFlowBlock` / `runControlFlowBlockNode` are in use for async `if`, `switch`, and `for` lowering.
- `compileInclude`, `compileExtends`, `compileImport`, and `compileFromImport` now use the channels-refactor model: control-flow async stays inside `runControlFlowBlock`, while command emission is synchronous.
- Root/value work such as template output, `set`, `do`, `return`, script `var`, and var-channel initializers is emitted synchronously as commands whose arguments may be promises.
- Sequential and bounded loops no longer use `waitAllClosures(1)` as an iteration-completion fallback.
- Sequential and bounded loop completion is driven by the per-iteration `__waited__` channel, as described in [waited-loops.md](C:\Projects\cascada\docs\code\waited-loops.md).
- Async control-flow inside waited-loop bodies now uses a child-local waited channel, and the parent loop tracks that control-flow block as one waited unit.
- The old "closure anchor" `WaitResolveCommand` model in loop tests has been removed.
- `runControlFlowBlock` now owns child-buffer creation/linking directly; it no longer delegates to `astate.asyncBlock`.

Still transitional:
- `AsyncState` and root-level `waitAllClosures()` uses still exist outside the migrated paths.
- `_compileMacro` still relies on `astate.waitAllClosures()` to avoid finishing macro/caller buffers before nested composition linking has happened.
- Some migration notes below remain useful as history, but the completed items should be read as implemented behavior unless explicitly marked future work.

---

## Migration Strategy: Two Phases

### Phase 1 — Introduce `runControlFlowBlock`, migrate `compileXXX` methods one by one

The new `runControlFlowBlock` helper is added to the runtime. The original Phase 1 plan was to implement it on top of `astate.asyncBlock`, but the current code has already moved past that transitional shape: `runControlFlowBlock` now creates/links its child buffer itself while still using `AsyncState` for closure tracking and cleanup.

Each `compileXXX` method is then migrated independently:
- Replace `asyncBlockBegin` / `asyncBlockEnd` wrappers with `runControlFlowBlock` at control-flow sites only.
- Move all non-control-flow command emission outside the async block — commands are added synchronously to the current buffer.
- Remove `waitAllClosures` calls as each method is migrated.
- Tests pass after each migration because `runControlFlowBlock` preserves the existing closure-tracking/cleanup contract while moving command emission and control-flow ownership into the new helper.

### Phase 2 — Drop `astate.asyncBlock`

Once all `compileXXX` methods have been migrated and no call site emits `astate.asyncBlock` or `waitAllClosures` directly, the remaining `AsyncState` dependency can be removed:
- `AsyncState` and its closure-counting machinery are removed.
- The `astate` parameter disappears from generated function signatures.
- `runControlFlowBlock` can become a simpler helper with no `AsyncState` dependency.

---

---

## The Core Principle

**Commands are added to the current buffer synchronously in almost all cases.**

A command argument that is a promise (an unresolved async value) is perfectly fine — `resolveCommandArgumentsForApply` handles awaiting it when the BufferIterator applies the command. There is no need to await the value before adding the command.

A child `CommandBuffer` is only needed when an async value determines **which commands get added at all** — i.e., it controls the structure of the command stream, not just the content of one argument.

---

## Value Async vs. Control-Flow Async

### Value async — NO child buffer needed

The result is a promise that flows through as a command argument. Add the command immediately.

```js
// set x = fetchUser()  — x is a VarChannel
let t1 = fetchUser(); // may return a promise
parentBuffer.add(new VarCommand({ channelName: 'x', args: [t1], pos }), 'x');

// {{ asyncExpr }}
let t2 = computeExpr(); // may return a promise
parentBuffer.add(new TextCommand({ channelName: '__text__', args: [t2], pos }), '__text__');

// @data.items.push(asyncValue)
let t3 = fetchItem(); // may return a promise
parentBuffer.add(new DataCommand({ command: 'push', args: [['items'], t3], pos }), 'data');
```

All of these are added synchronously. `resolveCommandArgumentsForApply` in the channel awaits the promise when the command is applied.

### Control-flow async — child buffer IS needed

The value determines how many iterations run, which branch executes, or which template loads. The structure of commands depends on resolving the value.

| Construct | Why child buffer needed |
|---|---|
| `if`/`elif`/`else` with async condition | Branch selection unknown until resolved |
| `switch` with async discriminant | Case selection unknown |
| `for item in expr` with async `expr` | Iteration count and values unknown |
| `each item in expr` with async `expr` | Same |
| `while cond` with async `cond` | Loop continuation unknown |
| `include asyncPath` | Template identity unknown; loading is async |
| `extends asyncPath` | Same |
| `import asyncPath` | Same |
| Limited-concurrency loop bodies | `__waited__` timing coordination (unchanged) |

If the controlling expression is already synchronous (not async per `node.isAsync`), no child buffer is created — the body is emitted inline into the current buffer.

---

## Error and Poison Handling

Cascada does not throw. Errors are represented as:

- **`PoisonedValue`**: a thenable that always rejects; can be detected synchronously via `isPoison()` without awaiting.
- **Promises that reject with `PoisonError`**: caught when awaited.

When a control-flow value is poison or its promise rejects, the branches do not execute. Instead, all channels that would have been written by those branches receive `addPoison(...)`. This logic already exists in the current `compileIf` and related methods — it just currently lives inside larger `asyncBlock` wrappers that are being removed.

The pattern inside a control-flow async fn:

```js
async (childBuf) => {
  let cond = evaluateCondition(); // may be PoisonedValue or a promise

  if (isPoison(cond)) {
    childBuf.addPoison(cond.errors, '__text__');
    childBuf.addPoison(cond.errors, 'data');
    return; // helper's finally calls markFinishedAndPatchLinks
  }

  if (cond && typeof cond.then === 'function') {
    try {
      cond = await cond;
    } catch (err) {
      const errors = isPoisonError(err) ? err.errors : [err];
      childBuf.addPoison(errors, '__text__');
      childBuf.addPoison(errors, 'data');
      return;
    }
    if (isPoison(cond)) {
      childBuf.addPoison(cond.errors, '__text__');
      childBuf.addPoison(cond.errors, 'data');
      return;
    }
  }

  // cond is now a plain resolved value
  if (cond) {
    // add then-branch commands synchronously — args may be promises, no awaiting
    childBuf.add(new TextCommand({ args: [maybePromise], ... }), '__text__');
  } else {
    childBuf.add(new TextCommand({ args: [otherMaybePromise], ... }), '__text__');
  }
  // markFinishedAndPatchLinks called by helper's finally
}
```

The async fn never throws (Cascada semantics). The helper's `.finally()` is a safety net only.

---

## The New Helper: `runControlFlowBlock`

Replaces direct `AsyncState.asyncBlock` call sites at control-flow sites.

Important nuance learned during implementation:
- in Phase 1, the helper still delegates to `astate.asyncBlock`
- control-flow blocks inside waited-loop bodies must be treated as one waited completion unit
- branch-local root expressions inside those control-flow buffers must not try to add leaf waited markers back into an already-closing parent iteration buffer
- the working solution is for those control-flow child buffers to own their own waited channel inside waited-loop scope

```js
// runtime.js
function runControlFlowBlock(parentBuffer, usedChannels, frame, context, asyncFn, enableWaitApplied = false) {
  const childBuf = createCommandBuffer(context, null, frame, enableWaitApplied);
  for (const ch of usedChannels) {
    parentBuffer.addBuffer(childBuf, ch);
  }
  // Fire and forget — main flow resumes immediately
  // asyncFn handles all poison cases internally; finally is a safety net
  asyncFn(childBuf).finally(() => {
    childBuf.markFinishedAndPatchLinks();
  });
}
```

Target-architecture properties:
- The child buffer is linked to all parent channels **synchronously** before the async fn starts.
- The main code flow **does not wait** — it continues adding commands to `parentBuffer` immediately after this call.
- `markFinishedAndPatchLinks` is called in `.finally()` so it always fires even if there is a compiler bug in the async fn.
- `enableWaitApplied` is only `true` for limited-concurrency loop iterations (`__waited__` mechanism, unchanged).

---

## Generated Code Patterns

### `if asyncCond` — before and after

**Current:**
```js
astate.asyncBlock(async (astate, frame, currentBuffer) => {
  let cond = await resolveCond();
  if (cond) { /* body */ }
  else       { /* body */ }
}, runtime, frame, { usedChannels: ['__text__', 'data'] }, parentBuffer, true, cb);
// Main flow blocked — nothing can be added to parentBuffer until asyncBlock resolves
```

**New:**
```js
runtime.runControlFlowBlock(parentBuffer, ['__text__', 'data'], frame, context,
  async (childBuf) => {
    // poison/promise handling for cond (see pattern above)
    let cond = await resolveCond();
    if (cond) {
      childBuf.add(new TextCommand({ args: [v1], ... }), '__text__');
      childBuf.add(new DataCommand({ ... }), 'data');
    } else {
      childBuf.add(new TextCommand({ args: [v2], ... }), '__text__');
    }
  }
);
// Main flow continues immediately — add more commands to parentBuffer here
parentBuffer.add(nextCmd, '__text__');
```

### `if syncCond` — no child buffer

```js
if (cond) {
  parentBuffer.add(new TextCommand({ args: [v1], ... }), '__text__');
} else {
  parentBuffer.add(new TextCommand({ args: [v2], ... }), '__text__');
}
```

### `for item in asyncList`

```js
runtime.runControlFlowBlock(parentBuffer, ['__text__', 'data'], frame, context,
  async (childBuf) => {
    // poison/promise handling for list
    const list = await resolveList();
    for (const item of list) {
      // iteration commands added synchronously — item values may be promises
      childBuf.add(new DataCommand({ command: 'push', args: [['items'], transform(item)], ... }), 'data');
      // nested control-flow async in loop body: runControlFlowBlock(childBuf, ...)
    }
  }
);
```

### `include asyncTemplateName`

```js
runtime.runControlFlowBlock(parentBuffer, ['__text__', 'data'], frame, context,
  async (childBuf) => {
    const name = await resolveName();     // async: template name may be a promise
    const tmpl = await loadTemplate(name); // async: template loading
    tmpl.executeInto(childBuf, context);   // sync: adds commands (or nested child buffers)
  }
);
```

### `{{ asyncExpr }}` — no child buffer, just add synchronously

```js
let t1 = evaluateExpr(); // may return a promise — that is fine
parentBuffer.add(new TextCommand({ channelName: '__text__', args: [t1], pos }), '__text__');
```

---

## Nested Control Flow

Nested control-flow blocks (e.g., an `if` inside a `for` body) use `runControlFlowBlock` recursively with the outer child buffer as their parent.

One important refinement came out of the waited-loop migration:
- outside waited loops, nested control flow is just another child buffer
- inside a sequential or bounded loop iteration, an async control-flow block contributes **one waited unit as a block**
- in that waited scope, branch internals should not emit parent-level leaf `WaitResolveCommand`s directly
- instead, the control-flow child buffer owns its own waited channel, and the parent waits on that child waited channel's completion

Why:
- the iteration `__waited__` channel is intentionally flat
- nested control-flow buffers are not inserted into that `__waited__` lane
- if branch-local async roots try to write waited markers into the parent iteration buffer after the iteration buffer is closing, they can hit "Cannot add command to finished CommandBuffer"

So the implemented rule is:
- ordinary root expressions emit waited markers in their owning waited buffer
- nested async control-flow inside a waited iteration is tracked as one parent-visible waited unit via the child control-flow waited-channel completion promise

```js
runtime.runControlFlowBlock(parentBuffer, ['__text__'], frame, context,
  async (outerBuf) => {
    const list = await resolveList();
    for (const item of list) {
      // Inner if with async condition — creates child of outerBuf
      runtime.runControlFlowBlock(outerBuf, ['__text__'], frame, context,
        async (innerBuf) => {
          const cond = await resolveItemCond(item);
          if (cond) {
            innerBuf.add(new TextCommand({ args: [item.name], ... }), '__text__');
          }
        }
      );
      // More commands added to outerBuf synchronously after firing innerBuf
      outerBuf.add(new TextCommand({ args: [separator], ... }), '__text__');
    }
  }
);
```

The ordering guarantee is maintained: `innerBuf` is added to `outerBuf`'s arrays synchronously before `outerBuf` is marked finished. The BufferIterator descends into `innerBuf` when it reaches that entry, waits for it to finish, then continues with subsequent entries in `outerBuf`.

---

## `markFinishedAndPatchLinks` Timing

In the old model, marking a buffer finished required waiting for all child async blocks to complete (via `waitAllClosures`). In the new model:

- **Root buffer** (`output`): `markFinishedAndPatchLinks()` is called immediately after all top-level statements are compiled and executed — no waiting.
- **Control-flow child buffers**: `markFinishedAndPatchLinks()` is called by the helper's `.finally()` when the async fn completes.
- **Inline sync paths**: there is no child buffer; commands go directly into the parent, so there is nothing to finish.

The `finished` flag means "no more entries will be added to this buffer's arrays." The BufferIterator will still process all existing entries (including child buffers that are still running) before declaring a channel's stream exhausted.

Practical lesson from the loop migration:
- infrastructure commands that belong to an iteration itself must also be added before the buffer is allowed to finish
- loop variable bindings and loop metadata bindings therefore cannot be emitted through `asyncAddValueToBuffer` or similar late async helpers
- they must be added synchronously as ordinary commands, just like other value-async operations

---

## What Is Removed

| Component | Phase | Notes |
|---|---|---|
| `astate.asyncBlock(...)` calls in generated code | **Phase 1** — removed from call sites as each `compileXXX` is migrated; replaced by `runControlFlowBlock` |
| `astate.waitAllClosures(...)` | **Phase 1** — removed from sequential loop compilation during migration |
| `asyncBlockBegin` / `asyncBlockEnd` in `compile-emit.js` | **Phase 1** — call sites removed; the functions may remain until Phase 2 |
| `asyncBlockValue` in `compile-emit.js` | **Phase 1** — value assignment emits no async block; result may be a promise, that is fine |
| `asyncBlockRender` in `compile-emit.js` | **Phase 1** — becomes `runControlFlowBlock` only where template execution is genuinely async |
| `asyncAddToBuffer` / `asyncAddToBufferScoped` in `compile-buffer.js` | **Phase 1** — commands added synchronously; these helpers are no longer emitted |
| `asyncBlock` in `compile-emit.js` (the simple wrapper) | **Phase 1** — call sites removed during migration |
| `getAsyncBlockArgs` `asyncMeta` wrapper object | **Phase 1** — `usedChannels` array passed directly to `runControlFlowBlock` via `getLinkedChannelsArg` (extracted); `getAsyncBlockArgs` retained for remaining `asyncBlock` call sites |
| `AsyncState` class (`async-state.js`) | **Phase 2** — removed once no call site uses `astate.asyncBlock` directly |
| `runControlFlowBlock` internal `astate.asyncBlock` dependency | **Phase 2** — reimplemented as a simple fire-and-forget wrapper |
| `astate` parameter in generated function signatures | **Phase 2** — removed from all generated functions once `AsyncState` is gone |
| `cb` callback parameter in generated functions | **Phase 2** — review; may no longer be needed once `astate` error propagation is gone |

---

## What Is Unchanged

| Component | Status |
|---|---|
| `CommandBuffer` tree structure | Unchanged |
| `BufferIterator` per channel | Unchanged |
| All command classes (`TextCommand`, `DataCommand`, `VarCommand`, etc.) | Unchanged |
| `resolveCommandArgumentsForApply` | Unchanged — becomes more central as the primary place promises are awaited |
| `CompileAnalysis` and `_analysis` metadata | Unchanged — `node.isAsync`, `usedChannels`, `declaredChannels` still drive decisions |
| `propagateIsAsync` | Unchanged — `node.isAsync` is the gate for whether a control-flow site needs a child buffer |
| `__waited__` / `waitApplied` / `enableWaitApplied` | Concept unchanged — but the implementation now relies on waited-channel `finalSnapshot()` rather than closure-counting fallback for sequential / bounded loop completion |
| Sequential path commands (`SequentialPathWriteCommand`, etc.) | Unchanged — deferred-result chaining via iterator still correct |
| Poison system (`PoisonedValue`, `PoisonError`, `isPoison`, `isPoisonError`) | Unchanged |
| `channel._recordError` / `addPoison` error paths | Unchanged |
| `markFinishedAndPatchLinks` | Unchanged — called sooner and more directly |

---

## `node.isAsync` Continues to Gate Child Buffer Creation

The existing `propagateIsAsync` pass already marks nodes as async only when needed (symbols, lookups, function calls, template composition). This flag is the compile-time signal:

- `node.isAsync === false` → emit the control-flow body inline, no child buffer.
- `node.isAsync === true` → emit `runControlFlowBlock(...)`, await the control-flow value inside the async fn, add body commands synchronously.

No change to the analysis pass is required.

---

## `usedChannels` for Child Buffer Linking

`usedChannels` is still computed from `node._analysis.usedChannels` (filtered to exclude locally-declared channels, per `getAsyncBlockArgs` logic). It is passed directly to `runControlFlowBlock` so the helper knows which parent channel arrays to insert the child buffer into.

The `CompileAnalysis._finalizeOutputUsage` pass that computes these sets is unchanged.

---

## Phase 1: Intermediate `runControlFlowBlock` Implementation

During Phase 1 the helper wraps `astate.asyncBlock` so the existing closure-tracking and buffer-finishing machinery continues to work unchanged:

```js
// runtime.js — Phase 1 implementation (actual)
function runControlFlowBlock(astate, parentBuffer, usedChannels, f, context, cb, asyncFn, enableWaitApplied = false) {
  void context;
  const asyncMeta = { usedChannels: usedChannels || null };
  return astate.asyncBlock(asyncFn, module.exports, f, asyncMeta, parentBuffer, true, cb, enableWaitApplied);
}
```

`asyncFn` is passed **directly** to `astate.asyncBlock` as the `func` argument. `asyncBlock` calls `func(childState, childFrame, activeBuffer)` — which maps exactly to the generated async fn's `(astate, frame, currentBuffer)` parameters. No extra wrapper layer needed.

`astate.asyncBlock` handles:
- Creates the child `CommandBuffer` and links it to parent channels via `usedChannels`.
- Tracks closure counts so parent can `waitAllClosures` if anything still uses it.
- Calls `markFinishedAndPatchLinks` in cleanup.

Nothing else changes in the runtime during Phase 1.

### New compiler-side helpers added in Phase 1

#### `compile-emit.getLinkedChannelsArg(node, frame)`

Extracted from `getAsyncBlockArgs`. Returns the JSON array string for the channels to link — `'["__text__","data"]'` or `'null'`. Filters `node._analysis.usedChannels` the same way as `getAsyncBlockArgs` (excludes locally-declared channels and `__return__`; includes `currentWaitedChannelName` when inside a limited-loop). `getAsyncBlockArgs` now delegates to this.

Used by `runControlFlowBlockNode` so `runControlFlowBlock(astate, buf, <channelsArg>, ...)` gets the right array without wrapping it in `{ usedChannels: ... }`.

#### `compile-buffer.runControlFlowBlockNode(node, frame, emitFunc)`

Compiler-side analog of `asyncBufferNode` for control-flow nodes. For async nodes:
1. Emits `runtime.runControlFlowBlock(astate, ${parentBuf}, ${linkedChannels}, frame, context, cb, async (astate, frame, currentBuffer) => {`
2. Sets compile-time `this.currentBuffer = 'currentBuffer'` so all emits inside `emitFunc` write to the right buffer variable
3. Creates compile-time `blockFrame = frame.push(false, false)` with `trackCompileTimeFrameDepth`
4. Calls `emitFunc(blockFrame, 'currentBuffer', prevBuffer)`
5. In `finally`: decrements `asyncClosureDepth`, emits `}, false);`, validates frame balance, restores `currentBuffer`

For non-async nodes: passes through to `emitFunc(frame, ...)` directly (same as `asyncBufferNode` non-async path).

Key differences from `asyncBufferNode`:
- Sets `this.currentBuffer = 'currentBuffer'` directly instead of creating a tmpid alias (`let t1 = currentBuffer`). The alias was needed in `asyncBufferNode` because inner `asyncBlock` calls also declare a `currentBuffer` parameter — removing those inner blocks eliminates the shadowing problem.
- Does not accept `createScope`, `sequential`, `positionNode`, or concurrency-limit parameters — control-flow blocks always use `false, false` framing and `false` for `enableWaitApplied`.
- Emits `}, false);` (fixed `enableWaitApplied=false`) not the full `asyncBlockEnd` argument list.

### What the compiler emits in Phase 1

The compiler emits `runtime.runControlFlowBlock(...)` instead of a raw `astate.asyncBlock(...)` at control-flow sites. The critical difference is what goes **inside**: only the control-flow-determining await plus synchronous branch compilation — no nested `asyncBlock` calls for branches.

```js
// Phase 1 generated code for: if asyncCond { body } else { else_ }
runtime.runControlFlowBlock(astate, currentBuffer, ["__text__","data"], frame, context, cb,
  async (astate, frame, currentBuffer) => {
    try {
      const t1 = await resolveCond();

      if (t1) {
        frame = frame.push();
        // body commands added synchronously to currentBuffer
        frame = frame.pop();
      } else {
        frame = frame.push();
        // else_ commands added synchronously to currentBuffer
        frame = frame.pop();
      }
    } catch (e) {
      const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ...);
      currentBuffer.addPoison(contextualError, "__text__");
      currentBuffer.addPoison(contextualError, "data");
    }
    // markFinishedAndPatchLinks handled by astate.asyncBlock cleanup
  },
false);
// Main flow continues synchronously — add more commands to the outer currentBuffer here
```

Note: the async fn's `(astate, frame, currentBuffer)` parameters shadow the outer ones — `currentBuffer` inside is the child buffer, `astate` is the child state, `frame` is the child frame. `frame.push()`/`frame.pop()` handle branch scoping explicitly since the inner `asyncBlock` wrappers that previously managed this are gone.

Value operations that previously had their own `asyncBlock` are emitted outside any block:
```js
// Phase 1: {{ asyncExpr }} — no async block, no astate involvement
let t1 = evaluateExpr(); // may return a promise
currentBuffer.add(new TextCommand({ channelName: '__text__', args: [t1], pos }), '__text__');
```

### Removing `waitAllClosures` during Phase 1

`waitAllClosures` is emitted in `asyncBlockEnd` for sequential loop bodies:
```js
await astate.waitAllClosures(1);
```

As each loop `compileXXX` method is migrated, this line is removed. Sequential ordering is maintained by the order in which commands and child buffers are added to the parent buffer — but for sequential and bounded loops the actual iteration completion signal is the iteration child buffer's `__waited__` channel `finalSnapshot()`, not generic closure counting.

This turned out to matter for two cases:
- nested sequential / bounded loops must contribute one explicit parent waited unit
- async control-flow blocks inside waited-loop bodies must also contribute one explicit waited unit as a block

### Migration order (suggested)

Migrate from simplest to most complex to catch regressions early:
1. ✅ **`compileOutput`** — partially migrated: pure value expressions now add `TextCommand` synchronously; `caller()` expressions keep `asyncAddToBufferScoped` (see note below) (Tier 1)
2. ✅ **`compileAsyncVarSet` step 3 / `compileChannelDeclaration`** — `asyncAddValueToBuffer` calls inlined; VarCommands now added synchronously via `currentBuffer.add(new VarCommand(...))` (Tier 1)
3. ✅ **`compileDo`** — `asyncBlock` + `Promise.all` removed; expressions evaluated inline. `do` is now fire-and-forget for async side effects (consistent with "Implicitly Parallel" model). `emitOwnWaitedConcurrencyResolve` preserved for limited-loop `__waited__` timing (Tier 2, required `compileReturn` rewrite first)
4. ✅ **`compileReturn`** — `waitAllClosures` removed; return value added as `VarCommand` to return channel synchronously (completed in prior chat)
5. ✅ **`compileIf`** — `asyncBufferNode` + two inner `asyncBlock` branch wrappers replaced by `runControlFlowBlockNode`; branches now compile synchronously inside the outer async fn with explicit `frame.push()`/`frame.pop()` (Tier 3). Adds `runtime.runControlFlowBlock`, `compile-buffer.runControlFlowBlockNode`, `compile-emit.getLinkedChannelsArg`.
6. ✅ **`compileSwitch`** — same pattern as `compileIf`: `asyncBufferNode` + per-case `asyncBlock` wrappers replaced by `runControlFlowBlockNode` with case bodies compiled synchronously. `branchChannels` collection simplified: reads `c.body._analysis.usedChannels` directly (available before compilation, no need to collect inside async block callbacks) (Tier 3)
7. ✅ **`compileFor` (parallel)** — outer `asyncBufferNode` replaced by `runControlFlowBlockNode`; non-async scope handling emitted manually (Tier 4)
8. ✅ **`compileFor` (sequential / `each`)** — completed. `waitAllClosures(1)` was removed from sequential loop-body completion, but the final implementation required more than simply deleting the line:
   - loop value bindings and loop metadata bindings were changed to synchronous command emission
   - nested sequential / bounded loops now add one explicit parent waited unit via their `runtime.iterate(...)` promise
   - nested async control-flow blocks inside waited-loop bodies now add one explicit parent waited unit via their child control-flow waited-channel completion promise
   - compiler/codegen tests were updated from the old "closure anchor" model to the new waited-unit model
9. ✅ **Remove `WaitResolveCommand` for `var x = expr` and `set_path` in limited loops** — `emitOwnWaitedConcurrencyResolve` removed from `compileAsyncVarSet`. The VarCommand's promise arg is already awaited by the buffer iterator as it processes the iteration buffer's var channel — the `WaitResolveCommand` in `__waited__N` was doubly tracking the same promise. Only codegen tests needed updating; no runtime regressions.
11. ✅ **`compileWhile`** — effectively completed through the shared `compileFor`/`_compileFor` path used for async `while` lowering. Waited-loop completion, false-break handling, and nested waited ownership now follow the same model as other sequential loops.
12. ✅ **`compileInclude` / `compileExtends` / `compileImport`** — completed. These inheritance/composition paths now use `runControlFlowBlock` for their async control-flow work, while imported bindings and include text commands are enqueued synchronously. `ignore missing` composition now returns a real empty composition buffer so include composition can rely on the normal boundary/snapshot contract.
13. ◐ **`compileMacro`, `compileGuard`, `compileRoot`** — partially completed. `compileRoot` still uses `waitAllClosures()` for final handoff, and `compileGuard` still needs a dedicated cleanup pass. `_compileMacro` also still uses `astate.waitAllClosures()` today.
14. ◐ **Streamline `_compileMacro` / remove macro `waitAllClosures()`** — still pending. A direct removal experiment was not valid yet:
   - nested async imports in macro/caller composition failed with `Cannot add command to finished CommandBuffer`
   - caller sequencing tests stopped registering expected side-effect commands
   - the concrete failure path goes through `runtime.linkWithParentCompositionBuffer(...)`, which means nested composition is still trying to attach to the parent after the macro buffer has already been finished
   - simply switching macro return capture from pre-finish `addSnapshot(...)` to post-finish `finalSnapshot()` was also not valid yet: nested caller/import composition regressed because the macro return needs an earlier point-in-time capture until the structural completion boundary is redesigned
   - this step needs a structural completion boundary for macro/caller composition before the `waitAllClosures()` fallback can be removed

The `compileFor` migration also exposed an important diagnostic rule:
- if removing a `waitAllClosures` fallback causes "Cannot add command to finished CommandBuffer", that usually means some command is still being emitted too late, not that closure counting was fundamentally required

The `_compileMacro` experiment produced exactly that failure shape. In that case the late work is nested composition linking (`linkWithParentCompositionBuffer(...)`) from macro/caller text paths, so macro cleanup still needs a stronger structural completion signal before its local `waitAllClosures()` can go away.

After each migration, run the full test suite before proceeding.

---

## Per-Method Migration Analysis

### Tier 1 — Remove async wrapping, add commands synchronously

These methods currently use `asyncAddToBufferScoped`, `asyncAddToBuffer`, or `asyncAddValueToBuffer` purely to wrap value computation — not for any control-flow reason. The async wrapper is entirely unnecessary: the computed value may be a promise, and that is fine. The command is added synchronously with the (possibly promise) argument; `resolveCommandArgumentsForApply` handles awaiting at apply time.

---

#### `compileOutput` — `{{ expr }}` template output ✅ partially migrated

**Current:** Each non-literal child (every `{{ expr }}`) is wrapped in `asyncAddToBufferScoped`, which fires an `asyncBlock` per child. A `forceWrapRootExpression` flag forces expressions that internally add commands (like channel commands) into the async block to avoid out-of-order concurrent additions.

**Implemented:** Discriminate on `child._analysis?.mutatedChannels?.size > 0`:
- **Pure value expressions** (`{{ user.name }}`, `{{ getUser() }}`, regular macro calls, etc.): add `TextCommand` synchronously — no async block. The result may be a promise; `resolveCommandArgumentsForApply` handles it at apply time.
- **Channel-mutating expressions** (`{{ caller() }}` and sequential `!` calls): keep `asyncAddToBufferScoped` with `forceWrapRootExpression=true`.

Important clarification from the waited-loop work:
- `compileOutput` itself does not own a special waited marker
- pure text roots still follow the same root-expression rule as other statement roots
- in limited / sequential waited scope, `compileExpression(...)` emits the single root `WaitResolveCommand` for `{{ expr }}`
- so there is no separate "remove text-root WRCs" migration step distinct from the root-expression waited model

```js
if (child._analysis?.mutatedChannels?.size > 0 && !this.buffer.currentWaitedChannelName) {
  // caller() or !-call: keep async block (see note below)
  frame = this.buffer.asyncAddToBufferScoped(node, frame, child, ..., true, true,
    (innerFrame) => { this._compileExpression(child, innerFrame, true, child); }, ...);
} else {
  // Pure value: synchronous TextCommand
  const returnId = this._tmpid();
  this.emit.line(`let ${returnId};`);
  this.emit(`${returnId} = `);
  this._compileExpression(child, frame, false, child);
  this.emit.line(';');
  const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, child, true);
  this.emit.line(`${this.buffer.currentBuffer}.add(${textCmdExpr}, "${textChannelName}");`);
  this.buffer.emitOwnWaitedConcurrencyResolve(frame, returnId, child);
}
```

**Why `caller()` still needs the async block:** The caller body (compiled from `{% call %}...{% endcall %}`) calls `runtime.linkWithParentCompositionBuffer` synchronously at the start of its execution to insert its `CommandBuffer` into the parent's buffer tree. This must happen before `waitAllClosures()` fires and calls `markFinishedAndPatchLinks()` on the parent buffer (which would make it reject further `addBuffer` calls). The inner async block created by `asyncAddToBufferScoped` tracks the `caller()` call as an active closure, preventing `waitAllClosures()` from completing too early. Regular macro calls do NOT need this — they return a text snapshot as a plain value with no buffer linking.

**`_expressionAddsCommands` deleted.** This was the previous ad-hoc AST walk that detected `caller()` and `!` calls. It is now replaced by `child._analysis?.mutatedChannels?.size > 0`, which is correct after the analysis fixes below.

**`forceWrapRootExpression` deleted** from non-`caller()` path — it is no longer needed since commands are added synchronously.

**Prerequisite: analysis fixes required before this migration could be correct:**
- `analyzeFunCall` (compiler-base.js): added detection of `caller()` function calls (both direct `caller()` and path-rooted forms). These calls now produce `mutates: [textChannel]`, making them visible in `mutatedChannels`. Without this, `caller()` calls would fall through to the sync path and crash at runtime.
- `analyzeCallExtension` / `analyzeCallExtensionAsync` (compiler.js): new methods declaring `mutates: [textChannel]`. These statement-level extension tags use `asyncAddToBufferScoped` internally but had no analysis.
- `analyzeIfAsync` (compiler.js): new method delegating to `analyzeIf`, ensuring `IfAsync` branches get `createScope: true` set correctly.

---

#### `compileChannelDeclaration` — `var x = asyncExpr`

**Current:** For `var` channels with an initializer, `asyncAddValueToBuffer` wraps a `VarCommand` construction in an async block.

**New:** Evaluate the initializer expression (result may be a promise), construct and add the `VarCommand` synchronously.

```js
if (channelType === 'var' && node.initializer) {
  const t1 = this._compileExpression(initNode, frame, true, initNode);
  // emit synchronously:
  currentBuffer.add(new VarCommand({ channelName: name, args: [t1], pos }), name);
}
```

---

#### `compileAsyncVarSet` step 3 — var channel assignment

**Current:** Step 3 (emit channel command + export) wraps each `VarCommand` in `asyncAddValueToBuffer`.

**New:** Emit `VarCommand` synchronously with the already-computed `valueId` (which may be a promise).

```js
// Step 3: synchronous VarCommand emit
currentBuffer.add(
  new VarCommand({ channelName: name, args: [valueId], pos: { lineno: node.lineno, colno: node.colno } }),
  name
);
```

The `valueId` already holds the (possibly promise) result of step 2; no wrapping needed.

---

#### `compileDo` — side-effect expression evaluation

**Current:** Wraps all children in an `asyncBlock`, collects promises from expressions, and `await Promise.all(promises)` before the block exits.

**New:** Evaluate each expression directly. Results that are promises are fire-and-forget — any side effects they produce go through channels (which handle ordering) or are external (user's responsibility to sequence with `!`). No async block, no `Promise.all` wait.

```js
if (node.isAsync) {
  node.children.forEach(child => {
    this._compileExpression(child, frame, false);
    this.emit.line(';');
    this.buffer.emitOwnWaitedConcurrencyResolve(frame, resultVar, child); // __waited__ stays
  });
} else {
  // sync path unchanged
}
```

---

### Tier 2 — Eliminate `waitAllClosures`

#### `compileReturn` — script/macro return statement

**Current:** Emits `astate.waitAllClosures(N).then(async () => { ... })` before evaluating the return value. This waits for all outstanding async blocks in the current scope to finish before resolving the return.

**Why `waitAllClosures` is no longer needed:** In the new model, all commands are added synchronously or via self-contained control-flow child buffers. By the time execution reaches the `return` statement, every command has already been added to the buffer. The buffer's iterator is responsible for applying them in order; the script doesn't need to wait.

**New:** Evaluate the return value expression (result may be a promise), resolve it (it's the explicit return value the caller gets back, so it does need to be awaited), mark the buffer finished, return.

```js
// New compileReturn (root return)
const t1 = this._compileExpression(node.value, frame, true, node);
// await the actual return value — this is the one value the caller receives
const resolved = await runtime.resolveSingle(t1);
if (runtime.isPoison(resolved)) { throw new runtime.PoisonError(resolved.errors); }
currentBuffer.markFinishedAndPatchLinks();
cb(null, resolved);
```

For function/macro returns, the `waitAllClosures(N)` is also removed — same reasoning. The resolved value is awaited because it is what the caller receives; everything else is in the buffer.

---

### Tier 3 — Use `runControlFlowBlock` for condition, compile branches synchronously

#### `compileIf` — if / elif / else ✅ migrated

**Previous structure (3 `astate.asyncBlock` calls per `if`):**
1. `asyncBufferNode` wraps the entire `if` block → emits outer `astate.asyncBlock`.
2. Inside: await condition via `_compileAwaitedExpression`.
3. Two inner `asyncBlock` calls — one for the true branch body, one for the false branch body.
4. Catch block poisons all channels from both branches if condition fails.

The two inner `asyncBlock` calls for branches were purely for closure tracking and frame scoping. The branch bodies only add commands — they don't need async wrappers.

**New structure (1 `runControlFlowBlock` call per `if`):**
1. `runControlFlowBlockNode` emits `runtime.runControlFlowBlock(...)` (creates child buffer via `asyncBlock` internally in Phase 1).
2. Inside the async fn: await condition, detect poison via existing try/catch, then add branch commands **synchronously**.
3. Branch bodies call `compile(node.body, f)` which emits synchronous command additions. Nested async control-flow (e.g., nested `if`) recursively calls `runControlFlowBlock` with `currentBuffer` as parent.
4. Branch scoping handled with explicit `frame = frame.push(); ... frame = frame.pop();` in generated code — no inner async blocks to manage this implicitly.

**Implemented in** `compiler.js`: `asyncBufferNode` → `runControlFlowBlockNode`; the two inner `this.emit.asyncBlock(...)` calls removed; branch compilation inline with `frame.push()`/`frame.pop()`.

**Key insight from implementation:** `asyncBufferNode` used `let t1 = currentBuffer` (tmpid alias) so inner `asyncBlock` calls wouldn't shadow the outer `currentBuffer` parameter. Once the inner async blocks are removed, `currentBuffer` is unambiguous — `runControlFlowBlockNode` sets `this.buffer.currentBuffer = 'currentBuffer'` directly without any alias.

---

#### `compileSwitch` — switch / case ✅ migrated

Identical pattern to `compileIf`. One `runControlFlowBlock` for the discriminant; each case branch emits commands synchronously with `frame.push()`/`frame.pop()`. The per-case `asyncBlock` wrappers are deleted.

One simplification over `compileIf`: the old code collected `branchChannels` inside each `asyncBlock` callback (after `compile(c.body, f)`). Since `_analysis` is fully populated before compilation starts, `c.body._analysis.usedChannels` is readable at any point — `allChannels` is now computed directly after the switch block is emitted, without any per-branch collection structure.

---

### Tier 4 — Loops and template composition

#### `compileFor` (parallel) ✅ migrated

**Changed in** `compile-loop.js:_compileFor`: outer `asyncBufferNode(node, frame, createScope=true, sequential=false, sourcePositionNode, ...)` replaced by `runControlFlowBlockNode(node, frame, ...)`.

**Non-async scope handling**: `asyncBufferNode(createScope=true)` for non-async nodes emits `frame = frame.push(); ... frame = frame.pop()` to scope loop-variable bindings. `runControlFlowBlockNode`'s non-async path is a simple pass-through with no scope. The callback therefore emits the push/pop manually and does a compiler-level `blockFrame.push(false, true)` for the non-async case:

```js
let innerFrame = blockFrame;
if (!node.isAsync) {
  innerFrame = blockFrame.push(false, true);
  this.compiler.emit.line('frame = frame.push();');
}
// ... body using innerFrame instead of blockFrame ...
if (!node.isAsync) {
  this.compiler.emit.line('frame = frame.pop();');
  innerFrame.pop();
}
```

**Async nodes**: `runControlFlowBlockNode` already creates a compiler-level `frame.push(false, false)` and sets `this.currentBuffer = 'currentBuffer'`. For async loops (`useLoopValues = true`), loop variables use `VarCommand` channels, not `frame.set()`, so no runtime `frame.push()` is needed in the generated code.

**Inner loop body unchanged**: `_compileLoopBody` still uses `asyncBufferNode` for each iteration's async block. The `_compileLoopElse` also still uses `asyncBufferNode`. These are separate items (8 / future).

#### `compileFor` / `compileWhile` (parallel) — original plan note

The iterable/condition is the control-flow gate. The loop setup needs `runControlFlowBlock` if the iterable is async. Inside the async fn: resolve the iterable, then iterate — each iteration adds commands synchronously to `childBuf` (or creates its own child buffers for control-flow within the iteration body).

`waitAllClosures` currently used in sequential loop bodies is removed. The `__waited__` mechanism handles limited-concurrency coordination independently and is unchanged.

#### `compileInclude` / `compileExtends` / `compileImport` ✅ migrated

These paths are now on the same model as the other migrated control-flow sites:
- the async control-flow part stays inside one `runControlFlowBlock` async fn
- commands are added synchronously to the active buffer once the controlling value is known
- include/import composition/linking logic stays inside that async fn because it depends on the resolved template/export object

Important implementation details that came out of the migration:
- `compileInclude` now resolves the template, renders for composition, applies boundary aliases, prelinks the composed child buffer, and enqueues the parent `TextCommand` synchronously from inside the control-flow child buffer
- `compileExtends` now resolves the parent template and registers blocks inside `runControlFlowBlock`, rather than via `asyncBlockBegin` / `asyncBlockEnd`
- `compileImport` / `compileFromImport` now enqueue imported var bindings synchronously as `VarCommand`s whose args may be promises
- async `ignore missing` composition now returns a real empty command buffer with a `__text__` channel, so include composition can rely on `_setBoundaryAliases()` and `addSnapshot()` directly instead of using defensive duck-typing

---

### Tier 5 — Complex, defer

**`compileMacro`:** Still uses `waitAllClosures` internally, and that is currently required. A direct removal experiment failed in two concrete ways:
- nested async imports in macro/caller composition hit `Cannot add command to finished CommandBuffer`
- caller sequencing tests stopped registering expected side-effect commands

That means the remaining issue is not generic async expression timing inside the macro body. The unresolved case is late structural work from macro/caller composition, especially `linkWithParentCompositionBuffer(...)`. `waitAllClosures` here should be treated as a temporary guard until macro/caller composition returns a structural completion signal that can replace it.

**`compileGuard`:** Very complex — guard state snapshots, sequence repair, `CaptureGuardStateCommand`, `RestoreGuardStateCommand`. Migrate last after all simpler methods prove the pattern.

**`compileRoot`:** Root orchestration with manual async chains and `waitAllClosures`. Migrate last.

---

## Summary: What Changes in Each File

| File | Tier 1–2 changes | Tier 3–4 changes |
|---|---|---|
| `compiler.js` | Remove `asyncAddValueToBuffer` from `compileAsyncVarSet` step 3, `compileChannelDeclaration`; rewrite `compileDo`; rewrite `compileReturn` (remove `waitAllClosures`) | Rewrite `compileIf`, `compileSwitch` to use `runControlFlowBlock` |
| `compile-buffer.js` | Remove `asyncAddToBufferScoped` from `compileOutput`; emit `TextCommand` directly | Remove `asyncAddToBuffer`, `asyncAddToBufferScoped` helpers once all call sites gone |
| `compile-loop.js` | — | ✅ `_compileFor` outer wrapper → `runControlFlowBlockNode` (item 7); sequential body `waitAllClosures` removal pending (item 8) |
| `compile-inheritance.js` | — | ✅ Rewrite `compileInclude`, `compileExtends`, `compileImport` |
| `runtime.js` | ✅ Add `runControlFlowBlock` (Phase 1: wraps `astate.asyncBlock`) | — |
| `compile-buffer.js` | ✅ Add `runControlFlowBlockNode` (compiler-side wrapper; emits `runControlFlowBlock`, manages `currentBuffer`) | — |
| `compile-emit.js` | ✅ Extract `getLinkedChannelsArg` from `getAsyncBlockArgs`; `getAsyncBlockArgs` delegates to it | — |

---

## Scope of Changes

### Phase 1 changes

- **`src/runtime/runtime.js`**: Add `runControlFlowBlock` (Phase 1 implementation wrapping `astate.asyncBlock`). Export it.
- **`src/compiler/compiler.js`**: Migrate `compileIf`, `compileFor`, `compileSwitch`, `compileWhile` one by one — emit `runControlFlowBlock` at control-flow sites; emit commands synchronously everywhere else; remove `waitAllClosures`.
- **`src/compiler/compile-inheritance.js`**: ✅ `compileInclude`, `compileExtends`, `compileImport`, and `compileFromImport` migrated to the channels-refactor model.
- **`src/compiler/compile-buffer.js`**: Stop emitting `asyncAddToBuffer` / `asyncAddToBufferScoped`; command-adding paths become synchronous.
- **`src/compiler/compile-emit.js`**: Stop emitting `asyncBlockBegin` / `asyncBlockEnd` / `asyncBlockValue` / `asyncBlockRender` from migrated call sites. Functions may remain in place until Phase 2.

### Phase 2 changes (after all `compileXXX` methods are migrated)

- **`src/runtime/async-state.js`**: Remove `AsyncState` entirely.
- **`src/runtime/runtime.js`**: Reimplement `runControlFlowBlock` without `astate.asyncBlock`.
- **`src/compiler/compile-emit.js`**: Remove `asyncBlockBegin`, `asyncBlockEnd`, `asyncBlockValue`, `asyncBlockRender`, `asyncBlock`, `getAsyncBlockArgs`.
- **`src/compiler/compile-buffer.js`**: Remove `asyncAddToBuffer`, `asyncAddToBufferScoped`.
- **Generated function signatures**: Remove `astate` parameter and review `cb`.

### Never changes

`CommandBuffer`, `BufferIterator`, `Channel` subclasses, all command classes, `CompileAnalysis`, `CompileAsync`, `compile-sequential.js`, `compile-loop.js` (structure only), the poison system, and `resolveCommandArgumentsForApply`.
