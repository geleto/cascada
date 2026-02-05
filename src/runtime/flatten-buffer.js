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

function doFlattenBuffer(arr, context = null, outputName = null, sharedState = null) {

  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, outputName, sharedState, doFlattenBuffer);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, outputName, sharedState, doFlattenBuffer);
}

// Output-driven entry point for script mode.
// Output carries buffer, context, and outputName — all flatten needs.
// Internal recursion (nested CommandBuffers) still goes through flattenBuffer.
function flattenOutput(output) {
  const buffer = output._buffer;
  const context = output._context;
  const outputName = (output._outputName && output._outputName !== 'output') ? output._outputName : null;

  // Template mode shortcut: empty named outputs return type defaults without flattening
  if (!buffer._scriptMode && output._outputName && output._outputName !== 'output'
      && typeof buffer._getOutputArray === 'function') {
    const target = buffer._getOutputArray(output._outputName);
    if (!target || target.length === 0) {
      if (output._outputType === 'data') return {};
      if (output._outputType === 'text') return '';
      if (output._outputType === 'value') return undefined;
    }
  }

  // Template mode or implicit 'output' handler: return flatten result directly
  if (!buffer._scriptMode || output._outputName === 'output') {
    return flattenBuffer(buffer, context, outputName);
  }

  // Script mode: flatten populates _target/_base as a side effect;
  // resolve the final value from them after flatten completes.
  const result = flattenBuffer(buffer, context, outputName);
  if (result && typeof result.then === 'function') {
    return result.then(() => output._resolveFromOutput());
  }
  return output._resolveFromOutput();
}

module.exports = {
  flattenBuffer,
  flattenOutput
};
