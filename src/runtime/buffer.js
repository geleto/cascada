'use strict';

const {
  handleError
} = require('./errors');

const { Command, ErrorCommand, TextCommand } = require('./commands');

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
    this.finished = true;

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

      // Link backward: previous element -> this.first
      if (position > 0 && firstCmd) {
        const prev = parentArray[position - 1];
        if (!isCommandBuffer(prev)) {
          prev.next = firstCmd;
        } else if (prev.finished) {
          const prevLast = prev.lastCommand(handlerName);
          if (prevLast) {
            prevLast.next = firstCmd;
          }
        }
      }

      // Link forward: this.last -> next element
      if (position < parentArray.length - 1 && lastCmd) {
        const next = parentArray[position + 1];
        if (!isCommandBuffer(next)) {
          lastCmd.next = next;
        } else if (next.finished) {
          const nextFirst = next.firstCommand(handlerName);
          if (nextFirst) {
            lastCmd.next = nextFirst;
          }
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
  }
}

function resolveOutputTargets(buffer, handlerNames = null) {
  if (!(buffer instanceof CommandBuffer)) {
    return Array.isArray(buffer) ? [{ name: null, array: buffer }] : [];
  }

  const allNames = Object.keys(buffer.arrays || {});
  const hasHandlerList = Array.isArray(handlerNames);
  const targetsAll = !hasHandlerList ||
    handlerNames.includes('_');

  const names = targetsAll
    ? allNames
    : handlerNames.filter(name => name && name !== '_');

  if (hasHandlerList && handlerNames.length === 0) {
    return [];
  }

  return names.map((name) => ({
    name,
    array: buffer.arrays[name] ?? []
  }));
}

// Check if value is a CommandBuffer using symbol
function isCommandBuffer(value) {
  return value && typeof value === 'object' && value[COMMAND_BUFFER_SYMBOL] === true;
}

// Clear buffer contents for guard error recovery
// This is used by guards to discard output when an error occurs
function clearBuffer(buffer, handlerNames = null) {
  if (!buffer) {
    return;
  }

  if (buffer instanceof CommandBuffer) {
    const targets = resolveOutputTargets(buffer, handlerNames);
    targets.forEach(({ name, array }) => {
      if (Array.isArray(array)) {
        array.length = 0;
      }
      buffer._setOutputIndex(name, 0);
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

/**
 * Add poison markers to output buffer for handlers that would have been written
 * in a branch that wasn't executed due to poisoned condition.
 *
 * When a condition evaluates to poison (error), branches aren't executed but would
 * have written to output handlers. This function adds markers to the buffer so that
 * flattenBuffer can collect these errors.
 *
 * @param {Array} buffer - The output buffer array to add markers to
 * @param {PoisonedValue|Error} error - The poison value or error from failed condition
 * @param {Array<string>} handlerNames - Names of handlers (e.g., ['text', 'data'])
 * @param {Object} errorContext - Context object with lineno, colno, errorContextString, and path
 */
function addPoisonMarkersToBuffer(buffer, errorOrErrors, handlerNames, errorContext = null) {
  const errors = (Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors]);

  // Process errors with proper context if available
  const processedErrors = errorContext ?
    errors.map(err => handleError(err, errorContext.lineno, errorContext.colno,
      errorContext.errorContextString, errorContext.path)) :
    errors;

  // Add one poison entry per handler that would have been written to.
  // Always use ErrorCommand so poison markers remain command-native.
  handlerNames.forEach((name) => {
    buffer.arrays[name] = buffer.arrays[name] ?? [];
    buffer.arrays[name].push(new ErrorCommand(processedErrors));
  });
}

function getPoisonedArrayErrors(arr, handlerName, allowedHandlers = null) {
  const allErrors = [];
  if (!arr) return allErrors;

  const isHandlerAllowed = (name) => !allowedHandlers || allowedHandlers.includes(name);
  if (!isHandlerAllowed(handlerName)) return allErrors;

  function walk(value, currentHandler) {
    if (!value) return;

    if (value instanceof CommandBuffer) {
      allErrors.push(...getPosonedBufferErrors(value, allowedHandlers));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, currentHandler));
      return;
    }

    if (value instanceof Command) {
      const commandHandler = value.handler || currentHandler;
      if (!isHandlerAllowed(commandHandler)) return;
      const err = value.getError();
      if (err) {
        allErrors.push(...err.errors);
      }
    }
  }

  walk(arr, handlerName);

  return allErrors;
}

function getPosonedBufferErrors(buffer, allowedHandlers = null) {
  const allErrors = [];
  const targets = resolveOutputTargets(buffer, allowedHandlers);
  targets.forEach(({ name, array }) => {
    allErrors.push(...getPoisonedArrayErrors(array, name, allowedHandlers));
  });
  return allErrors;
}

module.exports = {
  CommandBuffer,
  addPoisonMarkersToBuffer,
  clearBuffer,
  getPosonedBufferErrors,
  isCommandBuffer,
  COMMAND_BUFFER_SYMBOL
};

