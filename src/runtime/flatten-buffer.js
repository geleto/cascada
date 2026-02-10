'use strict';

const { CommandBuffer } = require('./buffer');
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

  // Some call sites provide a synthetic output facade for an existing buffer/handler.
  // Flatten against the registered output instance so we walk the chain that was
  // built at runtime for that handler.
  if (!output._frame && buffer._outputs instanceof Map) {
    const registered = buffer._outputs.get(output._outputName);
    if (registered && registered !== output) {
      output = registered;
      context = errorContext || output._context || context;
    }
  }

  const errors = [];
  flattenChain(output, errors);

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return output.getCurrentResult();
}

function flattenChain(output, errors) {
  let cmd = output._firstChainedCommand;
  const visited = new Set();

  while (cmd) {
    if (visited.has(cmd)) {
      errors.push(new RuntimeFatalError(
        `Detected cyclic command chain while flattening output '${output._outputName}'`
      ));
      break;
    }
    visited.add(cmd);

    try {
      cmd.apply(output);
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
    cmd = cmd.next;
  }
}

module.exports = {
  flattenBuffer
};
