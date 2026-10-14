
import {isArray, isScalarPrimitive, asyncIter, asyncFor, keys as objectKeys} from '../lib.js';

import {
  createPoison,
  isPoison,
  isPoisonError,
  isRuntimeError,
  markPromiseHandled,
  PoisonError,
  RuntimeError,
  valueWithOrigin,
} from './errors.js';

import {ErrorCommand} from './commands/errors.js';
import {ReturnIsUnsetCommand} from './commands/observation.js';
import {isFatalReported} from './error-context.js';
import {nextAsyncIterator, closeAsyncIterator} from './async-iterator.js';
import {getAsyncIterator} from './shared-iterable.js';

function asyncEach(arr, dimen, iter, cb) {
  if (isArray(arr)) {
    const len = arr.length;

    asyncIter(arr, function iterCallback(item, i, next) {
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
    asyncFor(arr, function iterCallback(key, val, i, len, next) {
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

  if (isArray(arr)) {
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
    const keys = objectKeys(arr || {});
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
  if (typeof arr !== 'object' || arr === null || isArray(arr)) {
    return arr;
  } else if (Symbol.iterator in arr) {
    return Array.from(arr);
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
    loopMeta.revindex = markPromiseHandled(len.then(l => l - index));
    loopMeta.revindex0 = markPromiseHandled(len.then(l => l - index - 1));
  } else {
    loopMeta.revindex = len - index;
    loopMeta.revindex0 = len - index - 1;
  }

  return loopMeta;
}

function addPoisonCommands(buffer, chainNames, poisonError, errorContext) {
  if (!buffer || !chainNames || chainNames.length === 0) {
    return;
  }
  for (const chainName of chainNames) {
    buffer.addCommand(new ErrorCommand(poisonError, errorContext), chainName);
  }
}

function poisonIterationEffects(buffer, asyncOptions, poisonError) {
  if (!asyncOptions) {
    return;
  }
  addPoisonCommands(buffer, asyncOptions.bodyPoisonChains, poisonError, asyncOptions.errorContext);
}

function normalizeLoopValue(value, errorContext) {
  try {
    return valueWithOrigin(value, errorContext, 'IteratorThrew');
  } catch (error) {
    return createPoison(PoisonError.wrap(error, errorContext, 'IteratorThrew'));
  }
}

function getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions) {
  // Returns null after poisoning this iteration's body effects for a malformed value.
  if (isPoison(value)) {
    return Array(loopVars.length).fill(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, loopVars.length).map(arg => normalizeLoopValue(arg, errorContext));
  }
  const poisonError = PoisonError.create('Expected an array for destructuring', errorContext, 'NotDestructurable');
  poisonIterationEffects(buffer, asyncOptions, poisonError);
  return null;
}

function acquireAsyncIterator(iterable, errorContext, replay) {
  try {
    const iterator = getAsyncIterator(iterable, replay);
    return iterator ? {iterator, next: iterator.next} : null;
  } catch (error) {
    throw PoisonError.wrap(error, errorContext, 'IteratorThrew');
  }
}

async function iterateAsyncSequential({iterator, next}, loopBody, loopVars, errorContext, returnAdvanceCheck, buffer, asyncOptions, progress) {
  let i = 0;
  let needsClose = true;
  let failure = null;
  try {
    while (!isFatalReported(errorContext)) {
      // A failed next() or normal exhaustion does not call return().
      needsClose = false;
      const result = await nextAsyncIterator(iterator, next, errorContext);
      if (result.done) break;
      needsClose = true;
      progress.didIterate = true;
      let value = result.value;
      if (value instanceof Error) {
        value = createPoison(PoisonError.wrap(value, errorContext, 'IteratorThrew'));
      }
      value = normalizeLoopValue(value, errorContext);

      let res;
      if (loopVars.length === 1) {
        res = loopBody(value, i, undefined, false, errorContext);
      } else {
        const args = getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions);
        if (!args) {
          i++;
          continue;
        }
        res = loopBody(...args, i, undefined, false, errorContext);
      }

      // While bodies return false; each bodies can return from the script.
      if (await res === false) break;
      if (returnAdvanceCheck && !(await returnAdvanceCheck())) break;
      i++;
    }
  } catch (error) {
    failure = {error};
  }
  if (needsClose) {
    try {
      await closeAsyncIterator(iterator);
    } catch (error) {
      // As in native iteration, cleanup must not replace a body failure.
      if (!failure) throw PoisonError.wrap(error, errorContext, 'IteratorThrew');
    }
  }
  if (failure) throw failure.error;
}

async function iterateAsyncParallel({iterator, next}, loopBody, loopVars, errorContext, buffer, asyncOptions, progress) {
  // Unbounded bodies can wait for source length without blocking further pulls.
  let i = 0;

  let resolveLast;

  let resolveLength;
  let rejectLength;
  const lenPromise = new Promise((resolve, reject) => {
    resolveLength = resolve;
    rejectLength = reject;
  });
  markPromiseHandled(lenPromise);

  try {
    while (!isFatalReported(errorContext)) {
      const result = await nextAsyncIterator(iterator, next, errorContext);
      if (result.done) {
        break;
      }

      progress.didIterate = true;
      let value = result.value;
      if (value instanceof Error) {
        value = createPoison(PoisonError.wrap(value, errorContext, 'IteratorThrew'));
      }
      value = normalizeLoopValue(value, errorContext);

      // A new item proves the preceding iteration was not the last one.
      resolveLast?.(false);
      const lastPromise = new Promise(resolve => { resolveLast = resolve; });

      const index = i++;
      if (loopVars.length === 1) {
        loopBody(value, index, lenPromise, lastPromise, errorContext);
      } else {
        const args = getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions);
        if (args) {
          loopBody(...args, index, lenPromise, lastPromise, errorContext);
        }
      }
    }
    resolveLength(i);
  } catch (error) {
    rejectLength(error);
    throw error;
  } finally {
    resolveLast?.(true);
  }
}

async function iterateAsyncLimited({iterator, next}, loopBody, loopVars, errorContext, limit, buffer, asyncOptions, progress) {
  let index = 0;
  let iteratorDone = false;
  let firstBodyError = null;
  let activeCount = 0;
  let resumeSlot = null;
  const workerCount = Math.max(1, Math.floor(limit));

  function waitForSlot() {
    if (activeCount < workerCount || firstBodyError) {
      return undefined;
    }
    return new Promise(resolve => { resumeSlot = resolve; });
  }

  function runIteration(i, value) {
    // Soft error: generator yielded an Error. Preserve the yielded error's
    // own origin when present; otherwise use the iterator source boundary.
    if (value instanceof Error) {
      value = createPoison(PoisonError.wrap(value, errorContext, 'IteratorThrew'));
    }
    value = normalizeLoopValue(value, errorContext);

    return callLoopBodyLimited(loopBody, loopVars, value, i, undefined, false, errorContext, buffer, asyncOptions);
  }

  function finishIteration(err = null) {
    activeCount--;
    if (err && !firstBodyError) {
      firstBodyError = err;
    }
    const resume = resumeSlot;
    resumeSlot = null;
    resume?.();
  }

  function startIteration(i, value) {
    activeCount++;
    queueMicrotask(() => {
      let res;
      try {
        res = runIteration(i, value);
      } catch (err) {
        finishIteration(err);
        return;
      }
      if (res && typeof res.then === 'function') {
        markPromiseHandled(res.then(
          () => finishIteration(),
          (err) => finishIteration(err)
        ));
        return;
      }
      finishIteration();
    });
  }

  while (!iteratorDone && !firstBodyError && !isFatalReported(errorContext)) {
    while (activeCount < workerCount && !iteratorDone && !firstBodyError && !isFatalReported(errorContext)) {
      const result = await nextAsyncIterator(iterator, next, errorContext);
      if (result.done) {
        iteratorDone = true;
        break;
      }
      const currentIndex = index++;
      progress.didIterate = true;
      startIteration(currentIndex, result.value);
    }
    const slot = waitForSlot();
    if (slot) {
      await slot;
    }
  }

  if (firstBodyError) {
    throw firstBodyError;
  }
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
function callLoopBodyLimited(loopBody, loopVars, value, index, len, isLast, errorContext, buffer = null, asyncOptions = null) {
  if (loopVars.length === 1) {
    return loopBody(value, index, len, isLast, errorContext);
  }

  const args = getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions);
  if (!args) {
    return undefined;
  }
  return loopBody(...args, index, len, isLast, errorContext);
}

async function iterateArraySequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck = null, buffer = null, asyncOptions = null) {
  const len = arr.length;
  let didIterate = len > 0;

  for (let i = 0; i < arr.length; i++) {
    if (isFatalReported(errorContext)) {
      break;
    }
    let value = arr[i];
    value = normalizeLoopValue(value, errorContext);
    const isLast = i === arr.length - 1;

    let res;
    if (loopVars.length === 1) {
      res = loopBody(value, i, len, isLast, errorContext);
    } else {
      const args = getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions);
      if (!args) {
        continue;
      }
      res = loopBody(...args, i, len, isLast, errorContext);
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
function iterateArrayParallel(arr, loopBody, loopVars, errorContext, buffer = null, asyncOptions = null) {
  const len = arr.length;
  let didIterate = len > 0;

  // Each loopBody call may start its own async structural work; poison propagation handles failures.
  for (let i = 0; i < arr.length; i++) {
    if (isFatalReported(errorContext)) {
      break;
    }
    let value = arr[i];
    value = normalizeLoopValue(value, errorContext);
    const isLast = i === arr.length - 1;

    if (loopVars.length === 1) {
      loopBody(value, i, len, isLast, errorContext);
    } else {
      const args = getDestructuredLoopArgs(value, loopVars, errorContext, buffer, asyncOptions);
      if (!args) {
        continue;
      }
      loopBody(...args, i, len, isLast, errorContext);
    }
  }

  return didIterate;
}

async function iterateArrayLimited(arr, loopBody, loopVars, errorContext, limit, buffer = null, asyncOptions = null) {
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
    value = normalizeLoopValue(value, errorContext);



    const isLast = index === len - 1;
    const res = callLoopBodyLimited(loopBody, loopVars, value, index, len, isLast, errorContext, buffer, asyncOptions);
    await res;
  };

  async function worker() {
    //each worker repeatedly grabs the next index and runs the iteration
    //until the index is greater than the length of the array
    while (true) {
      try {
        if (isFatalReported(errorContext)) {
          if (resolveAllScheduled) {
            resolveAllScheduled();
            resolveAllScheduled = null;
          }
          break;
        }
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
        // iterate(...) will handle the error after allIterationsScheduled rejects
        if (rejectAllScheduled) {
          rejectAllScheduled(err);
          rejectAllScheduled = null;
        }
      }
    }
  }

  // kick off the initial workers immediately
  //
  const workerCount = Math.min(limit, len);
  for (let i = 0; i < workerCount; i++) {
    markPromiseHandled(worker());
  }

  // Wait until every iteration has been started.
  await allIterationsScheduled;

  return didIterate;
}

async function iterateObject(arr, loopBody, loopVars, errorContext, effectiveSequential, maxConcurrency, returnAdvanceCheck = null, buffer = null, asyncOptions = null) {
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
        if (isFatalReported(errorContext)) {
          break;
        }
        const key = keys[i];
        let value = arr[key];
        value = normalizeLoopValue(value, errorContext);
        const isLast = i === len - 1;

        const res = loopBody(key, value, i, len, isLast, errorContext);
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
        if (isFatalReported(errorContext)) {
          break;
        }
        const key = keys[i];
        let value = arr[key];
        value = normalizeLoopValue(value, errorContext);

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
        maxConcurrency,
        buffer,
        asyncOptions
      );
    } else {
      // Parallel (unbounded) object iteration – same semantics as before
      for (let i = 0; i < len; i++) {
        const key = keys[i];
        let value = arr[key];
        value = normalizeLoopValue(value, errorContext);
        const isLast = i === len - 1;

        loopBody(key, value, i, len, isLast, errorContext);
        // Non-sequential bodies may be async; each body registers its own async block.
        // We deliberately do *not* await loopBody here – same as existing parallel behaviour.
      }
    }
  }

  return didIterate;
}

