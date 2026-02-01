'use strict';

/**
 * Command chain and snapshot support for CommandBuffer
 *
 * This module provides the infrastructure for building command chains with next pointers,
 * which will be used for incremental snapshot materialization in future phases.
 */

// Import symbols for robust type checking (avoids circular dependency)
const COMMAND_BUFFER_SYMBOL = Symbol.for('cascada.CommandBuffer');
const WRAPPED_COMMAND_SYMBOL = Symbol.for('cascada.WrappedCommand');

/**
 * Check if value is a CommandBuffer
 */
function isCommandBuffer(value) {
  return value && typeof value === 'object' && value[COMMAND_BUFFER_SYMBOL] === true;
}

/**
 * Check if value is a wrapped command
 */
function isWrappedCommand(value) {
  return value && typeof value === 'object' && value[WRAPPED_COMMAND_SYMBOL] === true;
}

/**
 * Track position when adding this buffer to a parent
 * @param {string} handlerName - The handler name (e.g., 'data', 'text')
 * @param {number} index - The index in the parent's array
 */
function setParentPosition(handlerName, index) {
  this.positions.set(handlerName, index);
}

/**
 * Find first actual command in handler array (recursive through nested buffers)
 * @param {string} handlerName - The handler name
 * @returns {Object|null} First command object or null if empty
 */
function firstCommand(handlerName) {
  const arr = this.arrays[handlerName];
  if (!arr || arr.length === 0) {
    return null;
  }

  for (const item of arr) {
    // If it's a wrapped command, return it
    if (isWrappedCommand(item)) {
      return item;
    }
    // If it's a nested CommandBuffer, recurse
    if (isCommandBuffer(item)) {
      const nestedFirst = item.firstCommand(handlerName);
      if (nestedFirst) {
        return nestedFirst;
      }
    }
  }

  return null;
}

/**
 * Find last actual command in handler array (recursive through nested buffers)
 * @param {string} handlerName - The handler name
 * @returns {Object|null} Last command object or null if empty
 */
function lastCommand(handlerName) {
  const arr = this.arrays[handlerName];
  if (!arr || arr.length === 0) {
    return null;
  }

  // Iterate backwards
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    // If it's a wrapped command, return it
    if (isWrappedCommand(item)) {
      return item;
    }
    // If it's a nested CommandBuffer, recurse
    if (isCommandBuffer(item)) {
      const nestedLast = item.lastCommand(handlerName);
      if (nestedLast) {
        return nestedLast;
      }
    }
  }

  return null;
}

/**
 * Called when async block completes - patches next pointers
 * This creates the command chain by linking commands in parent buffer
 */
function markFinishedAndPatchLinks() {
  this.finished = true;

  if (!this.parent) {
    return; // Root buffer needs no patching
  }

  // For each handler this buffer has position in:
  for (const [handlerName, position] of this.positions.entries()) {
    const parentArray = this.parent.arrays[handlerName];
    if (!parentArray) {
      continue;
    }

    const firstCmd = this.firstCommand(handlerName);
    const lastCmd = this.lastCommand(handlerName);

    // Link backward: previous element → this.first
    if (position > 0 && firstCmd) {
      const prev = parentArray[position - 1];
      if (isWrappedCommand(prev)) {
        // prev is a command object
        prev.next = firstCmd;
      } else if (isCommandBuffer(prev) && prev.finished) {
        const prevLast = prev.lastCommand(handlerName);
        if (prevLast) {
          prevLast.next = firstCmd;
        }
      }
    }

    // Link forward: this.last → next element
    if (position < parentArray.length - 1 && lastCmd) {
      const next = parentArray[position + 1];
      if (isWrappedCommand(next)) {
        // next is a command object
        lastCmd.next = next;
      } else if (isCommandBuffer(next) && next.finished) {
        const nextFirst = next.firstCommand(handlerName);
        if (nextFirst) {
          lastCmd.next = nextFirst;
        }
      }
    }
  }
}

