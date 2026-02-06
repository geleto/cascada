'use strict';

const {
  isPoison,
  isPoisonError,
  PoisonedValue,
  handleError
} = require('./errors');

const { Command, ErrorCommand, TextCommand } = require('./commands');

const {
  setParentPosition,
  firstCommand,
  lastCommand,
  markFinishedAndPatchLinks,
  debugChain,
  linkToPrevious,
  linkToNext,
  patchLinksAfterClear,
  traverseChain
} = require('./buffer-snapshot');

const { checkFinishedBuffer } = require('./checks');

// Unique symbols for type identification
const COMMAND_BUFFER_SYMBOL = Symbol.for('cascada.CommandBuffer');
const WRAPPED_COMMAND_SYMBOL = Symbol.for('cascada.WrappedCommand');

class CommandBuffer {
  constructor(context, parent = null) {
    this._context = context;
    this.parent = parent;
    this.positions = new Map();
    this.finished = false;
    this[COMMAND_BUFFER_SYMBOL] = true;

    // Create arrays namespace (handlers created lazily on first write/snapshot).
    // Note: templates write to the default arrays 'output' stream,
    this.arrays = Object.create(null);

    this._index = 0;
    // `_outputTypes` is script-only metadata used by the flattener to interpret
    // explicit output handler types. Templates don't need it.
    this._outputIndexes = Object.create(null);
  }

  /**
   * Coerces a value into a command instance and stamps chain properties on it.
   * Containers (CommandBuffer, Array) and error values (PoisonedValue) pass through unchanged.
   * Existing Command instances get chain properties stamped directly.
   * Everything else becomes a text command.
   * @param {*} value - The value to wrap
   * @returns {Object} Command instance with chain properties
   */
  _wrapCommand(value) {
    // Containers and error values pass through unchanged
    if (value instanceof CommandBuffer || Array.isArray(value) || isPoison(value)) {
      return value;
    }

    // Already stamped - return as-is
    if (value && value[WRAPPED_COMMAND_SYMBOL]) {
      return value;
    }

    let cmd;
    if (value instanceof Command) {
      cmd = value;
    } else if (value && typeof value === 'object' && 'handler' in value) {
      throw new Error('Plain command objects are not allowed; emit Command instances');
    } else {
      cmd = new TextCommand(value);
    }

    // Stamp chain properties
    cmd[WRAPPED_COMMAND_SYMBOL] = true;
    cmd.next = null;
    cmd.resolved = false;
    cmd.promise = null;
    cmd.resolve = null;
    return cmd;
  }

  // Snapshot and command chain methods (imported from buffer-snapshot.js)
  _setParentPosition(handlerName, index) {
    return setParentPosition.call(this, handlerName, index);
  }

  firstCommand(handlerName) {
    return firstCommand.call(this, handlerName);
  }

  lastCommand(handlerName) {
    return lastCommand.call(this, handlerName);
  }

  markFinishedAndPatchLinks() {
    return markFinishedAndPatchLinks.call(this);
  }

  debugChain(handlerName) {
    return debugChain.call(this, handlerName);
  }

  traverseChain(handlerName, processCommand) {
    return traverseChain.call(this, handlerName, processCommand);
  }

  _getOutputArray(outputName) {
    const name = outputName || 'output';
    if (!this.arrays[name]) {
      const arr = [];
      this.arrays[name] = arr;
    }
    return this.arrays[name];
  }

  reserveSlot(outputName) {
    const name = outputName || 'output';
    if (name === 'output') {
      return this._index++;
    }
    if (this._outputIndexes[name] === undefined) {
      this._outputIndexes[name] = 0;
    }
    return this._outputIndexes[name]++;
  }

  _setOutputIndex(outputName, nextIndex) {
    const name = outputName || 'output';
    if (name === 'output') {
      this._index = nextIndex;
      return;
    }
    this._outputIndexes[name] = nextIndex;
  }

  add(value, outputName = null) {
    // Check if buffer is finished
    checkFinishedBuffer(this);

    const slot = this.reserveSlot(outputName);
    const target = this._getOutputArray(outputName);
    const wrappedValue = this._wrapCommand(value);

    // Link to previous command
    if (target.length > 0) {
      const prev = target[target.length - 1];
      linkToPrevious(prev, wrappedValue, outputName || 'output');
    }

    target[slot] = wrappedValue;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (wrappedValue instanceof CommandBuffer) {
      wrappedValue.parent = this;
      wrappedValue._setParentPosition(outputName || 'output', slot);
    }

    return slot;
  }

  fillSlot(slot, value, outputName = null) {
    // Don't check finished here - fillSlot fills pre-reserved slots
    // that may have been reserved before the buffer was marked finished
    const target = this._getOutputArray(outputName);
    const wrappedValue = this._wrapCommand(value);

    // Link to previous and next commands
    if (slot > 0) {
      const prev = target[slot - 1];
      linkToPrevious(prev, wrappedValue, outputName || 'output');
    }
    if (slot < target.length - 1) {
      const next = target[slot + 1];
      linkToNext(wrappedValue, next, outputName || 'output');
    }

    target[slot] = wrappedValue;

    // If adding a CommandBuffer as a child, set up parent relationship
    if (wrappedValue instanceof CommandBuffer) {
      wrappedValue.parent = this;
      wrappedValue._setParentPosition(outputName || 'output', slot);
    }
  }
}

