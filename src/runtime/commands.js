'use strict';

const { isPoison, PoisonError } = require('./errors');

/**
 * Command classes for the script-mode output pipeline.
 *
 * Each command carries the data needed to mutate an Output object (ctx).
 * The flattener calls command.apply(outputCtx) in source order; ctx is the
 * Output instance for the target handler.
 *
 * apply() mutates ctx in place and throws on error (including poison).
 * getError() returns a PoisonError if the command carries poison, or null.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

class Command {
  constructor(options = null) {
    const opts = options || {};
    // Native command-chain metadata for buffer linking/snapshots.
    this.next = null;
    this.resolved = false;
    this.promise = null;
    this.resolve = null;
    this.reject = null;
    this.mutatesOutput = false;
    this.isSnapshotCommand = false;

    if (opts.withDeferredResult) {
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
  }

  resolveResult(value) {
    if (!this.resolve) {
      return;
    }
    this.resolve(value);
    this.resolve = null;
    this.reject = null;
  }

  rejectResult(err) {
    if (!this.reject) {
      return;
    }
    this.reject(err);
    this.resolve = null;
    this.reject = null;
  }

  getError() {
    return null;
  }

  apply(ctx) {
    throw new Error('Command.apply() must be overridden');
  }
}

// Base command for declared outputs only (text/value/data/sink).
class OutputCommand extends Command {
  constructor({ handler, command = null, args = null, arguments: legacyArgs = null, subpath = null, pos = null }) {
    super();
    this.handler = handler;
    this.command = command;
    this.arguments = args || legacyArgs || [];
    this.subpath = subpath;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.mutatesOutput = true;
  }

  getError() {
    const args = this.arguments;
    if (!Array.isArray(args)) return null;
    let errors = null;
    for (const arg of args) {
      if (isPoison(arg)) {
        if (!errors) errors = [];
        errors.push(...arg.errors);
      }
    }
    return errors ? new PoisonError(errors) : null;
  }

  apply(ctx) {
    const err = this.getError();
    if (err) throw err;
  }
}

class TextCommand extends OutputCommand {
  constructor(specOrValue) {
    const isSpecObject = !!specOrValue &&
      typeof specOrValue === 'object' &&
      !Array.isArray(specOrValue) &&
      (
        Object.prototype.hasOwnProperty.call(specOrValue, 'handler') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'args') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'arguments') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'command') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'subpath') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'pos')
      );
    if (isSpecObject) {
      super({
        handler: specOrValue.handler,
        command: null,
        args: specOrValue.args || specOrValue.arguments || [],
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

  apply(dispatchCtx) {
    super.apply(dispatchCtx);
    if (!dispatchCtx || !Array.isArray(dispatchCtx._target)) {
      if (dispatchCtx) {
        dispatchCtx._target = [];
      } else {
        return;
      }
    }
    const args = Array.isArray(this.arguments) ? this.arguments : [];
    const pos = this.pos || { lineno: 0, colno: 0 };
    for (const arg of args) {
      if (arg === null || arg === undefined) {
        continue;
      }
      const type = typeof arg;
      if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
        dispatchCtx._target.push(arg);
        continue;
      }
      if (type === 'object') {
        const hasCustomToString = arg.toString && arg.toString !== Object.prototype.toString;
        if (hasCustomToString) {
          dispatchCtx._target.push(arg);
          continue;
        }
      }
      const argType = Array.isArray(arg) ? 'array' : type;
      throw new Error(`Invalid TextCommand argument type '${argType}' at ${pos.lineno}:${pos.colno}. TextCommand only accepts text-like scalar values.`);
    }
  }
}

class ValueCommand extends OutputCommand {
  constructor(specOrValue) {
    const isSpecObject = !!specOrValue &&
      typeof specOrValue === 'object' &&
      !Array.isArray(specOrValue) &&
      (
        Object.prototype.hasOwnProperty.call(specOrValue, 'handler') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'args') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'arguments') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'command') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'subpath') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'pos')
      );
    if (isSpecObject) {
      super({
        handler: specOrValue.handler,
        command: null,
        args: specOrValue.args || specOrValue.arguments || [],
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

  apply(dispatchCtx) {
    super.apply(dispatchCtx);
    if (!dispatchCtx) return;
    dispatchCtx._target = this.arguments.length > 0 ? this.arguments[this.arguments.length - 1] : undefined;
  }
}

class DataCommand extends OutputCommand {
  constructor({ handler, command, args = null, arguments: legacyArgs = null, pos = null }) {
    super({
      handler,
      command: command || null,
      args: args || legacyArgs || [],
      subpath: null,
      pos
    });
  }

  apply(dispatchCtx) {
    super.apply(dispatchCtx);
    if (!dispatchCtx || !dispatchCtx._base) return;
    const method = this.command ? dispatchCtx._base[this.command] : dispatchCtx._base;
    if (typeof method !== 'function') {
      throw new Error(`has no method '${this.command}'`);
    }
    method.apply(dispatchCtx._base, this.arguments);
    dispatchCtx._target = dispatchCtx._base.data;
  }
}

class SinkCommand extends OutputCommand {
  constructor({ handler, command, args = null, arguments: legacyArgs = null, subpath = null, pos = null }) {
    super({
      handler,
      command: command || null,
      args: args || legacyArgs || [],
      subpath: subpath || null,
      pos
    });
  }

  apply(dispatchCtx) {
    super.apply(dispatchCtx);
    if (!dispatchCtx) return;
    const sink = dispatchCtx._sink;
    const method = this.command ? (sink && sink[this.command]) : sink;
    if (typeof method !== 'function') {
      throw new Error(`Sink method '${this.command}' not found`);
    }
    method.apply(sink, this.arguments);
  }
}

class ErrorCommand extends Command {
  constructor(errors) {
    super();
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(ctx) {
    throw this.getError();
  }
}

class SnapshotCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isSnapshotCommand = true;
  }

  apply(dispatchCtx) {
    if (!dispatchCtx || typeof dispatchCtx._resolveSnapshotCommandResult !== 'function') {
      this.rejectResult(new Error('SnapshotCommand requires an output handler with _resolveSnapshotCommandResult()'));
      return;
    }

    try {
      const result = dispatchCtx._resolveSnapshotCommandResult();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => {
            this.resolveResult(value);
          },
          (err) => {
            this.rejectResult(err);
          }
        );
      }
      this.resolveResult(result);
    } catch (err) {
      this.rejectResult(err);
    }
  }
}

class SetTargetCommand extends Command {
  constructor({ handler, target, pos = null }) {
    super();
    this.handler = handler;
    this.target = target;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(dispatchCtx) {
    if (!dispatchCtx) {
      return;
    }
    if (typeof dispatchCtx._restoreGuardState === 'function') {
      dispatchCtx._restoreGuardState(this.target);
      return;
    }
    dispatchCtx._target = this.target;
  }
}

module.exports = {
  Command,
  OutputCommand,
  TextCommand,
  ValueCommand,
  DataCommand,
  SinkCommand,
  ErrorCommand,
  SnapshotCommand,
  SetTargetCommand
};
