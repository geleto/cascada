'use strict';

const { CommandBuffer } = require('./command-buffer');
const { RuntimeFatalError, PoisonError } = require('./errors');

function flattenBuffer(output, errorContext = null) {
  if (!output || (typeof output !== 'object' && typeof output !== 'function')) {
    const context = errorContext || null;
    throw new RuntimeFatalError(
      `Invalid output object for flattening: ${output}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  let context = errorContext || output._context || null;
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

  if (typeof output.snapshot !== 'function') {
    throw new RuntimeFatalError(
      `Output object is missing snapshot() for flatten compatibility`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  // Sync-first compatibility: if output execution is fully completed,
  // return/throw synchronously (legacy flattenBuffer behavior in tests).
  if (output._completionResolved === true) {
    if (Array.isArray(output._errors) && output._errors.length > 0) {
      throw new PoisonError(output._errors.slice());
    }
    return output.getCurrentResult();
  }

  return output.snapshot();
}

module.exports = {
  flattenBuffer
};
