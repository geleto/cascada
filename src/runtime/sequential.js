'use strict';

const { createPoison, isPoison } = require('./errors');
const { memberLookupAsync, memberLookupScriptAsync, contextOrFrameLookup } = require('./lookup');
const { callWrapAsync } = require('./call');

/**
 * Await a sequence lock on a frame.
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {string} lockKeyToAwait - The lock variable name to await
 * @returns {Promise|undefined} The lock promise if it exists, undefined otherwise
 */
function awaitSequenceLock(frame, lockKeyToAwait) {
  if (!lockKeyToAwait) {
    return undefined;
  }

  const lockState = frame.lookup(lockKeyToAwait);

  if (lockState && typeof lockState.then === 'function') {
    return lockState; // JavaScript will automatically unwrap any nested promises
  } else {
    return undefined;
  }
}

/**
 * Execute an operation with sequence lock coordination.
 *
 * Optimized to avoid unnecessary microtask scheduling:
 * - Only awaits lock if it's actually a promise
 * - Only awaits result if operation is async
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {string} lockKey - The lock variable name (e.g., "!processed")
 * @param {Function} operation - The operation to execute (may be sync or async)
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} Result of the operation (always returns promise due to async function)
 */
async function withSequenceLock(frame, lockKey, operation, errorContext = null) {
  try {
    // Get lock state (undefined, Promise, or PoisonedValue)
    const lockPromise = awaitSequenceLock(frame, lockKey);

    if (lockPromise) {
      // Early return if lock is poisoned
      if (isPoison(lockPromise)) {
        frame.set(lockKey, lockPromise, true);//lock already poisoned
        return lockPromise;
      }

      // Wait for lock if it's held by another operation
      if (typeof lockPromise.then === 'function') {
        await lockPromise;//may throw an error? (does this happen, lock is either poison or true)
      }
    }

    // Execute the operation
    let result = operation();
    if (isPoison(result)) {
      frame.set(lockKey, result, true);//poison the lock
      return result;
    }

    // Await only if promise and not poison(synchronous operations can return poison)
    if (result && typeof result.then === 'function') {
      result = await result;//may throw an error?
    }
    frame.set(lockKey, true, true);//successfully acquired the lock
    return result;
  } catch (err) {
    // Only reached if operation/lock await failed
    const poison = createPoison(err, errorContext);//poison the lock
    frame.set(lockKey, poison, true);
    return poison;
  }
}

/**
 * Wraps a function call with sequence lock coordination.
 *
 * @todo - deprecate, the sequentialMemberLookupAsync of the FunCall path lookupVal/symbol should handle the frame lock release
 *
 * @param {Function} func - The function to call
 * @param {string} funcName - The name of the function (for error reporting)
 * @param {Object} context - The context object
 * @param {Array} args - The arguments to pass to the function
 * @param {AsyncFrame} frame - The async frame
 * @param {string} lockKey - The lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} Result of the function call
 */
async function sequentialCallWrap(func, funcName, context, args, frame, lockKey, errorContext) {
  return withSequenceLock(frame, lockKey, () =>
    callWrapAsync(func, funcName, context, args, errorContext), errorContext
  );
}

/**
 * Called in place of contextOrFrameLookup when the path has a sequence lock on it.
 *
 * @param {Object} context - The context object
 * @param {AsyncFrame} frame - The async frame
 * @param {string} name - The name to lookup
 * @param {string} lockKey - The lock variable name
 * @returns {Promise} The lookup result
 */
async function sequentialContextLookup(context, frame, name, lockKey) {
  return withSequenceLock(frame, lockKey, () =>
    contextOrFrameLookup(context, frame, name)
  );
}

/**
 * Called in place of memberLookupAsync when the path has a sequence lock on it.
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {*} target - The target object
 * @param {string|number} key - The key to lookup
 * @param {string} lockKey - The lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} The lookup result
 */
async function sequentialMemberLookupAsync(frame, target, key, lockKey, errorContext) {
  return withSequenceLock(frame, lockKey, () =>
    memberLookupAsync(target, key, errorContext), errorContext
  );
}

/**
 * Called in place of memberLookupScriptAsync when the path has a sequence lock on it.
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {*} target - The target object
 * @param {string|number} key - The key to lookup
 * @param {string} lockKey - The lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} The lookup result
 */
async function sequentialMemberLookupScriptAsync(frame, target, key, lockKey, errorContext) {
  return withSequenceLock(frame, lockKey, () =>
    memberLookupScriptAsync(target, key, errorContext), errorContext
  );
}

module.exports = {
  awaitSequenceLock,
  withSequenceLock,
  sequentialCallWrap,
  sequentialContextLookup,
  sequentialMemberLookupAsync,
  sequentialMemberLookupScriptAsync
};
