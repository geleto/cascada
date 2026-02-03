'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');
const { PoisonError } = require('./errors');
const { createFlattenState, buildFinalResultFromState } = require('./flatten-shared');

// the below comments may not be exactly correct right now
// outputName only (no focusOutput) => {outputName: ...} (wrapped)
// focusOutput only (no outputName) => value (unwrapped)
// both provided => value (unwrapped, focusOutput used)
// neither provided, no context => this is a text flattening => string
// neither provided, context  => ERROR (no longer supported)
function flattenBuffer(arr, context = null, focusOutput = null) {
  if (context && !focusOutput) {
    //throw new Error('flattenBuffer requires either focusOutput or outputName parameter');
  }
  if (context && arr instanceof CommandBuffer) {
    return flattenCommandBufferCached(arr, context, focusOutput);
  }

  return doFlattenBuffer(arr, context, focusOutput);
}

// @TODO - remove this once proper snapshot() is implemented for outputs
// In script mode, multiple snapshots/returns may request flattening the same
// CommandBuffer more than once (e.g. implicit return + explicit snapshots).
// Flattening must be idempotent w.r.t. executing output commands, so we cache
// the flattened state per CommandBuffer instance.
function flattenCommandBufferCached(buffer, context, focusOutput) {
  const resolveFromState = (state) => {
    if (state && state.collectedErrors && state.collectedErrors.length > 0) {
      throw new PoisonError(state.collectedErrors);
    }
    const finalResult = buildFinalResultFromState(state || {});

    if (!focusOutput) {
      return finalResult;
    }

    // Match flattenCommandBuffer focused return semantics.
    if (focusOutput === 'text') {
      const textArr = state.textOutput && state.textOutput.text ? state.textOutput.text : [];
      const textResult = Array.isArray(textArr) ? textArr.join('') : '';
      return textResult ? textResult : undefined;
    }
    if (state.textOutput && state.textOutput[focusOutput]) {
      return state.textOutput[focusOutput].join('');
    }
    return finalResult[focusOutput];
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
  const computed = doFlattenBuffer(buffer, context, null, null, sharedState);

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

function doFlattenBuffer(arr, context = null, focusOutput = null, outputName = null, sharedState = null) {

  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, focusOutput, outputName, sharedState, doFlattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, focusOutput, outputName, sharedState, doFlattenBuffer);
}

module.exports = {
  flattenBuffer
};
