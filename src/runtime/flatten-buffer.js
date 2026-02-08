'use strict';

const { CommandBuffer } = require('./buffer');
const { Command, OutputCommand } = require('./commands');
const { RuntimeFatalError, PoisonError, isPoisonError } = require('./errors');
const DataHandler = require('../script/data-handler');

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

  const errors = flattenCommandBuffer(buffer, output, context);
  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return output.getCurrentResult();
}

function flattenCommandBuffer(buffer, output, errorContext) {
  const errors = [];
  const arr = buffer._getOutputArray(output && output._outputName ? output._outputName : null);
  for (const entry of arr) {
    flattenEntry(entry, output, errorContext, errors);
  }
  return errors;
}

function flattenEntry(entry, output, errorContext, errors) {
  if (entry instanceof Command) {
    try {
      // Route built-in data handler commands to a DataHandler target.
      if (entry instanceof OutputCommand && entry.handler === 'data') {
        let base = output._base;
        if (!base) {
          const vars = errorContext && typeof errorContext.getVariables === 'function'
            ? errorContext.getVariables()
            : {};
          const env = errorContext && errorContext.env ? errorContext.env : null;
          base = new DataHandler(vars, env);
        }
        entry.apply({ _base: base });
      } else {
        entry.apply(output);
      }
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
    const nested = flattenCommandBuffer(entry, output, errorContext);
    if (nested.length > 0) {
      errors.push(...nested);
    }
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
