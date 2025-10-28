'use strict';

var lib = require('../lib');
const errors = require('./errors');
const sequential = require('./sequential');
const lookup = require('./lookup');
const call = require('./call');
const frame = require('./frame');
const resolve = require('./resolve');
const buffer = require('./buffer');
const loop = require('./loop');

function makeMacro(argNames, kwargNames, func, astate) {
  const macro = function macro(...macroArgs) {
    var argCount = numArgs(macroArgs);
    var args;
    var kwargs = getKeywordArgs(macroArgs);

    if (argCount > argNames.length) {
      args = macroArgs.slice(0, argNames.length);

      // Positional arguments that should be passed in as
      // keyword arguments (essentially default values)
      macroArgs.slice(args.length, argCount).forEach((val, i) => {
        if (i < kwargNames.length) {
          kwargs[kwargNames[i]] = val;
        }
      });
      args.push(kwargs);
    } else if (argCount < argNames.length) {
      args = macroArgs.slice(0, argCount);

      for (let i = argCount; i < argNames.length; i++) {
        const arg = argNames[i];

        // Keyword arguments that should be passed as
        // positional arguments, i.e. the caller explicitly
        // used the name of a positional arg
        args.push(kwargs[arg]);
        delete kwargs[arg];
      }
      args.push(kwargs);
    } else {
      args = macroArgs;
      if (astate && Object.keys(kwargs).length === 0) {
        args.push({});//kwargs
      }
    }

    if (astate) {
      args.push(astate.new());
    }
    return func.apply(this, args);
  };
  macro.isMacro = true;
  return macro;
}

function withPath(context, path, func) {
  const executionContext = (path && context.path !== path) ? context.forkForPath(path) : context;
  return func.call(executionContext);
}

function makeKeywordArgs(obj) {
  obj.__keywords = true;
  return obj;
}

function isKeywordArgs(obj) {
  return obj && Object.prototype.hasOwnProperty.call(obj, '__keywords');
}

function getKeywordArgs(args) {
  var len = args.length;
  if (len) {
    const lastArg = args[len - 1];
    if (isKeywordArgs(lastArg)) {
      return lastArg;
    }
  }
  return {};
}

function numArgs(args) {
  var len = args.length;
  if (len === 0) {
    return 0;
  }

  const lastArg = args[len - 1];
  if (isKeywordArgs(lastArg)) {
    return len - 1;
  } else {
    return len;
  }
}

// A SafeString object indicates that the string should not be
// autoescaped. This happens magically because autoescaping only
// occurs on primitive string objects.
function SafeString(val) {
  if (typeof val !== 'string') {
    return val;
  }

  this.val = val;
  this.length = val.length;
}

function newSafeStringAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return new SafeString(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return new SafeString(await v, lineno, colno);
    })(val);
  }
  return new SafeString(val, lineno, colno);
}

SafeString.prototype = Object.create(String.prototype, {
  length: {
    writable: true,
    configurable: true,
    value: 0
  }
});
SafeString.prototype.valueOf = function valueOf() {
  return this.val;
};
SafeString.prototype.toString = function toString() {
  return this.val;
};

function copySafeness(dest, target) {
  if (dest instanceof SafeString) {
    return new SafeString(target);
  }
  return target.toString();
}

function markSafe(val) {
  var type = typeof val;

  if (type === 'string') {
    return new SafeString(val);
  } else if (type !== 'function') {
    return val;
  } else if (type === 'object' && val.then && typeof val.then === 'function') {
    return (async (v) => {
      return markSafe(await v);
    })(val);
  }
  else {
    return function wrapSafe(args) {
      var ret = val.apply(this, arguments);

      if (typeof ret === 'string') {
        return new SafeString(ret);
      }

      return ret;
    };
  }
}

function suppressValue(val, autoescape) {
  val = (val !== undefined && val !== null) ? val : '';

  if (autoescape && !(val instanceof SafeString)) {
    val = lib.escape(val.toString());
  }

  return val;
}

