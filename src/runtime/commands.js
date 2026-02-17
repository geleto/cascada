'use strict';

const { isPoison, isPoisonError, PoisonError, createPoison, handleError } = require('./errors');
const contextualizedOutputErrorCache = new WeakMap();

/**
 * Command classes for the script-mode output pipeline.
 *
 * Each command carries the data needed to mutate an Output object.
 * The flattener calls command.apply(output) in source order; output is the
 * Output instance for the target handler.
 *
 * apply() mutates output in place and may encode poison into output state.
 * getError() returns a PoisonError if the command carries poison, or null.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

class Command {
  constructor(options = null) {
    const opts = options || {};
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

  extractPoisonFromArgs() {
    const args = this.arguments;
    if (isPoisonError(args) && Array.isArray(args.errors) && args.errors.length > 0) {
      return args.errors.slice();
    }
    if (isPoison(args) && Array.isArray(args.errors) && args.errors.length > 0) {
      return args.errors.slice();
    }
    if (!Array.isArray(args)) return [];
    const errors = [];
    for (const arg of args) {
      if (isPoisonError(arg) && Array.isArray(arg.errors) && arg.errors.length > 0) {
        errors.push(...arg.errors);
      } else if (isPoison(arg) && Array.isArray(arg.errors) && arg.errors.length > 0) {
        errors.push(...arg.errors);
      }
    }
    return errors;
  }

  toPoisonValue(errors) {
    return createPoison(errors);
  }

  getError() {
    const errors = this.extractPoisonFromArgs();
    return errors.length > 0 ? new PoisonError(errors) : null;
  }

  apply(ctx) {
    void ctx;
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
      this.normalizeArgs = !!specOrValue.normalizeArgs;
      return;
    }
    super({
      handler: 'text',
      command: null,
      arguments: [specOrValue],
      subpath: null,
      pos: null
    });
    this.normalizeArgs = false;
  }

  apply(output) {
    super.apply(output);
    if (!output || !Array.isArray(output._target)) {
      if (!output) {
        return;
      }
      output._setTarget([]);
    }
    const poisonErrors = this.extractPoisonFromArgs();
    if (poisonErrors.length > 0) {
      output._target.push(this.toPoisonValue(poisonErrors));
      output._markStateChanged();
      return;
    }
    const args = Array.isArray(this.arguments) ? this.arguments : [];
    const pos = this.pos || { lineno: 0, colno: 0 };
    for (const arg of args) {
      if (arg === null || arg === undefined) {
        continue;
      }
      const type = typeof arg;
      if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
        output._target.push(arg);
        continue;
      }
      if (type === 'object') {
        const hasCustomToString = arg.toString && arg.toString !== Object.prototype.toString;
        if (hasCustomToString) {
          output._target.push(arg);
          continue;
        }
      }
      const argType = Array.isArray(arg) ? 'array' : type;
      throw new Error(`Invalid TextCommand argument type '${argType}' at ${pos.lineno}:${pos.colno}. TextCommand only accepts text-like scalar values.`);
    }
    output._markStateChanged();
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

  apply(output) {
    super.apply(output);
    if (!output) return;
    const poisonErrors = this.extractPoisonFromArgs();
    if (poisonErrors.length > 0) {
      output._setTarget(this.toPoisonValue(poisonErrors));
      return;
    }
    if (!Array.isArray(this.arguments) || this.arguments.length === 0) {
      output._setTarget(undefined);
      return;
    }
    if (this.arguments.length > 1) {
      output._setTarget(this.toPoisonValue([
        contextualizeOutputError(output, this.pos, new Error('value output accepts exactly one argument'))
      ]));
      return;
    }
    output._setTarget(this.arguments[0]);
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

  apply(output) {
    super.apply(output);
    if (!output || !output._base) return;
    const poisonErrors = this.extractPoisonFromArgs();
    if (poisonErrors.length > 0) {
      setDataPoisonAtPath(
        output,
        this.arguments,
        this.toPoisonValue(poisonErrors)
      );
      return;
    }
    const method = this.command ? output._base[this.command] : output._base;
    if (typeof method !== 'function') {
      setDataPoisonAtPath(
        output,
        this.arguments,
        this.toPoisonValue([
          contextualizeOutputError(output, this.pos, new Error(`has no method '${this.command}'`))
        ])
      );
      return;
    }
    method.apply(output._base, this.arguments);
    output._setTarget(output._base.data);
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

  apply(output) {
    super.apply(output);
    if (!output) return;
    const isRootRepair = this.command === 'repair' && (!this.subpath || this.subpath.length === 0);
    if (!isRootRepair && isPoison(output._getTarget())) {
      return;
    }
    const poisonErrors = this.extractPoisonFromArgs();
    if (poisonErrors.length > 0) {
      output._setTarget(this.toPoisonValue(poisonErrors));
      return;
    }
    const sink = output._sink;
    const target = resolveSubpath(sink, this.subpath);
    const method = this.command ? (target && target[this.command]) : target;

    if (isRootRepair) {
      output._setTarget(undefined);
      if (typeof method !== 'function') {
        return;
      }
      const repairResult = method.apply(target, this.arguments);
      if (repairResult && typeof repairResult.then === 'function') {
        return Promise.resolve(repairResult).catch((err) => {
          output._setTarget(this.toPoisonValue([contextualizeOutputError(output, this.pos, err)]));
        });
      }
      return;
    }

    if (typeof method !== 'function') {
      output._setTarget(this.toPoisonValue([
        contextualizeOutputError(output, this.pos, new Error(`Sink method '${this.command}' not found`))
      ]));
      return;
    }

    try {
      const result = method.apply(target, this.arguments);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((err) => {
          output._setTarget(this.toPoisonValue([contextualizeOutputError(output, this.pos, err)]));
        });
      }
      return result;
    } catch (err) {
      output._setTarget(this.toPoisonValue([contextualizeOutputError(output, this.pos, err)]));
    }
  }
}

class SequenceCallCommand extends OutputCommand {
  constructor({ handler, command, args = null, arguments: legacyArgs = null, subpath = null, pos = null, withDeferredResult = false }) {
    super({
      handler,
      command: command || null,
      args: args || legacyArgs || [],
      subpath: subpath || null,
      pos
    });
    if (withDeferredResult) {
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
  }

  apply(output) {
    super.apply(output);
    if (!output) return undefined;
    const poisonErrors = this.extractPoisonFromArgs();
    if (poisonErrors.length > 0) {
      const err = new PoisonError(poisonErrors);
      this.rejectResult(err);
      throw err;
    }

    const execute = (sink) => {
      const target = resolveSubpath(sink, this.subpath);
      if (target === null || target === undefined) {
        this.resolveResult(undefined);
        return undefined;
      }
      const method = this.command ? target[this.command] : target;
      if (typeof method !== 'function') {
        this.resolveResult(undefined);
        return undefined;
      }
      const result = method.apply(target, this.arguments);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => {
            this.resolveResult(value);
            return value;
          },
          (err) => {
            this.rejectResult(err);
            throw err;
          }
        );
      }
      this.resolveResult(result);
      return result;
    };

    const sink = output._ensureSinkResolved ? output._ensureSinkResolved() : output._sink;
    if (sink && typeof sink.then === 'function') {
      return Promise.resolve(sink).then(execute);
    }
    return execute(sink);
  }
}

class SequenceGetCommand extends OutputCommand {
  constructor({ handler, command, subpath = null, pos = null, withDeferredResult = false }) {
    super({
      handler,
      command: command || null,
      args: [],
      subpath: subpath || null,
      pos
    });
    this.mutatesOutput = false;
    if (withDeferredResult) {
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
  }

  apply(output) {
    if (!output) return undefined;

    const execute = (sink) => {
      const target = resolveSubpath(sink, this.subpath);
      const value = (target === null || target === undefined || !this.command) ? undefined : target[this.command];
      this.resolveResult(value);
      return value;
    };

    const sink = output._ensureSinkResolved ? output._ensureSinkResolved() : output._sink;
    if (sink && typeof sink.then === 'function') {
      return Promise.resolve(sink).then(execute, (err) => {
        this.rejectResult(err);
        throw err;
      });
    }
    return execute(sink);
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
    void ctx;
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

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._resolveSnapshotCommandResult !== 'function') {
      this.rejectResult(contextualize(new Error('SnapshotCommand requires an output handler with _resolveSnapshotCommandResult()')));
      return;
    }

    try {
      const result = output._resolveSnapshotCommandResult();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => {
            this.resolveResult(value);
          },
          (err) => {
            this.rejectResult(contextualize(err));
          }
        );
      }
      this.resolveResult(result);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

class IsErrorCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isSnapshotCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._isErrorNow !== 'function') {
      this.rejectResult(contextualize(new Error('IsErrorCommand requires an output handler with _isErrorNow()')));
      return;
    }

    try {
      const result = output._isErrorNow();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(!!value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(!!result);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

class GetErrorCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isSnapshotCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._getErrorNow !== 'function') {
      this.rejectResult(contextualize(new Error('GetErrorCommand requires an output handler with _getErrorNow()')));
      return;
    }

    try {
      const result = output._getErrorNow();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value || null),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result || null);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

class SinkRepairCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.mutatesOutput = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._repairNow !== 'function') {
      this.rejectResult(contextualize(new Error('SinkRepairCommand requires a sink output handler with _repairNow()')));
      return;
    }

    try {
      const result = output._repairNow();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result);
    } catch (err) {
      this.rejectResult(contextualize(err));
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

  apply(output) {
    if (!output) {
      return;
    }
    if (typeof output._restoreGuardState === 'function') {
      output._restoreGuardState(this.target);
      return;
    }
    output._setTarget(this.target);
  }
}

module.exports = {
  Command,
  OutputCommand,
  TextCommand,
  ValueCommand,
  DataCommand,
  SinkCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  ErrorCommand,
  SnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  SinkRepairCommand,
  SetTargetCommand
};

function setDataPoisonAtPath(output, args, poisonValue) {
  if (!output || !output._base || typeof output._base.set !== 'function') {
    return;
  }
  const rawPath = Array.isArray(args) && args.length > 0 ? args[0] : null;
  const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
  const existingValue = readDataValueAtPath(output._base.data, path);
  const existingErrors = extractPoisonErrors(existingValue);
  const newErrors = extractPoisonErrors(poisonValue);
  const mergedPoison = (existingErrors.length > 0 || newErrors.length > 0)
    ? createPoison([...existingErrors, ...newErrors])
    : poisonValue;
  output._base.set(path, mergedPoison);
  output._setTarget(output._base.data);
}

function readDataValueAtPath(root, path) {
  if (!Array.isArray(path) || path.length === 0 || (path.length === 1 && path[0] === null)) {
    return root;
  }
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (segment === '[]') {
      if (!Array.isArray(current) || current.length === 0) {
        return undefined;
      }
      current = current[current.length - 1];
      continue;
    }
    current = current[segment];
  }
  return current;
}

function extractPoisonErrors(value) {
  if (isPoison(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  if (isPoisonError(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  return [];
}

function contextualizeOutputError(output, pos, err) {
  const lineno = pos && typeof pos.lineno === 'number' ? pos.lineno : 0;
  const colno = pos && typeof pos.colno === 'number' ? pos.colno : 0;
  const path = output && output._context && output._context.path ? output._context.path : null;
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    const cacheKey = `${lineno}:${colno}:${path || ''}`;
    const perError = contextualizedOutputErrorCache.get(err);
    if (perError && perError.has(cacheKey)) {
      return perError.get(cacheKey);
    }
    const wrapped = handleError(err, lineno, colno, null, path);
    if (wrapped !== err) {
      const nextPerError = perError || new Map();
      nextPerError.set(cacheKey, wrapped);
      contextualizedOutputErrorCache.set(err, nextPerError);
    }
    return wrapped;
  }
  const wrapped = handleError(err, lineno, colno, null, path);
  return wrapped;
}

function resolveSubpath(target, subpath) {
  if (!Array.isArray(subpath) || subpath.length === 0) {
    return target;
  }
  let current = target;
  for (const segment of subpath) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
