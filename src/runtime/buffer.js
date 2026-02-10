'use strict';

const { ErrorCommand, TextCommand } = require('./commands');

const { patchLinksAfterClear } = require('./buffer-snapshot');

const { checkFinishedBuffer } = require('./checks');

// Unique symbols for type identification
const COMMAND_BUFFER_SYMBOL = Symbol.for('cascada.CommandBuffer');

class CommandBuffer {
  constructor(context, parent = null) {
    this._context = context;
    this.parent = parent;
    this.positions = new Map();
    this.finished = false;
    this[COMMAND_BUFFER_SYMBOL] = true;

    // Create arrays namespace (handlers created lazily on first write/snapshot).
    this.arrays = Object.create(null);
    // `_outputTypes` is script-only metadata used by the flattener to interpret
    // explicit output handler types. Templates don't need it.
    this._outputIndexes = Object.create(null);

    // Incremental chain construction data structures
    // Shared registry of Output objects for this buffer hierarchy
    this._outputs = parent ? parent._outputs : new Map();
    // Track last chained index for each handler (per-buffer, per-handler)
    this._lastChainedIndex = new Map();
    // Track whether the last chained index has a chained command (per-buffer, per-handler)
    this._lastIndexIsChained = new Map();
    // Local chain endpoints for this buffer segment (per handler).
    // Only the root buffer mirrors these to Output._first/_last endpoints.
    this._firstLocalChainedCommand = new Map();
    this._lastLocalChainedCommand = new Map();
  }

  // Snapshot and command chain methods
  _registerOutput(handlerName, output) {
    if (!(this._outputs instanceof Map)) {
      this._outputs = new Map();
    }
    this._outputs.set(handlerName, output);

    // If commands were already chained before this output was registered,
    // bind this output to the existing local chain segment.
    if (!this.parent) {
      output._firstChainedCommand = this._firstLocalChainedCommand.get(handlerName) || null;
      output._lastChainedCommand = this._lastLocalChainedCommand.get(handlerName) || null;
    }
  }

  _setParentPosition(handlerName, index) {
    this.positions.set(handlerName, index);
  }

  firstCommand(handlerName) {
    const arr = this.arrays[handlerName];
    if (!arr || arr.length === 0) {
      return null;
    }

    for (const item of arr) {
      if (item == null) {
        continue; // skip unfilled slots in sparse arrays
      }
      if (!isCommandBuffer(item)) {
        return item;
      }
      const nestedFirst = item.firstCommand(handlerName);
      if (nestedFirst) {
        return nestedFirst;
      }
    }

    return null;
  }

  lastCommand(handlerName) {
    const arr = this.arrays[handlerName];
    if (!arr || arr.length === 0) {
      return null;
    }

    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (item == null) {
        continue; // skip unfilled slots in sparse arrays
      }
      if (!isCommandBuffer(item)) {
        return item;
      }
      const nestedLast = item.lastCommand(handlerName);
      if (nestedLast) {
        return nestedLast;
      }
    }