/**
 * Debug helper to visualize command chain
 * @param {string} handlerName - The handler name
 * @returns {Array<string>} Array of command types in chain
 */
function debugChain(handlerName) {
  const first = this.firstCommand(handlerName);
  let cmd = first;
  const chain = [];
  while (cmd) {
    chain.push(cmd.type || 'unknown');
    cmd = cmd.next;
  }
  return chain;
}

/**
 * Link a command to the previous command in the chain (used during add/fillSlot)
 * @param {Object} prev - Previous item (command or buffer)
 * @param {Object} current - Current command to link
 * @param {string} handlerName - Handler name for buffer lookups
 */
function linkToPrevious(prev, current, handlerName) {
  if (!prev || !isWrappedCommand(current)) {
    return;
  }

  if (isWrappedCommand(prev)) {
    // prev is a command object
    prev.next = current;
  } else if (isCommandBuffer(prev) && prev.finished) {
    // prev is a finished buffer - link its last command to current
    const prevLast = prev.lastCommand(handlerName);
    if (prevLast) {
      prevLast.next = current;
    }
  }
}

/**
 * Link a command to the next command in the chain (used during fillSlot)
 * @param {Object} current - Current command
 * @param {Object} next - Next item (command or buffer)
 * @param {string} handlerName - Handler name for buffer lookups
 */
function linkToNext(current, next, handlerName) {
  if (!isWrappedCommand(current) || !next) {
    return;
  }

  if (isWrappedCommand(next)) {
    // next is a command object
    current.next = next;
  } else if (isCommandBuffer(next) && next.finished) {
    // next is a finished buffer - link current to its first command
    const nextFirst = next.firstCommand(handlerName);
    if (nextFirst) {
      current.next = nextFirst;
    }
  }
}

/**
 * Update chain links when a buffer is cleared (guard recovery)
 * @param {Object} buffer - The buffer being cleared
 */
function patchLinksAfterClear(buffer) {
  if (!buffer.parent || !buffer.asyncMode) {
    return;
  }

  for (const [handlerName, position] of buffer.positions.entries()) {
    const parentArray = buffer.parent.arrays[handlerName];
    if (!parentArray) {
      continue;
    }

    // Link previous to next, skipping this empty buffer
    let prevCmd = null;
    if (position > 0) {
      const prev = parentArray[position - 1];
      if (isWrappedCommand(prev)) {
        prevCmd = prev;
      } else if (isCommandBuffer(prev) && prev.finished) {
        prevCmd = prev.lastCommand(handlerName);
      }
    }

    let nextCmd = null;
    if (position < parentArray.length - 1) {
      const next = parentArray[position + 1];
      if (isWrappedCommand(next)) {
        nextCmd = next;
      } else if (isCommandBuffer(next) && next.finished) {
        nextCmd = next.firstCommand(handlerName);
      }
    }

    // Link prev -> next, bypassing this buffer
    if (prevCmd && nextCmd) {
      prevCmd.next = nextCmd;
    } else if (prevCmd && !nextCmd) {
      prevCmd.next = null;
    }
  }
}

/**
 * Traverse command chain and call processor for each command
 * @param {Object} buffer - The buffer to traverse
 * @param {string} handlerName - The handler name (e.g., 'data', 'text')
 * @param {Function} processCommand - Function to call for each command
 * @returns {boolean} True if chain was used, false if fell back to array
 */
function traverseChain(buffer, handlerName, processCommand) {
  let current = buffer.firstCommand(handlerName);

  // If no chain exists, fall back to array
  if (!current) {
    return false;
  }

  // Traverse the chain using next pointers
  while (current) {
    processCommand(current);
    current = current.next;
  }

  return true;
}

module.exports = {
  setParentPosition,
  firstCommand,
  lastCommand,
  markFinishedAndPatchLinks,
  debugChain,
  linkToPrevious,
  linkToNext,
  patchLinksAfterClear,
  traverseChain
};
