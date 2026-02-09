# Snapshot Implementation Plan

**Status:** Reference architecture document. Keep updated as implementation progresses.

## Table of Contents

- [1. Overview](#1-overview)
- [2. Terminology](#2-terminology)
- [3. Architecture](#3-architecture)
  - [3.1 Data Structures](#31-data-structures)
  - [3.2 Chain Construction](#32-chain-construction)
  - [3.3 Resolution Mechanism](#33-resolution-mechanism)
  - [3.4 Snapshot Mechanism](#34-snapshot-mechanism)
  - [3.5 Copy-on-Write Optimization](#35-copy-on-write-optimization)
  - [3.6 Error Handling](#36-error-handling)
  - [3.7 Scope Boundaries and Output Isolation](#37-scope-boundaries-and-output-isolation)
  - [3.8 Template Mode](#38-template-mode)
- [4. Current Implementation State](#4-current-implementation-state)
- [5. Phased Implementation Plan](#5-phased-implementation-plan)
- [6. Test Strategy](#6-test-strategy)
- [7. Future Considerations](#7-future-considerations)

---

## 1. Overview

This document specifies the incremental snapshot architecture for Cascada's output system. It replaces the current "collect-then-flatten" model (where all commands are replayed in a single pass when `snapshot()` is called) with an incremental resolution model where commands apply their effects as they become ready.

### Current Model (collect-then-flatten)

1. Script/template code enqueues commands into `CommandBuffer.arrays[outputName]`.
2. `Output.snapshot()` calls `flattenBuffer()`, which walks the buffer tree recursively.
3. For each `Command`, calls `command.apply(output)` to mutate the output's accumulator (type-specific: `_target` for text/value, `DataHandler.data` via `_base` for data).
4. Returns `output.getCurrentResult()`.

### Target Model (incremental resolution)

1. Script/template code enqueues commands into `CommandBuffer.arrays[outputName]`.
2. Each command is linked into a per-output chain via `.next` pointers (already implemented).
3. When a command is **chained** (linked into the chain) AND its predecessor is **resolved** (has finished applying), the command's `apply()` is called immediately.
4. `Output.snapshot()` inserts a `SnapshotCommand` into the chain and returns its promise. When resolution reaches the `SnapshotCommand`, the promise resolves with the current accumulator state (via `getCurrentResult()`).
5. Copy-on-write ensures that resolved snapshots are not mutated by subsequent commands.

### Key Benefits

- **Point-in-time snapshots**: Each `snapshot()` captures the state at its position in the command stream, enabling the currently-skipped tests for multiple snapshots.
- **Incremental processing**: Commands apply as they're ready rather than in a deferred batch.
- **Sync fast path**: When all preceding commands are already resolved, a snapshot returns a value immediately without creating a Promise.
- **Foundation for future features**: Early return, streaming output, and fine-grained error recovery.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Chained** | A command is chained when the previous command's `.next` points to it, or it is the first command in its buffer (no predecessor needed). Note: the first command in a **child** buffer is also immediately chained — it resolves independently of the parent chain. |
| **Resolved** | A command is resolved when its `apply()` has completed — returned (if sync) or its returned promise has settled (if async). |
| **Ready** | A command is ready when it is both **chained** AND its predecessor is **resolved**. A ready command can have `apply()` called. The first command in any buffer is immediately ready (no predecessor). |
| **Output** | The runtime object (`TextOutput`, `DataOutput`, `ValueOutput`, `SinkOutputHandler`) that is passed to `command.apply()` as the dispatch context. Holds the accumulator state that commands mutate. |
| **Accumulator** | The live state that commands mutate via `apply()`. This is **output-type-specific**: for text, it is `Output._target` (array of fragments); for value, it is `Output._target` (the current value); for data, it is `DataHandler.data` (accessed via `Output._base`); for sink, the sink instance manages its own state via `Output._sink`. |
| **`_target`** | A property on the Output object. For `TextOutput`: `[]` (array of fragments, the actual accumulator). For `ValueOutput`: the current value (the actual accumulator). For `DataOutput`: `{}` (unused by commands — see `_base`). |
| **`_base`** | Handler instance on the Output. For `DataOutput`: a `DataHandler` instance whose internal `this.data` object is the real accumulator — `DataCommand.apply()` calls methods on `_base` which mutate `DataHandler.data`. `getCurrentResult()` returns `_base.getReturnValue()` which returns `DataHandler.data`. Sink outputs use `_sink` instead. |
| **CommandBuffer** | Container for an async execution context. Stores `arrays[outputName]` containing Commands and child CommandBuffers. Acts as an async barrier in the chain. |
| **Chain** | The per-output linked list of Commands connected via `.next` pointers. Each `outputName` in a buffer has its own independent chain. CommandBuffers are NOT part of the chain themselves — they are traversed to find the real Commands inside them. The chain spans across nested CommandBuffers once they finish and patch links. |

---

## 3. Architecture

### 3.1 Data Structures

#### Command (base class) - `src/runtime/commands.js`

```
Fields:
  next      : Command | null    — next command in chain
  resolved  : boolean           — true when apply() has completed
  promise   : Promise | null    — for SnapshotCommand: the snapshot promise
  resolve   : Function | null   — for SnapshotCommand: the resolve function

Methods:
  getError()   : PoisonError | null
  apply(output): void | throws
```

Existing subclasses: `OutputCommand`, `TextCommand`, `ValueCommand`, `DataCommand`, `SinkCommand`, `ErrorCommand`. These remain unchanged.

#### SnapshotCommand (new class) - to be added to `src/runtime/commands.js`

```
Fields (inherited from Command):
  next, resolved, promise, resolve
Additional fields:
  reject    : Function | null   — promise rejection function
  _result   : any               — cached result value (for sync fast path)
  _settled  : boolean           — true when promise has been resolved/rejected

Methods:
  getReturn() : value | Promise
    — If already settled: returns _result directly (sync fast path).
    — Otherwise: lazily creates promise (with resolve/reject) and returns it.

  apply(output):
    — Reads errors from output._errors.
    — If errors exist: reject promise with PoisonError, or store error for sync path.
    — Otherwise: resolve promise with output.getCurrentResult().
    — Set output._snapshotTaken = true.
    — Store result in _result, set _settled = true.

  getError(): null  (SnapshotCommand never carries poison itself)
```

The promise is created **lazily** in `getReturn()`. If the command resolves synchronously before `getReturn()` is called with a promise, no Promise is created - the result is returned directly. This follows the sync-first hybrid pattern.

#### CommandBuffer - `src/runtime/buffer.js`

```
Existing fields:
  _context       : Object         — execution context
  parent         : CommandBuffer | null
  positions      : Map<string, number>  — position of this buffer in parent's arrays
  finished       : boolean        — true when async block completes
  arrays         : { [outputName]: Array<Command|CommandBuffer> }
  _outputIndexes : { [outputName]: number }

Existing methods:
  add(value, outputName)         — append command/buffer to array, link chain
  fillSlot(slot, value, outputName) — fill reserved slot, link chain
  addText(value, pos, outputName)   — convenience for TextCommand
  reserveSlot(outputName)        — reserve a slot index for later fillSlot
  firstCommand(handlerName)      — first real Command in array (recurses into buffers)
  lastCommand(handlerName)       — last real Command in array (recurses into buffers)
  markFinishedAndPatchLinks()    — called when async block completes; patches chain
  traverseChain(handlerName, fn) — walk chain via .next pointers

New method:
  addSnapshot(outputName, output) — create/reuse SnapshotCommand, return value or promise
```

#### Output classes - `src/runtime/output.js`

```
Existing fields on Output base:
  _frame      : Frame
  _outputName : string
  _outputType : string
  _context    : Object
  _buffer     : CommandBuffer

New fields (added to Output base or subclasses as needed):
  _snapshotTaken : boolean    — copy-on-write flag, set by SnapshotCommand.apply()
  _errors        : Array      — accumulated errors from resolved commands
```

Subclass-specific fields remain: `TextOutput._target = []`, `DataOutput._target = {}`, `DataOutput._base = DataHandler`, `ValueOutput._target = undefined`, `SinkOutputHandler._sink`.

**Proxy facade note**: `createOutput()` returns a Proxy facade, not the raw Output instance. The Proxy forwards property access for names listed in `OUTPUT_API_PROPS` (defined in `output.js`). New fields `_snapshotTaken` and `_errors` **must be added to `OUTPUT_API_PROPS`** for the resolution driver to read/write them through the facade. Since `buffer._outputs[outputName]` stores the facade (set up by `declareOutput()`), all resolution driver access goes through the Proxy.

### 3.2 Chain Construction

The chain is built dynamically as commands are added. CommandBuffers are barriers in the array but are NOT chain nodes themselves — commands inside them are the chain nodes.

**Independent chains per output**: A single CommandBuffer can have arrays for multiple output names (`text`, `data`, etc.). Each output name has its own independent chain with its own `.next` pointers. Resolution for each chain is completely independent — each operates on a different Output object. `markFinishedAndPatchLinks()` iterates per-handlerName.

**Barrier mechanism**: `linkToPrevious(prev, current, handlerName)` returns early without linking when `current` is a CommandBuffer (buffers are never `.next` targets). When a command is added after an unfinished CommandBuffer, `linkToPrevious` sees the unfinished buffer and skips — the command is NOT chained until the buffer finishes and `markFinishedAndPatchLinks()` patches the link. This is how CommandBuffers act as async barriers.

#### Adding a command via `add(command, outputName)`

Already implemented in `buffer.js`. The flow:

1. Reserve a slot: `slot = reserveSlot(outputName)`.
2. If the array already has elements, call `linkToPrevious(prev, command, outputName)`:
   - If `prev` is a Command: set `prev.next = command`.
   - If `prev` is a finished CommandBuffer: set `prev.lastCommand(outputName).next = command`. If `lastCommand` returns `null` (empty buffer for this output), no link is made — see [Empty Child Buffer Gap](#empty-child-buffer-gap-known-issue).
   - If `prev` is an unfinished CommandBuffer: **skip** (link will be patched later by `markFinishedAndPatchLinks`).
   - If `command` is a CommandBuffer: **skip** (buffers are not chain nodes).
3. Store `command` at `arrays[outputName][slot]`.
4. If `command` is a CommandBuffer: set parent/position relationship.

**Phase 2 addition**: After linking, if the command is ready (chained + predecessor resolved), trigger resolution immediately. See [3.3 Resolution Mechanism](#33-resolution-mechanism).

#### Filling a reserved slot via `fillSlot(slot, command, outputName)`

Already implemented. Links both backward (to previous) and forward (to next element in array). This handles the case where an async expression resolves and fills a gap:

```
Before fillSlot: [CmdA, <empty>, CmdC]  — A resolved but can't propagate
After fillSlot:  [CmdA, CmdB, CmdC]     — A→B→C linked, B becomes ready
```

**Phase 2 addition**: After filling, check if the newly inserted command is ready. If the previous command is resolved, trigger resolution on the filled command.

#### Chain patching when async block completes: `markFinishedAndPatchLinks()`

Already implemented. Called from `AsyncState.asyncBlock().then()` when the async function's promise resolves. For each output name where this buffer has a position in its parent's array:

1. Find `firstCmd` and `lastCmd` of this buffer for that output name.
2. **Link backward**: If previous element exists and is resolved/finished, set `prev.next = firstCmd` (or `prev.lastCommand().next = firstCmd` if prev is a finished buffer).
3. **Link forward**: If next element exists and is resolved/finished, set `lastCmd.next = next` (or `lastCmd.next = next.firstCommand()` if next is a finished buffer).

**Important**: `markFinishedAndPatchLinks` only patches links with **already-finished** siblings. If a sibling buffer is still running, the link is left unpatched and will be completed when that sibling finishes.

**Phase 2 addition**: After patching links, if newly linked commands are ready, trigger their resolution.

#### Chain patching when buffer is cleared: `patchLinksAfterClear()`

Already implemented in `buffer-snapshot.js`. Used by guard error recovery. When a buffer's arrays are emptied, the chain is patched to skip over the now-empty buffer, connecting the previous command directly to the next.

#### Empty Child Buffer Gap (known issue)

If a child CommandBuffer has **no commands for a given outputName**, both `firstCommand(outputName)` and `lastCommand(outputName)` return `null`. When `markFinishedAndPatchLinks()` runs, it cannot link through the empty buffer because firstCmd/lastCmd are null — the link-backward and link-forward branches are both skipped.

**Example**: `[CmdA, EmptyChildBuffer, CmdB]` for output 'data':
1. CmdA added → first command, no linking needed.
2. EmptyChildBuffer added → not a command, skipped by `linkToPrevious`.
3. CmdB added → `linkToPrevious` sees EmptyChildBuffer (unfinished), skips.
4. EmptyChildBuffer finishes → `markFinishedAndPatchLinks` finds `firstCmd = null, lastCmd = null`. **No patching occurs.**
5. **Result: `CmdA.next` is never set to `CmdB`. Chain has a permanent gap.**

**Fix required**: `markFinishedAndPatchLinks()` must handle empty buffers by directly linking the previous element to the next element, similar to how `patchLinksAfterClear()` works. When `firstCmd` and `lastCmd` are both null for a given handlerName, find the previous and next elements in the parent array and link them to each other, skipping the empty buffer.

This must be fixed **before Phase 1** since chain-walk flatten depends on a complete chain.

### 3.3 Resolution Mechanism

#### Two Conditions for `apply()`

A command's `apply()` is called when BOTH conditions are met:

1. **Chained**: The command is linked into the chain (predecessor's `.next` points to it, or it is the first command with no predecessor).
2. **Previous resolved**: The predecessor command's `apply()` has completed. For the first command in a root buffer, this condition is vacuously true.

#### Two Trigger Points

Resolution can be triggered from two events:

**Trigger 1 — Command becomes chained** (`.next` is set on predecessor):
- Happens in `linkToPrevious()`, `linkToNext()`, `fillSlot()`, or `markFinishedAndPatchLinks()`.
- Check: is the predecessor already resolved?
- If yes → the newly chained command is ready → call the resolution driver.

**Trigger 2 — Command becomes resolved** (`apply()` completes):
- Happens at the end of the resolution driver after `apply()` returns/resolves.
- Check: does this command have a `.next`?
- If yes → the next command is ready → call the resolution driver on it.

Together, these two triggers ensure that resolution propagates through the chain regardless of whether commands are added before or after their predecessors resolve.

#### Resolution Driver (pseudocode)

This is the core function that applies commands and propagates resolution. It uses an **iterative loop** for the sync path to avoid stack overflow on long chains (thousands of sync commands are realistic for data-heavy scripts). It falls back to promise chaining for the rare async case.

```javascript
function resolveChain(startCommand, output) {
  let current = startCommand;
  while (current) {
    // Pre-apply: copy-on-write check (Phase 4)
    if (output._snapshotTaken) {
      output._deepCopyAccumulator();  // output-type-specific, see §3.5
      output._snapshotTaken = false;
    }

    // Apply the command
    try {
      const result = current.apply(output);
      if (result && typeof result.then === 'function') {
        // Async apply (rare — currently only possible for future sink methods).
        // Break out of the sync loop and chain via promises.
        return result.then(() => {
          current.resolved = true;
          if (current.next) resolveChain(current.next, output);
        }).catch(err => {
          accumulateError(output, err);
          current.resolved = true;
          if (current.next) resolveChain(current.next, output);
        });
      }
    } catch (err) {
      accumulateError(output, err);
    }

    // Sync path (common case) — iterate, don't recurse
    current.resolved = true;
    current = current.next;
  }
}

function accumulateError(output, err) {
  if (!output._errors) output._errors = [];
  if (isPoisonError(err)) {
    output._errors.push(...err.errors);
  } else {
    output._errors.push(err);
  }
}
```

#### Sync Fast Path

In the current codebase, all command `apply()` methods are synchronous (no async sink methods yet). This means:

- When a command is added and its predecessor is already resolved, `resolveChain()` runs synchronously in a tight iterative loop.
- The entire chain from the first command to the last can resolve in a single synchronous pass.
- `snapshot()` on a fully-resolved chain returns a value directly, no Promise needed.

This is the performance-critical path. The async path (promise-returning `apply()`) only matters for future sink methods and should not add overhead to the common case.

#### First Command Auto-Resolution

When the first command is added to an array (array was empty before):
- It has no predecessor → chained condition is vacuously met.
- No predecessor to wait for → previous-resolved condition is vacuously met.
- Therefore: the first command is **immediately ready** and `resolveChain()` is called synchronously.

#### Child Buffer First-Command Auto-Resolution

The first command in a **child** CommandBuffer also has no predecessor within that buffer, so it is immediately ready when added — it resolves independently of the parent chain, before `markFinishedAndPatchLinks()` links the child into the parent.

This is correct behavior because child async blocks run concurrently. The ordering is preserved because:

1. Commands within the child buffer resolve in their correct relative order (C before D).
2. The parent chain cannot cross the child buffer barrier until it finishes. Commands after the buffer (like CmdB below) are NOT chained until patching occurs.

**Example**: `Parent: [CmdA, ChildBuffer, CmdB]`, `ChildBuffer: [CmdC, CmdD]`

| Event | Effect |
|-------|--------|
| CmdA added to parent | First in parent → auto-resolves, mutates accumulator |
| ChildBuffer added to parent | Not a command, no resolution |
| CmdC added to child | First in child → auto-resolves, mutates accumulator |
| CmdD added to child | CmdC.next = CmdD, CmdC resolved → CmdD resolves |
| CmdB added to parent | prev = ChildBuffer (unfinished) → NOT chained |
| ChildBuffer finishes | Patches: CmdA→CmdC (already resolved), CmdD→CmdB → CmdB resolves |

Final mutation order: A, C, D, B — correct source order.

**Copy-on-write interaction**: If a SnapshotCommand resolves in the parent chain before the child buffer's commands, the child's first command sees the `_snapshotTaken` flag and performs a deep copy before mutating. This ensures the snapshot captures state before the child's mutations.

#### Where Does the Resolution Driver Get the Output?

The resolution driver needs the Output object to pass to `apply()`. The Output is accessible via:
- `buffer._outputs[outputName]` — set up during `declareOutput()` in `output.js`.
- For templates: the root output is stored similarly on the frame/buffer.

When `add()` or `fillSlot()` triggers resolution, it can look up the Output from `this._outputs[outputName]`. When `markFinishedAndPatchLinks()` triggers resolution, it can look up the Output from `this.parent._outputs[outputName]`.

If `_outputs` is not available (e.g., template mode where outputs aren't declared via `declareOutput`), resolution is not triggered at add-time. Instead, it happens when `snapshot()` / `flattenBuffer()` is called (Phase 1 behavior as fallback).

### 3.4 Snapshot Mechanism

#### `Output.snapshot()` — new behavior

Current: calls `flattenBuffer(this)` which walks the tree and applies all commands.

New: delegates to `buffer.addSnapshot(outputName, this)` which:
1. Returns the snapshot value (sync) or a promise (async).

```javascript
// Output base class
snapshot() {
  if (!this._buffer) {
    return this._outputType === 'text' ? '' : undefined;
  }
  return this._buffer.addSnapshot(this._outputName, this);
}
```

#### `CommandBuffer.addSnapshot(outputName, output)` — new method

```javascript
addSnapshot(outputName, output) {
  const arr = this.arrays[outputName];

  // Reuse: if the last element is already a SnapshotCommand, return its promise/value
  if (arr && arr.length > 0) {
    const last = arr[arr.length - 1];
    if (last instanceof SnapshotCommand) {
      return last.getReturn();
    }
  }

  // Create new SnapshotCommand and add it to the chain
  const cmd = new SnapshotCommand();
  this.add(cmd, outputName);
  // add() may have triggered sync resolution, making cmd already settled

  return cmd.getReturn();
  // Returns value directly if settled (sync fast path),
  // or a lazily-created Promise if still pending.
}
```

#### SnapshotCommand Lifecycle

1. **Created** by `addSnapshot()`. No promise allocated yet.
2. **Added** to buffer via `add()`. Chain linking happens. May trigger resolution immediately.
3. **Resolved** (two scenarios):
   - **Sync**: All preceding commands were already resolved. `resolveCommand()` runs synchronously through the chain and calls `SnapshotCommand.apply()`. The result is stored in `_result`. When `getReturn()` is called, it returns `_result` directly.
   - **Async**: Some preceding commands are pending (behind an unfinished CommandBuffer or unfilled slot). A Promise is created lazily when `getReturn()` is called. When resolution eventually reaches the SnapshotCommand, `apply()` resolves the promise.

#### Promise Sharing / Reuse

When `snapshot()` is called multiple times with no intervening commands, the same SnapshotCommand is reused (last-element check in `addSnapshot`). All callers receive the same value/promise.

When commands are added between snapshots, each snapshot gets its own SnapshotCommand at its position in the chain, capturing the state at that point.

### 3.5 Copy-on-Write Optimization

#### Problem

`snapshot()` returns the accumulator state by reference for performance. If a subsequent command mutates the accumulator, the previously returned snapshot reference would see the mutation. The accumulator is output-type-specific (see [Terminology](#2-terminology)): `_target` for text/value, `DataHandler.data` for data.

#### Solution

A `_snapshotTaken` flag on the Output object tracks whether a snapshot has been taken since the last copy.

**Flag lifecycle:**
1. Initially `false`.
2. `SnapshotCommand.apply()` sets `_snapshotTaken = true` after resolving.
3. Before the next command's `apply()` runs (in the resolution driver): if `_snapshotTaken` is `true`, call `output._deepCopyAccumulator()` and clear the flag.

**Performance implications:**
- **Common case** (single snapshot at end): No copy occurs. Flag is set but no subsequent command runs.
- **Multiple snapshots**: Copy occurs only when the first command after a snapshot needs to mutate. The copy is of the current state, not the full history.
- **Value output**: Replacement (not mutation), so no deep copy needed — the old value is already captured by the SnapshotCommand.

#### Deep Copy Strategy (`_deepCopyAccumulator`)

Each Output subclass implements `_deepCopyAccumulator()` appropriate to its accumulator:

- **TextOutput**: `this._target = this._target.slice()` — shallow copy of the fragments array. Fragments are immutable strings, so shallow is sufficient.
- **ValueOutput**: No copy needed — `ValueCommand.apply()` replaces `_target` entirely rather than mutating it. The previous snapshot's reference to the old value is safe. `_deepCopyAccumulator` is a no-op.
- **DataOutput**: Must deep-copy `DataHandler.data` (the real accumulator, accessed via `_base`). Approach: `this._base.data = JSON.parse(JSON.stringify(this._base.data))` or structured clone. Note that `_target` on DataOutput (`{}`) is not used by commands — the copy target is `_base.data`. `getCurrentResult()` returns `_base.getReturnValue()` which returns `_base.data`, so the copy must happen there.
- **SinkOutput**: Sink manages its own state via `_sink`. COW does not apply — each `SinkOutputHandler.snapshot()` call delegates to `sink.snapshot()` which is expected to return an independent value.

### 3.6 Error Handling

#### Error Accumulation

With incremental resolution, errors from `apply()` are caught by the resolution driver and accumulated on `output._errors` (an array).

- `OutputCommand.apply()` throws `PoisonError` when arguments contain poison.
- `ErrorCommand.apply()` always throws `PoisonError`.
- Other `apply()` methods can throw runtime errors (e.g., "has no method", "Invalid path segment").

All errors are caught and accumulated. Resolution continues past errors - subsequent commands still apply (unless they themselves depend on poisoned values, in which case they'll also throw).

**This preserves the "Never Miss Any Error" principle**: all commands are applied, all errors collected.

#### SnapshotCommand Error Handling

When `SnapshotCommand.apply()` runs:

- If `output._errors` has entries: reject the promise with `new PoisonError(output._errors)`, or throw (for sync path).
- If no errors: resolve with `output.getCurrentResult()`.

This matches the current behavior where `flattenBuffer()` collects all errors and throws a single `PoisonError` at the end.

**Error accumulation across multiple snapshots**: Errors accumulate across the entire chain lifetime. Each SnapshotCommand reports ALL errors that occurred from the start of the chain up to its position. This matches the current single-flatten behavior (any error poisons the entire output) and is the simplest correct behavior. A second snapshot will include errors from before the first snapshot.

Future refinement: per-snapshot error slicing (each snapshot only reports errors since the previous snapshot) could be added later if needed, but is not part of the current plan.

### 3.7 Scope Boundaries and Output Isolation

A **scope boundary** occurs when a new execution context cannot access the parent's outputs. This happens for:
- **Macro calls**: New frame with `outputScope = true`, new CommandBuffer with `parent = null`.
- **Capture blocks**: Temporary output scope.
- **Call blocks**: Caller body has its own output scope.

At scope boundaries:
- A new root CommandBuffer is created (`parent = null`).
- New Output objects are created via `declareOutput()`.
- The chain within the scope is completely independent from the outer scope.
- Commands in the inner scope operate on the inner Output's `_target`.

Within the same scope, **nested async blocks** create child CommandBuffers that DO have a parent. These child buffers are barriers in the parent's chain but share the same Output objects. Commands in child buffers operate on the same `_target` as commands in the parent buffer.

### 3.8 Template Mode

Templates use the same CommandBuffer/chain mechanism for text output:

- Async template root creates a `CommandBuffer` and a text `Output` via `runtime.declareOutput(frame, "text", "text", context, null)` — the same `declareOutput()` used by scripts. This means `buffer._outputs` is populated for templates too, so the resolution driver can find the Output.
- Compiler emits `TextCommand` writes via `buffer.addText()`.
- Template `{{ expression }}` output goes through `suppressValueAsync` → `TextCommand`.
- The final result is obtained via `flattenBuffer(output)` after `astate.waitAllClosures()`.

The incremental resolution architecture applies equally to templates. However, templates typically don't call `snapshot()` mid-execution — they flatten once at the end. So the primary benefit for templates is the chain-based traversal (Phase 1) rather than point-in-time snapshots (Phase 3).

**Sync template mode** remains string-based (`output += ...`) and is unaffected by this architecture.

---

## 4. Current Implementation State

### Already Implemented

| Component | File | Status |
|-----------|------|--------|
| Command base with `next`, `resolved`, `promise`, `resolve` fields | `commands.js` | Done, untested |
| All Command subclasses with `apply()` methods | `commands.js` | Done, tested |
| `CommandBuffer.add()` with chain linking | `buffer.js` | Done, untested |
| `CommandBuffer.fillSlot()` with chain linking | `buffer.js` | Done, untested |
| `CommandBuffer.firstCommand(handlerName)` | `buffer.js` | Done, untested |
| `CommandBuffer.lastCommand(handlerName)` | `buffer.js` | Done, untested |
| `CommandBuffer.markFinishedAndPatchLinks()` | `buffer.js` | Done, untested |
| `CommandBuffer.traverseChain(handlerName, fn)` | `buffer.js` | Done, untested |
| `linkToPrevious()`, `linkToNext()`, `patchLinksAfterClear()` | `buffer-snapshot.js` | Done, untested |
| Output classes with `_target`, `_base`, `_buffer` | `output.js` | Done, tested |
| `flattenBuffer()` — tree-walk flatten | `flatten-buffer.js` | Done, tested |
| `declareOutput()` storing outputs on buffer | `output.js` | Done, tested |
| `markFinishedAndPatchLinks()` called from `AsyncState.asyncBlock().then()` | `async-state.js:79` | Done, untested |

### Not Yet Implemented

| Component | File | Phase |
|-----------|------|-------|
| Fix empty child buffer chain gap | `buffer.js` | Pre-Phase 1 |
| `SnapshotCommand` class | `commands.js` | Phase 3 |
| `CommandBuffer.addSnapshot()` method | `buffer.js` | Phase 3 |
| Chain-based flatten (replacing tree-walk) | `flatten-buffer.js` | Phase 1 |
| Resolution driver (`resolveCommand`) | New or `flatten-buffer.js` | Phase 2 |
| Trigger resolution from `add()` / `fillSlot()` / `markFinishedAndPatchLinks()` | `buffer.js` | Phase 2 |
| Add `_snapshotTaken`, `_errors` to `OUTPUT_API_PROPS` | `output.js` | Phase 2 |
| `Output._errors` accumulator | `output.js` | Phase 2 |
| `Output._snapshotTaken` flag | `output.js` | Phase 4 |
| `Output._deepCopyAccumulator()` per subclass | `output.js` | Phase 4 |
| `Output.snapshot()` using `addSnapshot()` | `output.js` | Phase 3 |
| Sink `apply()` return value handling | `commands.js` | Phase 5 |

---

## 5. Phased Implementation Plan

### Phase 1: Chain-Based Flatten (Drop-In Replacement)

**Goal**: Replace tree-walk flatten with chain traversal. Validates that the chain is wired correctly. Still flattens all at once when `snapshot()` is called.

**Semantic note**: The tree-walk recurses into child CommandBuffers regardless of their `finished` state. The chain-walk only follows `.next` pointers — if a child buffer is unfinished at flatten time, its commands are not linked into the chain and will be missed. In practice this is not an issue: `snapshot()` in scripts is compiled with `waitAllClosures()` before the return value, and templates call `flattenBuffer` after `waitAllClosures()`, so all buffers are finished at flatten time. But this means Phase 1 is not a strict drop-in replacement for code paths that flatten before all async work completes.

**Changes**:
- Modify `flattenBuffer()` in `flatten-buffer.js` to walk the chain via `.next` pointers instead of recursing into CommandBuffer trees.
- Use `buffer.firstCommand(outputName)` to find the start of the chain.
- Walk `command.next` until `null`, calling `command.apply(output)` on each.
- Error collection remains the same (try/catch around each apply, accumulate, throw PoisonError at end).

**Pseudocode**:
```javascript
function flattenBuffer(output, errorContext) {
  // ... validation unchanged ...
  const errors = [];
  let current = output._buffer.firstCommand(output._outputName);
  while (current) {
    try {
      current.apply(output);
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
    current = current.next;
  }
  if (errors.length > 0) throw new PoisonError(errors);
  return output.getCurrentResult();
}
```

**Testing**: All existing tests must pass. If chain linking has bugs, tests will fail here, revealing issues in `linkToPrevious`, `fillSlot`, `markFinishedAndPatchLinks`, etc.

**Risk**: Low. If the chain is broken, we can compare against the tree-walk to debug.

### Phase 2: Incremental Resolution

**Goal**: Commands apply as they become ready, rather than in a deferred batch. The resolution driver is introduced, and `add()` / `fillSlot()` / `markFinishedAndPatchLinks()` trigger resolution.

**Changes**:
- Add resolution driver function `resolveChain()` (in `flatten-buffer.js` or new `resolve-chain.js`).
- Add `output._errors` array for error accumulation.
- Add `_snapshotTaken` and `_errors` to `OUTPUT_API_PROPS` in `output.js` so the Proxy facade forwards them.
- Modify `CommandBuffer.add()`: after chain linking, if the added command is ready, call `resolveChain()`.
  - First command in array: always ready (no predecessor).
  - Command after a resolved predecessor: ready.
  - Command after an unfinished CommandBuffer: not ready (wait for patching).
  - Output reference obtained from `this._outputs[outputName]` (set by `declareOutput`). If not available, skip — fallback applies at snapshot time.
- Modify `CommandBuffer.fillSlot()`: same — after filling and linking, check if ready.
- Modify `CommandBuffer.markFinishedAndPatchLinks()`: after patching links, for each newly linked command whose predecessor is resolved, call `resolveChain()`. Output reference obtained from `this.parent._outputs[outputName]`.
- Modify `flattenBuffer()` to handle already-resolved commands:
  ```javascript
  function flattenBuffer(output, errorContext) {
    // ... validation unchanged ...
    const errors = output._errors ? output._errors.slice() : [];
    let current = output._buffer.firstCommand(output._outputName);
    while (current) {
      if (!current.resolved) {
        // Fallback: apply commands not yet resolved by incremental resolution
        try {
          current.apply(output);
        } catch (err) {
          if (isPoisonError(err)) errors.push(...err.errors);
          else errors.push(err);
        }
        current.resolved = true;
      }
      current = current.next;
    }
    if (errors.length > 0) throw new PoisonError(errors);
    return output.getCurrentResult();
  }
  ```
  In the common case (all commands already resolved by incremental resolution), the loop just skips every command and returns immediately.

**Key invariant**: `command.resolved` is set to `true` AFTER `apply()` completes. No command is resolved without having been applied.

**Fallback**: If `buffer._outputs[outputName]` is not available, incremental resolution is not triggered at add-time. `flattenBuffer()` applies all unresolved commands at snapshot time. This ensures backwards compatibility.

**Testing**: All existing tests must pass. Since all current commands are sync and most scripts add commands sequentially, commands will resolve synchronously during `add()`. The observable behavior should be identical.

### Phase 3: SnapshotCommand and Async Snapshots

**Goal**: Replace `flattenBuffer()` calls in `Output.snapshot()` with `SnapshotCommand` insertion. Enable point-in-time snapshots.

**Changes**:
- Add `SnapshotCommand` class to `commands.js`.
- Add `CommandBuffer.addSnapshot(outputName, output)` method to `buffer.js`.
- Change `Output.snapshot()` to call `this._buffer.addSnapshot(this._outputName, this)`.
- `SinkOutputHandler.snapshot()` adaptation: Sinks are fundamentally different — `SinkCommand.apply()` calls methods on the sink object (`_sink`), not on `_target`. The sink's `snapshot()` method (or `getReturnValue()`/`finalize()`) returns the current state. For sinks, the SnapshotCommand should call the sink's snapshot method rather than `getCurrentResult()` on `_target`. The simplest approach: `SinkOutputHandler.snapshot()` still triggers `flattenBuffer()` to apply any unresolved sink commands in order, then delegates to the sink's own snapshot method. Full integration with `addSnapshot()` can be deferred until Phase 5 (sink return values).
- Enable the previously-skipped tests:
  - "should allow multiple snapshots at different points"
  - "should keep snapshot values immutable after further writes"

**Testing**: Existing tests must pass (snapshots at end behave the same). Skipped snapshot tests should now pass.

### Phase 4: Copy-on-Write

**Goal**: Ensure snapshot immutability. A snapshot returns `_target` by reference; subsequent mutations don't affect it.

**Changes**:
- Add `_snapshotTaken` flag to Output classes (initialized `false`).
- In resolution driver: before calling `apply()`, check `_snapshotTaken`. If true, call `output._deepCopyAccumulator()` and clear the flag.
- Implement `_deepCopyAccumulator()` per output type (see [3.5](#35-copy-on-write-optimization)):
  - `TextOutput`: `this._target = this._target.slice()`.
  - `ValueOutput`: no-op.
  - `DataOutput`: `this._base.data = JSON.parse(JSON.stringify(this._base.data))` — copies the DataHandler's internal data object (the real accumulator). `_target` on DataOutput is not involved.

**Testing**: The "immutable after further writes" test validates this. Add targeted copy-on-write tests.

### Phase 5: Sink Return Values (Last)

**Goal**: Enable `var result = sink.doSomething()` to return a value from the sink's `apply()`.

**Changes**:
- `SinkCommand.apply()` returns the sink method's return value.
- `addSinkCommand()` (or equivalent) returns a promise/value for the return.
- The compiler generates code that captures this return value.
- Requires `command.getReturn()` on SinkCommand.

**This phase is deferred**: it requires compiler changes and is less critical than snapshot correctness.

---

## 6. Test Strategy

### Existing Tests (Must All Pass)

These test files exercise the output pipeline and will validate each phase:

- `tests/explicit-outputs.js` — Comprehensive script output tests (data, text, value, sink, macros, scoping, async, errors, guards).
- `tests/pasync/flattent-buffer.js` — Direct flatten tests (data assembly, text output, sink factory/singleton, error handling, autoescape).
- `tests/pasync/*.js` — Various async parallelism tests that produce text/data output.
- `tests/script.js` — Script mode tests.

### New Tests per Phase

#### Phase 1: Chain-Based Flatten
- **Unit test**: Build a CommandBuffer manually, add commands and nested child buffers, verify `firstCommand()` / `lastCommand()` / chain traversal produces correct order.
- **Unit test**: Build a chain with multiple levels of nesting, verify flatten via chain matches flatten via tree-walk.
- **Edge case**: Empty arrays, empty nested buffers, buffers with only child buffers (no direct commands).

#### Phase 2: Incremental Resolution
- **Unit test**: Add commands one by one, verify each is resolved immediately after add (check `command.resolved === true`).
- **Unit test**: Reserve a slot, add commands after it, fill the slot — verify resolution propagates correctly.
- **Unit test**: Simulate async blocks: create child CommandBuffer (unfinished), add commands after it, verify they are NOT resolved until `markFinishedAndPatchLinks()` is called.
- **Timing test**: Use delays to prove commands resolve as they become ready, not all at once.

#### Phase 3: SnapshotCommand
- **Enable**: "should allow multiple snapshots at different points" (currently skipped).
- **Enable**: "should keep snapshot values immutable after further writes" (currently skipped).
- **New test**: `snapshot()` at different points in the command stream returns correct point-in-time state.
- **New test**: `snapshot()` returns a Promise when preceding commands are pending (behind async barrier).
- **New test**: `snapshot()` returns a value directly when all preceding commands are resolved (sync fast path).
- **New test**: Multiple `snapshot()` calls with no intervening commands share the same SnapshotCommand.
- **New test**: SnapshotCommand with errors — promise rejects with PoisonError.

#### Phase 4: Copy-on-Write
- **New test**: Take snapshot, add more commands, verify snapshot value is unchanged.
- **New test**: Take two snapshots with commands between them, verify each has correct state.
- **New test**: Verify no unnecessary copies (single snapshot at end triggers no copy).

#### Phase 5: Sink Return Values
- **New test**: `var x = sink.method()` captures the return value.
- **New test**: Async sink method return value.

### Test Patterns

For resolution testing, use the pattern from existing tests with `delay()`:
```javascript
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
```

For chain verification, use `CommandBuffer.traverseChain()` or manual `.next` walking:
```javascript
const chain = [];
let cmd = buffer.firstCommand('data');
while (cmd) { chain.push(cmd); cmd = cmd.next; }
expect(chain).to.have.length(expectedCount);
```

---

## 7. Future Considerations

### Guard/Revert Interaction

Guards currently use `clearBuffer()` to discard commands on error. With incremental resolution, commands that have already resolved have already mutated `_target`. Clearing the buffer doesn't undo their effects.

**Important interaction with child buffer auto-resolution (see [3.3](#child-buffer-first-command-auto-resolution))**: In Phase 2+, commands inside a child CommandBuffer auto-resolve independently when added. This means guard commands DO mutate the accumulator before the guard's success/failure is determined.

The current guard implementation works because:
1. Guard creates a child CommandBuffer.
2. On success, the child buffer finishes normally and links into the parent chain.
3. On failure, `clearBuffer()` empties the child's arrays and patches links to skip it.

With incremental resolution, commands in the guard's child buffer resolve and mutate the accumulator as they're added. If the guard fails, the accumulator has already been modified. The guard revert mechanism must **restore the accumulator state to a saved checkpoint** taken before the guard block started. This is the existing guard behavior (save/restore `_target` or DataHandler state). It continues to work because the revert restores the pre-guard state regardless of what mutations occurred.

If guard revert doesn't currently save/restore the accumulator for all output types, this must be verified and fixed as part of guard-output integration testing.

### Early Return

The snapshot architecture enables early return: a `return` statement can insert a SnapshotCommand at its position and resolve the script with that snapshot's value, even if later commands exist in the buffer. Later commands would simply never resolve (or their effects would be discarded).

### Streaming Output

Incremental resolution naturally supports streaming: as text commands resolve, their output could be streamed to a consumer rather than accumulated in `_target`. This is a future optimization for template rendering.

### Error Overwrite / Recovery

Currently, any error in the chain poisons the final snapshot. In the future, commands could overwrite errored values (e.g., `data.x = fallbackValue` after `data.x = failedAsyncCall()`), allowing recovery without guard blocks. This is NOT part of the current plan but the architecture supports it because errors are accumulated per-output rather than halting resolution.

### Circular Reference Detection

If commands could reference other outputs or create dependency cycles, resolution could deadlock. This is not currently possible with the linear chain model but should be monitored if the architecture evolves.

---

## Appendix: Key File Reference

| File | Role |
|------|------|
| `src/runtime/commands.js` | Command class hierarchy, `apply()` implementations |
| `src/runtime/buffer.js` | CommandBuffer, chain linking, `add()`, `fillSlot()`, `markFinishedAndPatchLinks()` |
| `src/runtime/buffer-snapshot.js` | Chain link helpers: `linkToPrevious()`, `linkToNext()`, `patchLinksAfterClear()` |
| `src/runtime/flatten-buffer.js` | `flattenBuffer()` — currently tree-walk, will become chain-walk (Phase 1) |
| `src/runtime/output.js` | Output classes, `snapshot()`, `createOutput()`, `declareOutput()` |
| `src/runtime/async-state.js` | `asyncBlock()` lifecycle, calls `markFinishedAndPatchLinks()` on completion |
| `src/runtime/errors.js` | `PoisonError`, `isPoison()`, `isPoisonError()` |
| `src/script/data-handler.js` | `DataHandler` — target for `@data` commands |
| `tests/explicit-outputs.js` | Comprehensive script output tests |
| `tests/pasync/flattent-buffer.js` | Direct flatten/command tests |
