'use strict';

import lib from '../lib.js';

import {
  createPoison,
  isPoison,
  isPoisonError,
  isRuntimeFatalError,
  PoisonError,
  handleError,
} from './errors.js';

import {VarCommand} from './channels/var.js';

const arrayFrom = Array.from;
const supportsIterators = (
  typeof Symbol === 'function' && Symbol.iterator && typeof arrayFrom === 'function'
);
function asyncEach(arr, dimen, iter, cb) {
  if (lib.isArray(arr)) {
    const len = arr.length;

    lib.asyncIter(arr, function iterCallback(item, i, next) {
      switch (dimen) {
        case 1:
          iter(item, i, len, next);
          break;
        case 2:
          iter(item[0], item[1], i, len, next);
          break;
        case 3:
          iter(item[0], item[1], item[2], i, len, next);
          break;
        default:
          item.push(i, len, next);
          iter.apply(this, item);
      }
    }, cb);
  } else {
    lib.asyncFor(arr, function iterCallback(key, val, i, len, next) {
      iter(key, val, i, len, next);
    }, cb);
  }
}

function asyncAll(arr, dimen, func, cb) {
  var finished = 0;
  var len;
  var resultArr;

  function done(i, output) {
    finished++;
    resultArr[i] = output;

    if (finished === len) {
      cb(null, resultArr.join(''));
    }
  }

  if (lib.isArray(arr)) {
    len = arr.length;
    resultArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];

        switch (dimen) {
          case 1:
            func(item, i, len, done);
            break;
          case 2:
            func(item[0], item[1], i, len, done);
            break;
          case 3:
            func(item[0], item[1], item[2], i, len, done);
            break;
          default:
            item.push(i, len, done);
            func.apply(this, item);
        }
      }
    }
  } else {
    const keys = lib.keys(arr || {});
    len = keys.length;
    resultArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        func(k, arr[k], i, len, done);
      }
    }
  }
}

function fromIterator(arr) {
  if (typeof arr !== 'object' || arr === null || lib.isArray(arr)) {
    return arr;
  } else if (supportsIterators && Symbol.iterator in arr) {
    return arrayFrom(arr);
  } else {
    return arr;
  }
}

function createLoopBindings(index, len, last) {
  const loopMeta = {
    index: index + 1,
    index0: index,
    first: index === 0,
    length: len,
    last
  };

  if (len && typeof len.then === 'function') {
    loopMeta.revindex = len.then(l => l - index);
    loopMeta.revindex0 = len.then(l => l - index - 1);
  } else {
    loopMeta.revindex = len - index;
    loopMeta.revindex0 = len - index - 1;
  }

  return loopMeta;
}

function setLoopValueBindings(channelName, index, len, last, pos) {
  return new VarCommand({
    channelName,
    args: [createLoopBindings(index, len, last)],
    pos
  });
}

async function iterateAsyncSequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck = null) {
  let didIterate = false;
  let i = 0;

  try {
    for await (let value of arr) { // value is now mutable
      didIterate = true;

      if (value instanceof Error) {
        // Soft error: generator yielded an error. Add context and poison it.
        value = createPoison(value, errorContext);
      }

      let res;
      if (loopVars.length === 1) {
        // `while` loops pass `undefined` for len/last, which is correct.
        res = loopBody(value, i, undefined, false, errorContext);
      } else {
        if (isPoison(value)) {
          const args = Array(loopVars.length);
          args[0] = value;
          res = loopBody(...args, i, undefined, false, errorContext);
        } else if (!Array.isArray(value)) {
          throw new Error('Expected an array for destructuring');
        } else {
          res = loopBody(...value.slice(0, loopVars.length), i, undefined, false, errorContext);
        }
      }

      // Sequential loops await the compiled body result directly.
      // For async while loops, `false` is the explicit break sentinel.
      const resVal = await res;

      if (resVal === false) {
        break;
      }

      if (returnAdvanceCheck && !(await returnAdvanceCheck())) {
        break;
      }

      i++;
    }
  } catch (err) {
    // Hard error: generator threw OR the loopBody threw.
    // Add error context and re-throw immediately (stop iteration)
    const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
    contextualError.didIterate = didIterate;
    throw contextualError;
  }

  return didIterate;
}