/**
 * Poison body/else chain effects when loop input fails before/during iteration.
 *
 * @param {Object} buffer - The CommandBuffer instance
 * @param {Object} asyncOptions - Options containing mutation-only poison targets
 * @param {PoisonError} poisonError - Poison error to propagate
 * @param {boolean} didIterate - Whether any iterations occurred
 */
function poisonLoopEffects(buffer, asyncOptions, poisonError, didIterate) {
  // Poison body chain effects.
  addPoisonCommands(buffer, asyncOptions.bodyPoisonChains, poisonError, asyncOptions.errorContext);

  if (didIterate) {
    return;// we don't poison the else side-effects if we had at least one iteration
  }

  // Poison else chain effects.
  addPoisonCommands(buffer, asyncOptions.elsePoisonChains, poisonError, asyncOptions.errorContext);
}

function canUseSyncArrayDispatch(iterable, asyncOptions) {
  if (!Array.isArray(iterable)) return false;
  if (asyncOptions) {
    if (
      'then' in iterable ||
      Symbol.asyncIterator in iterable ||
      asyncOptions.sequential ||
      asyncOptions.returnCheckChainName ||
      (asyncOptions.concurrentLimit !== null && asyncOptions.concurrentLimit !== undefined)
    ) {
      return false;
    }
  }

  return true;
}

