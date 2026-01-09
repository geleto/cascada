'use strict';

var lib = require('../lib');
const errors = require('./errors');
const sequential = require('./sequential');
const lookup = require('./lookup');
const call = require('./call');
const frame = require('./frame');
const resolve = require('./resolve');
const buffer = require('./buffer');
const guard = require('./guard');
const loop = require('./loop');
const outputValue = require('./safe-output');

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

module.exports = {
  makeMacro,
  makeKeywordArgs,
  numArgs,
  suppressValue: outputValue.suppressValue,
  suppressValueAsync: outputValue.suppressValueAsync,
  suppressValueScript: outputValue.suppressValueScript,
  suppressValueScriptAsync: outputValue.suppressValueScriptAsync,
  ensureDefined: outputValue.ensureDefined,
  ensureDefinedAsync: outputValue.ensureDefinedAsync,
  promisify,
  withPath,
  SafeString: outputValue.SafeString,
  newSafeStringAsync: outputValue.newSafeStringAsync,
  copySafeness: outputValue.copySafeness,
  markSafe: outputValue.markSafe,

  // Frame classes
  Frame: frame.Frame,
  AsyncFrame: frame.AsyncFrame,

  AsyncState: require('./async-state').AsyncState,

  // Poison value infrastructure
  PoisonedValue: errors.PoisonedValue,
  PoisonError: errors.PoisonError,
  RuntimeError: errors.RuntimeError,
  createPoison: errors.createPoison,
  isPoison: errors.isPoison,
  isPoisonError: errors.isPoisonError,
  collectErrors: errors.collectErrors,
  isError: errors.isError,
  peekError: errors.peekError,

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
  markBufferReverted: buffer.markBufferReverted,
  revertBufferHandlers: buffer.revertBufferHandlers,
  getPosonedBufferErrors: buffer.getPosonedBufferErrors,
  markBufferHasRevert: buffer.markBufferHasRevert,

  guard,


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

  sequentialContextLookup: sequential.sequentialContextLookup,
  sequentialMemberLookupScriptAsync: sequential.sequentialMemberLookupScriptAsync,
  sequentialMemberLookupAsync: sequential.sequentialMemberLookupAsync,
};
