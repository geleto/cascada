'use strict';

const { createPoison, isPoison, PoisonError } = require('./errors');
const { memberLookupAsync, memberLookupScriptAsync, contextOrFrameLookup } = require('./lookup');
const { callWrapAsync } = require('./call');

/**
 * Await a sequence lock on a frame.
 * @todo - rename to lookupSequenceLock
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {string} lockKeyToAwait - The lock variable name to await
 * @returns {Promise|null} The lock promise if it exists, null otherwise
 */
function awaitSequenceLock(frame, lockKeyToAwait) {
  if (!lockKeyToAwait) {
    return undefined;
  }

  const lockState = frame.lookup(lockKeyToAwait);

  if (lockState && typeof lockState.then === 'function') {
    return lockState; // return the lock promise
  } else {
    return null;//currently the lockState value can only be `true`
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
 * @returns {Promise|*} Result of the operation (Promise if async or contended, Value if sync and free)
 */
function withSequenceLock(frame, lockKey, operation, errorContext = null, repair = false) {
  // Get lock state (undefined, Promise, or PoisonedValue)
  let lockPromise = awaitSequenceLock(frame, lockKey);//returns null if no promise to await
  if (lockPromise) {
    // Check for existing poison on the lock
    if (isPoison(lockPromise)) {
      // Fast path, no need to await we know it's poison
      if (!repair) {
        // Do not run the operation, keep path poisoned
        return lockPromise;//return now, do not run the operation
      } else {
        // Run the operation, update the lock
        const result = operation();
        // Handle result directly if it's sync
        if (!result || typeof result.then !== 'function') {
          // A final non-promise result, update the lock now
          if (isPoison(result)) {
            // poison the lock
            frame.set(lockKey, result, true);
          } else {
            //sucessfull completion of the operation
            frame.set(lockKey, true, true);
          }
          return result;
        }
        // If operation returns a promise, flow into the promise handling logic below
        lockPromise = result;
        // Wrap the new result (after lockPromise resolution)
        const wrapped = lockPromise.then(
          (res) => {
            // Optimization: Release the lock in the frame to 'true' so subsequent
            // isPoison() checks are synchronous and faster.
            // Safety: We use an identity check to ensure we don't overwrite a
            // new lock promise if another operation has already begun.
            if (frame.lookup(lockKey) === wrapped) {
              frame.set(lockKey, true, true);
            }
            return res;
          },
          (err) => {
            const poison = createPoison(err, errorContext);
            // Optimization: Poison the lock in the frame.
            // Safety: Only if we are still the lock holder.
            if (frame.lookup(lockKey) === wrapped) {
              frame.set(lockKey, poison, true);
            }
            // Return poison so the 'wrapped' promise adopts its state (rejects with PoisonError).
            // This ensures awaiters receive the correct error.
            return poison;
          }
        );
        frame.set(lockKey, wrapped, true);
        return wrapped;
      }
    }

    if (typeof lockPromise.then === 'function') {
      // Promisify lockPromise
      if (repair) {
        // Continue with the operation,
        // it still has to be chained after the old promise
        // no matter whether it resolves or rejects
        lockPromise = lockPromise.then(
          () => operation(),
          () => operation()
        );
      } else {
        // Run operation only if lock resolves succesfully
        lockPromise = lockPromise.then(
          () => operation()
        );
      }

      // Chain the frame update logic
      lockPromise = lockPromise.then(
        (res) => {
          // Optimization: Release the lock in the frame to 'true' if we are the current holder.
          if (frame.lookup(lockKey) === lockPromise) {
            frame.set(lockKey, true, true);
          }
          return res;
        },
        (err) => {
          const p = createPoison(err, errorContext);
          // Optimization: Poison the lock in the frame.
          // Safety: Only if we are still the lock holder.
          if (frame.lookup(lockKey) === lockPromise) {
            frame.set(lockKey, p, true);
          }
          throw err;
        }
      );

      // Resolve with the new lock promise (that wraps the previous lockPromise value)
      frame.set(lockKey, lockPromise, true);
      return lockPromise;
    }
  }

  // No lock to .then(), just run the operation
  // and set the lock to the operation result
  let result;
  try {
    result = operation();
  } catch (err) {
    // Operation throws synchronously, poison the lock
    const poison = createPoison(err, errorContext);
    frame.set(lockKey, poison, true);
    return poison;
  }

  // Check for poison FIRST, because PoisonedValue has a .then method
  // but we want to treat it as a static value for frame optimization
  if (isPoison(result)) {
    frame.set(lockKey, result, true);
    return result;
  }

  if (result && typeof result.then === 'function') {
    // Operation returned a promise. We must wrap it to update frame on completion.
    const wrapped = result.then(
      (res) => {
        // Optimization: Release the lock in the frame to 'true' if we are the current holder.
        if (frame.lookup(lockKey) === wrapped) {
          frame.set(lockKey, true, true);
        }
        return res;
      },
      (err) => {
        const poison = createPoison(err, errorContext);
        // Optimization: Poison the lock in the frame.
        // Safety: Only if we are still the lock holder.
        if (frame.lookup(lockKey) === wrapped) {
          frame.set(lockKey, poison, true);
        }
        // Return poison so the 'wrapped' promise adopts its state (rejects with PoisonError).
        // This ensures awaiters receive the correct error.
        return poison;
      }
    );
    frame.set(lockKey, wrapped, true);
    return wrapped;
  } else {
    // Sync result (not poison, not promise)
    frame.set(lockKey, true, true);
    return result;
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
async function sequentialCallWrap(func, funcName, context, args, frame, lockKey, errorContext, repair = false) {
  return withSequenceLock(frame, lockKey, () =>
    callWrapAsync(func, funcName, context, args, errorContext), errorContext, repair
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
async function sequentialContextLookup(context, frame, name, lockKey, repair = false) {
  return withSequenceLock(frame, lockKey, () =>
    contextOrFrameLookup(context, frame, name), null, repair
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
async function sequentialMemberLookupAsync(frame, target, key, lockKey, errorContext, repair = false) {
  return withSequenceLock(frame, lockKey, () =>
    memberLookupAsync(target, key, errorContext), errorContext, repair
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
async function sequentialMemberLookupScriptAsync(frame, target, key, lockKey, errorContext, repair = false) {
  return withSequenceLock(frame, lockKey, () =>
    memberLookupScriptAsync(target, key, errorContext), errorContext, repair
  );
}

module.exports = {
  withSequenceLock,
  sequentialCallWrap,
  sequentialContextLookup,
  sequentialMemberLookupAsync,
  sequentialMemberLookupScriptAsync
};
