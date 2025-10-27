'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  handleError,
  RuntimePromise,
  collectErrors
} = require('./errors');

/**
 * Sync call wrapper for templates.
 */
function callWrap(obj, name, context, args) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                 !Object.prototype.hasOwnProperty.call(context.ctx, name);

  return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, args);
}

/**
 * Async call wrapper using sync-first hybrid pattern.
 */
function callWrapAsync(obj, name, context, args, errorContext) {

  // Check if we need async path: obj or any arg is a promise
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasArgPromises = args.some(arg => arg && typeof arg.then === 'function' && !isPoison(arg));

  if (objIsPromise || hasArgPromises) {
    // Must use async path to await all promises before making decisions
    // _callWrapAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _callWrapAsyncComplex(obj, name, context, args, errorContext);
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
    // Multiple sources poisoned - merge all errors
    const errors = [
      ...(objPoison ? obj.errors : []),
      ...poisonedArgs.flatMap(p => p.errors)
    ];
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - validate and call
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    const result = obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, args);
    if (result && typeof result.then === 'function') {// && !isPoison(result)) {
      // add context to the promise that will be applied if it rejects
      return new RuntimePromise(result, errorContext);
    }
    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

async function _callWrapAsyncComplex(obj, name, context, args, errorContext) {
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
        // Add context to the error when catching from await
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        errors.push(contextualError);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  // Await ALL args to collect all errors (never miss any error principle)
  const argErrors = await collectErrors(args);
  errors.push(...argErrors);

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve all arg promises
  const resolvedArgs = [];
  for (const arg of args) {
    if (arg && typeof arg.then === 'function') {
      try {
        resolvedArgs.push(await arg);
      } catch (err) {
        // Should not happen as collectErrors already caught errors
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        return createPoison(isPoisonError(err) ? err.errors : [contextualError]);
      }
    } else {
      resolvedArgs.push(arg);
    }
  }

  // All resolved successfully - validate and call the function
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    const result = obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, resolvedArgs);

    // Wrap promise results to preserve error context
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext);
    }

    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

module.exports = {
  callWrap,
  callWrapAsync,
};
