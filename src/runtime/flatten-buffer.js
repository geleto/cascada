'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');
const { PoisonError } = require('./errors');
const { createFlattenState, buildFinalResultFromState, resolveOutputValue } = require('./flatten-shared');

// the below comments may not be exactly correct right now
// outputName only => value (unwrapped)
// neither provided, no context => this is a text flattening => string
// neither provided, context  => ERROR (no longer supported)
function flattenBuffer(arr, context = null, outputName = null) {
  if (context && !outputName) {
    //throw new Error('flattenBuffer requires either focusOutput or outputName parameter');
  }
  if (context && arr instanceof CommandBuffer) {
    return flattenCommandBufferCached(arr, context, outputName);
  }

  return doFlattenBuffer(arr, context, outputName);
}

// @TODO - remove this once proper snapshot() is implemented for outputs
// In script mode, multiple snapshots/returns may request flattening the same
// CommandBuffer more than once (e.g. implicit return + explicit snapshots).
// Flattening must be idempotent w.r.t. executing output commands, so we cache
// the flattened state per CommandBuffer instance.
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

function doFlattenBuffer(arr, context = null, outputName = null, sharedState = null) {

  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, outputName, sharedState, doFlattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, outputName, sharedState, doFlattenBuffer);
}

module.exports = {
  flattenBuffer
};