    return null;
  }

  markFinishedAndPatchLinks() {
    // Do not recursively finish child buffers.
    // Each child buffer is finished by its own async block lifecycle.

    this.finished = true;

    // Check all handlers to see if they're fully chained now that buffer is finished
    // This handles the "finish-then-chain" scenario
    if (this._outputs instanceof Map) {
      for (const [handlerName] of this._outputs) {
        this._checkFullyChained(handlerName);
      }
    }

    // No legacy next-pointer patching here.
    // In incremental mode, _chainCommand is the single source of truth.
  }

  debugChain(handlerName) {
    const first = this.firstCommand(handlerName);
    let cmd = first;
    const chain = [];
    while (cmd) {
      chain.push(cmd.handler || 'unknown');
      cmd = cmd.next;
    }
    return chain;
  }

  traverseChain(handlerName, processCommand) {
    let current = this.firstCommand(handlerName);
    if (!current) {
      return false;
    }

    while (current) {
      processCommand(current);
      current = current.next;
    }

    return true;
  }

  // Incremental chain construction methods

  /**
   * Try to advance the chain for the given handler starting from the specified position.
   * Only advances if the position is exactly the next sequential position after the last chained index,
   * and the last chained index is fully chained (not a gap).
   */
  _tryAdvanceChain(handlerName, position) {
    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

    // If chain is contiguous, we can only advance from the next index.
    // If blocked on a gap, we can only resume by filling that exact gap index.
    const expectedPosition = lastChained ? (lastIdx + 1) : lastIdx;
    if (position !== expectedPosition) {
      return;
    }

    this._advanceChainFrom(handlerName, position);
  }

  /**
   * Advance the chain from the given index, linking consecutive commands/buffers.
   * Continues until hitting a gap (null slot) or end of array.
   */
  _advanceChainFrom(handlerName, fromIndex) {
    const arr = this.arrays[handlerName];
    if (!arr) return;

    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;
    // Ignore redundant re-advances over already fully chained positions.
    if (lastChained && fromIndex <= lastIdx) {
      return;
    }

    let prev = this._lastLocalChainedCommand.get(handlerName) || null;
    let i = fromIndex;

    while (i < arr.length) {
      const item = arr[i];

      if (item == null) {
        // Hit a gap - stop advancing but record this position
        this._lastChainedIndex.set(handlerName, i);
        this._lastIndexIsChained.set(handlerName, false);
        return;
      }

      if (isCommandBuffer(item)) {
        // Child buffer: only proceed once it is fully chained for this handler.
        // Then splice its local command segment (if any) into the parent chain.
        if (!item._isFullyChained(handlerName)) {
          this._lastChainedIndex.set(handlerName, i);
          this._lastIndexIsChained.set(handlerName, false);
          return;
        }

        const childFirst = item.firstCommand(handlerName);
        const childLast = item.lastCommand(handlerName);
        if (childFirst && childLast) {
          prev = this._chainRange(childFirst, childLast, prev, handlerName);
          prev = childLast;
        }
      } else {
        // Regular command
        prev = this._chainCommand(item, prev, handlerName);
      }

      i++;
    }

    // Successfully advanced through all remaining elements
    this._lastChainedIndex.set(handlerName, i - 1);
    this._lastIndexIsChained.set(handlerName, true);

    // Check if buffer is now fully chained
    this._checkFullyChained(handlerName);
  }

  /**
   * Link a command into the chain and update Output endpoints.
   */
  _chainCommand(cmd, prev, handlerName) {
    this._chainRange(cmd, cmd, prev, handlerName);
    return cmd;
  }

  _chainRange(firstCmd, lastCmd, prev, handlerName) {
    if (prev) {
      prev.next = firstCmd;
    } else {
      this._firstLocalChainedCommand.set(handlerName, firstCmd);
      if (!this.parent) {
        const output = this._outputs?.get(handlerName);
        if (output) {
          output._firstChainedCommand = firstCmd;
        }
      }
    }

    this._lastLocalChainedCommand.set(handlerName, lastCmd);
    if (!this.parent) {
      const output = this._outputs?.get(handlerName);
      if (output) {
        output._lastChainedCommand = lastCmd;
      }
    }

    return lastCmd;
  }

  /**
   * Notify parent buffer that this buffer's chain is fully constructed for the given handler.
   */
  _notifyParentChained(handlerName) {
    if (!this.parent) return;

    const position = this.positions.get(handlerName);
    if (position === undefined) return;

    this.parent._childBufferChained(handlerName, position);
  }

  /**
   * Called when a child buffer at the given position becomes fully chained.
   * Attempts to continue advancing the chain from that position.
   */
  _childBufferChained(handlerName, position) {
    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

    const expectedPosition = lastChained ? (lastIdx + 1) : lastIdx;
    // Advance if this notification unblocks the exact position we were waiting on.
    if (position === expectedPosition) {
      this._advanceChainFrom(handlerName, position);
    }
  }

  /**
   * Check if the buffer is fully chained for the given handler and notify parent if so.
   */
  _checkFullyChained(handlerName) {
    const arr = this.arrays[handlerName];
    if (!arr) {
      // No writes for this handler in this buffer. Once finished, this handler
      // is trivially fully chained and parent progression can continue.
      if (!this.finished) {
        return;
      }
      this._notifyParentChained(handlerName);
      return;
    }

    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

    // Fully chained if: last index is the end of the array, it's chained, and buffer is finished
    const isFullyChained = (lastIdx === arr.length - 1) && lastChained && this.finished;

    if (isFullyChained) {
      this._notifyParentChained(handlerName);
    }
  }

  _isFullyChained(handlerName) {
    if (!this.finished) {
      return false;
    }

    const arr = this.arrays[handlerName];
    if (!arr) {
      return true;
    }

    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;
    return (lastIdx === arr.length - 1) && lastChained;
  }

  reserveSlot(outputName) {
    if (this._outputIndexes[outputName] === undefined) {
      this._outputIndexes[outputName] = 0;
    }
    if (!this.arrays[outputName]) {
      this.arrays[outputName] = [];
    }
    return this._outputIndexes[outputName]++;
  }

  _setOutputIndex(outputName, nextIndex) {
    this._outputIndexes[outputName] = nextIndex;
  }

  addText(value, pos = null, outputName = 'text') {
    const textPos = pos && typeof pos === 'object'
      ? pos
      : { lineno: 0, colno: 0 };
    return this.add(new TextCommand({
      handler: 'text',
      args: [value],
      pos: textPos
    }), outputName);
  }

  addPoison(errors, outputName) {
    const errs = Array.isArray(errors) ? errors : [errors];
    return this.add(new ErrorCommand(errs), outputName);
  }

  add(value, outputName) {
    // Check if buffer is finished
    checkFinishedBuffer(this);

    const slot = this.reserveSlot(outputName);
    const target = this.arrays[outputName];

    target[slot] = value;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (value instanceof CommandBuffer) {
      value.parent = this;
      value._setParentPosition(outputName, slot);
      // Share outputs when attaching so child chaining can resolve Output objects.
      // Only re-run retroactive chaining when the shared registry actually changed.
      if (value._outputs !== this._outputs) {
        value._outputs = this._outputs;
        value._advanceChainFrom(outputName, 0);
      }
    }

    // Try to advance the chain incrementally
    this._tryAdvanceChain(outputName, slot);

    return slot;
  }

  fillSlot(slot, value, outputName) {
    // Don't check finished here - fillSlot fills pre-reserved slots
    // that may have been reserved before the buffer was marked finished
    const target = this.arrays[outputName];

    target[slot] = value;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (value instanceof CommandBuffer) {
      value.parent = this;
      value._setParentPosition(outputName, slot);
      if (value._outputs !== this._outputs) {
        value._outputs = this._outputs;
        value._advanceChainFrom(outputName, 0);
      }
    }

    // Try to advance the chain incrementally (filling a gap may unblock chain advancement)
    this._tryAdvanceChain(outputName, slot);
  }
}

