'use strict';

const { CommandBuffer, resolveBufferArray } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');
const { PoisonError } = require('./errors');
const { createFlattenState, buildFinalResultFromState, resolveOutputValue } = require('./flatten-shared');

function doFlattenBuffer(arr, context = null, outputName = null, sharedState = null) {
  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, outputName, sharedState, doFlattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, outputName, sharedState, doFlattenBuffer);
}

// Template-mode entry point: flatten text from a buffer or raw array.
function flattenBufferText(arr, outputName = null, sharedState = null) {
  let target = arr;
  const name = outputName || 'text';

  if (arr instanceof CommandBuffer) {
    const textArray = resolveBufferArray(arr, name);
    if (!outputName && name === 'text') {
      target = (Array.isArray(textArray) && textArray.length > 0)
        ? textArray
        : resolveBufferArray(arr, 'output');
    } else {
      target = textArray;
    }
  }

  return flattenText(target, name, sharedState, doFlattenBuffer);
}

// In script mode, multiple snapshots/returns may request flattening the same
// CommandBuffer more than once (e.g. implicit return + explicit snapshots).
// Flattening is idempotent: it populates Output._target/_base once, and
// subsequent snapshot() calls read from those without re-executing commands.
// We cache the flattened state per CommandBuffer instance to enforce this.
function flattenCommandBufferCached(buffer, context, outputName) {
  const resolveFromState = (state) => {
    if (state && state.collectedErrors && state.collectedErrors.length > 0) {
      throw new PoisonError(state.collectedErrors);
    }
    const finalResult = buildFinalResultFromState(state || {});

    if (!outputName) {
      return finalResult;
    }

    return resolveOutputValue(state || {}, outputName);
  };

  if (buffer._flattenState) {
    try {
      return resolveFromState(buffer._flattenState);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  if (buffer._flattenStatePromise) {
    return buffer._flattenStatePromise.then((state) => resolveFromState(state));
  }

  // Always flatten the full buffer once to ensure all output commands execute.
  // Use a properly-shaped shared state so flattening logic can mutate it
  // without re-initializing on each recursive call.
  const sharedState = createFlattenState(null, buffer._outputTypes || null);
  const computed = doFlattenBuffer(buffer, context, null, sharedState);

  const store = (state) => {
    buffer._flattenState = state;
    buffer._flattenStatePromise = null;
    return state;
  };

  if (computed && typeof computed.then === 'function') {
    buffer._flattenStatePromise = computed.then(store, (err) => {
      buffer._flattenStatePromise = null;
      throw err;
    });
    return buffer._flattenStatePromise.then((state) => resolveFromState(state));
  }

  const state = store(computed);
  return resolveFromState(state);
}

// Output-driven entry point for script mode.
// Output carries buffer, context, and outputName — all flatten needs.
// Internal recursion (nested CommandBuffers) goes through doFlattenBuffer.
function flattenBuffer(output, errorContext = null) {

  if (!output || (typeof output !== 'object' && typeof output !== 'function')) {
    return undefined;
  }

  const buffer = output._buffer;
  if (!buffer) {
    return undefined;
  }

  let context = errorContext || output._context || null;
  const outputName = (output._outputName && output._outputName !== 'output') ? output._outputName : null;
  const isTemplateMode = (buffer instanceof CommandBuffer) && !buffer._scriptMode;
  if (isTemplateMode) {
    // Template mode should use text flattening (no second-pass suppression).
    context = null;
  }

  // Script mode: flatten populates _target/_base as a side effect;
  // resolve the final value from them after flatten completes.
  const result = (context && buffer instanceof CommandBuffer)
    ? flattenCommandBufferCached(buffer, context, outputName)
    : doFlattenBuffer(buffer, context, outputName);
  const resolveFromOutput = () => {
    if (!output || typeof output !== 'object') {
      return result;
    }
    if (output._outputType === 'text') {
      if (Array.isArray(output._target)) {
        return output._target.join('');
      }
      return result;
    }
    if (output._base) {
      return typeof output._base.getReturnValue === 'function'
        ? output._base.getReturnValue()
        : output._base;
    }
    return output._target !== undefined ? output._target : result;
  };
  if (result && typeof result.then === 'function') {
    return result.then(() => resolveFromOutput());
  }
  return resolveFromOutput();
}

module.exports = {
  flattenBuffer,
  flattenBufferText
};