function suppressValueAsync(val, autoescape, errorContext) {
  // Poison check - return rejected promise synchronously
  if (errors.isPoison(val)) {
    return val;
  }

  // Simple literal value (not array, not promise) - return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Arrays without promises - handle synchronously
  if (Array.isArray(val)) {
    const hasPoison = val.some(errors.isPoison);
    const hasPromises = val.some(item => item && typeof item.then === 'function');

    // If array has no promises and no poison, handle synchronously
    if (!hasPromises && !hasPoison) {
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }

    // Has promises or poison - delegate to async helper
    return _suppressValueAsyncComplex(val, autoescape, errorContext);
  }

  // Promise - delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape, errorContext);
}

async function _suppressValueAsyncComplex(val, autoescape, errorContext) {
  // Handle promise values
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      if (errors.isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new errors.PoisonError([contextualError]);
      }
    }

    // Check if resolved to poison
    if (errors.isPoison(val)) {
      throw new errors.PoisonError(val.errors);
    }
  }

  // Handle arrays
  if (Array.isArray(val)) {
    // Collect errors from all items (deterministic)
    const collectedErrors = await errors.collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new errors.PoisonError(collectedErrors);
    }

    const hasPromises = val.some(item => item && typeof item.then === 'function');

    if (hasPromises) {
      try {
        let resolvedArray = await resolve.deepResolveArray(val);

        if (resolvedArray.length > 0) {
          resolvedArray = [resolvedArray.join(',')];
        }
        if (autoescape) {
          resolvedArray.push((value) => suppressValue(value, true));
        }
        return resolvedArray;
      } catch (err) {
        if (errors.isPoisonError(err)) {
          throw err;
        } else {
          const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
          throw new errors.PoisonError([contextualError]);
        }
      }
    } else {
      // No promises in array
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }
  }

  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno, context) {
  if (val === null || val === undefined) {
    const err = errors.handleError(
      new Error('attempted to output null or undefined value'),
      lineno + 1,
      colno + 1,
      null,
      context ? context.path : null
    );
    throw err;
  }
  return val;
}

//@todo - remove lineno, colno
function ensureDefinedAsync(val, lineno, colno, context, errorContext) {
  // Poison check - return rejected promise synchronously
  if (errors.isPoison(val)) {
    return val;
  }

  // Simple literal value - validate and return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return ensureDefined(val, lineno, colno, context);
  }

  // Complex cases - delegate to async helper
  return _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext);
}

//@todo - remove lineno, colno
async function _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext) {
  // Handle arrays with possible poison values
  if (Array.isArray(val)) {
    const collectedErrors = await errors.collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new errors.PoisonError(collectedErrors);
    }

    // Append validation function
    val.push((v) => ensureDefined(v, lineno, colno, context));
    return val;
  }

  // Handle promises
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      if (errors.isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new errors.PoisonError([contextualError]);
      }
    }

    if (errors.isPoison(val)) {
      throw new errors.PoisonError(val.errors);
    }
  }

  return ensureDefined(val, lineno, colno, context);
}

function promisify(fn) {
  return function (...args) {
    return new Promise((resolvePromise, reject) => {
      const callback = (error, ...results) => {
        if (error) {
          reject(error);
        } else {
          resolvePromise(results.length === 1 ? results[0] : results);
        }
      };

      fn(...args, callback);
    });
  };
}

class AsyncState {
  constructor(parent = null) {
    this.activeClosures = 0;
    this.waitClosuresCount = 0;
    this.parent = parent;
    this.completionPromise = null;
    this.completionResolver = null;
    this.asyncBlockFrame = null;//@todo - remove
  }

  enterAsyncBlock(asyncBlockFrame) {
    const newState = new AsyncState(this);
    newState.asyncBlockFrame = asyncBlockFrame || null;
    newState._incrementClosures();

    // Create a new completion promise for this specific closure chain
    /*this.waitAllClosures().then(() => {
      asyncBlockFrame.dispose();// - todo - why does it succeed and then fail?
    });*/

    return newState;
  }

  leaveAsyncBlock() {
    this.activeClosures--;

    if (this.activeClosures === this.waitClosuresCount) {
      if (this.completionResolver) {
        this.completionResolver();
        // Reset both promise and resolver
        this.completionPromise = null;
        this.completionResolver = null;
      }
    } else if (this.activeClosures < 0) {
      throw new Error('Negative activeClosures count detected');
    }

    if (this.parent) {
      return this.parent.leaveAsyncBlock();
    }

    return this.parent;
  }

