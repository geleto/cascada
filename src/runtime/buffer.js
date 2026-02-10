'use strict';

const { ErrorCommand, TextCommand } = require('./commands');

const {
  linkToPrevious,
  linkToNext,
  patchLinksAfterClear
} = require('./buffer-snapshot');

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
  }

  // Snapshot and command chain methods
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

    // Legacy link patching (will be removed in Phase 2 when we switch to pure chain-walk)
    if (!this.parent) {
      return;
    }

    for (const [handlerName, position] of this.positions.entries()) {
      const parentArray = this.parent.arrays[handlerName];
      if (!parentArray) {
        continue;
      }

      const firstCmd = this.firstCommand(handlerName);
      const lastCmd = this.lastCommand(handlerName);

      // Find the previous command (resolving buffers and skipping unfilled slots)
      let prevCmd = null;
      if (position > 0) {
        const prev = parentArray[position - 1];
        if (prev && !isCommandBuffer(prev)) {
          prevCmd = prev;
        } else if (prev && isCommandBuffer(prev) && prev.finished) {
          prevCmd = prev.lastCommand(handlerName);
        }
      }

      // Find the next command (resolving buffers and skipping unfilled slots)
      let nextCmd = null;
      if (position < parentArray.length - 1) {
        const next = parentArray[position + 1];
        if (next && !isCommandBuffer(next)) {
          nextCmd = next;
        } else if (next && isCommandBuffer(next) && next.finished) {
          nextCmd = next.firstCommand(handlerName);
        }
      }

      if (firstCmd && lastCmd) {
        // Non-empty buffer: link prev -> firstCmd, lastCmd -> next
        if (prevCmd) {
          prevCmd.next = firstCmd;
        }
        if (nextCmd) {
          lastCmd.next = nextCmd;
        }
      } else {
        // Empty buffer for this handler: link prev directly to next, skipping this buffer
        if (prevCmd && nextCmd) {
          prevCmd.next = nextCmd;
        }
      }
    }
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

    // Can only advance if this position is the next sequential one and no gap exists
    if (position !== lastIdx + 1 || !lastChained) {
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

    const output = this._outputs?.get(handlerName);
    if (!output) return;

    let prev = output._lastChainedCommand;
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
        // Child buffer - link to its first command if it has one
        const childFirst = item._outputs?.get(handlerName)?._firstChainedCommand;
        if (childFirst) {
          prev = this._chainCommand(childFirst, prev, handlerName);
          const childLast = item._outputs?.get(handlerName)?._lastChainedCommand;
          if (childLast) {
            prev = childLast;
          }
        } else {
          // Child buffer has no chained commands yet - stop here
          this._lastChainedIndex.set(handlerName, i);
          this._lastIndexIsChained.set(handlerName, false);
          return;
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
    const output = this._outputs?.get(handlerName);
    if (!output) return cmd;

    if (prev) {
      prev.next = cmd;
    } else {
      // This is the first command in the chain
      output._firstChainedCommand = cmd;
    }

    output._lastChainedCommand = cmd;
    return cmd;
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

    // Only advance if this is the next position we were waiting for
    if (position === lastIdx + 1 && lastChained) {
      this._advanceChainFrom(handlerName, position);
    }
  }

  /**
   * Check if the buffer is fully chained for the given handler and notify parent if so.
   */
  _checkFullyChained(handlerName) {
    const arr = this.arrays[handlerName];
    if (!arr) return; // No array for this handler in this buffer

    const lastIdx = this._lastChainedIndex.get(handlerName) ?? -1;
    const lastChained = this._lastIndexIsChained.get(handlerName) ?? true;

    // Fully chained if: last index is the end of the array, it's chained, and buffer is finished
    const isFullyChained = (lastIdx === arr.length - 1) && lastChained && this.finished;

    if (isFullyChained) {
      this._notifyParentChained(handlerName);
    }
  }

  /**
   * Variant of _advanceChainFrom used for on-demand chain building.
   * Recursively builds child buffer chains when encountering them.
   */
  _advanceChainFromWithDemandBuild(handlerName, fromIndex) {
    const arr = this.arrays[handlerName];
    if (!arr) return;

    const output = this._outputs?.get(handlerName);
    if (!output) return;

    let prev = output._lastChainedCommand;
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
        // Recursively process child buffer
        prev = this._linkChildBufferCommands(item, handlerName, prev, output);
        // If child is empty, prev stays the same
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
   * Helper for on-demand building: recursively link all commands in a child buffer
   * without updating global chain endpoints (to avoid overwriting parent's first command).
   */
  _linkChildBufferCommands(childBuffer, handlerName, prev, output) {
    const arr = childBuffer.arrays[handlerName];
    if (!arr || arr.length === 0) return prev;

    for (const item of arr) {
      if (item == null) {
        continue; // Skip gaps
      }

      if (isCommandBuffer(item)) {
        // Recursively process nested child
        prev = this._linkChildBufferCommands(item, handlerName, prev, output);
      } else {
        // Link command without calling _chainCommand (to avoid updating global endpoints)
        if (prev) {
          prev.next = item;
        } else {
          output._firstChainedCommand = item;
        }
        prev = item;
      }
    }

    return prev;
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

    // Link to previous command
    if (target.length > 0) {
      const prev = target[target.length - 1];
      linkToPrevious(prev, value, outputName);
    }

    target[slot] = value;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (value instanceof CommandBuffer) {
      value.parent = this;
      value._setParentPosition(outputName, slot);
    }

    // Try to advance the chain incrementally
    this._tryAdvanceChain(outputName, slot);

    return slot;
  }

  fillSlot(slot, value, outputName) {
    // Don't check finished here - fillSlot fills pre-reserved slots
    // that may have been reserved before the buffer was marked finished
    const target = this.arrays[outputName];

    // Link to previous and next commands
    if (slot > 0) {
      const prev = target[slot - 1];
      linkToPrevious(prev, value, outputName);
    }
    if (slot < target.length - 1) {
      const next = target[slot + 1];
      linkToNext(value, next, outputName);
    }

    target[slot] = value;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (value instanceof CommandBuffer) {
      value.parent = this;
      value._setParentPosition(outputName, slot);
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

