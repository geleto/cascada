'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenText } = require('./flatten-text');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');
const { RuntimeFatalError } = require('./errors');

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
  const name = outputName || 'text';

  if (arr instanceof CommandBuffer) {
    return flattenCommandBuffer(arr, null, name, sharedState);
  }

  return flattenText(arr, name, sharedState, doFlattenBuffer);
}

// Output-driven entry point for script mode.
// Output carries buffer, context, and outputName — all flatten needs.
// Internal recursion (nested CommandBuffers) goes through doFlattenBuffer.
function flattenBuffer(output, errorContext = null) {

  let context = errorContext || output._context || null;

  if (!output || (typeof output !== 'object' && typeof output !== 'function')) {
    throw new RuntimeFatalError(
      `Invalid output object for flattening: ${output}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  const buffer = output._buffer;
  if (!buffer) {
    throw new RuntimeFatalError(
      `Output object is missing _buffer property for flattening: ${output}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  const outputName = (output._outputName && output._outputName !== 'output') ? output._outputName : null;
  const isTemplateMode = (buffer instanceof CommandBuffer) && !buffer._scriptMode;
  if (isTemplateMode) {
    // Template mode should use text flattening (no second-pass suppression).
    throw new RuntimeFatalError(
      'flattenBuffer should not be called directly in template mode; use flattenBufferText instead',
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  return doFlattenBuffer(buffer, context, outputName);
}

module.exports = {
  flattenBuffer,
  flattenBufferText
};
