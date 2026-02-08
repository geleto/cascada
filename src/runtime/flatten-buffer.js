'use strict';

const { CommandBuffer } = require('./buffer');
const { Command } = require('./commands');
const { RuntimeFatalError, PoisonError, isPoisonError } = require('./errors');

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

  const errors = [];
  flattenCommandBuffer(buffer, output, context, errors);
  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return output.getCurrentResult();
}

function flattenCommandBuffer(buffer, output, errorContext, errors) {
  const arr = buffer.arrays[output._outputName] ?? [];
  for (const command of arr) {
    flattenCommand(command, output, errorContext, errors);
  }
}

function flattenCommand(entry, output, errorContext, errors) {
  if (entry instanceof Command) {
    try {
      entry.apply(output);
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
    return;
  }

  if (entry instanceof CommandBuffer) {
    flattenCommandBuffer(entry, output, errorContext, errors);
    return;
  }

  if (errorContext) {
    throw new RuntimeFatalError(
      `Invalid command in buffer: ${entry}`,
      errorContext.lineno,
      errorContext.colno,
      errorContext.errorContextString,
      errorContext.path
    );
  }
}

module.exports = {
  flattenBuffer
};
