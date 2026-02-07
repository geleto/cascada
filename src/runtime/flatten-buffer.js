'use strict';

const { CommandBuffer } = require('./buffer');
const { flattenCommandBuffer } = require('./flatten-commands');
const { RuntimeFatalError } = require('./errors');

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

  if (!(buffer instanceof CommandBuffer)) {
    throw new RuntimeFatalError(
      `Output _buffer must be a CommandBuffer, got: ${typeof buffer}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  return flattenCommandBuffer(buffer, context, output._outputName);
}

module.exports = {
  flattenBuffer
};
