'use strict';

const {
  isPoison,
  isPoisonError,
  handleError
} = require('./errors');

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

    // Create arrays namespace
    this.arrays = {
      output: [],
      data: [],
      text: [],
      value: []
    };

    this._index = 0;
    this._outputTypes = Object.create(null);
    this._outputIndexes = Object.create(null);
    this._outputIndexes.output = 0;
    this._outputIndexes.data = 0;
    this._outputIndexes.text = 0;
    this._outputIndexes.value = 0;
    this._outputArrays = this.arrays;
  }

  /**
   * Wraps a value in a command object for chain building
   * @param {*} value - The value to wrap
   * @returns {Object} Command object with type, value, and metadata fields
   */
  _wrapCommand(value) {
    // Already wrapped - return as-is
    if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
      return value;
    }

    // CommandBuffer and arrays should not be wrapped - pass through as-is
    if (value instanceof CommandBuffer || Array.isArray(value)) {
      return value;
    }

    // Only wrap specific types: primitives, functions, command objects, and poison markers
    // Everything else (plain objects, objects with custom toString, etc.) passes through

    // Primitives (strings, numbers, booleans, null, undefined)
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ||
        value === null || value === undefined) {
      return {
        [WRAPPED_COMMAND_SYMBOL]: true,
        type: 'text',
        value: value,
        next: null,
        resolved: false,
        promise: null,
        resolve: null
      };
    }

    // Functions (used for SafeString processing)
    if (typeof value === 'function') {
      return {
        [WRAPPED_COMMAND_SYMBOL]: true,
        type: 'function',
        value: value,
        next: null,
        resolved: false,
        promise: null,
        resolve: null
      };
    }

    // Poison markers
    if (value && typeof value === 'object' && value.__cascadaPoisonMarker === true) {
      return {
        [WRAPPED_COMMAND_SYMBOL]: true,
        type: 'poison',
        value: value,
        next: null,
        resolved: false,
        promise: null,
        resolve: null
      };
    }

    // Command objects (have 'command' property)
    if (value && typeof value === 'object' && 'command' in value) {
      return {
        [WRAPPED_COMMAND_SYMBOL]: true,
        type: 'command',
        value: value,
        next: null,
        resolved: false,
        promise: null,
        resolve: null
      };
    }

    // Everything else (plain objects, objects with custom toString, etc.) - pass through unwrapped
    return value;
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
    if (!this._outputArrays[name]) {
      const arr = [];
      this._outputArrays[name] = arr;
    }
    return this._outputArrays[name];
  }

  _reserveSlot(outputName) {
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

    const slot = this._reserveSlot(outputName);
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

  reserveSlot(outputName = null) {
    return this._reserveSlot(outputName);
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

  const allNames = Object.keys(buffer._outputArrays || {});
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

  if (names.length === 0 && buffer._outputArrays.output) {
    return [{ name: 'output', array: buffer._outputArrays.output }];
  }

  return names.map((name) => ({
    name,
    array: buffer._getOutputArray(name)
  }));
}


// Helper to check if an object is a wrapped command
function isWrappedCommand(item) {
  return item && typeof item === 'object' && item[WRAPPED_COMMAND_SYMBOL] === true;
}

// Unwraps a wrapped command, returning the original value
function unwrapCommand(item) {
  return isWrappedCommand(item) ? item.value : item;
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

  // Add one marker per handler that would have been written to
  const targets = resolveOutputTargets(buffer, handlerNames);
  targets.forEach(({ name, array }) => {
    const marker = {
      __cascadaPoisonMarker: true,  // Flag for detection in flattenBuffer
      errors: processedErrors,       // Array of Error objects to collect (now with proper context)
      handler: name || 'text',        // Which handler was intended (for debugging)
    };

    if (Array.isArray(array)) {
      array.push(marker);
    }
  });
}

function getPosonedBufferErrors(arr, allowedHandlers = null) {
  const allErrors = [];
  if (!arr) return allErrors;

  if (arr instanceof CommandBuffer) {
    const targets = resolveOutputTargets(arr, allowedHandlers);
    targets.forEach(({ name, array }) => {
      const nestedErrors = getPosonedBufferErrors(array, allowedHandlers);
      if (nestedErrors.length > 0) {
        allErrors.push(...nestedErrors);
      }
    });
    return allErrors;
  }

  if (!Array.isArray(arr)) {
    const isTextPoison = isPoison(arr) || isPoisonError(arr);
    if (isTextPoison) {
      // Direct poison (without handler property) is from text/default output.
      // We check if 'text' handler is allowed (or if allowedHandlers is null/global).
      if (allowedHandlers && !allowedHandlers.includes('text')) {
        return allErrors;
      }
      if (arr.errors) {
        allErrors.push(...arr.errors);
      } else {
        allErrors.push(arr);
      }
    }
    return allErrors;
  }

  for (const item of arr) {
    if (!item) continue;
    if (item instanceof CommandBuffer) {
      const nestedErrors = getPosonedBufferErrors(item, allowedHandlers);
      if (nestedErrors.length > 0) {
        allErrors.push(...nestedErrors);
      }
      continue;
    }
    // Check for poison marker
    if (item.__cascadaPoisonMarker === true) {
      if (allowedHandlers && !allowedHandlers.includes(item.handler)) {
        continue;
      }
      if (item.errors && item.errors.length > 0) {
        allErrors.push(...item.errors);
      }
      continue;
    }
    // Check for direct poison value or PoisonError
    const isTextPoison = isPoison(item) || isPoisonError(item);
    if (isTextPoison) {
      if (allowedHandlers && !allowedHandlers.includes('text')) {
        continue;
      }
      if (item.errors) {
        allErrors.push(...item.errors);
      } else {
        allErrors.push(item);
      }
      continue;
    }
    // Recursive check for nested arrays
    if (Array.isArray(item)) {
      const nestedErrors = getPosonedBufferErrors(item, allowedHandlers);
      if (nestedErrors.length > 0) {
        allErrors.push(...nestedErrors);
      }
    }
  }

  return allErrors;
}

module.exports = {
  CommandBuffer,
  addPoisonMarkersToBuffer,
  resolveBufferArray,
  resolveOutputTargets,
  clearBuffer,
  getPosonedBufferErrors,
  isWrappedCommand,
  unwrapCommand,
  isCommandBuffer,
  traverseChain,
  COMMAND_BUFFER_SYMBOL,
  WRAPPED_COMMAND_SYMBOL
};

