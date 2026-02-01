# Command Chain with Next Pointers - Implementation Reference

**Status:** ✅ Phase 1 Complete - This document describes the completed implementation, updated to reflect actual implementation vs original plan.

## Big Picture Context

Cascada is being refactored to support proper incremental snapshots of output handlers (data/text/value). The snapshot mechanism will work by:
1. Building a linked chain of commands with `next` pointers (THIS PHASE)
2. Later: Adding resolution propagation and promises to support incremental materialization
3. Later: Implementing proper snapshot() that returns current state cheaply

This phase focuses solely on building the command chains. The chains will later be used by flatten operations and snapshot resolution, but for now we just need to build them correctly and verify with existing tests.

**Key architectural points:**
- Each output handler (data, text, value) maintains its own independent command chain
- CommandBuffers are NOT in the chain - they are containers; only actual commands are linked
- Commands are wrapped in objects with metadata (type, value, next, resolved, etc.)
- In async mode: everything is wrapped in command objects
- In non-async mode: keep current simple string-based approach (no changes needed)

## Files Modified

### Primary Files
1. **src/runtime/buffer.js** - CommandBuffer class with command wrapping and linking
2. **src/runtime/buffer-snapshot.js** - NEW MODULE: Chain building logic (firstCommand, lastCommand, markFinishedAndPatchLinks, etc.)
3. **src/runtime/async-state.js** - AsyncState.asyncBlock() method with chain patching
4. **src/runtime/checks.js** - Added checkFinishedBuffer() runtime check
5. **src/compiler/compile-emit.js** - Updated to use `.arrays` namespace
6. **src/compiler/compiler.js** - Removed asyncMode parameters
7. **src/compiler/compile-buffer.js** - Removed asyncMode parameters
8. **src/runtime/flatten-commands.js** - Removed asyncMode checks, uses traverseChain()

### Context Files (read but don't modify yet)
- **src/runtime/flatten-buffer.js** - Will be updated in next phase to use chains
- **src/runtime/flatten-text.js** - Will be updated in next phase
- **src/runtime/flatten-commands.js** - Will be updated in next phase

## Detailed Implementation Requirements

### 1. Command Object Structure (buffer.js)

In **async mode only**, wrap all output elements (strings, functions, command objects) in a uniform command structure:

```javascript
// Command object structure:
{
  type: 'command' | 'text' | 'function' | 'poison',
  value: <the actual content - string, function, or command object>,
  next: <reference to next command in chain, initially null>,
  resolved: false,  // Will be used in future phase
  promise: null,    // Will be used in future phase
  resolve: null     // Will be used in future phase
}
```

**Non-async mode:** No changes - continue using plain strings and existing structure.

### 2. CommandBuffer Structure Updates (buffer.js)

**Implemented structure:**

```javascript
class CommandBuffer {
  constructor(context, parent = null) {
    this._context = context;
    this.parent = parent;  // Parent CommandBuffer reference
    this.positions = new Map();  // Map<handlerName, index in parent array>
    this.finished = false;  // Flag to prevent adding after completion
    this[COMMAND_BUFFER_SYMBOL] = true;  // Symbol for type checking

    // All output arrays under explicit namespace
    this.arrays = {
      output: [],
      data: [],
      text: [],
      value: []
    };

    this._index = 0;
    this._outputTypes = Object.create(null);
    this._outputIndexes = Object.create(null);
    this._outputArrays = this.arrays;
  }
}
```

**Note:** Backward compatibility properties (`this.output`, `this.data`, etc.) were removed during refactoring. All code uses `this.arrays.*` namespace exclusively.

**Key methods implemented:**

**Type Checking (Symbol-based):**
Uses `Symbol.for()` for robust cross-module type checking:
```javascript
const COMMAND_BUFFER_SYMBOL = Symbol.for('cascada.CommandBuffer');
const WRAPPED_COMMAND_SYMBOL = Symbol.for('cascada.WrappedCommand');

function isCommandBuffer(value) {
  return value && typeof value === 'object' && value[COMMAND_BUFFER_SYMBOL] === true;
}

function isWrappedCommand(value) {
  return value && typeof value === 'object' && value[WRAPPED_COMMAND_SYMBOL] === true;
}
```

**In buffer.js:**
```javascript
// Wrap value in command object (always wraps in async mode)
_wrapCommand(value) {
  // Already wrapped - return as-is
  if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
    return value;
  }

  // CommandBuffer and arrays pass through unwrapped
  if (value instanceof CommandBuffer || Array.isArray(value)) {
    return value;
  }

  // Wrap primitives, functions, command objects, poison markers
  // Everything else passes through
  return {
    [WRAPPED_COMMAND_SYMBOL]: true,
    type: /* 'text' | 'function' | 'command' | 'poison' */,
    value: value,
    next: null,
    resolved: false,
    promise: null,
    resolve: null
  };
}
```

