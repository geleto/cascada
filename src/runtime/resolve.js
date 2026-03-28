/**
 * Lazy Deep Resolution System
 *
 * This module implements the runtime logic for handling asynchronous data structures efficiently.
 *
 * CORE CONCEPT:
 * Instead of recursively scanning every object for Promises, we use a specific "Marker System".
 * This module exports the `createObject`/`createArray` factories which `setPath` uses to mark
 * objects during updates. While `setPath` handles the structural modification, this module
 * handles the **Resolution**: ensuring that when an object is finally accessed, all its
 * properties and children are resolved and the object is finalized in-place.
 *
 * HOW IT WORKS:
 * 1. **Marking (`createObject` / `createArray`)**:
 *    - When the *compiler* emits an object/array literal in async mode, it wraps it with these helpers.
 *    - These functions scan *shallowly* for Promises or other marked children.
 *    - If found, they attach a hidden `RESOLVE_MARKER` (Symbol).
 *
 * 2. **Deferral**:
 *    - The object remains a normal synchronous object.
 *    - The promises inside are NOT awaited immediately.
 *    - This allows building complex trees (e.g. via `setPath`) without blocking.
 *
 * 3. **Resolution (`resolveAll` / `resolveSingle`)**:
 *    - When the object is finally used (e.g. function arg, output), the runtime calls these resolve helpers.
 *    - They check for the `RESOLVE_MARKER`.
 *    - If present, they await the marker's internal Promise.
 *
 * 4. **In-Place Mutation**:
 *    - The marker's Promise waits for all child promises to settle (Parallel execution).
 *    - On success, it **mutates the object in-place**, replacing promises with real values.
 *    - This ensures subsequent reads are instant and synchronous.
 */
'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  collectErrors,
  PoisonError
} = require('./errors');
const { RESOLVE_MARKER, RESOLVED_VALUE_MARKER } = require('./markers');

function makeResolvedValue(value, mapper = null) {
  return {
    [RESOLVED_VALUE_MARKER]: true,
    value,
    then(onFulfilled) {
      const resolvedValue = mapper ? mapper(value) : value;
      return onFulfilled ? onFulfilled(resolvedValue) : resolvedValue;
    }
  };
}

function isResolvedValue(value) {
  return !!(value && value[RESOLVED_VALUE_MARKER]);
}

function unwrapResolvedValue(value) {
  return isResolvedValue(value) ? value.value : value;
}

// Normalize a value that is leaving Cascada and becoming an ordinary JS promise/value.
// Only three cases are allowed here:
// - RESOLVE_MARKER-backed lazy values: return a promise for the final resolved object/array
// - RESOLVED_VALUE_MARKER wrappers: unwrap synchronously to the plain value
// - PoisonedValue: convert to a normal rejecting promise
// Keeping this narrow avoids turning it into a generic resolution helper.
function normalizeFinalPromise(value) {
  if (isResolvedValue(value)) {
    return unwrapResolvedValue(value);
  }
  if (isPoison(value)) {
    return Promise.reject(new PoisonError(value.errors));
  }
  if (value && value[RESOLVE_MARKER]) {
    return Promise.resolve(value[RESOLVE_MARKER]).then(() => value);
  }
  return value;
}

// Consume an array of independent Cascada values.
// - waits for every entry so no rejection/error is missed
// - returns one PoisonedValue containing all collected errors
// - otherwise returns the array with each entry resolved at its top-level value boundary
async function resolveAll(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('resolveAll expects an array of values');
  }

  if (args.length === 0) {
    return [];
  }

  // Fast path: single argument can use resolveSingle directly.
  if (args.length === 1) {
    const resolved = await resolveSingle(args[0]);
    return [resolved];
  }

  // Fast path: duo is a hot path from compiler aggregate emission.
  if (args.length === 2) {
    return resolveDuo(args[0], args[1]);
  }

  // Collect all errors first (awaits all promises)
  const errors = await collectErrors(args);

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - proceed with normal resolution (unwrapping)
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    resolvedArgs.push(await resolveValueAndMarker(args[i]));
  }

  return resolvedArgs;
}

// Resolve one Cascada value far enough to expose its current concrete value:
// unwrap resolved-value wrappers, await a real promise, and finalize a marker-backed
// object/array in place if needed.
async function resolveValueAndMarker(value) {
  let resolved = unwrapResolvedValue(value);

  if (resolved && typeof resolved.then === 'function') {
    try {
      resolved = await resolved;
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      throw err;
    }
  }

  if (resolved && resolved[RESOLVE_MARKER]) {
    try {
      await resolved[RESOLVE_MARKER];
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      throw err;
    }
  }

  return resolved;
}

// Resolve a plain object's properties by first marking it as a lazy Cascada object and
// then waiting for that object's own marker. Used when object-property resolution itself
// is the intended consumption boundary.
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

// Consume exactly two independent Cascada values with the same "never miss any error"
// rule as resolveAll(), but keep the hot two-value path explicit.
async function resolveDuo(...args) {
  if (args.length !== 2) {
    throw new TypeError(`resolveDuo expects exactly 2 arguments, got ${args.length}`);
  }
  const left = args[0];
  const right = args[1];

  const errors = await collectErrors([left, right]);
  if (errors.length > 0) {
    return createPoison(errors);
  }

  const resolvedLeft = await resolveValueAndMarker(left);
  const resolvedRight = await resolveValueAndMarker(right);
  return [resolvedLeft, resolvedRight];
}

// Consume one top-level Cascada value.
// - sync values return via a branded resolved-value wrapper for fast-path compatibility
// - promises are awaited and converted to PoisonedValue on failure
// - marker-backed objects/arrays are finalized in place and then returned
async function resolveSingle(...args) {
  if (args.length !== 1) {
    throw new TypeError(`resolveSingle expects exactly 1 argument, got ${args.length}`);
  }
  const value = unwrapResolvedValue(args[0]);

  // Synchronous shortcuts
  if (isPoison(value)) {
    return value; // Propagate poison synchronously
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return makeResolvedValue(value);
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

// Like resolveSingle(), but preserve the historical one-element-array shape used by some
// compiled call sites. This is compatibility glue, not a separate semantic boundary.
function resolveSingleArr(value) {
  value = unwrapResolvedValue(value);
  if (isPoison(value)) {
    return value;
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return makeResolvedValue(value, (resolvedValue) => [resolvedValue]);
  }

  return _resolveSingleArrAsync(value);
}

async function _resolveSingleArrAsync(value) {
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

// Wrap a JS function so its trailing arguments are consumed as Cascada values before the
// underlying function is called. Used for APIs that explicitly want resolved arguments.
function resolveArguments(fn, skipArguments = 0) {
  return async function (...args) {
    const skippedArgs = args.slice(0, skipArguments);
    const remainingArgs = args.slice(skipArguments);
    const resolvedArgs = await resolveAll(remainingArgs);
    const finalArgs = [...skippedArgs, ...resolvedArgs];

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
  normalizeFinalPromise,


  createObject,
  createArray,
  RESOLVE_MARKER,
  RESOLVED_VALUE_MARKER,
  isResolvedValue,
  unwrapResolvedValue
};