async function iterateAsyncParallel(arr, loopBody, loopVars, errorContext) {
  let didIterate = false;
  // PARALLEL PATH
  // This logic allows for `loop.length` and `loop.last` to work
  // by resolving promises only after the entire iterator is consumed. This
  // only works when loop bodies are fired in parallel (sequential=false)
  const iterator = arr[Symbol.asyncIterator]();
  let result;
  let i = 0;

  let lastPromiseResolve;
  let lastPromise = new Promise(resolve => {
    lastPromiseResolve = resolve;
  });

  // This promise is used for the completion and error propagation
  let iterationComplete;
  const lenPromise = new Promise((resolve, reject) => {
    let length = 0;
    // This IIFE runs "in the background" to exhaust the iterator
    iterationComplete = (async () => {
      try {
        while (true) {
          // Async generators await yielded values. If a generator yields a thenable that rejects,
          // iterator.next() will throw. We catch PoisonErrors as soft errors and continue iteration.
          // Non-PoisonErrors from the generator are treated as hard errors.
          result = await iterator.next();

          // Check if iterator is done
          if (result.done) {
            break;
          }

          length++;
          didIterate = true;
          let value = result.value;
          if (value instanceof Error) {
            // Soft error: generator yielded an error
            value = createPoison(value, errorContext);
          }

          // Resolve the previous iteration's lastPromise
          if (lastPromiseResolve) {
            lastPromiseResolve(false);
            lastPromise = new Promise(resolveNew => {
              lastPromiseResolve = resolveNew;
            });
          }

          if (loopVars.length === 1) {
            loopBody(value, i, lenPromise, lastPromise, errorContext);
          } else {
            if (!Array.isArray(value)) {
              if (isPoison(value)) {
                //poison all loop variables
                value = Array(loopVars.length).fill(value);
              } else {
                throw new Error('Expected an array for destructuring');
              }
            }
            loopBody(...value.slice(0, loopVars.length), i, lenPromise, lastPromise);
          }
          i++;
        }

        // Resolve final lastPromise
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        // Resolve length to unblock any loop bodies waiting for loop.length
        resolve(length);

      } catch (error) {
        // Hard error from iterator.next() or loop body
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        const rejectionError = new PoisonError(error, errorContext);
        // Preserve the loop-else decision on both the aggregate PoisonError and
        // its leaf error, since callers inspect both shapes in existing paths.
        rejectionError.didIterate = didIterate;
        if (rejectionError.errors.length > 0) {
          rejectionError.errors[rejectionError.errors.length - 1].didIterate = didIterate;
        }
        reject(rejectionError);
      }
    })();
  });

  // Wait for iteration to complete (including loop bodies)
  // lenPromise resolves with length, iterationComplete handles errors
  await lenPromise;
  await iterationComplete;

  return didIterate;
}

