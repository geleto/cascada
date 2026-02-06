'use strict';

const { CommandBuffer, resolveBufferArray } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');

function doFlattenBuffer(arr, context = null, outputName = null, sharedState = null) {
  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, context, outputName, sharedState);
  }

  if (!context) {
    return flattenText(arr, outputName, sharedState, doFlattenBuffer);
  }

  return flattenCommands(arr, context, outputName, sharedState);
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
  const result = doFlattenBuffer(buffer, context, outputName);
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
  return resolveFromOutput();
}

module.exports = {
  flattenBuffer,
  flattenBufferText
};