function iterateSync(arr, loopBody, loopElse, buffer, loopVars, asyncOptions, errorContext) {
  const didIterate = iterateArrayParallel(arr, loopBody, loopVars, errorContext, buffer, asyncOptions);
  if (didIterate || !loopElse) {
    return undefined;
  }
  return loopElse();
}

function iterate(arr, loopBody, loopElse, buffer, loopVars = [], asyncOptions = null) {
  const errorContext = asyncOptions ? asyncOptions.errorContext : null;
  if (canUseSyncArrayDispatch(arr, asyncOptions)) {
    return iterateSync(arr, loopBody, loopElse, buffer, loopVars, asyncOptions, errorContext);
  }
  return iterateAsync(arr, loopBody, loopElse, buffer, loopVars, asyncOptions);
}

async function iterateAsync(arr, loopBody, loopElse, buffer, loopVars = [], asyncOptions = null) {
  const errorContext = asyncOptions ? asyncOptions.errorContext : null;

  // Handle poison detection if in async mode
  if (asyncOptions) {
    arr = normalizeLoopValue(arr, errorContext);
    // Check for synchronous poison first
    if (isPoison(arr)) {
      // Array expression evaluated to poison - poison both body and else
      poisonLoopEffects(buffer, asyncOptions, PoisonError.group(arr.errors), false);
      return; // Early return, else doesn't run
    }

    // Check for promise that might reject with poison
    if (arr && typeof arr.then === 'function') {
      try {
        arr = await arr;
      } catch (err) {
        // Promise rejected - poison both body and else
        if (!isPoisonError(err)) {
          RuntimeError.reportAndThrow(err, errorContext);
        }
        poisonLoopEffects(buffer, asyncOptions, err, false);
        return;
      }
    }

    // Note: After await, arr cannot be poison (await converts poison to PoisonError)
  }

  const sequential = asyncOptions ? asyncOptions.sequential : false;
  let limitSequentialOverride = false;
  const isAsync = asyncOptions !== null;

  const progress = {didIterate: false};
  // Called between sequential iterations. The ordered chain observation may
  // be async because it is enqueued on the loop's command buffer.
  const returnAdvanceCheck = asyncOptions && asyncOptions.returnCheckChainName
    ? (() => buffer.addCommand(new ReturnIsUnsetCommand({
      chainName: asyncOptions.returnCheckChainName,
      errorContext
    }), asyncOptions.returnCheckChainName))
    : null;

  try {
    if (asyncOptions && asyncOptions.scriptMode && (typeof arr === 'string' || isScalarPrimitive(arr))) {
      poisonLoopEffects(
        buffer,
        asyncOptions,
        PoisonError.create(`Cannot iterate over scalar value ${arr.toString()}`, errorContext, 'NotIterable'),
        false
      );
      return;
    }

    // Resolve and validate concurrentLimit if present
    let maxConcurrency = asyncOptions ? asyncOptions.concurrentLimit : null;

    if (asyncOptions && maxConcurrency !== null && maxConcurrency !== undefined) {
      // 1. If it's a PoisonedValue → whole loop is poisoned
      if (isPoison(maxConcurrency)) {
        poisonLoopEffects(buffer, asyncOptions, PoisonError.group(maxConcurrency.errors), false);
        return;
      }

      // 2. If it's a Promise (thenable), await it
      if (typeof maxConcurrency.then === 'function') {
        try {
          maxConcurrency = await maxConcurrency;
        } catch (err) {
          // Promise rejected - poison both body and else
          if (!isPoisonError(err)) {
            RuntimeError.reportAndThrow(err, errorContext);
          }
          poisonLoopEffects(buffer, asyncOptions, err, false);
          return;
        }
      }

      // 3. Normalise and validate according to the rules
      if (maxConcurrency == null || maxConcurrency === 0) {
        // null / undefined / 0 → ignore, treated as "no limit"
        maxConcurrency = null;
      } else {
        if (typeof maxConcurrency !== 'number' || !Number.isFinite(maxConcurrency) || maxConcurrency <= 0) {
          poisonLoopEffects(
            buffer,
            asyncOptions,
            PoisonError.create('concurrentLimit must be a positive number or 0 / null / undefined', errorContext, 'InvalidConcurrentLimit'),
            false
          );
          return;
        }
        if (maxConcurrency === 1) {
          limitSequentialOverride = true;
          maxConcurrency = null;
        }
      }
    }
    if (isFatalReported(errorContext)) return;
    const asyncIterator = isAsync ? acquireAsyncIterator(arr, errorContext, asyncOptions.replayAsyncIterables !== false) : null;
    if (arr && typeof arr === 'object' && !Array.isArray(arr) && !asyncIterator) {
      arr = fromIterator(arr);
      if (arr && !Array.isArray(arr) && loopVars.length !== 2) {
        throw new Error(
          `Expected two variables for key/value iteration, got ${loopVars.length} : ${loopVars.join(', ')}`
        );
      }
    }

    const effectiveSequential = sequential || limitSequentialOverride;
    if (asyncIterator) {
      // Length/last promises require unbounded parallel bodies to avoid deadlock.
      if (effectiveSequential) {
        await iterateAsyncSequential(asyncIterator, loopBody, loopVars, errorContext, returnAdvanceCheck, buffer, asyncOptions, progress);
      } else if (maxConcurrency) {
        await iterateAsyncLimited(asyncIterator, loopBody, loopVars, errorContext, maxConcurrency, buffer, asyncOptions, progress);
      } else {
        await iterateAsyncParallel(asyncIterator, loopBody, loopVars, errorContext, buffer, asyncOptions, progress);
      }
    } else if (arr) {
      if (Array.isArray(arr)) {
        if (effectiveSequential) {
          progress.didIterate = await iterateArraySequential(arr, loopBody, loopVars, errorContext, returnAdvanceCheck, buffer, asyncOptions);
        } else if (maxConcurrency && maxConcurrency < arr.length) {
          progress.didIterate = await iterateArrayLimited(arr, loopBody, loopVars, errorContext, maxConcurrency, buffer, asyncOptions);
        } else {
          progress.didIterate = iterateArrayParallel(arr, loopBody, loopVars, errorContext, buffer, asyncOptions);
        }
      } else {
        progress.didIterate = await iterateObject(arr, loopBody, loopVars, errorContext, effectiveSequential, maxConcurrency, returnAdvanceCheck, buffer, asyncOptions);
      }
    }
  } catch (err) {
    if (!asyncOptions || isRuntimeError(err)) {
      throw err;
    }
    if (!isPoisonError(err)) {
      RuntimeError.reportAndThrow(err, errorContext);
    }
    // if we had at least one iteration, we won't poison the else side-effects
    poisonLoopEffects(buffer, asyncOptions, err, progress.didIterate);
    return;
  }

  // Handle else execution.
  if (!progress.didIterate && loopElse) {
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
    // The sequential consumer closes this private iterator when the body stops.
    yield i++;
  }
}

export { asyncEach, asyncAll, fromIterator, createLoopBindings, poisonLoopEffects, iterate, whileIterator };