async function iterateAsyncLimited(arr, loopBody, loopVars, errorContext, limit) {
  const iterator = arr[Symbol.asyncIterator]();
  let didIterate = false;
  let index = 0;
  let iteratorDone = false;

  let resolveAllScheduled;
  let rejectAllScheduled;
  const allIterationsScheduled = new Promise((resolve, reject) => {
    resolveAllScheduled = resolve;
    rejectAllScheduled = reject;
  });

  // --- Simple lock so iterator.next() is never called concurrently ---
  let iteratorLocked = false;
  const lockQueue = [];

  async function acquireIteratorLock() {
    while (iteratorLocked) {
      await new Promise(resolve => lockQueue.push(resolve));
    }
    iteratorLocked = true;
  }

  function releaseIteratorLock() {
    iteratorLocked = false;
    const next = lockQueue.shift();
    if (next) {
      next();
    }
  }

  // Helper to pull the next value from the async iterator
  async function getNext() {
    if (iteratorDone) {
      return null;
    }

    await acquireIteratorLock();
    try {
      // Re-check under the lock to avoid extra next() calls after done
      if (iteratorDone) {
        return null;
      }

      const result = await iterator.next();

      if (result.done) {
        iteratorDone = true;
        return null;
      }

      return result.value;
    } catch (err) {
      // Hard error from iterator.next().
      // Let iterate(...) handle it via its outer catch.
      if (rejectAllScheduled) {
        if (!isPoisonError(err)) {
          err.didIterate = didIterate;
        }
        rejectAllScheduled(err);
        rejectAllScheduled = null;
      }
      iteratorDone = true;
      return null;
    } finally {
      releaseIteratorLock();
    }
  }

  // Use the same limited body-call helper as arrays
  async function runIteration(i, value) {
    // Soft error: generator yielded an Error → convert to poison with context
    if (value instanceof Error) {
      value = createPoison(value, errorContext);
    }

    const res = callLoopBodyLimited(loopBody, loopVars, value, i, undefined, false, errorContext);
    // Normalise sync/async body
    await Promise.resolve(res);
  }

  async function worker() {
    while (true) {
      const value = await getNext();
      if (value === null) {
        // Iterator exhausted or hard error already routed via rejectAllScheduled
        if (iteratorDone && resolveAllScheduled) {
          // First worker that observes exhaustion resolves "all scheduled"
          resolveAllScheduled();
          resolveAllScheduled = null;
        }
        return;
      }

      const currentIndex = index++;
      didIterate = true;

      try {
        const res = runIteration(currentIndex, value);
        await res;
      } catch (err) {
        // Error inside loop body. Let iterate(...) handle via its outer catch.
        if (rejectAllScheduled) {
          if (!isPoisonError(err)) {
            err.didIterate = didIterate;
          }
          rejectAllScheduled(err);
          rejectAllScheduled = null;
        }
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.floor(limit));

  // Kick off the initial workers immediately
  for (let i = 0; i < workerCount; i++) {
    // Fire-and-forget; we only wait for "all scheduled"
    worker();
  }

  // Wait until every iteration has been *started* (scheduled),
  // mirroring iterateArrayLimited semantics.
  await allIterationsScheduled;

  return didIterate;
}

/**
 * Helper function to call loop body with proper destructuring and poison handling.
 * Used for limited concurrency mode (arrays + async iterators) which uses while-style metadata.
 *
 * @param {Function} loopBody - The loop body function
 * @param {Array} loopVars - Array of loop variable names
 * @param {*} value - The value for this iteration
 * @param {number} index - The current index
 * @param {Object} errorContext - Error context object
 * @returns {Promise|*} The result of calling the loop body
 */
function callLoopBodyLimited(loopBody, loopVars, value, index, len, isLast, errorContext) {
  if (loopVars.length === 1) {
    return loopBody(value, index, len, isLast, errorContext);
  }

  if (isPoison(value)) {
    const args = Array(loopVars.length).fill(value);
    return loopBody(...args, index, len, isLast, errorContext);
  }

  if (!Array.isArray(value)) {
    throw new Error('Expected an array for destructuring');
  }

  return loopBody(...value.slice(0, loopVars.length), index, len, isLast, errorContext);
}

async function iterateArraySequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck = null) {
  const len = arr.length;
  let didIterate = len > 0;

  for (let i = 0; i < arr.length; i++) {
    let value = arr[i];
    const isLast = i === arr.length - 1;

    let res;
    if (loopVars.length === 1) {
      res = loopBody(value, i, len, isLast, errorContext);
    } else {
      if (!Array.isArray(value)) {
        if (isPoison(value)) {
          const args = Array(loopVars.length).fill(value);
          res = loopBody(...args, i, len, isLast, errorContext);
        } else {
          throw new Error('Expected an array for destructuring');
        }
      } else {
        res = loopBody(...value.slice(0, loopVars.length), i, len, isLast, errorContext);
      }
    }

    await res;

    if (returnAdvanceCheck && !(await returnAdvanceCheck())) {
      break;
    }
  }

  return didIterate;
}

// Synchronous (not async): returns boolean directly for sync loops, avoids Promise overhead.
// Arrays iterate synchronously - only loop bodies can be async.
function iterateArrayParallel(arr, loopBody, loopVars, errorContext) {
  const len = arr.length;
  let didIterate = len > 0;

  // Each loopBody call may start its own async structural work; poison propagation handles failures.
  for (let i = 0; i < arr.length; i++) {
    let value = arr[i];
    const isLast = i === arr.length - 1;

    if (loopVars.length === 1) {
      loopBody(value, i, len, isLast, errorContext);
    } else {
      if (!Array.isArray(value)) {
        if (isPoison(value)) {
          const args = Array(loopVars.length).fill(value);
          loopBody(...args, i, len, isLast, errorContext);
        } else {
          throw new Error('Expected an array for destructuring');
        }
      } else {
        loopBody(...value.slice(0, loopVars.length), i, len, isLast, errorContext);
      }
    }
  }

  return didIterate;
}

async function iterateArrayLimited(arr, loopBody, loopVars, errorContext, limit) {
  const len = arr.length;
  const didIterate = len > 0;

  if (len === 0) {
    return false;
  }

  let nextIndex = 0;

  let resolveAllScheduled;
  let rejectAllScheduled;
  const allIterationsScheduled = new Promise((resolve, reject) => {
    resolveAllScheduled = resolve;
    rejectAllScheduled = reject;
  });

  const runIteration = async (index) => {
    let value = arr[index];



    const isLast = index === len - 1;
    const res = callLoopBodyLimited(loopBody, loopVars, value, index, len, isLast, errorContext);
    await Promise.resolve(res);
  };

  async function worker() {
    //each worker repeatedly grabs the next index and runs the iteration
    //until the index is greater than the length of the array
    while (true) {
      try {
        const current = nextIndex++;
        if (current >= len) {
          break;
        }
        const res = runIteration(current);
        if (current === len - 1 && resolveAllScheduled) {
          // this was the last runIteration
          resolveAllScheduled();
          resolveAllScheduled = null;
        }
        await res;
      } catch (err) {
        // most likely a bug, @todo - betetr handling of unexpoected errors
        // iterate(...) will handle the error after allIterationsScheduled rejects
        rejectAllScheduled(err);
        rejectAllScheduled = null;
      }
    }
  }

  // kick off the initial workers immediately
  //
  const workerCount = Math.min(limit, len);
  for (let i = 0; i < workerCount; i++) {
    worker();
  }

  // Wait until every iteration has been started.
  await allIterationsScheduled;

  return didIterate;
}

async function iterateObject(arr, loopBody, loopVars, errorContext, effectiveSequential, maxConcurrency, returnAdvanceCheck = null) {
  const keys = Object.keys(arr);
  const len = keys.length;
  let didIterate = len > 0;

  if (len > 0) {
    // For objects we *always* require two loop variables: key and value
    if (loopVars.length !== 2) {
      throw new Error(
        `Expected two variables for key/value iteration, got ${loopVars.length} : ${loopVars.join(', ')}`
      );
    }

    if (effectiveSequential) {
      // Sequential object iteration (unchanged semantics, but via effectiveSequential)
      for (let i = 0; i < len; i++) {
        const key = keys[i];
        let value = arr[key];
        const isLast = i === len - 1;

        const res = loopBody(key, value, i, len, isLast);
        // In sequential mode we always await the body
        await res;

        if (returnAdvanceCheck && !(await returnAdvanceCheck())) {
          break;
        }
      }
    } else if (maxConcurrency && maxConcurrency < len) {
      // Limited-concurrency path: reuse array-limited helper on [key, value] pairs,
      // preserving Error→poison behaviour and full length/last metadata.
      const entries = new Array(len);
      for (let i = 0; i < len; i++) {
        const key = keys[i];
        let value = arr[key];

        entries[i] = [key, value];
      }

      // iterateArrayLimited will:
      // - enforce the concurrency pool,
      // - call callLoopBodyLimited → loopBody(key, value, index, len, isLast, errorContext),
      // - return a boolean didIterate.
      didIterate = await iterateArrayLimited(
        entries,
        loopBody,
        loopVars,
        errorContext,
        maxConcurrency
      );
    } else {
      // Parallel (unbounded) object iteration – same semantics as before
      for (let i = 0; i < len; i++) {
        const key = keys[i];
        let value = arr[key];
        const isLast = i === len - 1;

        loopBody(key, value, i, len, isLast);
        // Non-sequential bodies may be async; each body registers its own async block.
        // We deliberately do *not* await loopBody here – same as existing parallel behaviour.
      }
    }
  }

  return didIterate;
}

/**
 * Poison body/else channel effects when loop input fails before/during iteration.
 *
 * @param {Object} buffer - The CommandBuffer instance
 * @param {Object} asyncOptions - Options containing write counts and channels
 * @param {Array} errors - Array of error objects to propagate
 * @param {boolean} didIterate - Whether any iterations occurred
 */
function poisonLoopEffects(buffer, asyncOptions, errors, didIterate) {
  //replace the errors with the handleError'd errors
  errors = errors.map(error => handleError(error, asyncOptions.errorContext.lineno, asyncOptions.errorContext.colno, asyncOptions.errorContext.errorContextString, asyncOptions.errorContext.path));

  // Poison body channel effects.
  if (asyncOptions.bodyChannels && asyncOptions.bodyChannels.length > 0) {
    for (const channelName of asyncOptions.bodyChannels) {
      buffer.addPoison(errors, channelName);
    }
  }

  if (didIterate) {
    return;// we don't poison the else side-effects if we had at least one iteration
  }

  // Poison else channel effects.
  if (asyncOptions.elseChannels && asyncOptions.elseChannels.length > 0) {
    for (const channelName of asyncOptions.elseChannels) {
      buffer.addPoison(errors, channelName);
    }
  }
}

async function iterate(arr, loopBody, loopElse, buffer, loopVars = [], asyncOptions = null) {
  // Handle poison detection if in async mode
  if (asyncOptions) {
    // Check for synchronous poison first
    if (isPoison(arr)) {
      // Array expression evaluated to poison - poison both body and else
      poisonLoopEffects(buffer, asyncOptions, arr.errors, false);
      return; // Early return, else doesn't run
    }

    // Check for promise that might reject with poison
    if (arr && typeof arr.then === 'function') {
      try {
        arr = await arr;
      } catch (err) {
        // Promise rejected - poison both body and else
        const errors = isPoisonError(err) ? err.errors : [err];
        poisonLoopEffects(buffer, asyncOptions, errors, false);
        return;
      }
    }

    // Note: After await, arr cannot be poison (await converts poison to PoisonError)
  }

  let sequential = asyncOptions ? asyncOptions.sequential : false;
  let limitSequentialOverride = false;
  const isAsync = asyncOptions !== null;
  const errorContext = asyncOptions ? asyncOptions.errorContext : null;

  let didIterate = false;
  // Called between sequential iterations. The ordered channel observation may
  // be async because it is enqueued on the loop's command buffer.
  const returnAdvanceCheck = asyncOptions && asyncOptions.returnCheckChannelName
    ? (() => buffer.addReturnIsUnset(
      asyncOptions.returnCheckChannelName,
      { lineno: errorContext?.lineno || 0, colno: errorContext?.colno || 0 }
    ))
    : null;

  if (arr && typeof arr === 'object' && !Array.isArray(arr) && !(isAsync && typeof arr[Symbol.asyncIterator] === 'function')) {
    arr = fromIterator(arr);
    if (arr && !Array.isArray(arr) && loopVars.length !== 2) {
      throw new Error(
        `Expected two variables for key/value iteration, got ${loopVars.length} : ${loopVars.join(', ')}`
      );
    }
  }

  try {
    // Resolve and validate concurrentLimit if present
    let maxConcurrency = asyncOptions ? asyncOptions.concurrentLimit : null;

    if (asyncOptions && maxConcurrency !== null && maxConcurrency !== undefined) {
      // 1. If it's a PoisonedValue → whole loop is poisoned
      if (isPoison(maxConcurrency)) {
        const errors = maxConcurrency.errors || [maxConcurrency];
        poisonLoopEffects(buffer, asyncOptions, errors, false);
        return;
      }

      // 2. If it's a Promise (thenable), await it
      if (typeof maxConcurrency.then === 'function') {
        try {
          maxConcurrency = await maxConcurrency;
          // After await, if it was a PoisonedValue, it would have thrown a PoisonError
          // which is caught by the outer catch. Check for poison after await.
          if (isPoison(maxConcurrency)) {
            const errors = maxConcurrency.errors || [maxConcurrency];
            poisonLoopEffects(buffer, asyncOptions, errors, false);
            return;
          }
        } catch (err) {
          // Promise rejected - poison both body and else
          const errors = isPoisonError(err) ? err.errors : [err];
          poisonLoopEffects(buffer, asyncOptions, errors, false);
          return;
        }
      }

      // 3. Normalise and validate according to the rules
      if (maxConcurrency == null || maxConcurrency === 0) {
        // null / undefined / 0 → ignore, treated as "no limit"
        maxConcurrency = null;
      } else {
        const numericLimit = Number(maxConcurrency);
        if (typeof maxConcurrency !== 'number' || !Number.isFinite(numericLimit) || numericLimit <= 0) {
          poisonLoopEffects(
            buffer,
            asyncOptions,
            [new Error('concurrentLimit must be a positive number or 0 / null / undefined')],
            false
          );
          return;
        }
        maxConcurrency = numericLimit;
        if (numericLimit === 1) {
          limitSequentialOverride = true;
          maxConcurrency = null;
        }
      }
    }
    if (isAsync && arr && typeof arr[Symbol.asyncIterator] === 'function') {
      // We must have two separate code paths. The `lenPromise` and `lastPromise`
      // mechanism is fundamentally incompatible with sequential execution, as it
      // would create a deadlock.

      const effectiveSequential = sequential || limitSequentialOverride;

      if (effectiveSequential) {
        // Used for `while` and `each` loops and
        // any `for` loop marked as sequential. It does NOT support `loop.length`
        // or `loop.last` for async iterators, as that is impossible to know
        // without first consuming the entire iterator.
        didIterate = await iterateAsyncSequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck);
      } else if (maxConcurrency) {
        // Limited concurrency path: behaves like while loops for metadata
        didIterate = await iterateAsyncLimited(arr, loopBody, loopVars, errorContext, maxConcurrency);
      } else {
        // PARALLEL PATH
        // This complex logic allows for `loop.length` and `loop.last` to work
        // by resolving promises only after the entire iterator is consumed. This
        // only works when loop bodies are fired in parallel (sequential=false)
        didIterate = await iterateAsyncParallel(arr, loopBody, loopVars, errorContext);
      }
    }
    else if (arr) {
      if (Array.isArray(arr)) {
        const len = arr.length;
        const effectiveSequential = sequential || limitSequentialOverride;

        if (effectiveSequential) {
          didIterate = await iterateArraySequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck);
        } else if (maxConcurrency && maxConcurrency < len) {
          didIterate = await iterateArrayLimited(arr, loopBody, loopVars, errorContext, maxConcurrency);
        } else {
          // Sync: returns boolean directly. Async: await to handle Promise (though it's not async)
          const result = iterateArrayParallel(arr, loopBody, loopVars, errorContext);
          didIterate = asyncOptions ? await result : result;
        }
      } else {
        // object iteration
        const effectiveSequential = sequential || limitSequentialOverride;
        didIterate = await iterateObject(arr, loopBody, loopVars, errorContext, effectiveSequential, maxConcurrency, returnAdvanceCheck);
      }
    }
  } catch (err) {
    if (!asyncOptions || isRuntimeFatalError(err)) {
      throw err;
    }
    const errors = isPoisonError(err) ? err.errors : [err];
    didIterate = errors[errors.length - 1]?.didIterate || false;
    // if we had at least one iteration, we won't poison the else side-effects
    poisonLoopEffects(buffer, asyncOptions, errors, didIterate);
    return;
  }

  // Handle else execution.
  if (!didIterate && loopElse) {
    if (asyncOptions) {
      await loopElse();
    } else {
      // Sync: execute directly (else block is sync function, outputs to buffer via closure)
      loopElse();
    }
  }

}

async function* whileIterator() {
  let i = 0;
  while (true) {
    // This generator yields loop indices indefinitely.
    // The consumer (iterateAsyncSequential) controls termination.
    // When the compiled while-loop body returns false,
    // the consumer breaks its 'for await' loop.
    // This triggers the implicit .return() on this iterator,
    // safely terminating this generator execution.
    yield i++;
  }
}

export default {
  asyncEach,
  asyncAll,
  fromIterator,
  createLoopBindings,
  setLoopValueBindings,
  iterateAsyncSequential,
  iterateAsyncParallel,
  poisonLoopEffects,
  iterate,
  whileIterator
};
export { asyncEach, asyncAll, fromIterator, createLoopBindings, setLoopValueBindings, iterateAsyncSequential, iterateAsyncParallel, poisonLoopEffects, iterate, whileIterator };

