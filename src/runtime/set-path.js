/**
 * Deep Path Assignment with Lazy Resolution Support
 *
 * This module provides the `setPath` function, which is the core mechanism for
 * updating values within nested data structures in Cascada (a.position[getIndex()] = 10)
 *
 * KEY FEATURES:
 * 1. **Copy-On-Write (Immutability)**:
 *    - Updates never mutate the original object.
 *    - It returns a deep copy but only for the path, doing shallow copy at each path segment.
 *    - Example: `setPath(obj, ['a', 'b'], 1)` returns a new `obj` reference/copy.
 *
 * 2. **Transparent Async Support**:
 *    - Handles Promises at any level: root object, path segments (keys), or the value itself.
 *    - If any part of the path traversal (root or key) is async, the operation returns a Promise
 *      resolving to the new container.
 *
 * 3. **The "Consistency Rule" (Async Keys vs Async Values)**:
 *    - **Async Value**: If you assign an async value to a synchronous path (e.g. `obj.x = asyncVal()`),
 *      the result is a synchronous "Lazy Object" with the value marked for resolution.
 *      - Why? The structure is known immediately, only the leaf value is pending.
 *    - **Async Key**: If you use an async key (e.g. `arr[asyncIdx()] = val`),
 *      the result is a **Promise** for the entire container.
 *      - Why? We cannot write to the container until we know *where* to write.
 *      - This guarantees consistency by preventing reads of the container until the write is fully resolved.
 *
 * 4. **Lazy Resolution Integration**:
 *    - When an async value is assigned to a synchronous object/array, `setPath` does NOT wait for it.
 *    - **setPath's Role**: It updates the structure and then delegates to `createObject`/`createArray`.
 *    - **createObject/Array's Role**: These helpers inspect the container and attach a hidden `RESOLVE_MARKER`.
 *      - The marker holds a Promise that coordinates the resolution.
 *      - It waits for all async children to settle.
 *      - Upon completion, it mutates the object in-place, swapping Promises for real values.
 */
'use strict';

const { isPoison, createPoison } = require('./errors');
const {
  resolveAll,
  RESOLVE_MARKER,
  createObject,
  createArray
} = require('./resolve');

/**
 * Helper to check if a value is "Async" (Promise) or "Lazy" (Marked).
 * These values require the container to be marked.
 * Note: PoisonedValue has .then but should be treated as synchronous value (assigned as-is).
 */
function needsResolution(val) {
  return val && (typeof val.then === 'function' || val[RESOLVE_MARKER]) && !isPoison(val);
}

/**
 * Returns a shallow copy of the object with a single path segment updated.
 * Handles async values for previous object, key, and value.
 *
 * @param {Object|Promise} obj - The parent object (resolved or promise)
 * @param {String|Number|Promise} key - The key to set (resolved or promise)
 * @param {any} value - The value to set (resolved or promise)
 * @returns {Object|Promise} A shallow copy of obj with obj[key] = value, or a Promise resolving to it.
 */
function setSinglePath(obj, key, value) {
  // If obj or key are async, we must go async to resolve the target container.
  // Note: We do NOT force async just because 'value' is async. We handle that lazily.
  // Important: PoisonedValue is a thenable, but we want to handle it synchronously.
  const isObjAsync = (obj && typeof obj.then === 'function' && !isPoison(obj)) || (obj && obj[RESOLVE_MARKER]);
  const isKeyAsync = (key && typeof key.then === 'function' && !isPoison(key)) || (key && key[RESOLVE_MARKER]);

  if (isObjAsync || isKeyAsync || isPoison(obj) || isPoison(key)) {
    return _setSinglePathAsync(obj, key, value);
  }

  // Synchronous path
  return _setSinglePathSync(obj, key, value);
}