  asyncBlock(func, runtime, f, readVars, writeCounts, cb, lineno, colno, context, errorContextString = null) {
    const childFrame = f.pushAsyncBlock(readVars, writeCounts);
    const childState = this.enterAsyncBlock(childFrame);

    try {
      // 1. Invoke the async function to get the promise.
      const promise = func(childState, childFrame);

      promise.finally(() => {
        childState.leaveAsyncBlock();
      });

      return promise;
    } catch (syncError) {
      // This catches synchronous errors that might happen before the promise is even created.
      // This can happen mostly due to compiler error, may remove it in the future
      const handledError = runtime.handleError(syncError, lineno, colno, errorContextString, context ? context.path : null);
      cb(handledError);
      childState.leaveAsyncBlock();// Ensure cleanup even on sync failure.
    }
  }

  _incrementClosures() {
    this.activeClosures++;
    if (this.parent) {
      this.parent._incrementClosures();
    }
  }

  // can use only one closureCount value at a time
  async waitAllClosures(closureCount = 0) {
    this.waitClosuresCount = closureCount;
    if (this.activeClosures === closureCount) {
      return Promise.resolve();
    }

    // Reuse existing promise if it exists
    if (this.completionPromise) {
      return this.completionPromise;
    }

    // Create new promise and store it
    this.completionPromise = new Promise(resolvePromise => {
      this.completionResolver = resolvePromise;
    });

    return this.completionPromise;
  }

  new() {
    return new AsyncState();
  }
}


module.exports = {
  AsyncState,
  makeMacro,
  makeKeywordArgs,
  numArgs,
  suppressValue,
  suppressValueAsync,
  ensureDefined,
  ensureDefinedAsync,
  promisify,
  withPath,
  SafeString,
  newSafeStringAsync,
  copySafeness,
  markSafe,

  // Frame classes
  Frame: frame.Frame,
  AsyncFrame: frame.AsyncFrame,

  // Poison value infrastructure
  PoisonedValue: errors.PoisonedValue,
  PoisonError: errors.PoisonError,
  RuntimeError: errors.RuntimeError,
  createPoison: errors.createPoison,
  isPoison: errors.isPoison,
  isPoisonError: errors.isPoisonError,
  collectErrors: errors.collectErrors,

  resolveAll: resolve.resolveAll,
  resolveDuo: resolve.resolveDuo,
  resolveSingle: resolve.resolveSingle,
  resolveSingleArr: resolve.resolveSingleArr,
  resolveObjectProperties: resolve.resolveObjectProperties,
  resolveArguments: resolve.resolveArguments,
  deepResolveArray: resolve.deepResolveArray,
  deepResolveObject: resolve.deepResolveObject,

  flattenBuffer: buffer.flattenBuffer,
  addPoisonMarkersToBuffer: buffer.addPoisonMarkersToBuffer,

  memberLookup: lookup.memberLookup,
  memberLookupAsync: lookup.memberLookupAsync,
  memberLookupScript: lookup.memberLookupScript,
  memberLookupScriptAsync: lookup.memberLookupScriptAsync,
  contextOrFrameLookup: lookup.contextOrFrameLookup,
  contextOrFrameLookupScript: lookup.contextOrFrameLookupScript,
  contextOrFrameLookupScriptAsync: lookup.contextOrFrameLookupScriptAsync,

  isArray: lib.isArray,
  keys: lib.keys,
  inOperator: lib.inOperator,

  callWrap: call.callWrap,
  callWrapAsync: call.callWrapAsync,
  sequentialCallWrap: sequential.sequentialCallWrap,
  handleError: errors.handleError,

  iterate: loop.iterate,
  asyncEach: loop.asyncEach,
  asyncAll: loop.asyncAll,
  fromIterator: loop.fromIterator,
  iterateAsyncSequential: loop.iterateAsyncSequential,
  iterateAsyncParallel: loop.iterateAsyncParallel,
  whileConditionIterator: loop.whileConditionIterator,
  setLoopBindings: loop.setLoopBindings,

  awaitSequenceLock: sequential.awaitSequenceLock,
  sequentialContextLookup: sequential.sequentialContextLookup,
  sequentialMemberLookupScriptAsync: sequential.sequentialMemberLookupScriptAsync,
  sequentialMemberLookupAsync: sequential.sequentialMemberLookupAsync,
};