**In buffer-snapshot.js (separate module):**
```javascript
// Track position when adding buffer to parent
function setParentPosition(handlerName, index) {
  this.positions.set(handlerName, index);
}

// Find first actual command in handler array (recursive through nested buffers)
function firstCommand(handlerName) {
  const arr = this.arrays[handlerName];
  if (!arr || arr.length === 0) return null;

  for (const item of arr) {
    if (isWrappedCommand(item)) return item;
    if (isCommandBuffer(item)) {
      const nestedFirst = item.firstCommand(handlerName);
      if (nestedFirst) return nestedFirst;
    }
  }
  return null;
}

// Find last actual command (similar recursive logic)
function lastCommand(handlerName) { /* ... */ }

// Called when async block completes - patches next pointers
function markFinishedAndPatchLinks() {
  this.finished = true;
  if (!this.parent) return;

  for (const [handlerName, position] of this.positions.entries()) {
    const parentArray = this.parent.arrays[handlerName];
    if (!parentArray) continue;

    const firstCmd = this.firstCommand(handlerName);
    const lastCmd = this.lastCommand(handlerName);

    // Link backward: previous element → this.first
    if (position > 0 && firstCmd) {
      const prev = parentArray[position - 1];
      if (isWrappedCommand(prev)) {
        prev.next = firstCmd;
      } else if (isCommandBuffer(prev) && prev.finished) {
        const prevLast = prev.lastCommand(handlerName);
        if (prevLast) prevLast.next = firstCmd;
      }
    }

    // Link forward: this.last → next element
    if (position < parentArray.length - 1 && lastCmd) {
      const next = parentArray[position + 1];
      if (isWrappedCommand(next)) {
        lastCmd.next = next;
      } else if (isCommandBuffer(next) && next.finished) {
        const nextFirst = next.firstCommand(handlerName);
        if (nextFirst) lastCmd.next = nextFirst;
      }
    }
  }
}

// Helper functions for linking during add/fillSlot
function linkToPrevious(prev, current, handlerName) { /* ... */ }
function linkToNext(current, next, handlerName) { /* ... */ }
function patchLinksAfterClear(buffer) { /* ... guard recovery */ }
```

**Note:** Chain building logic separated into `buffer-snapshot.js` module and imported into CommandBuffer class. Methods called via `.call(this, ...)` delegation.

**Implemented add() method:**

```javascript
add(value, outputName = null) {
  // Check if buffer is finished
  checkFinishedBuffer(this);

  const slot = this._reserveSlot(outputName);
  const target = this._getOutputArray(outputName);

  // Always wrap in command object (CommandBuffers only exist in async mode)
  const wrappedValue = this._wrapCommand(value);

  // Link to previous command
  if (target.length > 0) {
    const prev = target[target.length - 1];
    linkToPrevious(prev, wrappedValue, outputName || 'output');
  }

  target[slot] = wrappedValue;

  // If adding a CommandBuffer as child, set up parent relationship
  if (wrappedValue instanceof CommandBuffer) {
    wrappedValue.parent = this;
    wrappedValue._setParentPosition(outputName || 'output', slot);
  }

  return slot;
}
```

**Note:** No `_shouldWrap()` check needed - CommandBuffers only exist in async mode, so always wrap.

**When adding a nested CommandBuffer to a parent:**

```javascript
// Somewhere in the code that creates child buffers and adds them to parent
childBuffer.parent = parentBuffer;
const index = parentBuffer.arrays[handlerName].length;
parentBuffer.arrays[handlerName].push(childBuffer);
childBuffer._setParentPosition(handlerName, index);
```

**Handle guard recover**
When a guard recovers from a poisoned output, its CommandBuffer is cleared with clearBuffer.
The next chains has to be updated to skip the CommandBuffer.

### 3. Async State Patching (async-state.js)

**Implemented asyncBlock() method:**

```javascript
asyncBlock(func, runtime, f, readVars, writeCounts, usedOutputs, cb, lineno, colno, context, errorContextString = null, isExpression = false, sequentialAsyncBlock = false) {
  // ... parameter handling ...

  const childFrame = f.pushAsyncBlock(readVars, writeCounts, sequentialAsyncBlock, usedOutputs);
  const checkInfo = createCheckInfo(cb, runtime, lineno, colno, errorContextString, context);
  const childState = this._enterAsyncBlock(childFrame);
  childState.checkInfo = checkInfo;
  if (checkInfo) {
    childFrame.checkInfo = checkInfo;
  }

  // Single promise variable, simplified chain
  const promise = func(childState, childFrame)
    .then((result) => {
      // Patch command chain when async function completes
      if (childFrame._outputBuffer) {
        childFrame._outputBuffer.markFinishedAndPatchLinks();
      }
      return result;
    })
    .finally(() => {
      // Ensure per-block finalization always runs
      if (sequentialAsyncBlock) {
        childFrame._commitSequentialWrites();
      }
      childState._leaveAsyncBlock();
    });

  // Report fatal errors (side-effect only - doesn't suppress rejection)
  promise.catch(err => {
    if (err instanceof runtime.RuntimeFatalError) {
      cb(err);
    }
  });

  return promise;
}
```

