'use strict';

/**
 * Command chain helpers for CommandBuffer
 *
 * This module only contains shared link/patch helpers.
 * Command lookup/traversal behavior lives directly on CommandBuffer methods.
 */

// Import symbols for robust type checking (avoids circular dependency)
const COMMAND_BUFFER_SYMBOL = Symbol.for('cascada.CommandBuffer');

/**
 * Check if value is a CommandBuffer
 */
function isCommandBuffer(value) {
  return value && typeof value === 'object' && value[COMMAND_BUFFER_SYMBOL] === true;
}

/**
 * Link a command to the previous command in the chain (used during add/fillSlot)
 * @param {Object} prev - Previous item (command or buffer)
 * @param {Object} current - Current command to link
 * @param {string} handlerName - Handler name for buffer lookups
 */
function linkToPrevious(prev, current, handlerName) {
  if (!prev || isCommandBuffer(current)) {
    return;
  }

  if (!isCommandBuffer(prev)) {
    // prev is a command object
    prev.next = current;
  } else if (prev.finished) {
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
  if (isCommandBuffer(current) || !next) {
    return;
  }

  if (!isCommandBuffer(next)) {
    // next is a command object
    current.next = next;
  } else if (next.finished) {
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
      if (!isCommandBuffer(prev)) {
        prevCmd = prev;
      } else if (prev.finished) {
        prevCmd = prev.lastCommand(handlerName);
      }
    }

    let nextCmd = null;
    if (position < parentArray.length - 1) {
      const next = parentArray[position + 1];
      if (!isCommandBuffer(next)) {
        nextCmd = next;
      } else if (next.finished) {
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

module.exports = {
  linkToPrevious,
  linkToNext,
  patchLinksAfterClear
};
