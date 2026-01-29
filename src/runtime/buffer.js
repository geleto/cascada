'use strict';

const {
  isPoison,
  isPoisonError,
  handleError
} = require('./errors');

class CommandBuffer {
  constructor(context) {
    this._context = context;
    this.output = [];
    this.data = [];
    this.text = [];
    this.value = [];
    this._index = 0;
    this._outputTypes = Object.create(null);
    this._outputIndexes = Object.create(null);
    this._outputIndexes.output = 0;
    this._outputIndexes.data = 0;
    this._outputIndexes.text = 0;
    this._outputIndexes.value = 0;
    this._outputArrays = {
      output: this.output,
      data: this.data,
      text: this.text,
      value: this.value
    };
  }

  _getOutputArray(outputName) {
    const name = outputName || 'output';
    if (!this._outputArrays[name]) {
      const arr = [];
      this._outputArrays[name] = arr;
      this[name] = arr;
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
    const slot = this._reserveSlot(outputName);
    const target = this._getOutputArray(outputName);
    target[slot] = value;
    return slot;
  }

  reserveSlot(outputName = null) {
    return this._reserveSlot(outputName);
  }

  fillSlot(slot, value, outputName = null) {
    const target = this._getOutputArray(outputName);
    target[slot] = value;
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

// Flags a buffer scope so later passes know it contains a @_revert command.
function markBufferHasRevert(buffer, handlerNames = null) {
  const targets = resolveOutputTargets(buffer, handlerNames);
  targets.forEach(({ array }) => {
    if (!Array.isArray(array)) return;
    array._hasRevert = true;
    array._revertsProcessed = false;
  });
}

// Determines which handler a buffer entry belongs to.
function detectHandlerName(item) {
  if (!item) return null;
  if (item.__cascadaPoisonMarker === true) {
    return item.handler || 'text';
  }
  if (Array.isArray(item)) {
    return 'text';
  }
  if (typeof item === 'object') {
    if ('handler' in item && item.handler) {
      return item.handler;
    }
    if ('text' in item && Object.keys(item).length > 0) {
      return 'text';
    }
    return null;
  }
  // primitives/functions count as text output
  return 'text';
}

// Identifies buffer command objects representing @_revert() calls.
function isRevertCommand(item) {
  return item && typeof item === 'object' && item.command === '_revert';
}

// Marks a buffer entry as reverted so flattening skips it.
function markNodeReverted(container, index) {
  const value = container[index];
  if (!value || typeof value !== 'object') {
    container[index] = { _reverted: true };
    return;
  }
  value._reverted = true;
}

function markBufferReverted(buffer) {
  if (!buffer) {
    return;
  }
  if (buffer instanceof CommandBuffer) {
    buffer._reverted = true;
    const targets = resolveOutputTargets(buffer, null);
    targets.forEach(({ name, array }) => {
      if (Array.isArray(array)) {
        array.length = 0;
      }
      buffer._setOutputIndex(name === 'output' ? null : name, 0);
    });
    return;
  }

  buffer._reverted = true;
  if (Array.isArray(buffer)) {
    buffer.length = 0;
  }
}

function resetBufferOutputIndexes(buffer, handlerNames = null) {
  if (!(buffer instanceof CommandBuffer)) {
    return;
  }

  const targets = resolveOutputTargets(buffer, handlerNames);
  targets.forEach(({ name, array }) => {
    const nextIndex = Array.isArray(array) ? array.length : 0;
    buffer._setOutputIndex(name === 'output' ? null : name, nextIndex);
  });
}

// Walks recorded linear nodes backwards and reverts those for a handler.
function revertLinearNodes(linearNodes, handlerName) {
  if (!linearNodes) return;
  for (let i = linearNodes.length - 1; i >= 0; i--) {
    const info = linearNodes[i];

    if (info && info.isRevertMarker) {
      // Markers belong to the scope where @_revert executed. If it matches the handler
      // we're currently rewinding (or was a universal @_revert), we stop for this scope
      // but keep bubbling up so that parent scopes continue their own cleanup.
      const markerHandlers = info.handlers;
      const targetsAllHandlers = info.targetsAllHandlers === true;
      const appliesToHandler = targetsAllHandlers ||
        (handlerName !== null && markerHandlers && markerHandlers.includes(handlerName));

      if (appliesToHandler) {
        // Debug helper: uncomment to confirm early-exit skip logic during tests
        // console.log('[revert-opt][marker-hit] handler=%s, universal=%s', handlerName === null ? '_' : handlerName, targetsAllHandlers);
        break; // stop rewinding once we hit a previous _revert on the same handler
      }
      continue;
    }

    const currentHandler = info.handler || 'text';
    if (handlerName && handlerName !== currentHandler) {
      continue;
    }
    markNodeReverted(info.container, info.index);
    linearNodes.splice(i, 1);
  }
}

// Performs a single linear scan to apply handler-targeted reverts per buffer.
function processReverts(buffer, outputName = null) {
  const target = resolveBufferArray(buffer, outputName);
  if (!Array.isArray(target) || target._revertsProcessed) return;
  walkBufferForReverts(target, true, null, null, outputName);
}

// Recursively walks a buffer tree collecting nodes for the linear pass.
function walkBufferForReverts(container, forceScopeRoot = false, inheritedLinearNodes = null, parentIndexRef = null, outputName = null) {
  const isScopeRoot = forceScopeRoot || container._outputScopeRoot === true;
  const linearNodes = isScopeRoot ? [] : inheritedLinearNodes;

  if (!isScopeRoot && !linearNodes) {
    throw new Error('Non-scope buffers require shared linear nodes');
  }

  const scopeHasExplicitRevert = container._hasRevert === true;
  if (isScopeRoot && !forceScopeRoot && !scopeHasExplicitRevert) {
    container._revertsProcessed = true;
    return false;
  }

  let scopeHasRevert = scopeHasExplicitRevert;

  for (let i = 0; i < container.length; i++) {
    const item = container[i];
    const resolvedItem = item instanceof CommandBuffer ? resolveBufferArray(item, outputName) : item;

    if (Array.isArray(resolvedItem)) {
      const childIsScope = resolvedItem._outputScopeRoot === true;
      const lastValue = resolvedItem.length > 0 ? resolvedItem[resolvedItem.length - 1] : null;
      const hasPostProcessFn = typeof lastValue === 'function';

      if (childIsScope) {
        if (resolvedItem._hasRevert === true) {
          const childHasRevert = walkBufferForReverts(resolvedItem, false, null, { container, index: i }, outputName);
          if (childHasRevert) {
            resolvedItem._hasRevert = true;
            scopeHasRevert = true;
          }
        } else {
          resolvedItem._revertsProcessed = true;
        }
        linearNodes.push({ handler: 'text', container, index: i, scopeRoot: true, parentIndexRef });
        continue;
      }

      if (hasPostProcessFn) {
        linearNodes.push({ handler: 'text', container, index: i, parentIndexRef });
        continue;
      }

      const childHasRevert = walkBufferForReverts(resolvedItem, false, linearNodes, { container, index: i }, outputName);
      if (childHasRevert) {
        scopeHasRevert = true;
      }
      continue;
    }

    if (item && item._reverted) {
      continue;
    }

    if (isRevertCommand(item)) {
      const targetsAllHandlers = item.handler === '_';
      const handlerList = targetsAllHandlers
        ? [null] // null => revert all handlers in this scope
        : (Array.isArray(item.handlers) && item.handlers.length > 0 ?
          item.handlers :
          [item.handler || 'text']);
      handlerList.forEach(handler => revertLinearNodes(linearNodes, handler));
      linearNodes.push({
        isRevertMarker: true,
        targetsAllHandlers,
        handlers: targetsAllHandlers ? null : handlerList.slice(),
        parentIndexRef
      });
      markNodeReverted(container, i);
      scopeHasRevert = true;
      continue;
    }

    const handlerName = detectHandlerName(item) || 'text';
    linearNodes.push({ handler: handlerName, container, index: i, parentIndexRef });
  }

  if (isScopeRoot) {
    container._hasRevert = scopeHasRevert;
    container._revertsProcessed = true;
    const rebuilt = [];
    if (linearNodes && linearNodes.length > 0) {
      for (const entry of linearNodes) {
        if (entry && entry.isRevertMarker) continue;
        if (!entry || !entry.container) continue;
        const value = entry.container[entry.index];
        if (!value || value._reverted) continue;
        rebuilt.push(value);
      }
    } else {
      for (const item of container) {
        if (!item || item._reverted) continue;
        rebuilt.push(item);
      }
    }
    container.length = rebuilt.length;
    for (let idx = 0; idx < rebuilt.length; idx++) {
      container[idx] = rebuilt[idx];
    }
  }

  return scopeHasRevert;
}

function revertBufferHandlers(buffer, handlerNames) {
  if (!Array.isArray(handlerNames) || handlerNames.length === 0) {
    markBufferReverted(buffer);
    return;
  }

  const targets = resolveOutputTargets(buffer, handlerNames);
  targets.forEach(({ name, array }) => {
    if (!Array.isArray(array)) {
      return;
    }
    array.push({
      handler: name || 'text',
      command: '_revert',
      arguments: [],
      pos: null
    });
    markBufferHasRevert(array);
    processReverts(array, name);
    if (buffer instanceof CommandBuffer) {
      buffer._setOutputIndex(name, array.length);
    }
  });
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
  processReverts,
  markBufferReverted,
  resetBufferOutputIndexes,
  revertBufferHandlers,
  markBufferHasRevert,
  getPosonedBufferErrors
};

