'use strict';

const { isPoison, createPoison, collectErrors } = require('./errors');

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
  // If any input is a promise (or poison), handle async flow
  if ((obj && typeof obj.then === 'function') ||
    (key && typeof key.then === 'function') ||
    (value && typeof value.then === 'function') ||
    isPoison(obj) || isPoison(key) || isPoison(value)) {
    return _setSinglePathAsync(obj, key, value);
  }

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
  } else {
    newObj = { ...obj };
    newObj[key] = value;
  }
  return newObj;
}

/*
 * We are not using resolveAll because of the deep resolution.
 * TODO - once the deep resolution is removed, use resolveAll.
*/
async function _setSinglePathAsync(objSyncOrPromise, keySyncOrPromise, valueSyncOrPromise) {
  // Resolve all inputs
  const errors = await collectErrors([objSyncOrPromise, keySyncOrPromise, valueSyncOrPromise]);
  if (errors.length > 0) {
    return createPoison(errors);
  }

  const [obj, key, value] = await Promise.all([objSyncOrPromise, keySyncOrPromise, valueSyncOrPromise]);
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
  // If no segments, just return the value
  if (!segments || segments.length === 0) {
    return value;
  }

  const [head, ...tail] = segments;

  // Collect sync errors
  const errors = [];
  if (isPoison(root)) errors.push(...root.errors);
  if (isPoison(head)) errors.push(...head.errors);
  if (isPoison(value)) errors.push(...value.errors);

  const isRootAsync = root && typeof root.then === 'function' && !isPoison(root);
  const isHeadAsync = head && typeof head.then === 'function' && !isPoison(head);
  const isValueAsync = value && typeof value.then === 'function' && !isPoison(value);

  // If strictly sync and we have errors: return combined poison immediately
  if (errors.length > 0 && !isRootAsync && !isHeadAsync && !isValueAsync) {
    return createPoison(errors);
  }

  // If async involved (or errors + async), go async
  if (errors.length > 0 || isRootAsync || isHeadAsync || isValueAsync) {
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
  return setSinglePath(root, key, newChild);
}

/*
 * TODO - once the deep resolution is removed, use resolveAll.
*/
async function _setPathAsync(rootPromise, headPromise, tail, valuePromise) {
  // Resolve root, head, and value
  const errors = await collectErrors([rootPromise, headPromise, valuePromise]);
  if (errors.length > 0) return createPoison(errors);

  const [root, head, value] = await Promise.all([rootPromise, headPromise, valuePromise]);

  // Handle mid-path '[]' as access to last element
  let key = head;
  if (key === '[]' && Array.isArray(root) && tail.length > 0) {
    key = root.length - 1;
    if (key < 0) {
      throw new Error(`Cannot access last element ('[]') of empty array`);
    }
  }

  // Get child
  let child;
  if (root === undefined || root === null) {
    return createPoison(new Error(`Cannot access property '${key}' of undefined or null`));
  }
  child = root[key];

  // Recurse
  const newChild = setPath(child, tail, value);

  // Set
  return setSinglePath(root, key, newChild);
}

module.exports = {
  setPath
};