**Implementation notes:**
- No try/catch wrapper needed - async functions return rejected promises, don't throw synchronously
- Single promise variable (simplified from 3 intermediate variables in initial plan)
- `.catch()` attached as side-effect handler - doesn't affect returned promise chain
- Patching happens in `.then()` before `.finally()` cleanup

### 4. Runtime Checks (checks.js)

Add a new check function:

```javascript
/**
 * Check if trying to add command to finished CommandBuffer
 * This prevents race conditions where commands are added after the buffer
 * has completed its async block and patched its links.
 */
function checkFinishedBuffer(buffer) {
  if (buffer && buffer.finished) {
    throw new Error(
      'Cannot add command to finished CommandBuffer. ' +
      'This indicates a timing issue where commands are being added after ' +
      'the async block has completed.'
    );
  }
}

module.exports = {
  // ... existing exports ...
  checkFinishedBuffer
};
```

Call this check in `CommandBuffer.add()` and related methods before adding elements.

### 5. Testing Strategy

**Verification:**
- Run existing test suite - all tests should pass
- The chains are built but not yet used (flatten still uses arrays)
- Tests verify that command wrapping doesn't break functionality
- Tests verify buffer finishing logic works correctly

**Add debug helper (optional):**
```javascript
// In CommandBuffer for debugging chain structure
debugChain(handlerName) {
  const first = this.firstCommand(handlerName);
  let cmd = first;
  const chain = [];
  while (cmd) {
    chain.push(cmd.type || 'unknown');
    cmd = cmd.next;
  }
  return chain;
}
```

### 7. Migration Notes

**What changed:**
- CommandBuffer gains parent/positions tracking
- Commands always wrapped in objects (CommandBuffers only exist in async mode)
- Symbol-based type checking (`COMMAND_BUFFER_SYMBOL`, `WRAPPED_COMMAND_SYMBOL`)
- Next pointers set when commands added and buffers finish
- Buffers marked finished after async completion
- Chain building logic separated into `buffer-snapshot.js` module
- asyncMode parameter removed (unnecessary - CommandBuffers imply async)
- Backward compatibility properties (`this.output`, etc.) removed
- Promise chain in asyncBlock() simplified to single variable
- Try/catch wrapper removed from asyncBlock() (async functions can't throw sync)

**What stayed the same:**
- Flatten operations still use array iteration (will change in next phase)
- Non-async mode unchanged (no CommandBuffer infrastructure)
- All existing APIs remain compatible
- Test behavior identical - all 2225 tests pass

### 8. Edge Cases to Handle

1. **Empty buffers:** firstCommand/lastCommand return null - patching skips gracefully
2. **Root buffer:** Has parent=null, positions empty - markFinished does nothing
3. **Nested CommandBuffers:** firstCommand/lastCommand recurse to find actual commands
4. **Concurrent sibling buffers:** Each patches independently, order doesn't matter
5. **Poison markers:** Should be wrapped as command objects with type='poison'

### 9. Arrays Structure Reference

**Implemented structure within CommandBuffer:**
```javascript
// All arrays under explicit namespace:
this.arrays = {
  output: [],
  data: [],
  text: [],
  value: []
};

// Reference stored for convenience:
this._outputArrays = this.arrays;
```

**Note:** Backward compatibility properties (`this.output`, `this.data`, etc.) were removed during refactoring. All access goes through `this.arrays.*` or `this._outputArrays.*` namespaces.

## Actual Implementation Results

Phase 1 completed successfully:
- ✅ All commands wrapped in command objects with Symbol-based type checking
- ✅ Command chains built with next pointers for each handler
- ✅ Buffers track parent/position relationships
- ✅ Patching happens automatically when async blocks complete
- ✅ Runtime checks prevent adding to finished buffers
- ✅ All existing tests pass (2225/2225)
- ✅ Chain building logic modularized in buffer-snapshot.js
- ✅ asyncMode parameter eliminated (unnecessary)
- ✅ Backward compatibility properties removed, `.arrays` namespace used throughout
- ✅ Promise chain simplified in asyncBlock()
- ⏳ Flatten operations beginning to use chains via traverseChain() (hybrid approach)
- ⏳ Snapshot mechanism not yet implemented (future phase)

## Implementation Decisions

**Questions resolved during implementation:**

1. **Command wrapping and double-wrapping:**
   - ✅ YES - `_wrapCommand()` checks if already wrapped: `if (value && typeof value === 'object' && 'type' in value && 'value' in value) return value;`
   - Also passes through CommandBuffers and arrays unwrapped

2. **Global flag for chain building:**
   - ✅ SIMPLIFIED - No flag needed. CommandBuffers only exist in async mode, so always build chains.
   - asyncMode parameter removed entirely

3. **Special handling for markers:**
   - ✅ YES - Poison markers wrapped as command objects with `type: 'poison'`
   - Revert mechanism simplified to not need special chain handling

4. **Debug logging:**
   - ✅ YES - Added `debugChain(handlerName)` method that returns array of command types in chain
   - Available for debugging but not actively used in production code

**Result:** Phase 1 complete with all tests passing (2225/2225). Chain structure built and ready for next phase.