# Prompt for AI Coding Agent: Implement Command Chain with Next Pointers

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

## Files to Modify

### Primary Files
1. **src/runtime/buffer.js** - CommandBuffer class
2. **src/runtime/async-state.js** - AsyncState.asyncBlock() method
3. **src/runtime/checks.js** - Add new runtime checks
4. **src/compiler/compile-emit.js** - May need minor updates to command emission

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

Add to the CommandBuffer class:

```javascript
class CommandBuffer {
  constructor(context, parent = null) {
    this._context = context;
    this.parent = parent;  // NEW: parent CommandBuffer reference
    this.positions = new Map();  // NEW: Map<handlerName, index in parent array>
    this.finished = false;  // NEW: flag to prevent adding after completion

    // Move all output arrays under explicit namespace
    this.arrays = {};  // NEW: this.arrays.data, this.arrays.text, etc.
    // Note: keep backward compatibility properties pointing to arrays

    this._index = 0;
    this._outputTypes = Object.create(null);
    this._outputIndexes = Object.create(null);
    // ... rest of existing properties
  }
}
```

**Key methods to add:**

```javascript
// Wrap value in command object (async mode only)
_wrapCommand(value, handlerName) {
  // If already a command object, return as-is
  // Otherwise wrap based on type
}

// Track position when adding buffer to parent
_setParentPosition(handlerName, index) {
  this.positions.set(handlerName, index);
}

// Find first actual command in handler array (recursive through nested buffers)
firstCommand(handlerName) {
  // Return first command, recursing into CommandBuffers if needed
  // Return null if empty
}

// Find last actual command in handler array (recursive)
lastCommand(handlerName) {
  // Return last command, recursing into CommandBuffers if needed
  // Return null if empty
}

// Called when async block completes - patches next pointers
markFinishedAndPatchLinks() {
  this.finished = true;

  if (!this.parent) return; // Root buffer needs no patching

  // For each handler this buffer has position in:
  for (const [handlerName, position] of this.positions.entries()) {
    const parentArray = this.parent.arrays[handlerName];
    if (!parentArray) continue;

    const firstCmd = this.firstCommand(handlerName);
    const lastCmd = this.lastCommand(handlerName);

    // Link backward: previous element → this.first
    if (position > 0 && firstCmd) {
      const prev = parentArray[position - 1];
      if (prev.type) { // prev is command
        prev.next = firstCmd;
      } else if (prev instanceof CommandBuffer && prev.finished) {
        const prevLast = prev.lastCommand(handlerName);
        if (prevLast) prevLast.next = firstCmd;
      }
    }

    // Link forward: this.last → next element
    if (position < parentArray.length - 1 && lastCmd) {
      const next = parentArray[position + 1];
      if (next.type) { // next is command
        lastCmd.next = next;
      } else if (next instanceof CommandBuffer && next.finished) {
        const nextFirst = next.firstCommand(handlerName);
        if (nextFirst) lastCmd.next = nextFirst;
      }
    }
  }
}
```

**Update existing add() method:**

```javascript
add(value, outputName = null) {
  // Check if buffer is finished - throw error if so (see checks.js)

  const slot = this._reserveSlot(outputName);
  const target = this._getOutputArray(outputName);

  // IN ASYNC MODE: wrap value in command object
  const wrappedValue = this._shouldWrap() ? this._wrapCommand(value, outputName) : value;

  // Link to previous command if it exists and is a command object
  if (target.length > 0) {
    const prev = target[target.length - 1];
    if (prev.type) { // prev is a command object
      prev.next = wrappedValue;
    }
    // If prev is CommandBuffer, linking happens when it finishes
  }

  target[slot] = wrappedValue;
  return slot;
}
```

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

In the `asyncBlock()` method, add patching call in `promise.then()`:

