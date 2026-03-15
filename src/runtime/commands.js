'use strict';

const { isPoison, isPoisonError, PoisonError, createPoison, handleError } = require('./errors');
const contextualizedOutputErrorCache = new WeakMap();
let safeOutputApi = null;

/**
 * Command classes for the script-mode output pipeline.
 *
 * Each command carries the data needed to mutate an Output object.
 * The flattener calls command.apply(output) in source order; output is the
 * Output instance for the target handler.
 *
 * apply() mutates output in place and may encode poison into output state.
 * getError() returns a PoisonError if the command carries poison, or null.
 *
 * isObservable: true  — command returns a deferred value; applied immediately
 *                       without waiting for prior mutable commands to complete.
 * isObservable: false — command mutates output state; waits for any pending
 *                       observable commands before applying.
 * Copy-on-write protection (DataOutput._beforeApplyCommand) is triggered for
 * every non-observable (mutating) command.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

// Base class for all commands. Manages the optional deferred-result promise used by observable commands.
class Command {
  constructor(options = null) {
    const opts = options || {};
    this.resolved = false;
    this.promise = null;
    this.resolve = null;
    this.reject = null;
    this.isObservable = false;
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

// Base class for commands targeting a declared output handler (text/value/data/sink). Carries handler name, method name, arguments, and source position.
class OutputCommand extends Command {
  constructor({ handler, command = null, args = null, arguments: legacyArgs = null, subpath = null, pos = null }) {
    super();
    this.handler = handler;
    this.command = command;
    this.arguments = args || legacyArgs || [];
    this.subpath = subpath;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  extractPoisonFromArgs() {
    const args = this.arguments;
    if (isPoison(args) && Array.isArray(args.errors) && args.errors.length > 0) {
      return args.errors.slice();
    }
    if (!Array.isArray(args)) return [];
    const errors = [];
    for (const arg of args) {
      if (isPoison(arg) && Array.isArray(arg.errors) && arg.errors.length > 0) {
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

// Appends one or more text values to a text output's buffer array, or replaces it on `set`.
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
        command: specOrValue.command || null,
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
    if (this.command === 'set') {
      if (args.length !== 1) {
        output._setTarget(this.toPoisonValue([
          contextualizeOutputError(output, this.pos, new Error('text.set() accepts exactly one argument'))
        ]));
        return;
      }
      output._setTarget([]);
    } else if (this.command !== null) {
      output._setTarget(this.toPoisonValue([
        contextualizeOutputError(output, this.pos, new Error(`Unsupported text output command '${this.command}'`))
      ]));
      return;
    }
    if (!this.normalizeArgs) {
      appendTextValues(output, args, this.pos);
      return;
    }
    const normalizedArgs = [];
    let hasAsyncNormalization = false;
    for (const arg of args) {
      const normalized = normalizeTextCommandArg(arg, output, this.pos);
      if (normalized && typeof normalized.then === 'function') {
        hasAsyncNormalization = true;
      }
      normalizedArgs.push(normalized);
    }
    if (hasAsyncNormalization) {
      return Promise.all(normalizedArgs).then((resolvedArgs) => {
        appendTextValues(output, resolvedArgs, this.pos);
      });
    }
    appendTextValues(output, normalizedArgs, this.pos);
  }
}

// Sets the value of a var output's target to the single supplied argument.
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
      handler: 'var',
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
        contextualizeOutputError(output, this.pos, new Error('var output accepts exactly one argument'))
      ]));
      return;
    }
    output._setTarget(this.arguments[0]);
  }
}

// Timing-only sync point: awaits an iteration value for limited-concurrency loop synchronization. Does not propagate errors.
class WaitResolveCommand extends OutputCommand {
  constructor({ handler, args = null, arguments: legacyArgs = null, pos = null }) {
    super({
      handler,
      command: null,
      args: args || legacyArgs || [],
      subpath: null,
      pos
    });
  }

  async apply(output) {
    super.apply(output);
    const value = Array.isArray(this.arguments) && this.arguments.length > 0
      ? this.arguments[0]
      : undefined;
    try {
      const { resolveSingle } = require('./resolve');
      const resolved = await resolveSingle(value);
      if (output) {
        output._setTarget(resolved);
      }
      return resolved;
    } catch (err) {
      // Timing-only command: do not alter functional error flow.
      void err;
      return undefined;
    }
  }
}

// Invokes a named data handler method (e.g., set, push) on a data output's DataHandler. Corresponds to @data directives in scripts.
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
    const rawPath = Array.isArray(this.arguments) && this.arguments.length > 0 ? this.arguments[0] : null;
    const dataPath = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
    const poisonErrors = this.extractPoisonFromArgs();
    // Preserve existing poison on a data path for non-set operations, but still
    // merge any new poison that arrived through arguments.
    if (this.command !== 'set') {
      const existing = readDataValueAtPath(output._base.data, dataPath);
      if (isPoison(existing) || isPoisonError(existing)) {
        if (poisonErrors.length > 0) {
          setDataPoisonAtPath(
            output,
            this.arguments,
            this.toPoisonValue(poisonErrors)
          );
        }
        return;
      }
    }
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
    try {
      method.apply(output._base, this.arguments);
      output._setTarget(output._base.data);
    } catch (err) {
      setDataPoisonAtPath(
        output,
        this.arguments,
        this.toPoisonValue([
          contextualizeOutputError(output, this.pos, err)
        ])
      );
    }
  }
}

// Calls a method on a sink output object (or a sub-path within it). Errors poison the output target.
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

// Calls a method on a sequence sink in source order and resolves the deferred result promise with the return value. Mutating — waits for prior observables.
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

// Reads a property from a sequence sink in source order and resolves the deferred result promise with the value. Observable — applied immediately without waiting for pending mutating commands.
class SequenceGetCommand extends OutputCommand {
  constructor({ handler, command, subpath = null, pos = null, withDeferredResult = false }) {
    super({
      handler,
      command: command || null,
      args: [],
      subpath: subpath || null,
      pos
    });
    this.isObservable = true;
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

// Executes a `!`-path read operation in source order. Skips (rejects) if the path is already poisoned. Observable.
class SequentialPathReadCommand extends Command {
  constructor({ handler, pathKey, operation, repair = false, pos = null, withDeferredResult = true }) {
    super({ withDeferredResult });
    this.handler = handler;
    this.pathKey = pathKey || handler;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
  }

  apply(output) {

    const existingPoison = output._getSequentialPathPoisonErrors();
    if (!this.repair && Array.isArray(existingPoison) && existingPoison.length > 0) {
      this.rejectResult(new PoisonError(existingPoison.slice()));
      return;
    }

    const run = () => {
      let result;
      try {
        result = this.operation();
      } catch (err) {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          output._clearSequentialPathPoison();
        }
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        this.rejectResult(new PoisonError(contextualized));
      };

      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(resolveResultValue, rejectResultError);
      }

      resolveResultValue(result);
      return result;
    };

    return run();
  }
}

// Like SequentialPathReadCommand but clears existing path poison before executing (used in `resume` blocks).
class RepairReadCommand extends SequentialPathReadCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

// Executes a `!`-path write/call operation in source order. Poisons the path on failure so subsequent commands on the same path are skipped. Mutating.
class SequentialPathWriteCommand extends Command {
  constructor({ handler, pathKey, operation, repair = false, pos = null, withDeferredResult = true }) {
    super({ withDeferredResult });
    this.handler = handler;
    this.pathKey = pathKey || handler;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(output) {

    const existingPoison = output._getSequentialPathPoisonErrors();
    if (!this.repair && Array.isArray(existingPoison) && existingPoison.length > 0) {
      this.rejectResult(new PoisonError(existingPoison.slice()));
      return;
    }

    const run = () => {
      let result;
      try {
        result = this.operation();
      } catch (err) {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        output._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
          output._applySequentialPathPoisonErrors(contextualized);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          output._clearSequentialPathPoison();
        }
        output._setSequentialPathLastResult(value);
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        output._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
      };

      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(resolveResultValue, rejectResultError);
      }

      resolveResultValue(result);
      return result;
    };

    return run();
  }
}

// Like SequentialPathWriteCommand but clears existing path poison before executing (used in `resume` blocks).
class RepairWriteCommand extends SequentialPathWriteCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

// Poison marker in the command buffer. Always throws a PoisonError when applied, propagating errors through the buffer in source order.
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

// Writes poison directly into an output's target: pushes a PoisonedValue onto a text buffer, or replaces a data/var/sink target with one.
class TargetPoisonCommand extends Command {
  constructor({ handler, errors = null, pos = null }) {
    super();
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(output) {
    if (!output) {
      return;
    }
    const contextualizedErrors = contextualizeErrorsForOutput(output, this.pos, this.errors);
    if (output._outputType === 'text') {
      if (!Array.isArray(output._target)) {
        output._setTarget([]);
      }
      output._target.push(createPoison(contextualizedErrors));
      output._markStateChanged();
      return;
    }
    if (typeof output._applyPoisonErrors === 'function') {
      output._applyPoisonErrors(contextualizedErrors);
      return;
    }
    output._setTarget(createPoison(contextualizedErrors));
  }
}

// Captures the current output state (with poison inspection) as a deferred value. Used for `snapshot()` calls and explicit `return data/text.snapshot()`. Observable.
class SnapshotCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
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

// Captures the raw output target without poison inspection. Used for overwrite semantics (e.g., var-output set_path) where poisoned leaves may be replaced by the write. Observable.
class RawSnapshotCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isSnapshotCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._getTarget !== 'function') {
      this.rejectResult(contextualize(new Error('RawSnapshotCommand requires an output handler with _getTarget()')));
      return;
    }

    try {
      this.resolveResult(output._getTarget());
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to a boolean indicating whether the output currently holds a poisoned (error) value. Observable.
class IsErrorCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
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

// Resolves to the current error on the output (a PoisonError or null). Observable.
class GetErrorCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
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

// Snapshots the current output state for `try/resume` guard entry. The captured state is passed to a later RestoreGuardStateCommand. Observable.
class CaptureGuardStateCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isSnapshotCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._captureGuardState !== 'function') {
      this.rejectResult(contextualize(new Error('CaptureGuardStateCommand requires an output handler with _captureGuardState()')));
      return;
    }

    try {
      const result = output._captureGuardState();
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

// Calls `_repairNow()` on a sink output to repair it within a guard block. Carries a deferred result.
class SinkRepairCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
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

// Captures the current text output state (including poison) for `try/resume` guard entry.
// The captured state is passed to a later RestoreGuardStateCommand. Observable.
// @todo - not implemented, implement as a general CaptureGuardStateCommand?
class TextCheckpointCommand extends Command {
  constructor({ handler, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isSnapshotCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output || typeof output._captureTextCheckpoint !== 'function') {
      this.rejectResult(contextualize(new Error('TextCheckpointCommand requires a text output handler with _captureTextCheckpoint()')));
      return;
    }

    try {
      const result = output._captureTextCheckpoint();
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

// Restores a previously captured guard state to the output, overwriting the current target with the saved snapshot. Carries a deferred result.
class RestoreGuardStateCommand extends Command {
  constructor({ handler, target, pos = null }) {
    super({ withDeferredResult: true });
    this.handler = handler;
    this.target = target;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.resolveResult(undefined);
      return;
    }

    try {
      const result = output._restoreGuardState(this.target);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result);
      return result;
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

module.exports = {
  Command,
  OutputCommand,
  TextCommand,
  ValueCommand,
  WaitResolveCommand,
  DataCommand,
  SinkCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand,
  ErrorCommand,
  TargetPoisonCommand,
  SnapshotCommand,
  RawSnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  CaptureGuardStateCommand,
  SinkRepairCommand,
  TextCheckpointCommand,
  RestoreGuardStateCommand
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

function contextualizeErrorsForOutput(output, pos, errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const lineno = pos && typeof pos.lineno === 'number' ? pos.lineno : 0;
  const colno = pos && typeof pos.colno === 'number' ? pos.colno : 0;
  const path = output && output._context && output._context.path ? output._context.path : null;
  const contextualized = [];
  for (const err of errors) {
    if (isPoisonError(err) && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const nested of err.errors) {
        contextualized.push(handleError(nested, lineno, colno, null, path));
      }
      continue;
    }
    contextualized.push(handleError(err, lineno, colno, null, path));
  }
  return contextualized;
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

function normalizeTextCommandArg(value, output, pos) {
  const { materializeTemplateTextValue } = getSafeOutputApi();
  const materialized = materializeTemplateTextValue(value, buildTextErrorContext(output, pos));
  if (materialized && typeof materialized.then === 'function') {
    return Promise.resolve(materialized).then((resolved) => normalizeMaterializedTextArg(resolved, output, pos));
  }
  return normalizeMaterializedTextArg(materialized, output, pos);
}

function normalizeMaterializedTextArg(value, output, pos) {
  const { suppressValue, suppressValueScript } = getSafeOutputApi();
  const throwOnUndefined = isThrowOnUndefinedEnabled(output);
  if (throwOnUndefined && (value === null || value === undefined)) {
    throw contextualizeOutputError(output, pos, new Error('attempted to output null or undefined value'));
  }
  const autoescape = isAutoescapeEnabled(output);
  if (isScriptOutputMode(output)) {
    return suppressValueScript(value, autoescape);
  }
  return suppressValue(value, autoescape);
}

function appendTextValues(output, values, pos) {
  const args = Array.isArray(values) ? values : [values];
  const commandPos = pos || { lineno: 0, colno: 0 };
  for (const value of args) {
    if (value === null || value === undefined) {
      continue;
    }
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      output._target.push(value);
      continue;
    }
    if (type === 'object') {
      const hasCustomToString = value.toString && value.toString !== Object.prototype.toString;
      if (hasCustomToString) {
        output._target.push(value);
        continue;
      }
    }
    const argType = Array.isArray(value) ? 'array' : type;
    throw new Error(`Invalid TextCommand argument type '${argType}' at ${commandPos.lineno}:${commandPos.colno}. TextCommand only accepts text-like scalar values.`);
  }
  output._markStateChanged();
}

function buildTextErrorContext(output, pos) {
  return {
    lineno: pos && typeof pos.lineno === 'number' ? pos.lineno : 0,
    colno: pos && typeof pos.colno === 'number' ? pos.colno : 0,
    errorContextString: null,
    path: output && output._context ? output._context.path || null : null
  };
}

function isAutoescapeEnabled(output) {
  const opts = output && output._context && output._context.env ? output._context.env.opts : null;
  return !!(opts && opts.autoescape);
}

function isThrowOnUndefinedEnabled(output) {
  const opts = output && output._context && output._context.env ? output._context.env.opts : null;
  return !!(opts && opts.throwOnUndefined);
}

function isScriptOutputMode(output) {
  return !!(output && output._context && output._context.scriptMode);
}

function getSafeOutputApi() {
  if (!safeOutputApi) {
    safeOutputApi = require('./safe-output');
  }
  return safeOutputApi;
}