// Check if value is a CommandBuffer using symbol
// @todo, get rif of this, use instanceof instead
function isCommandBuffer(value) {
  return value && typeof value === 'object' && value[COMMAND_BUFFER_SYMBOL] === true;
}

/*
 * @param {CommandBuffer} buffer - The buffer to clear
 * @param {Array<string>} handlerNames - Names of handlers to clear (optional)
 * @returns {void}
 * Clear buffer contents for guard error recovery
 This is used by guards to discard output when an error occurs
If no handler names are provided, all handlers are cleared.
 */
function clearBuffer(buffer, handlerNames = null) {
  if (!buffer) {
    return;
  }

  if (buffer instanceof CommandBuffer) {
    const names = handlerNames || Object.keys(buffer.arrays);
    names.forEach((name) => {
      if (buffer.arrays[name]) {
        buffer.arrays[name].length = 0;
        buffer._setOutputIndex(name, 0);
      }
      buffer._lastChainedIndex.delete(name);
      buffer._lastIndexIsChained.delete(name);
      buffer._firstLocalChainedCommand.delete(name);
      buffer._lastLocalChainedCommand.delete(name);
    });

    // Update next chains to skip this buffer if it has a parent
    patchLinksAfterClear(buffer);

    return;
  }

  // For non-CommandBuffer arrays
  if (Array.isArray(buffer)) {
    buffer.length = 0;
  }
}

function getPosonedBufferErrors(buffer, allowedHandlers = null) {
  const allErrors = [];
  if (!buffer || !(buffer instanceof CommandBuffer)) return allErrors;
  if (Array.isArray(allowedHandlers) && allowedHandlers.length === 0) return allErrors;

  const names = allowedHandlers || Object.keys(buffer.arrays);
  names.forEach((name) => {
    const arr = buffer.arrays[name];
    if (arr) {
      arr.forEach((item) => {
        if (item instanceof CommandBuffer) {
          allErrors.push(...getPosonedBufferErrors(item, allowedHandlers));
        } else {
          const err = item.getError();
          if (err) {
            allErrors.push(...err.errors);
          }
        }
      });
    }
  });
  return allErrors;
}

module.exports = {
  CommandBuffer,
  clearBuffer,
  getPosonedBufferErrors,
  isCommandBuffer,
  COMMAND_BUFFER_SYMBOL
};