function _setSinglePathSync(obj, key, value) {
  if (obj === undefined || obj === null) {
    throw new Error(`Cannot set property '${key}' of undefined or null`);
  }

  let newObj;
  if (Array.isArray(obj)) {
    newObj = [...obj];
    // Handle array-specific keys if needed (though compiler usually passes indices)
    if (key === '[]') {
      newObj.push(value);
    } else {
      newObj[key] = value;
    }

    // If the new value is async/lazy, mark the result
    if (needsResolution(value)) {
      newObj = createArray(newObj);
    }
  } else {
    newObj = { ...obj };
    newObj[key] = value;

    // If the new value is async/lazy, mark the result
    if (needsResolution(value)) {
      newObj = createObject(newObj);
    }
  }
  return newObj;
}

async function _setSinglePathAsync(objSyncOrPromise, keySyncOrPromise, value) {
  // Resolve obj and key. We pass 'value' through as-is (Lazy assignment).
  const resolved = await resolveAll([objSyncOrPromise, keySyncOrPromise]);
  if (isPoison(resolved)) {
    return resolved;
  }

  const [obj, key] = resolved;

  // Delegate to sync logic which handles marking
  return _setSinglePathSync(obj, key, value);
}


/**
 * Sets a value at a deep path, ensuring shallow copies at each level.
 * Handles arrays of segments where each segment can be a promise.
 *
 * @param {Object|Promise} root - The root object.
 * @param {Array} segments - Array of path segments (can be mixed values/Promises).
 * @param {any} value - The final value to set.
 * @returns {Object|Promise} The new root object (or Promise resolving to it).
 */
function setPath(root, segments, value) {
  // If no segments, just return the value (but marking it if needed? No, bare value replacement)
  if (!segments || segments.length === 0) {
    return value;
  }

  const [head, ...tail] = segments;

  // Collect sync errors
  const errors = [];
  if (isPoison(root)) errors.push(...root.errors);
  if (isPoison(head)) errors.push(...head.errors);
  // We don't check 'value' errors here; we treat poison value as assignment.

  const isRootAsync = (root && typeof root.then === 'function' && !isPoison(root)) || (root && root[RESOLVE_MARKER]);
  const isHeadAsync = (head && typeof head.then === 'function' && !isPoison(head)) || (head && head[RESOLVE_MARKER]);

  // If strictly sync and we have errors: return combined poison immediately
  if (errors.length > 0 && !isRootAsync && !isHeadAsync) {
    return createPoison(errors);
  }

  // If async involved (or errors + async), go async
  if (errors.length > 0 || isRootAsync || isHeadAsync) {
    return _setPathAsync(root, head, tail, value);
  }

  // Sync get
  if (root === undefined || root === null) {
    throw new Error(`Cannot access property '${head}' of undefined or null`);
  }

  // Handle mid-path '[]' as access to last element
  let key = head;
  if (key === '[]' && Array.isArray(root) && tail.length > 0) {
    key = root.length - 1;
    if (key < 0) {
      throw new Error(`Cannot access last element ('[]') of empty array`);
    }
  }

  const child = root[key];

  const newChild = setPath(child, tail, value);

  // Note: setPath recursive call returns newChild.
  // If newChild is async/lazy (Marked or Promise), setSinglePath will detect it via needsResolution check in sync path
  // (because setSinglePath calls _setSinglePathSync which calls needsResolution(value))
  // and mark the result accordingly.
  return setSinglePath(root, key, newChild);
}

async function _setPathAsync(rootPromise, headPromise, tail, value) {
  // Resolve root and head. Pass 'value' through.
  const resolved = await resolveAll([rootPromise, headPromise]);
  if (isPoison(resolved)) return resolved;

  const [root, head] = resolved;

  // Handle mid-path '[]' as access to last element
  let key = head;
  if (key === '[]' && Array.isArray(root) && tail.length > 0) {
    key = root.length - 1;
    if (key < 0) {
      throw new Error(`Cannot access last element ('[]') of empty array`);
    }
  }

  // Get child
  if (root === undefined || root === null) {
    return createPoison(new Error(`Cannot access property '${key}' of undefined or null`));
  }
  let child = root[key];

  // Recurse
  const newChild = setPath(child, tail, value);

  // Set
  return setSinglePath(root, key, newChild);
}

module.exports = {
  setPath
};
