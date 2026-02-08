'use strict';

const { CommandBuffer } = require('./buffer');
const { Command, ErrorCommand, OutputCommand } = require('./commands');
const { RuntimeFatalError, PoisonError, isPoison } = require('./errors');
const DataHandler = require('../script/data-handler');
const BUILTIN_HANDLERS = new Set(['text', 'data', 'value', 'sink']);

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
  for (const command of arr) {
    errors.push(...flattenCommands(command, output, errorContext));
  }
  return errors;
}

function flattenCommands(command, output, errorContext) {
  const errors = [];


  function pushTextValue(val) {
    if (!output || !Array.isArray(output._target)) {
      return;
    }
    output._target.push(val);
  }

  if (isPoison(command)) {
    errors.push(...command.errors);
    return errors;
  }

  if (command instanceof ErrorCommand) {
    const errList = command.value && command.value.errors
      ? command.value.errors
      : [command.value || new Error('Command buffer entry produced an unspecified error')];
    errors.push(...errList);
    return errors;
  }

  if (command instanceof Command) {
    if (command instanceof OutputCommand) {
      // Collect poison from command args before attempting apply().
      if (Array.isArray(command.arguments)) {
        for (const arg of command.arguments) {
          if (isPoison(arg)) {
            errors.push(...arg.errors);
          }
        }
        if (errors.length > 0) {
          return errors;
        }
      }

      // Unknown handlers are unsupported. Built-ins are allowed even if the
      // current flattened output name differs.
      const handlerName = command.handler;
      const isKnownCustomOutput = !!(output && output._outputName && handlerName === output._outputName);
      if (handlerName && !BUILTIN_HANDLERS.has(handlerName) && !isKnownCustomOutput) {
        errors.push(new Error(`Unsupported output command target: ${handlerName}`));
        return errors;
      }
    }

    try {
      // Route built-in data handler commands to a DataHandler target.
      if (command instanceof OutputCommand && command.handler === 'data') {
        let base = output._base;
        if (!base) {
          const vars = errorContext && typeof errorContext.getVariables === 'function'
            ? errorContext.getVariables()
            : {};
          const env = errorContext && errorContext.env ? errorContext.env : null;
          base = new DataHandler(vars, env);
        }
        command.apply({ _base: base });
      } else {
        command.apply(output);
      }
    } catch (err) {
      errors.push(err);
      return errors;
    }
    return errors;
  }

  if (command instanceof CommandBuffer) {
    errors.push(...flattenCommandBuffer(command, output, errorContext));
    return errors;
  }

  if (errorContext) {
    throw new RuntimeFatalError(
      `Invalid command in buffer: ${command}`,
      errorContext.lineno,
      errorContext.colno,
      errorContext.errorContextString,
      errorContext.path
    );
  }

  return errors;
}

module.exports = {
  flattenBuffer
};
