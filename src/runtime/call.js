
import {createPoison, isPoison, isPoisonError, RuntimePromise, PoisonError, RuntimeError, poisonIfNaN} from './errors.js';
import {throwReportedFatal} from './error-context.js';
import {RESOLVE_MARKER, resolveAll} from './resolve.js';

/**
 * Sync call wrapper for templates.
 */
function callWrap(obj, name, context, args, currentBuffer = null) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                 !Object.prototype.hasOwnProperty.call(context.ctx, name);

  const executionContext = (obj.isMacro || isGlobal) ? context : context.ctx;
  if (obj.isMacro) {
    return obj._invoke(executionContext, args, currentBuffer);
  }
  return obj.apply(executionContext, args);
}

/**
 * Async call wrapper using sync-first hybrid pattern.
 */
function callWrapAsync(obj, name, context, args, errorContext, currentBuffer = null) {
  throwReportedFatal(errorContext);

  if (obj && obj.isMacro) {
    // Macros are promise/poison-transparent Cascada boundaries. They receive
    // raw argument values and any thrown/rejected error must propagate as a
    // real fatal error rather than being normalized into FunCall poison here.
    return obj._invoke(context, args, currentBuffer);
  }

  // Check if we need async path: obj or any arg is a promise
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasAsyncArgs = Array.isArray(args) && args.some(arg =>
    arg &&
    !isPoison(arg) &&
    (typeof arg.then === 'function' || arg[RESOLVE_MARKER])
  );

  if (objIsPromise || hasAsyncArgs) {
    // Must use async path to await all promises before making decisions
    // _callWrapAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _callWrapAsyncComplex(obj, name, context, args, errorContext, currentBuffer);
  }

  // All values are non-promises - collect all errors synchronously
  const objPoison = isPoison(obj);
  const poisonedArgs = args.filter(isPoison);

  // Optimize: avoid creating new poison if only one source is poisoned
  if (objPoison && poisonedArgs.length === 0) {
    return obj; // Only obj is poisoned - return it directly
  } else if (!objPoison && poisonedArgs.length === 1) {
    return poisonedArgs[0]; // Only one arg is poisoned - return it directly
  } else if (objPoison || poisonedArgs.length > 0) {
    const errors = [];
    if (objPoison) {
      errors.push(...obj.errors);
    }
    for (const arg of poisonedArgs) {
      errors.push(...arg.errors);
    }
    return createPoison(PoisonError.group(errors));
  }

  // No errors - validate and call
  const targetError = classifyCallTarget(obj, name, errorContext);
  if (targetError) {
    return createPoison(targetError);
  }

  try {
    const executionContext = getCallExecutionContext(context, name);
    const result = obj.apply(executionContext, args);
    if (isPoison(result)) {
      return result;
    }
    if (result && typeof result.then === 'function') {// && !isPoison(result)) {
      // add context to the promise that will be applied if it rejects
      return new RuntimePromise(result, errorContext, 'UserCallThrew');
    }
    return poisonIfNaN(result, errorContext);
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'UserCallThrew'));
  }
}

async function _callWrapAsyncComplex(obj, name, context, args, errorContext, currentBuffer = null) {
  const errors = [];

  // Await obj if it's a promise and check for poison
  if (obj && typeof obj.then === 'function' && !isPoison(obj)) {
    try {
      obj = await obj;
      if (isPoison(obj)) {
        errors.push(...obj.errors);
      }
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        RuntimeError.reportAndThrow(err, errorContext);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  throwReportedFatal(errorContext);

  if (obj && obj.isMacro) {
    // Macros are promise/poison-transparent Cascada boundaries. Keep promise-
    // valued args untouched and let any thrown/rejected error propagate as a
    // real fatal error to the nearest cb()-owning boundary.
    return obj._invoke(context, args, currentBuffer);
  }

  let resolvedArgs = args;
  try {
    resolvedArgs = await resolveAll(args);
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      RuntimeError.reportAndThrow(err, errorContext);
    }
  }

  if (errors.length > 0) {
    return createPoison(PoisonError.group(errors));
  }

  // All resolved successfully - validate and call the function
  throwReportedFatal(errorContext);

  const targetError = classifyCallTarget(obj, name, errorContext);
  if (targetError) {
    return createPoison(targetError);
  }

  try {
    const executionContext = getCallExecutionContext(context, name);
    const result = obj.apply(executionContext, resolvedArgs);
    if (isPoison(result)) {
      return result;
    }

    // Wrap promise results to preserve error context
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext, 'UserCallThrew');
    }

    return poisonIfNaN(result, errorContext);
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'UserCallThrew'));
  }
}

function envCallWrapAsync(fn, thisArg, args, errorContext) {
  throwReportedFatal(errorContext);

  try {
    const result = fn.apply(thisArg, args);
    if (isPoison(result)) {
      return result;
    }
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext, 'UserCallThrew');
    }
    return poisonIfNaN(result, errorContext);
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'UserCallThrew'));
  }
}

function invokeCallbackExtension(fn, ...args) {
  return new Promise((resolvePromise, reject) => {
    const callback = (error, ...results) => {
      if (error) {
        reject(error);
      } else {
        resolvePromise(results.length === 1 ? results[0] : results);
      }
    };
    fn(...args, callback);
  });
}

function classifyCallTarget(obj, name, errorContext) {
  if (obj === undefined) {
    return PoisonError.create(
      'Unable to call `' + name + '`, which is undefined',
      errorContext,
      'MissingFunction'
    );
  }
  if (typeof obj !== 'function') {
    return PoisonError.create(
      'Unable to call `' + name + '`, which is not a function',
      errorContext,
      'NotAFunction'
    );
  }
  return null;
}

function resolveScriptCallTarget(context, name, errorContext) {
  if (context && typeof context.lookupScriptCall === 'function') {
    return context.lookupScriptCall(name, errorContext);
  }
  const value = getOwnedContextValue(context, name, errorContext);
  if (value === undefined) {
    return createPoison(PoisonError.create(
      `Can not look up unknown variable/function: ${name}`,
      errorContext,
      'MissingFunction'
    ));
  }
  if (value && typeof value.then === 'function' && !isPoison(value)) {
    return new RuntimePromise(value, errorContext, 'ContextValueRejected');
  }
  return poisonIfNaN(value, errorContext);
}

function getOwnedContextValue(context, name, errorContext) {
  if (!context) {
    return undefined;
  }
  if (typeof context.lookup === 'function') {
    return context.lookup(name, errorContext);
  }
  if (Object.prototype.hasOwnProperty.call(context, name)) {
    return context[name];
  }
  return undefined;
}

function getCallExecutionContext(context, name) {
  if (!context || !context.env || !context.ctx) {
    return context;
  }
  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                 !Object.prototype.hasOwnProperty.call(context.ctx, name);
  return isGlobal ? context : context.ctx;
}

export {
  callWrap,
  callWrapAsync,
  envCallWrapAsync,
  invokeCallbackExtension,
  classifyCallTarget,
  resolveScriptCallTarget
};
