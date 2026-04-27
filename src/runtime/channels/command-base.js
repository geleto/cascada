'use strict';

import {
  isPoison,
  isPoisonError,
  isRuntimeFatalError,
  PoisonError,
  createPoison,
  handleError,
  markPromiseHandled,
} from '../errors';

import {RESOLVE_MARKER, isResolvedValue, unwrapResolvedValue} from '../resolve';
const contextualizedOutputErrorCache = new WeakMap();

// Base class for all commands. Manages the optional deferred-result promise used by observable commands.
class Command {
  constructor(options = null) {
    const opts = options || {};
    this.resolved = false;
    this.promise = null;
    this.resolve = null;
    this.reject = null;
    this.isObservable = false;

    if (opts.withDeferredResult) {
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      // Deferred command results are often consumed later by other internal runtime
      // paths (for example as command arguments). Mark them handled immediately so
      // an early rejection does not become a process-level warning before the real
      // Cascada consumer observes it.
      markPromiseHandled(this.promise);
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

// Base class for commands targeting a declared channel (text/var/data/sequence). Carries channel name, method name, arguments, and source position.
class ChannelCommand extends Command {
  constructor({ channelName, command = null, args = null, subpath = null, pos = null, withDeferredResult = false }) {
    super({ withDeferredResult });
    this.channelName = channelName;
    this.command = command;
    this.arguments = args || [];
    // Channel commands are buffered and applied later by the iterator. Any raw
    // promise/marker-backed value already present in the buffered argument
    // graph can reject before apply-time resolution runs, so command argument
    // staging remains broad here on purpose.
    if (this.arguments.length > 0) {
      markDeferredThenablesHandled(this.arguments);
    }
    this.subpath = subpath;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  extractPoisonFromArgs(args = this.arguments) {
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

const __defaultExport = {
  Command,
  ChannelCommand,
  contextualizeErrorsForOutput,
  contextualizeOutputError,
  runWithResolvedArguments,
  markDeferredThenablesHandled
};
export { Command, ChannelCommand, contextualizeErrorsForOutput, contextualizeOutputError, runWithResolvedArguments, markDeferredThenablesHandled };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }

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

// Resolve a command payload at apply time and invoke the supplied callback with
// the resolved top-level argument values. Poison is preserved inside the resolved
// payload so each command can apply its own semantics (for example, poisoning a
// specific data path or rejecting an observable command result) rather than a
// generic helper short-circuiting too early.
function runWithResolvedArguments(value, cmd, output, applyFn) {
  if (Array.isArray(value)) {
    let hasAsync = false;

    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) {
        continue;
      }
      const fastValue = unwrapResolvedValue(value[i]);
      if (fastValue !== value[i]) {
        value[i] = fastValue;
      }
      if (isPoison(fastValue)) {
        continue;
      }
      if (!fastValue || (typeof fastValue.then !== 'function' && !fastValue[RESOLVE_MARKER])) {
        continue;
      }
      hasAsync = true;
      break;
    }

    if (!hasAsync) {
      return applyFn(value);
    }

    // The array has at least one async entry, so resolve each top-level slot and
    // preserve poison as data for the command to handle.
    return runWithResolvedArgumentsAsync(value, cmd, output, applyFn);
  } else {
    //a single non-array argument
    if (value === undefined) {
      return applyFn(undefined);
    }

    value = unwrapResolvedValue(value);
    if (isPoison(value) || !value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
      return applyFn(value);
    }

    // the value is either a promise or a RESOLVE_MARKER
    if (value[RESOLVE_MARKER]) {
      return Promise.resolve(value[RESOLVE_MARKER]).then(() => {
        return applyFn(value);
      }).catch((err) => {
        return applyFn(classifyCommandArgumentFailure(output, cmd, err));
      });
    }

    return Promise.resolve(value).then((resolvedValue) => {
      if (resolvedValue && resolvedValue[RESOLVE_MARKER]) {
        return Promise.resolve(resolvedValue[RESOLVE_MARKER]).then(() => applyFn(resolvedValue));
      }
      return applyFn(resolvedValue);
    }).catch((err) => {
      return applyFn(classifyCommandArgumentFailure(output, cmd, err));
    });
  }
}

async function runWithResolvedArgumentsAsync (value, cmd, output, applyFn) {
  const resolvedArray = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === undefined) {
      resolvedArray[i] = undefined;
      continue;
    }
    const fastValue = unwrapResolvedValue(entry);
    if (isPoison(fastValue) || !fastValue || (typeof fastValue.then !== 'function' && !fastValue[RESOLVE_MARKER])) {
      resolvedArray[i] = fastValue;
      continue;
    }
    if (fastValue[RESOLVE_MARKER]) {
      try {
        await fastValue[RESOLVE_MARKER];
        resolvedArray[i] = fastValue;
      } catch (err) {
        resolvedArray[i] = classifyCommandArgumentFailure(output, cmd, err);
      }
      continue;
    }

    try {
      const resolvedValue = await fastValue;
      if (resolvedValue && resolvedValue[RESOLVE_MARKER]) {
        try {
          await resolvedValue[RESOLVE_MARKER];
          resolvedArray[i] = resolvedValue;
        } catch (err) {
          resolvedArray[i] = classifyCommandArgumentFailure(output, cmd, err);
        }
      } else {
        resolvedArray[i] = resolvedValue;
      }
    } catch (err) {
      resolvedArray[i] = classifyCommandArgumentFailure(output, cmd, err);
    }
  }
  return applyFn(resolvedArray);
}

function classifyCommandArgumentFailure(output, cmd, err) {
  const errors = isPoisonError(err) ? err.errors : [err];
  const lineno = cmd && cmd.pos && typeof cmd.pos.lineno === 'number' ? cmd.pos.lineno : 0;
  const colno = cmd && cmd.pos && typeof cmd.pos.colno === 'number' ? cmd.pos.colno : 0;
  const path = output && output._context && output._context.path ? output._context.path : null;
  const contextualized = errors.map((item) => handleError(item, lineno, colno, null, path));
  const fatalRuntimeError = contextualized.find((item) => isRuntimeFatalError(item));
  if (fatalRuntimeError) {
    throw fatalRuntimeError;
  }
  return createPoison(contextualized);
}

function isHandledDeferredPromise(value) {
  return value instanceof Promise;
}

// Command arguments may sit in buffers for a while before a consumer applies the
// command. Mark any deferred native promises as handled up front so early
// rejections do not surface as process-level warnings before Cascada consumes
// them. This does not resolve values early; it only attaches a no-op rejection
// handler to promises already present in the argument structure.
function markDeferredThenablesHandled(value, seen = null) {
  if (value === null || value === undefined) {
    return;
  }

  if (isPoison(value)) {
    return;
  }

  if (isResolvedValue(value)) {
    return;
  }

  const nextSeen = seen || new WeakSet();
  if (typeof value === 'object' || typeof value === 'function') {
    if (nextSeen.has(value)) {
      return;
    }
    nextSeen.add(value);
  }

  if (isHandledDeferredPromise(value)) {
    markPromiseHandled(Promise.resolve(value));
    return;
  }

  if (value && isHandledDeferredPromise(value[RESOLVE_MARKER])) {
    markPromiseHandled(Promise.resolve(value[RESOLVE_MARKER]));
    // Marker-backed arrays/objects already own recursive child-promise collection
    // through their marker promise, so command staging only needs to handle that
    // single deferred boundary here instead of recursing into the structure again.
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      markDeferredThenablesHandled(entry, nextSeen);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      markDeferredThenablesHandled(value[key], nextSeen);
    }
  }
}

