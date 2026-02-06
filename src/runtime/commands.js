'use strict';

/**
 * Command classes for the script-mode output pipeline.
 *
 * Each command carries the data needed to mutate an Output object (ctx).
 * The flattener calls command.apply(outputCtx) in source order; ctx is the
 * Output instance for the target handler.
 *
 * apply() mutates ctx in place; callers must not rely on return values.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

class Command {
  apply(ctx) {
    throw new Error('Command.apply() must be overridden');
  }
}

// Generic handler-dispatch command used for custom/non-specialized handlers.
class HandlerCommand extends Command {
  constructor({ handler, command = null, arguments: args = [], subpath = null, pos = null }) {
    super();
    this.handler = handler;
    this.command = command;
    this.arguments = args;
    this.subpath = subpath;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(dispatchCtx) {
    return dispatchCtx.invokeOutputCommand(this);
  }
}

class TextCommand extends HandlerCommand {
  constructor(specOrValue) {
    const isSpecObject = !!specOrValue &&
      typeof specOrValue === 'object' &&
      !Array.isArray(specOrValue) &&
      (
        Object.prototype.hasOwnProperty.call(specOrValue, 'handler') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'args') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'command') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'subpath') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'pos')
      );
    if (isSpecObject) {
      super({
        handler: specOrValue.handler,
        command: null,
        arguments: specOrValue.args || [],
        subpath: null,
        pos: specOrValue.pos || null
      });
      return;
    }
    super({
      handler: 'text',
      command: null,
      arguments: [specOrValue],
      subpath: null,
      pos: null
    });
  }
}

class ValueCommand extends HandlerCommand {
  constructor(specOrValue) {
    const isSpecObject = !!specOrValue &&
      typeof specOrValue === 'object' &&
      !Array.isArray(specOrValue) &&
      (
        Object.prototype.hasOwnProperty.call(specOrValue, 'handler') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'args') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'command') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'subpath') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'pos')
      );
    if (isSpecObject) {
      super({
        handler: specOrValue.handler,
        command: null,
        arguments: specOrValue.args || [],
        subpath: null,
        pos: specOrValue.pos || null
      });
      return;
    }
    super({
      handler: 'value',
      command: null,
      arguments: [specOrValue],
      subpath: null,
      pos: null
    });
  }
}

class DataCommand extends HandlerCommand {
  constructor({ handler, command, args = [], pos = null }) {
    super({
      handler,
      command: command || null,
      arguments: args,
      subpath: null,
      pos
    });
  }
}

class SinkCommand extends HandlerCommand {
  constructor({ handler, command, args = [], subpath = null, pos = null }) {
    super({
      handler,
      command: command || null,
      arguments: args,
      subpath: subpath || null,
      pos
    });
  }
}

class ErrorCommand extends Command {
  constructor(value) {
    super();
    this.value = value;
  }

  apply(ctx) {
    ctx._target = this.value;
  }
}

module.exports = {
  Command,
  HandlerCommand,
  TextCommand,
  ValueCommand,
  DataCommand,
  SinkCommand,
  ErrorCommand
};
