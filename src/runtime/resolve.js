/**
 * Lazy Deep Resolution System
 *
 * This module implements the runtime logic for handling asynchronous data structures efficiently.
 *
 * CORE CONCEPT:
 * Instead of recursively scanning every object for Promises, we use a specific "Marker System".
 * This module exports the `createObject`/`createArray` factories which `deepAssign` uses to mark
 * objects during updates. While `deepAssign` handles the structural modification, this module
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
 *    - This allows building complex trees (e.g. via `deepAssign`) without blocking.
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
import {createPoison, isPoison, collectErrors, PoisonError, poisonOrRethrow} from './errors.js';
import {RESOLVE_MARKER, RESOLVED_VALUE_MARKER} from './markers.js';

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

// Normalize a value that is leaving Cascada and becoming an ordinary JS
// promise/value. Regular Cascada resolution owns promise/RESOLVE_MARKER value
// shapes; the final boundary only translates Cascada poison into public
// promise rejection.
function normalizeFinalPromise(value) {
  const resolved = resolveSingle(value);
  if (isResolvedValue(resolved)) {
    return unwrapResolvedValue(resolved);
  }
  if (isPoison(resolved)) {
    return Promise.reject(PoisonError.group(resolved.errors));
  }
  if (resolved && typeof resolved.then === 'function') {
    return Promise.resolve(resolved).then((resolvedValue) => {
      if (isPoison(resolvedValue)) {
        return Promise.reject(PoisonError.group(resolvedValue.errors));
      }
      return resolvedValue;
    });
  }
  return resolved;
}

// Run cleanup around an already-produced Cascada value without assimilating it through
// Promise.resolve. Use for internal finally-style cleanup; final public exits still go
// through normalizeFinalPromise().
function finallyValue(value, onFinally) {
  if (isResolvedValue(value)) {
    onFinally();
    return unwrapResolvedValue(value);
  }
  if (value && typeof value.then === 'function') {
    return value.then((resolved) => {
      onFinally();
      return resolved;
    }, (err) => {
      onFinally();
      throw err;
    });
  }
  onFinally();
  return value;
}

// Chain an internal Cascada value without forcing Promise.resolve assimilation. Use when
// replacing value.then(...) over resolveSingle/resolveDuo/resolveAll results so poison
// propagates synchronously and resolved-value wrappers unwrap on the sync path.
function thenValue(value, onFulfilled) {
  if (isPoison(value)) {
    return value;
  }
  if (isResolvedValue(value)) {
    return onFulfilled(unwrapResolvedValue(value));
  }
  if (value && typeof value.then === 'function') {
    return value.then(onFulfilled);
  }
  return onFulfilled(value);
}

// Consume an array of independent Cascada values.
// - waits for every entry so no rejection/error is missed
// - returns one PoisonedValue containing all collected errors
// - otherwise returns the array with each entry resolved at its top-level value boundary
function resolveAll(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('resolveAll expects an array of values');
  }

  switch (args.length) {
    case 0:
      return makeResolvedValue([]);
    case 1:
      return resolveSingleAsArray(args[0]);
    case 2:
      return resolveDuoAsArray(args[0], args[1]);
    default:
      return resolveMany(args);
  }
}

function needsResolution(value) {
  return !!(value && (typeof value.then === 'function' || value[RESOLVE_MARKER]));
}

function resolveSingleAsArray(arg) {
  const value = unwrapResolvedValue(arg);
  if (isPoison(value)) {
    return value;
  }
  if (needsResolution(value)) {
    return resolveAllAsync([arg]);
  }
  return makeResolvedValue([value]);
}

function resolveDuoAsArray(leftArg, rightArg) {
  const left = unwrapResolvedValue(leftArg);
  const right = unwrapResolvedValue(rightArg);
  const syncErrors = [];

  if (isPoison(left)) {
    syncErrors.push(...left.errors);
  }
  if (isPoison(right)) {
    syncErrors.push(...right.errors);
  }

  if (
    (!isPoison(left) && needsResolution(left)) ||
    (!isPoison(right) && needsResolution(right))
  ) {
    return resolveAllAsync([leftArg, rightArg]);
  }

  if (syncErrors.length > 0) {
    return createPoison(PoisonError.group(syncErrors));
  }

  return makeResolvedValue([left, right]);
}

function resolveMany(args) {
  const resolvedArgs = [];
  const syncErrors = [];

  for (let i = 0; i < args.length; i++) {
    const value = unwrapResolvedValue(args[i]);
    if (isPoison(value)) {
      syncErrors.push(...value.errors);
      continue;
    }
    if (value && (typeof value.then === 'function' || value[RESOLVE_MARKER])) {
      return resolveAllAsync(args);
    }
    resolvedArgs.push(value);
  }

  if (syncErrors.length > 0) {
    return createPoison(PoisonError.group(syncErrors));
  }

  return makeResolvedValue(resolvedArgs);
}

async function resolveAllAsync(args) {
  const errors = await collectErrors(args);

  if (errors.length > 0) {
    return createPoison(PoisonError.group(errors)); // Errors already have position info from collectErrors
  }

  // No errors - proceed with normal resolution (unwrapping)
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    resolvedArgs.push(await resolveSingle(args[i]));
  }

  return resolvedArgs;
}

// Async core for resolveSingle(): await a promise (if any), then finalize a lazy
// RESOLVE_MARKER (if any), converting rejections to poison. A poison result has no
// marker, so it falls through unchanged.
async function resolveSingleAsync(value) {
  try {
    let resolved = value;
    if (resolved && typeof resolved.then === 'function') {
      resolved = await resolved;
    }
    if (resolved && resolved[RESOLVE_MARKER]) {
      await resolved[RESOLVE_MARKER];
    }
    return resolved;
  } catch (err) {
    return poisonOrRethrow(err);
  }
}

// Consume exactly two independent Cascada values with the same "never miss any error"
// rule as resolveAll(), but keep the hot two-value path explicit.
function resolveDuo(left, right) {
  if (arguments.length !== 2) {
    throw new TypeError(`resolveDuo expects exactly 2 arguments, got ${arguments.length}`);
  }
  return resolveDuoAsArray(left, right);
}

// Consume one top-level Cascada value.
// - sync values return via a branded resolved-value wrapper for fast-path compatibility
// - promises are awaited and converted to PoisonedValue on failure
// - marker-backed objects/arrays are finalized in place and then returned
function resolveSingle(value) {
  if (arguments.length !== 1) {
    throw new TypeError(`resolveSingle expects exactly 1 argument, got ${arguments.length}`);
  }
  value = unwrapResolvedValue(value);

  // Synchronous shortcuts
  if (isPoison(value)) {
    return value; // Propagate poison synchronously
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return makeResolvedValue(value);
  }

  return resolveSingleAsync(value);
}

// Like resolveSingle(), but preserve the historical one-element-array shape used by some
// compiled call sites. This is compatibility glue, not a separate semantic boundary.
function resolveSingleArr(value) {
  value = unwrapResolvedValue(value);
  if (isPoison(value)) {
    return value;
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return makeResolvedValue([value]);
  }

  return _resolveSingleArrAsync(value);
}

async function _resolveSingleArrAsync(value) {
  try {
    const resolved = await resolveSingle(value);
    return [resolved];
  } catch (err) {
    return poisonOrRethrow(err);
  }
}

// Wrap a JS function so its trailing arguments are consumed as Cascada values before the
// underlying function is called. Used for APIs that explicitly want resolved arguments.
function resolveArguments(fn, skipArguments = 0) {
  return function (...args) {
    const skippedArgs = args.slice(0, skipArguments);
    const remainingArgs = args.slice(skipArguments);
    const resolvedArgs = resolveAll(remainingArgs);

    if (isResolvedValue(resolvedArgs)) {
      try {
        return fn.apply(this, skippedArgs.concat(resolvedArgs.value));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return resolvedArgs.then((finalResolvedArgs) => {
      return fn.apply(this, skippedArgs.concat(finalResolvedArgs));
    });
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
// Scan-time helper: return the promise a parent lazy marker must wait on, if any.
// This is a dependency only; awaiting it does not replace the child slot.
function getResolvePromise(value) {
  if (!value) {
    return null;
  }
  if (typeof value.then === 'function' && !isPoison(value)) {
    return value;
  }
  if (value[RESOLVE_MARKER]) {
    return value[RESOLVE_MARKER];
  }
  return null;
}

// Finalize-time helper: return the current slot value, or a promise for the same
// slot value after its own lazy marker has finished mutating it in place.
function getResolvedLazyValue(value) {
  if (!value) {
    return value;
  }
  if (isPoison(value)) {
    return value;
  }
  if (typeof value.then === 'function') {
    return value;
  }
  if (value[RESOLVE_MARKER]) {
    return value[RESOLVE_MARKER].then(() => value);
  }
  return value;
}

async function assignResolvedLazyValue(container, key) {
  const value = getResolvedLazyValue(container[key]);
  container[key] = isPoison(value) ? value : await value;
}

function attachResolveMarker(container, dependencies, finalize) {
  if (dependencies.length === 0) {
    return container;
  }

  const resolver = (async () => {
    const errors = await collectErrors(dependencies);
    if (errors.length > 0) {
      throw PoisonError.group(errors);
    }

    await finalize();
    delete container[RESOLVE_MARKER];
    return container;
  })();

  Object.defineProperty(container, RESOLVE_MARKER, {
    value: resolver,
    configurable: true,
    writable: true,
    enumerable: false
  });

  return container;
}

function createObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const dependencies = [];
  for (const key in obj) {
    const dependency = getResolvePromise(obj[key]);
    if (dependency) {
      dependencies.push(dependency);
    }
  }

  return attachResolveMarker(obj, dependencies, async () => {
    for (const key in obj) {
      await assignResolvedLazyValue(obj, key);
    }
  });
}

/**
 * Enhances an array with specific runtime capabilities (Lazy Resolution).
 * Similar to createObject, but for Arrays.
 * Scans elements for Promises/Marked items.
 * If found, attaches RESOLVE_MARKER to resolve/mutate in-place.
 */
function createArray(arr) {
  if (!Array.isArray(arr)) return arr;

  const dependencies = [];
  for (let i = 0; i < arr.length; i++) {
    const dependency = getResolvePromise(arr[i]);
    if (dependency) {
      dependencies.push(dependency);
    }
  }

  return attachResolveMarker(arr, dependencies, async () => {
    for (let i = 0; i < arr.length; i++) {
      await assignResolvedLazyValue(arr, i);
    }
  });
}

export { resolveAll, resolveDuo, resolveSingle, resolveSingleArr, resolveArguments, normalizeFinalPromise, finallyValue, thenValue, createObject, createArray, RESOLVE_MARKER, RESOLVED_VALUE_MARKER, isResolvedValue, unwrapResolvedValue };
