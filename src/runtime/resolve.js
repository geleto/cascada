'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  collectErrors,
  PoisonError
} = require('./errors');

const RESOLVE_MARKER = Symbol.for('cascada.resolve');

// Helper to resolve multiple values (Arguments, Array elements).
// 1. Awaits all to collect potential errors (parallel wait via collectErrors).
// 2. If any fail, returns Poison (containing all collected errors).
// 3. If all succeed, unwraps values and ensures nested Lazy Objects are also resolved.
async function resolveAll(args) {
  // Collect all errors first (awaits all promises)
  const errors = await collectErrors(args);

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - proceed with normal resolution (unwrapping)
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];

    if (arg && typeof arg.then === 'function') {
      try {
        arg = await arg;
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }

    if (arg && arg[RESOLVE_MARKER]) {
      try {
        await arg[RESOLVE_MARKER];
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }

    resolvedArgs.push(arg);
  }

  return resolvedArgs;
}





async function resolveObjectProperties(obj) {
  const marked = createObject(obj);
  if (marked && marked[RESOLVE_MARKER]) {
    try {
      await marked[RESOLVE_MARKER];
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      throw err;
    }
  }
  return marked;
}

async function resolveDuo(...args) {
  return resolveAll(args);
}

async function resolveSingle(value) {
  // Synchronous shortcuts
  if (isPoison(value)) {
    return value; // Propagate poison synchronously
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return {
      then(onFulfilled) {
        return onFulfilled ? onFulfilled(value) : value;
      }
    };
  }

  // Await promise, convert rejections to poison
  let resolvedValue;
  try {
    resolvedValue = value;
    if (typeof value.then === 'function') {
      resolvedValue = await value;
    }
  } catch (err) {
    // Note: This is called from various contexts; error position added upstream
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    return createPoison(err);
  }

  // Check if resolved to poison
  if (isPoison(resolvedValue)) {
    return resolvedValue;
  }

  if (resolvedValue && resolvedValue[RESOLVE_MARKER]) {
    try {
      await resolvedValue[RESOLVE_MARKER];
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      return createPoison(err);
    }
  }

  return resolvedValue;
}

async function resolveSingleArr(value) {
  try {
    const resolved = await resolveSingle(value);
    return [resolved];
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    throw err;
  }
}

function resolveArguments(fn, skipArguments = 0) {
  return async function (...args) {
    const skippedArgs = args.slice(0, skipArguments);
    const remainingArgs = args.slice(skipArguments);
    await resolveAll(remainingArgs);
    const finalArgs = [...skippedArgs, ...remainingArgs];

    return fn.apply(this, finalArgs);
  };
}

/**
 * Enhances an object with specific runtime capabilities (Lazy Resolution).
 * Scans shallow properties for Promises or other Lazy Objects.
 * If any are found, attaches a hidden RESOLVE_MARKER promise that:
 * 1. Awaits all dependencies.
 * 2. Mutates the object in-place with resolved values.
 * 3. Propagates errors via rejection (PoisonError).
 *
 * If no async properties are found, returns the object as-is (Sync optimization).
 */
function createObject(obj) {
  // Basic checks
  if (!obj || typeof obj !== 'object') return obj;

  const promises = [];

  // Scan for immediate promises or marked children
  for (const key in obj) {
    const val = obj[key];
    if (val) {
      if (typeof val.then === 'function' && !isPoison(val)) {
        promises.push(val);
      } else if (val[RESOLVE_MARKER]) {
        promises.push(val[RESOLVE_MARKER]); // Dependency on child resolution
      }
    }
  }

  if (promises.length > 0) {
    const resolver = (async () => {
      // Wait for all dependencies to settle
      const errors = await collectErrors(promises);

      if (errors.length > 0) {
        throw new PoisonError(errors);
      }

      // All dependencies successful. Apply values.
      for (const key in obj) {
        let val = obj[key];
        if (val) {
          if (typeof val.then === 'function' && !isPoison(val)) {
            try {
              obj[key] = await val;
            } catch (e) {
              throw new PoisonError([e]);
            }
          } else if (val[RESOLVE_MARKER]) {
            try {
              await val[RESOLVE_MARKER];
              // Note: child object is mutated in place by its own resolver
            } catch (e) {
              throw new PoisonError([e]);
            }
          }
        }
      }

      // Clean up marker
      delete obj[RESOLVE_MARKER];
      return obj;
    })();

    // Attach the marker
    Object.defineProperty(obj, RESOLVE_MARKER, {
      value: resolver,
      configurable: true,
      writable: true,
      enumerable: false
    });
  }

  return obj;
}

/**
 * Enhances an array with specific runtime capabilities (Lazy Resolution).
 * Similar to createObject, but for Arrays.
 * Scans elements for Promises/Marked items.
 * If found, attaches RESOLVE_MARKER to resolve/mutate in-place.
 */
function createArray(arr) {
  if (!Array.isArray(arr)) return arr;

  const promises = [];
  for (let i = 0; i < arr.length; i++) {
    const val = arr[i];
    if (val) {
      if (typeof val.then === 'function' && !isPoison(val)) {
        promises.push(val);
      } else if (val[RESOLVE_MARKER]) {
        promises.push(val[RESOLVE_MARKER]);
      }
    }
  }

  if (promises.length > 0) {
    const resolver = (async () => {
      const errors = await collectErrors(promises);
      if (errors.length > 0) {
        throw new PoisonError(errors);
      }

      for (let i = 0; i < arr.length; i++) {
        const val = arr[i];
        if (val) {
          if (typeof val.then === 'function' && !isPoison(val)) {
            try {
              arr[i] = await val;
            } catch (e) {
              throw new PoisonError([e]);
            }
          } else if (val[RESOLVE_MARKER]) {
            try {
              await val[RESOLVE_MARKER];
            } catch (e) {
              throw new PoisonError([e]);
            }
          }
        }
      }

      delete arr[RESOLVE_MARKER];
      return arr;
    })();

    Object.defineProperty(arr, RESOLVE_MARKER, {
      value: resolver,
      configurable: true,
      writable: true,
      enumerable: false
    });
  }

  return arr;
}

module.exports = {
  resolveAll,
  resolveDuo,
  resolveSingle,
  resolveSingleArr,
  resolveObjectProperties,
  resolveArguments,


  createObject,
  createArray,
  RESOLVE_MARKER
};
