# Snapshot Implementation Plan

**Status:** Updated with incremental chain construction algorithm (Phase 1).

## Table of Contents

- [1. Overview](#1-overview)
- [2. Terminology](#2-terminology)
- [3. Architecture](#3-architecture)
  - [3.1 Data Structures](#31-data-structures)
  - [3.2 Incremental Chain Construction](#32-incremental-chain-construction)
  - [3.3 Scope Boundaries and Output Isolation](#33-scope-boundaries-and-output-isolation)
  - [3.4 Template Mode](#34-template-mode)
- [4. Current Implementation State](#4-current-implementation-state)
- [5. Implementation Plan](#5-implementation-plan)
- [6. Test Strategy](#6-test-strategy)
- [7. Future Considerations](#7-future-considerations)

---

## 1. Overview

This document specifies the incremental chain construction architecture for Cascada's output system. It replaces the current "collect-then-flatten" model with an incremental chaining model where the command chain is built progressively as commands are added, ensuring a complete, traversable chain by flatten time.

### Current Model (collect-then-flatten)

1. Script/template code enqueues commands into `CommandBuffer.arrays[outputName]`.
2. Commands and buffers added via `add()` / `fillSlot()` with basic `.next` linking.
3. `markFinishedAndPatchLinks()` attempts to link across buffer boundaries when buffers finish.
4. **Problem**: Buffers can finish before their slots are filled, creating incomplete chains.
5. `Output.snapshot()` calls `flattenBuffer()`, which walks the buffer tree recursively (tree-walk).

### New Model (incremental chain construction)

1. Script/template code enqueues commands into `CommandBuffer.arrays[outputName]`.
2. Each buffer tracks chain progress per handler via `_lastChainedIndex` and `_lastIndexIsChained`.
3. Output objects store chain endpoints via `_firstChainedCommand` and `_lastChainedCommand`.
4. As commands/buffers are added or filled, the chain advances incrementally.
5. Child buffers notify parent when fully chained, allowing parent to continue advancing.
6. By flatten time, the chain is complete - no gaps from unfilled slots or unfinished buffers.
7. `flattenBuffer()` uses simple chain-walk via `.next` pointers.

### Key Benefits

- **Complete chains**: No gaps from timing issues (slots filled after buffer finishes).
- **Incremental construction**: Chain built progressively, not deferred to flatten time.
- **Simplified flatten**: Simple `.next` pointer traversal, no tree recursion.
- **Foundation for future features**: Point-in-time snapshots, early return, streaming output.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Chained** | A command is chained when it has been linked into the output's chain - its predecessor's `.next` points to it (or it is the first command with no predecessor), AND it has been registered as the tail of the chain (`output._lastChainedCommand`). |
| **Fully Chained** | A buffer is fully chained for a handler when: (1) all its elements up to the last position are chained, (2) its last element is chained (or array is empty), and (3) the buffer is finished. |
| **lastChainedIndex** | Per-buffer, per-handler tracking: the index of the last element that has been successfully chained into the global chain for this handler. Initial value: -1 (no elements chained). |
| **lastIndexIsChained** | Per-buffer, per-handler flag: `true` if the element at `lastChainedIndex` is ready for a successor to be chained. `false` when waiting for a child CommandBuffer to become fully chained. Initial value: `true` (vacuously - no pending buffer). |
| **Output** | The runtime object (`TextOutput`, `DataOutput`, `ValueOutput`, `SinkOutputHandler`) that stores chain endpoints and is passed to `command.apply()`. |
| **Accumulator** | The live state that commands mutate via `apply()`. Output-type-specific: `_target` for text/value, `DataHandler.data` (via `_base`) for data. |
| **CommandBuffer** | Container for an async execution context. Stores `arrays[outputName]` containing Commands and child CommandBuffers. Tracks chain progress per handler. |
| **Chain** | The per-output linked list of Commands connected via `.next` pointers. Each `outputName` has its own independent chain. CommandBuffers are NOT part of the chain - they are containers that we link through. |

---

## 3. Architecture

### 3.1 Data Structures

#### Command (base class) - `src/runtime/commands.js`

```javascript
Fields:
  next      : Command | null    — next command in chain
  resolved  : boolean           — (future) true when apply() completed
  promise   : Promise | null    — (future) for SnapshotCommand
  resolve   : Function | null   — (future) for SnapshotCommand

Methods:
  getError()   : PoisonError | null
  apply(output): void | throws
```

Existing subclasses: `OutputCommand`, `TextCommand`, `ValueCommand`, `DataCommand`, `SinkCommand`, `ErrorCommand`. These remain unchanged.

#### CommandBuffer - `src/runtime/buffer.js`

```javascript
Existing fields:
  _context       : Object                — execution context
  parent         : CommandBuffer | null  — parent buffer
  positions      : Map<string, number>   — position in parent's arrays
  finished       : boolean               — true when async block completes
  arrays         : { [outputName]: Array<Command|CommandBuffer> }
  _outputIndexes : { [outputName]: number }

New fields (Phase 1):
  _outputs           : Map<string, Output> — shared registry (inherited from parent)
  _lastChainedIndex  : Map<string, number> — per-handler: last chained position
  _lastIndexIsChained: Map<string, boolean> — per-handler: is last element ready?

Existing methods:
  add(value, outputName)                — append, link, advance chain
  fillSlot(slot, value, outputName)     — fill slot, link, advance chain
  reserveSlot(outputName)               — reserve array index
  firstCommand(handlerName)             — first Command (recurse into buffers)
  lastCommand(handlerName)              — last Command (recurse into buffers)
  markFinishedAndPatchLinks()           — mark finished, check if fully chained

New methods (Phase 1):
  _tryAdvanceChain(handlerName, position)      — check if can advance from position
  _advanceChainFrom(handlerName, startPos)     — advance chain from position
  _chainCommand(handlerName, command)          — link command into global chain
  _checkFullyChained(handlerName)              — check if fully chained, notify parent
  _notifyParentChained(handlerName)            — notify parent we're fully chained
  _childBufferChained(child, handlerName)      — handle child notification
```

#### Output classes - `src/runtime/output.js`

```javascript
Existing fields on Output base:
  _frame      : Frame
  _outputName : string
  _outputType : string
  _context    : Object
  _buffer     : CommandBuffer  — declaring buffer (not necessarily root)

New fields (Phase 1):
  _firstChainedCommand : Command | null  — head of chain (for fast flatten)
  _lastChainedCommand  : Command | null  — tail of chain (for linking)

Future fields (Phase 2+):
  _snapshotTaken : boolean    — copy-on-write flag
  _errors        : Array      — accumulated errors from resolution
```

Subclass-specific fields remain: `TextOutput._target = []`, `DataOutput._target = {}`, `DataOutput._base = DataHandler`, `ValueOutput._target = undefined`, `SinkOutputHandler._sink`.

### 3.2 Incremental Chain Construction

The chain is built incrementally as commands are added or filled. Each buffer tracks its chain progress per handler. When a buffer becomes fully chained, it notifies its parent, allowing the parent's chain to advance through it.

#### Core Concepts

**Chain Progress Tracking** (per buffer, per handler):
- `_lastChainedIndex`: Index of last element that's been chained (-1 initially)
- `_lastIndexIsChained`: Whether element at `lastChainedIndex` is ready for successor
  - `true`: Last element is a Command (ready) or a fully-chained CommandBuffer
  - `false`: Last element is a CommandBuffer waiting to become fully chained

**Global Chain State** (per output):
- `_firstChainedCommand`: Head of the chain (for flatten to start walking)
- `_lastChainedCommand`: Tail of the chain (where we link new commands)

**Output Registry**:
- `buffer._outputs`: Map of handlerName → Output object
- Shared across all buffers in same scope (child buffers inherit parent's `_outputs`)
- Output registers itself in its declaring buffer's `_outputs` via `declareOutput()`

#### Adding a Command

When `add(command, handlerName)` or `fillSlot(slot, command, handlerName)` is called:

```javascript
add(command, handlerName) {
  checkFinishedBuffer(this);  // Error if buffer is finished

  const slot = reserveSlot(handlerName);
  this.arrays[handlerName][slot] = command;

  this._tryAdvanceChain(handlerName, slot);

  return slot;
}

fillSlot(slot, command, handlerName) {
  // fillSlot doesn't check finished - slot was pre-reserved
  this.arrays[handlerName][slot] = command;

  this._tryAdvanceChain(handlerName, slot);
}

_tryAdvanceChain(handlerName, position) {
  const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
  const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

  // Can only advance if: position is next AND previous element is ready
  if (position !== lastIdx + 1 || !lastChained) {
    return;  // Not ready to advance
  }

  this._advanceChainFrom(handlerName, position);
}
```

#### Advancing the Chain

```javascript
_advanceChainFrom(handlerName, startPos) {
  const arr = this.arrays[handlerName];
  let pos = startPos;

  // Keep advancing while next position exists and is non-null
  while (pos < arr.length && arr[pos] != null) {
    const item = arr[pos];

    if (item instanceof Command) {
      // Chain this command
      this._chainCommand(handlerName, item);
      this._lastChainedIndex.set(handlerName, pos);
      this._lastIndexIsChained.set(handlerName, true);
      pos++;  // Continue to next position
    }
    else if (isCommandBuffer(item)) {
      // Hit a buffer - mark position but wait for buffer to chain
      this._lastChainedIndex.set(handlerName, pos);
      this._lastIndexIsChained.set(handlerName, false);

      // Check if buffer is already fully chained
      if (item._isFullyChained(handlerName)) {
        item._notifyParentChained(handlerName);
        // Note: _childBufferChained will be called, which continues advancing
        return;  // Let _childBufferChained handle further advancement
      }

      break;  // Wait for buffer to become fully chained
    }
  }

  // Check if this buffer is now fully chained
  this._checkFullyChained(handlerName);
}

_chainCommand(handlerName, command) {
  const output = this._outputs.get(handlerName);
  if (!output) {
    throw new Error(`Cannot chain command: no output declared for '${handlerName}'`);
  }

  const lastChained = output._lastChainedCommand;

  if (lastChained) {
    lastChained.next = command;
  } else {
    // First command in chain
    output._firstChainedCommand = command;
  }

  output._lastChainedCommand = command;
}
```

#### Child Buffer Notification

When a child buffer becomes fully chained:

```javascript
_notifyParentChained(handlerName) {
  if (!this.parent) return;
  this.parent._childBufferChained(this, handlerName);
}

_childBufferChained(child, handlerName) {
  const childPos = child.positions.get(handlerName);
  const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
  const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

  // Only process if we're waiting for this child
  if (childPos !== lastIdx || lastChained) {
    return;  // Not waiting for this child
  }

  // Link through the child buffer
  const output = this._outputs.get(handlerName);
  const childFirst = child.firstCommand(handlerName);
  const childLast = child.lastCommand(handlerName);

  if (childFirst) {
    // Non-empty buffer: link through it
    const lastChainedCmd = output._lastChainedCommand;
    if (lastChainedCmd) {
      lastChainedCmd.next = childFirst;
    } else {
      output._firstChainedCommand = childFirst;
    }
    output._lastChainedCommand = childLast;
  }
  // else: empty buffer, nothing to link

  // Mark this position as chained
  this._lastIndexIsChained.set(handlerName, true);

  // Continue advancing from next position
  this._advanceChainFrom(handlerName, childPos + 1);
}
```

#### Buffer Finishing

When `markFinishedAndPatchLinks()` is called (async block completes):

```javascript
markFinishedAndPatchLinks() {
  // First, recursively finish all child buffers (bottom-up)
  for (const handlerName in this.arrays) {
    const arr = this.arrays[handlerName];
    if (arr) {
      for (const item of arr) {
        if (isCommandBuffer(item) && !item.finished) {
          item.markFinishedAndPatchLinks();
        }
      }
    }
  }

  this.finished = true;

  if (!this.parent) return;

  // Check each handler to see if now fully chained
  for (const handlerName in this.arrays) {
    this._checkFullyChained(handlerName);
  }
}

_checkFullyChained(handlerName) {
  if (!this.finished) return;  // Must be finished

  const arr = this.arrays[handlerName] ?? [];
  const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
  const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

  // Fully chained if: last index is last position AND last element is chained
  const isFullyChained = (lastIdx === arr.length - 1) && lastChained;

  if (isFullyChained && this.parent) {
    this._notifyParentChained(handlerName);
  }
}

_isFullyChained(handlerName) {
  const arr = this.arrays[handlerName] ?? [];
  const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
  const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

  return this.finished && (lastIdx === arr.length - 1) && lastChained;
}
```

#### Key Scenarios

**Scenario 1: Chain first, then finish**
```
1. Commands added → chain advances → lastChainedIndex reaches last position
2. Last element chains → lastIndexIsChained = true
3. Buffer finishes → markFinishedAndPatchLinks() → checks all handlers
4. Handler is fully chained → notify parent
```

**Scenario 2: Finish first, then chain**
```
1. Buffer finishes → markFinishedAndPatchLinks() → checks all handlers
2. Not fully chained yet → don't notify
3. Later: slot filled or child buffer chains
4. _advanceChainFrom() → chain advances → _checkFullyChained()
5. Now fully chained + finished → notify parent
```

**Scenario 3: Empty buffer**
```
1. Buffer created with no commands for this handler (arrays[handler] = [])
2. Buffer finishes → lastIdx = -1, arr.length = 0
3. lastIdx === arr.length - 1 → -1 === -1 → true ✓
4. lastIndexIsChained = true (initial value)
5. Fully chained! Notify parent
6. Parent's _childBufferChained: childFirst = null (empty), skip linking
7. Mark position as chained and continue advancing
```

#### Flatten Implementation

With complete chains guaranteed by flatten time:

```javascript
function flattenBuffer(output, errorContext = null) {
  // ... validation ...

  const errors = [];
  let current = output._firstChainedCommand;  // Start at head

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

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return output.getCurrentResult();
}
```

#### On-Demand Chain Building (Legacy Test Support)

For tests that create buffers directly without using `declareOutput()`, a fallback mechanism ensures chains are built before flatten:

```javascript
// In flattenBuffer(), before walking the chain:
if (!output._firstChainedCommand && buffer.arrays[output._outputName]?.length > 0) {
  buildChainOnDemand(buffer, output);
}

function buildChainOnDemand(buffer, output) {
  // Register output if not already registered
  if (buffer._outputs instanceof Map && !buffer._outputs.has(output._outputName)) {
    buffer._outputs.set(output._outputName, output);
  }

  // Reset chain endpoints (clears any partial state)
  output._firstChainedCommand = null;
  output._lastChainedCommand = null;

  // Build chain recursively using special demand-build method
  buffer._advanceChainFromWithDemandBuild(output._outputName, 0);
}
```

**Key differences from incremental construction:**
- `_advanceChainFromWithDemandBuild()` recursively processes child buffers via `_linkChildBufferCommands()`
- Child commands are linked directly without calling `_chainCommand()` to avoid overwriting parent's `_firstChainedCommand`
- No parent notification (no runtime tracking, just one-time chain construction)
- Used only when chain is empty at flatten time (legacy code path)

### 3.3 Scope Boundaries and Output Isolation

A **scope boundary** occurs when a new execution context cannot access the parent's outputs:
- **Macro calls**: New frame with `outputScope = true`
- **Capture blocks**: Temporary output scope
- **Call blocks**: Caller body has its own output scope

At scope boundaries:
- A new CommandBuffer is created with `parent = null` (root for this scope)
- New Output objects are created via `declareOutput()`
- Each Output registers itself: `buffer._outputs.set(outputName, output)`
- The chain within the scope is independent from outer scope

Within the same scope:
- **Nested async blocks** create child CommandBuffers with `parent` set
- Child buffers inherit parent's `_outputs`: `this._outputs = parent._outputs`
- All buffers in scope share same Output objects
- Commands in child buffers operate on the same accumulators as parent

### 3.4 Template Mode

Templates use the same mechanism as scripts:

- Async template root creates a `CommandBuffer` and declares a text `Output` via `runtime.declareOutput(frame, "text", "text", context, null)`
- Output registers itself in buffer: `buffer._outputs.set("text", textOutput)`
- Compiler emits `TextCommand` writes via `buffer.addText()`
- Template `{{ expression }}` output goes through `suppressValueAsync` → `TextCommand`
- Chain is built incrementally as template executes
- Final result obtained via `flattenBuffer(output)` after `astate.waitAllClosures()`

**Sync template mode** remains string-based (`output += ...`) and is unaffected.

---

## 4. Current Implementation State

### ✅ Phase 1 Complete

All Phase 1 components have been implemented and tested. **Test results: 2276/2343 passing (97.1%)**

| Component | File | Status |
|-----------|------|--------|
| Command base with `next` field | `commands.js` | ✅ Done, tested |
| All Command subclasses with `apply()` | `commands.js` | ✅ Done, tested |
| `CommandBuffer.add()` with incremental chaining | `buffer.js` | ✅ Done, tested |
| `CommandBuffer.fillSlot()` with incremental chaining | `buffer.js` | ✅ Done, tested |
| `CommandBuffer.firstCommand(handlerName)` | `buffer.js` | ✅ Done, tested |
| `CommandBuffer.lastCommand(handlerName)` | `buffer.js` | ✅ Done, tested |
| `CommandBuffer.markFinishedAndPatchLinks()` | `buffer.js` | ✅ Updated, tested |
| Output classes with `_target`, `_base`, `_buffer` | `output.js` | ✅ Done, tested |
| `flattenBuffer()` — chain-walk flatten | `flatten-buffer.js` | ✅ Done, tested |
| `declareOutput()` with registry | `output.js` | ✅ Done, tested |
| Buffer `_outputs` registry | `buffer.js` | ✅ Done, tested |
| Buffer `_lastChainedIndex` | `buffer.js` | ✅ Done, tested |
| Buffer `_lastIndexIsChained` | `buffer.js` | ✅ Done, tested |
| Output `_firstChainedCommand` | `output.js` | ✅ Done, tested |
| Output `_lastChainedCommand` | `output.js` | ✅ Done, tested |
| `_tryAdvanceChain()` method | `buffer.js` | ✅ Done, tested |
| `_advanceChainFrom()` method | `buffer.js` | ✅ Done, tested |
| `_chainCommand()` method | `buffer.js` | ✅ Done, tested |
| `_checkFullyChained()` method | `buffer.js` | ✅ Done, tested |
| `_notifyParentChained()` method | `buffer.js` | ✅ Done, tested |
| `_childBufferChained()` method | `buffer.js` | ✅ Done, tested |
| OUTPUT_API_PROPS with chain fields | `output.js` | ✅ Done, tested |

### Additional Components (Beyond Original Plan)

| Component | File | Purpose |
|-----------|------|---------|
| `_advanceChainFromWithDemandBuild()` | `buffer.js` | Recursive chain building for legacy tests |
| `_linkChildBufferCommands()` | `buffer.js` | Helper for on-demand nested buffer linking |
| `buildChainOnDemand()` | `flatten-buffer.js` | Fallback for tests that bypass declareOutput |
| Output self-registration | `output.js` | Outputs register themselves in constructor |

---

## 5. Implementation Plan

### Phase 1: Incremental Chain Construction

**Goal**: Build complete command chains incrementally as commands are added. Chains are guaranteed complete by flatten time, enabling simple chain-walk flatten.

**Changes**:

1. **Add data structures** to `buffer.js`:
   ```javascript
   // In CommandBuffer constructor:
   this._outputs = parent ? parent._outputs : new Map();
   this._lastChainedIndex = new Map();
   this._lastIndexIsChained = new Map();
   ```

2. **Add data structures** to `output.js`:
   ```javascript
   // In Output constructors:
   this._firstChainedCommand = null;
   this._lastChainedCommand = null;
   ```

3. **Update `declareOutput()`** in `output.js`:
   ```javascript
   // Register output in buffer's registry
   if (!buffer._outputs) buffer._outputs = new Map();
   buffer._outputs.set(outputName, output);
   ```

4. **Implement chain advancement** in `buffer.js`:
   - `_tryAdvanceChain(handlerName, position)`
   - `_advanceChainFrom(handlerName, startPos)`
   - `_chainCommand(handlerName, command)`

5. **Implement child notification** in `buffer.js`:
   - `_notifyParentChained(handlerName)`
   - `_childBufferChained(child, handlerName)`
   - `_checkFullyChained(handlerName)`
   - `_isFullyChained(handlerName)`

6. **Update `add()` and `fillSlot()`** in `buffer.js`:
   ```javascript
   // After storing command in array:
   this._tryAdvanceChain(handlerName, slot);
   ```

7. **Update `markFinishedAndPatchLinks()`** in `buffer.js`:
   ```javascript
   // Replace existing link patching with:
   this.finished = true;
   for (const handlerName in this.arrays) {
     this._checkFullyChained(handlerName);
   }
   ```

8. **Update `flattenBuffer()`** in `flatten-buffer.js`:
   ```javascript
   // Replace tree-walk with chain-walk:
   let current = output._firstChainedCommand;
   while (current) {
     // apply, collect errors
     current = current.next;
   }
   ```

**Testing**: All existing tests must pass (2314 tests). Chain is complete by flatten time, so behavior is identical to tree-walk.

**Risk**: Low. Algorithm guarantees complete chains. If issues arise, can compare chain structure with tree-walk structure.

---

## 6. Test Strategy

### Existing Tests (Must All Pass)

All 2314+ existing tests must continue passing:
- `tests/explicit-outputs.js` — Script output tests (data, text, value, sink, macros, scoping, async, errors)
- `tests/pasync/*.js` — Async parallelism tests
- `tests/poison/*.js` — Error handling tests
- `tests/script.js` — Script mode tests

### New Unit Tests (Phase 1)

**Chain construction tests**:
- Manually build CommandBuffer with commands and nested buffers
- Verify `_lastChainedIndex` and `_lastIndexIsChained` advance correctly
- Verify chain endpoints (`_firstChainedCommand`, `_lastChainedCommand`) are correct
- Verify child buffer notification flow

**Edge cases**:
- Empty arrays (no commands for handler)
- Out-of-order slot filling (fill slot 2, then slot 1)
- Empty child buffers (no commands for handler)
- Deeply nested buffers (4+ levels)
- Multiple handlers in same buffer

**Chain verification pattern**:
```javascript
const chain = [];
let cmd = output._firstChainedCommand;
while (cmd) {
  chain.push(cmd.handler);
  cmd = cmd.next;
}
expect(chain).to.eql(['text', 'text', 'text']);
```

---

## 7. Future Considerations

### Point-in-Time Snapshots (Phase 2)

The complete chain architecture enables point-in-time snapshots:
- Insert `SnapshotCommand` at specific positions in chain
- `snapshot()` returns value/promise based on chain state at that position
- Requires incremental resolution (apply commands as chained)

### Copy-on-Write (Phase 3)

Ensure snapshot immutability:
- Add `_snapshotTaken` flag to Output
- Before applying command after snapshot, deep-copy accumulator
- Prevents subsequent mutations from affecting snapshot references

### Streaming Output (Future)

Chain architecture supports streaming:
- Apply commands as they're chained (incremental resolution)
- Stream text fragments as they're applied
- Useful for large template rendering

### Early Return (Future)

Insert `SnapshotCommand` at return position, resolve script with that value. Commands added after return are ignored.

---

## Appendix: Key File Reference

| File | Role |
|------|------|
| `src/runtime/commands.js` | Command class hierarchy, `apply()` implementations |
| `src/runtime/buffer.js` | CommandBuffer, chain tracking, add/fill/finish methods |
| `src/runtime/flatten-buffer.js` | `flattenBuffer()` — chain-walk implementation |
| `src/runtime/output.js` | Output classes, `snapshot()`, `declareOutput()`, chain endpoints |
| `src/runtime/async-state.js` | `asyncBlock()` lifecycle, calls `markFinishedAndPatchLinks()` |
| `src/runtime/errors.js` | `PoisonError`, `isPoison()`, `isPoisonError()` |
| `src/script/data-handler.js` | `DataHandler` — target for `@data` commands |
| `tests/explicit-outputs.js` | Comprehensive script output tests |
