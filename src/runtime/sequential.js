'use strict';

const { createPoison, isPoison, collectErrors } = require('./errors');
const { memberLookupAsync, memberLookupScriptAsync, contextOrFrameLookup } = require('./lookup');
const { callWrapAsync } = require('./call');


function createLockPromise(frame, promise, writeKey, readKey, errorContext, updateWrite, updateRead) {
  let lockPromise = promise.then(
    (res) => {
      if (updateWrite && writeKey && frame.lookup(writeKey) === lockPromise) {
        frame.set(writeKey, true, true);
      }
      if (updateRead && readKey && frame.lookup(readKey) === lockPromise) {
        frame.set(readKey, true, true);
      }
      return res;
    },
    (err) => {
      const poison = createPoison(err, errorContext);
      if (updateWrite && writeKey && frame.lookup(writeKey) === lockPromise) {
        frame.set(writeKey, poison, true);
      }
      if (updateRead && readKey && frame.lookup(readKey) === lockPromise) {
        frame.set(readKey, poison, true);
      }
      return poison;
    }
  );

  if (updateWrite && writeKey) {
    frame.set(writeKey, lockPromise, true);
  }
  if (updateRead && readKey) {
    frame.set(readKey, lockPromise, true);
  }

  return lockPromise;
}

function updateReadLock(frame, readKey, newPromise, errorContext) {
  if (!readKey) {
    return null;
  }
  const current = frame.lookup(readKey);
  if (current && typeof current.then === 'function') {
    const combined = (async () => {
      const errors = await collectErrors([current, newPromise]);
      if (errors.length > 0) {
        return createPoison(errors);
      }
      return true;
    })();
    return createLockPromise(frame, combined, null, readKey, errorContext, false, true);
  }
  return createLockPromise(frame, newPromise, null, readKey, errorContext, false, true);
}

function withSequenceLocks(frame, waitKey, writeKey, readKey, operation, errorContext = null, repair = false, mode = 'write') {
  let waitState = null;
  if (waitKey) {
    waitState = frame.lookup(waitKey);
  }

  if (!repair) {
    if (waitState && isPoison(waitState)) {
      return waitState;
    }
    if (writeKey && writeKey !== waitKey) {
      const writeState = frame.lookup(writeKey);
      if (writeState && isPoison(writeState)) {
        return writeState;
      }
    }
    if (readKey && readKey !== waitKey) {
      const readState = frame.lookup(readKey);
      if (readState && isPoison(readState)) {
        return readState;
      }
    }
  }

  const waitPromise = (waitState && typeof waitState.then === 'function')
    ? waitState
    : null;

  if (waitPromise) {
    const chained = repair
      ? waitPromise.then(() => operation(), () => operation())
      : waitPromise.then(() => operation());

    if (mode === 'write' || (mode === 'read' && repair)) {
      return createLockPromise(frame, chained, writeKey, readKey, errorContext, true, true);
    }
    updateReadLock(frame, readKey, chained, errorContext);
    return chained;
  }

  // @todo - shouldn't we check for poison first?
  let result;
  try {
    result = operation();
  } catch (err) {
    const poison = createPoison(err, errorContext);
    //@todo - isn't this a race condition?
    // Another async block may modify it
    // shouldn't we promisify the read/write key immediately
    // and resolve it to true if necessary?
    // and if it has not changed - replace that promise
    // with the real value
    if (writeKey) {
      frame.set(writeKey, poison, true);
    }
    if (readKey) {
      frame.set(readKey, poison, true);
    }
    return poison;
  }

  // Check for poison FIRST, because PoisonedValue has a .then method
  // but we want to treat it as a static value for frame optimization
  if (isPoison(result)) {
    if (writeKey) {
      frame.set(writeKey, result, true);
    }
    if (readKey) {
      frame.set(readKey, result, true);
    }
    return result;
  }

  if (result && typeof result.then === 'function') {
    if (mode === 'write' || (mode === 'read' && repair)) {
      return createLockPromise(frame, result, writeKey, readKey, errorContext, true, true);
    }
    updateReadLock(frame, readKey, result, errorContext);
    return result;
  }

  // Sync result (not poison, not promise)
  if (mode === 'write' || (mode === 'read' && repair)) {
    if (writeKey) {
      frame.set(writeKey, true, true);
    }
    if (readKey) {
      frame.set(readKey, true, true);
    }
  } else if (readKey) {
    const current = frame.lookup(readKey);
    if (!(current && typeof current.then === 'function') && !isPoison(current)) {
      frame.set(readKey, true, true);
    }
  }
  return result;
}

function withSequenceLock(frame, lockKey, operation, errorContext = null, repair = false) {
  return withSequenceLocks(frame, lockKey, lockKey, lockKey, operation, errorContext, repair, 'write');
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
 * @param {string} writeKey - The write lock variable name
 * @param {string} readKey - The read lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} Result of the function call
 */
function sequentialCallWrap(func, funcName, context, args, frame, writeKey, readKey, errorContext, repair = false) {
  return withSequenceLocks(
    frame,
    readKey,
    writeKey,
    readKey,
    () => callWrapAsync(func, funcName, context, args, errorContext),
    errorContext,
    repair,
    'write'
  );
}

/**
 * Called in place of contextOrFrameLookup when the path has a sequence lock on it.
 *
 * @param {Object} context - The context object
 * @param {AsyncFrame} frame - The async frame
 * @param {string} name - The name to lookup
 * @param {string} writeKey - The write lock variable name
 * @param {string} readKey - The read lock variable name
 * @returns {Promise} The lookup result
 */
function sequentialContextLookup(context, frame, name, writeKey, readKey, repair = false) {
  return withSequenceLocks(
    frame,
    writeKey,
    writeKey,
    readKey,
    () => contextOrFrameLookup(context, frame, name),
    null,
    repair,
    'read'
  );
}

/**
 * Called in place of memberLookupAsync when the path has a sequence lock on it.
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {*} target - The target object
 * @param {string|number} key - The key to lookup
 * @param {string} writeKey - The write lock variable name
 * @param {string} readKey - The read lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} The lookup result
 */
function sequentialMemberLookupAsync(frame, target, key, writeKey, readKey, errorContext, repair = false) {
  return withSequenceLocks(
    frame,
    writeKey,
    writeKey,
    readKey,
    () => memberLookupAsync(target, key, errorContext),
    errorContext,
    repair,
    'read'
  );
}

/**
 * Called in place of memberLookupScriptAsync when the path has a sequence lock on it.
 *
 * @param {AsyncFrame} frame - The async frame
 * @param {*} target - The target object
 * @param {string|number} key - The key to lookup
 * @param {string} writeKey - The write lock variable name
 * @param {string} readKey - The read lock variable name
 * @param {Object} errorContext - Error context with lineno, colno, errorContextString, path
 * @returns {Promise} The lookup result
 */
function sequentialMemberLookupScriptAsync(frame, target, key, writeKey, readKey, errorContext, repair = false) {
  return withSequenceLocks(
    frame,
    writeKey,
    writeKey,
    readKey,
    () => memberLookupScriptAsync(target, key, errorContext),
    errorContext,
    repair,
    'read'
  );
}

module.exports = {
  withSequenceLock,
  withSequenceLocks,
  sequentialCallWrap,
  sequentialContextLookup,
  sequentialMemberLookupAsync,
  sequentialMemberLookupScriptAsync
};