function resolveBufferArray(buffer, outputName = null) {
  if (buffer instanceof CommandBuffer) {
    return buffer._getOutputArray(outputName);
  }
  return buffer;
}

function resolveOutputTargets(buffer, handlerNames = null) {
  if (!(buffer instanceof CommandBuffer)) {
    return Array.isArray(buffer) ? [{ name: null, array: buffer }] : [];
  }

  const allNames = Object.keys(buffer.arrays || {});
  const outputNames = allNames.filter(name => name !== 'output');
  const hasHandlerList = Array.isArray(handlerNames);
  const targetsAll = !hasHandlerList ||
    handlerNames.includes('_') || handlerNames.includes(null);

  const names = targetsAll
    ? outputNames
    : handlerNames.filter(name => name && name !== '_');

  if (hasHandlerList && handlerNames.length === 0) {
    return [];
  }

  if (names.length === 0 && buffer.arrays && buffer.arrays.output) {
    return [{ name: 'output', array: buffer.arrays.output }];
  }

  return names.map((name) => ({
    name,
    array: buffer._getOutputArray(name)
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
      buffer._setOutputIndex(name === 'output' ? null : name, 0);
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
  // In script mode, emit ErrorCommand instances; in template mode, push PoisonedValue directly.
  const isScript = buffer instanceof CommandBuffer && buffer._scriptMode;
  const targets = resolveOutputTargets(buffer, handlerNames);
  targets.forEach(({ name, array }) => {
    if (Array.isArray(array)) {
      if (isScript) {
        array.push(new ErrorCommand(new PoisonedValue(processedErrors)));
      } else {
        array.push(new PoisonedValue(processedErrors));
      }
    }
  });
}

function getPoisonedCommandBufferErrors(buffer, allowedHandlers = null) {
  const allErrors = [];
  if (!buffer) return allErrors;
  const targets = resolveOutputTargets(buffer, allowedHandlers);
  targets.forEach(({ name, array }) => {
    const handlerName = name || 'text';
    const nestedErrors = getPoisonedArrayErrors(array, handlerName, allowedHandlers);
    if (nestedErrors.length > 0) {
      allErrors.push(...nestedErrors);
    }
  });
  return allErrors;
}

function getPoisonedArrayErrors(arr, handlerName, allowedHandlers = null) {
  const allErrors = [];
  if (!arr) return allErrors;

  const isHandlerAllowed = (name) => !allowedHandlers || allowedHandlers.includes(name);
  if (!isHandlerAllowed(handlerName)) return allErrors;

  function pushPoison(errOrPoison) {
    if (!errOrPoison) return;
    if (errOrPoison.errors) {
      allErrors.push(...errOrPoison.errors);
    } else {
      allErrors.push(errOrPoison);
    }
  }

  function walk(value, currentHandler) {
    if (!value) return;

    if (value instanceof CommandBuffer) {
      allErrors.push(...getPoisonedCommandBufferErrors(value, allowedHandlers));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, currentHandler));
      return;
    }

    // Handle script-mode poison markers.
    if (value instanceof ErrorCommand) {
      if (isHandlerAllowed(currentHandler)) {
        pushPoison(value.value);
      }
      return;
    }

    if (isPoison(value) || isPoisonError(value)) {
      if (isHandlerAllowed(currentHandler)) {
        pushPoison(value);
      }
      return;
    }

    if (typeof value === 'object') {
      // Command object: recurse into argument payloads under its handler.
      if (value.handler !== undefined) {
        const commandHandler = value.handler || currentHandler;
        if (!isHandlerAllowed(commandHandler)) return;
        if (Array.isArray(value.arguments)) {
          value.arguments.forEach((arg) => walk(arg, commandHandler));
        }
        return;
      }

      Object.keys(value).forEach((key) => walk(value[key], currentHandler));
    }
  }

  walk(arr, handlerName);

  return allErrors;
}

function getPosonedBufferErrors(arr, allowedHandlers = null) {
  if (!arr) return [];
  if (arr instanceof CommandBuffer) {
    return getPoisonedCommandBufferErrors(arr, allowedHandlers);
  }
  return getPoisonedArrayErrors(arr, 'text', allowedHandlers);
}

module.exports = {
  CommandBuffer,
  addPoisonMarkersToBuffer,
  resolveBufferArray,
  resolveOutputTargets,
  clearBuffer,
  getPosonedBufferErrors,
  isCommandBuffer,
  traverseChain,
  COMMAND_BUFFER_SYMBOL,
  WRAPPED_COMMAND_SYMBOL
};

