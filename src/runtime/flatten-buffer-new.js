'use strict';

const { Command, ErrorCommand } = require('./commands');
const { CommandBuffer } = require('./buffer');
const { RuntimeFatalError, PoisonedValue } = require('./errors');

function flattenBuffer(arr, output, context = null) {
  let errors = [];
  if (arr instanceof CommandBuffer) {
    errors = flattenCommandBuffer(arr, output, context);
  } else {
    // Intentionally left as-is for now (per request).
    errors = flattenText(arr, output._outputName);
  }
  if (errors.length) {
    return new PoisonedValue(errors); // @todo add context details
  }
  return errors;
}

function flattenCommandBuffer(buffer, output, errorContext) {
  const errors = [];
  const arr = buffer.arrays[output._outputName] || [];
  for (const command of arr) {
    errors.push(...flattenCommands(command, output, errorContext));
  }
  return errors;
}

function flattenCommands(command, output, errorContext) {
  const errors = [];

  if (command instanceof ErrorCommand) {
    const errList = command.value && command.value.errors ? command.value.errors : [command];
    errors.push(...errList);
    return errors;
  }

  if (command instanceof Command) {
    try {
      command.apply(output);
    } catch (err) {
      if (errorContext) {
        throw new RuntimeFatalError(
          err,
          errorContext.lineno,
          errorContext.colno,
          errorContext.errorContextString,
          errorContext.path
        );
      }
      throw err;
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
  flattenBuffer,
  flattenCommandBuffer,
  flattenCommands
};

/*
const {Command, ErrorCommand} = require('./commands');
const { CommandBuffer} = require('./buffer');
const { RuntimeFatalError, PoisonedValue } = require('./runtime');

function flattenBuffer(arr, output, context = null) {
  let errors;
  if (arr instanceof CommandBuffer) {
    errors = flattenCommandBuffer(arr, output, context);
  } else {
    errors = flattenText(arr, output.outputName);
  }
  if (errors.length) {
    return new PoisonedValue(errors);//@todo - context
  }
  return errors;
}

function flattenCommandBuffer(buffer, output, errorContext) {
  const errors = [];
  const arr = buffer.arrays[output._outputName] || [];
  for (const command of arr) {
    errors.push(...flattenCommands(command, output, errorContext));
  }
}

function flattenCommands(command, output, errorContext) {
  let errors = [];
  if (command instanceof ErrorCommand) {
    errors = [(command.value && command.value.errors ? command.value.errors : [command])];
  } else if (command instanceof Command) {
    command.apply(output, errorContext);
  } else if (command instanceof CommandBuffer) {
    errors.push(...flattenCommandBuffer(command, output, errorContext));
  } else {
    if (errorContext) {
      throw new RuntimeFatalError(`Invalid command in buffer: ${command}`,
        errorContext.lineno,
        errorContext.colno,
        errorContext.errorContextString,
        errorContext.path
      );
    }
  }
  return errors;
}
*/