```javascript
asyncBlock(func, runtime, f, readVars, writeCounts, usedOutputs, cb, lineno, colno, context, errorContextString = null, isExpression = false, sequentialAsyncBlock = false) {
  // ... existing parameter handling ...

  const childFrame = f.pushAsyncBlock(readVars, writeCounts, sequentialAsyncBlock, usedOutputs);
  const checkInfo = createCheckInfo(cb, runtime, lineno, colno, errorContextString, context);
  const childState = this._enterAsyncBlock(childFrame);
  childState.checkInfo = checkInfo;
  if (checkInfo) {
    childFrame.checkInfo = checkInfo;
  }

  try {
    const promise = func(childState, childFrame);

    // NEW: Patch command chain when async function completes
    const patchedPromise = promise.then(() => {
      if (childFrame._outputBuffer) {
        childFrame._outputBuffer.markFinishedAndPatchLinks();
      }
    });

    // Check for fatal errors
    patchedPromise.catch(err => {
      if (err instanceof runtime.RuntimeFatalError) {
        cb(err);
      }
    });

    // Existing finally logic
    const wrappedPromise = patchedPromise.finally(() => {
      if (sequentialAsyncBlock) {
        childFrame._commitSequentialWrites();
      }
      childState._leaveAsyncBlock();
    });

    wrappedPromise.catch(() => { });
    return wrappedPromise;
  } catch (syncError) {
    // ... existing error handling ...
  }
}
```

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

### 5. Determining Async Mode

The wrapping should only happen in async mode. CommandBuffer needs to know if it's in async mode:

**Option 1:** Pass asyncMode flag to constructor:
```javascript
// In compile-emit.js funcBegin:
this.emit(`let ${bufferVar} = new runtime.CommandBuffer(context, null, ${this.compiler.asyncMode});`);
```

**Option 2:** Check at runtime via context/environment flag.

Choose the approach that fits better with existing patterns.

### 6. Testing Strategy

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

**What changes:**
- CommandBuffer gains parent/positions tracking
- Commands wrapped in objects (async mode only)
- Next pointers set when commands added and buffers finish
- Buffers marked finished after async completion

**What stays the same:**
- Flatten operations still use array iteration (will change in next phase)
- Non-async mode unchanged
- All existing APIs remain compatible
- Test behavior identical

### 8. Edge Cases to Handle

1. **Empty buffers:** firstCommand/lastCommand return null - patching skips gracefully
2. **Root buffer:** Has parent=null, positions empty - markFinished does nothing
3. **Nested CommandBuffers:** firstCommand/lastCommand recurse to find actual commands
4. **Concurrent sibling buffers:** Each patches independently, order doesn't matter
5. **Poison markers:** Should be wrapped as command objects with type='poison'

### 9. Files Structure Reference

The arrays structure within CommandBuffer:
```javascript
// OLD (backward compat properties still point here):
this.output = this.arrays.output = [];
this.data = this.arrays.data = [];
this.text = this.arrays.text = [];
this.value = this.arrays.value = [];

// NEW explicit namespace:
this.arrays = {
  output: [],
  data: [],
  text: [],
  value: []
}
```

## Expected Output

After this phase:
- ✅ All commands in async mode are wrapped in command objects
- ✅ Command chains built with next pointers for each handler
- ✅ Buffers track parent/position relationships
- ✅ Patching happens automatically when async blocks complete
- ✅ Runtime checks prevent adding to finished buffers
- ✅ All existing tests pass
- ⏳ Flatten operations still use arrays (next phase will use chains)
- ⏳ Snapshot mechanism not yet implemented (future phase)

## Questions to Resolve During Implementation

1. Should command wrapping check for already-wrapped commands to avoid double-wrapping?
2. Should there be a global flag/context to enable chain building, or always do it in async mode?
3. Do revert markers and poison markers need special handling in the chain?
4. Should we add logging/debugging output for chain construction (removable later)?

Please implement this phase, ensuring all existing tests continue to pass. The chain structure will be validated in the next phase when we switch flatten operations to use it.