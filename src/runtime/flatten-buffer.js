'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenCommands, flattenCommandBuffer } = require('./flatten-commands');
const { RuntimeFatalError } = require('./errors');

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
  if (buffer instanceof CommandBuffer) {
    return flattenCommandBuffer(buffer, context, outputName);
  }
  return flattenCommands(buffer, context, outputName);
}

module.exports = {
  flattenBuffer
};
