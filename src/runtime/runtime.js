'use strict';

var lib = require('../lib');
const errors = require('./errors');
const sequential = require('./sequential');
const lookup = require('./lookup');
const call = require('./call');
const frame = require('./frame');
const output = require('./output');
const resolve = require('./resolve');
const buffer = require('./command-buffer');
const guard = require('./guard');
const loop = require('./loop');
const outputValue = require('./safe-output');
const commands = require('./commands');

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

/**
 * Link a composed child buffer into selected parent handler lanes.
 *
 * The compiler provides a conservative handler candidate list; this helper
 * performs a runtime intersection against `presenceMap` (typically child `_outputs`)
 * to avoid linking lanes that do not exist for the child.
 */
function linkWithParentCompositionBuffer(parentBuffer, childBuffer, handlers, presenceMap) {
  if (!parentBuffer || !childBuffer || !Array.isArray(handlers) || handlers.length === 0) {
    return;
  }
  if (!(presenceMap instanceof Map)) {
    return;
  }
  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i];
    if (presenceMap.has(handler)) {
      parentBuffer.addBuffer(childBuffer, handler);
    }
  }
}

module.exports = {
  makeMacro,
  makeKeywordArgs,
  numArgs,
  suppressValue: outputValue.suppressValue,
  suppressValueAsync: outputValue.suppressValueAsync,
  suppressValueScript: outputValue.suppressValueScript,
  materializeTemplateTextValue: outputValue.materializeTemplateTextValue,
  suppressValueScriptAsync: outputValue.suppressValueScriptAsync,
  ensureDefined: outputValue.ensureDefined,
  ensureDefinedAsync: outputValue.ensureDefinedAsync,
  promisify,
  withPath,
  linkWithParentCompositionBuffer,
  SafeString: outputValue.SafeString,
  copySafeness: outputValue.copySafeness,
  markSafe: outputValue.markSafe,

  // Frame classes
  Frame: frame.Frame,
  AsyncFrame: frame.AsyncFrame,
  Output: output.Output,
  DataOutput: output.DataOutput,
  TextOutput: output.TextOutput,
  ValueOutput: output.ValueOutput,
  SequentialPathOutput: output.SequentialPathOutput,
  createOutput: output.createOutput,
  SinkOutput: output.SinkOutput,
  createSinkOutput: output.createSinkOutput,
  SequenceOutput: output.SequenceOutput,
  createSequenceOutput: output.createSequenceOutput,
  getOutput: output.getOutput,
  declareOutput: output.declareOutput,
  OutputCommand: commands.OutputCommand,
  TextCommand: commands.TextCommand,
  ValueCommand: commands.ValueCommand,
  WaitResolveCommand: commands.WaitResolveCommand,
  DataCommand: commands.DataCommand,
  SinkCommand: commands.SinkCommand,
  SequenceCallCommand: commands.SequenceCallCommand,
  SequenceGetCommand: commands.SequenceGetCommand,
  SequentialPathReadCommand: commands.SequentialPathReadCommand,
  RepairReadCommand: commands.RepairReadCommand,
  SequentialPathWriteCommand: commands.SequentialPathWriteCommand,
  RepairWriteCommand: commands.RepairWriteCommand,
  ErrorCommand: commands.ErrorCommand,
  TargetPoisonCommand: commands.TargetPoisonCommand,
  SnapshotCommand: commands.SnapshotCommand,
  IsErrorCommand: commands.IsErrorCommand,
  GetErrorCommand: commands.GetErrorCommand,
  SinkRepairCommand: commands.SinkRepairCommand,
  RestoreGuardStateCommand: commands.RestoreGuardStateCommand,

  AsyncState: require('./async-state').AsyncState,

  // Poison value infrastructure
  PoisonedValue: errors.PoisonedValue,
  PoisonError: errors.PoisonError,
  RuntimeError: errors.RuntimeError,
  RuntimeFatalError: errors.RuntimeFatalError,
  createPoison: errors.createPoison,
  isPoison: errors.isPoison,
  isPoisonError: errors.isPoisonError,
  collectErrors: errors.collectErrors,
  isError: errors.isError,
  peekError: errors.peekError,
  mergeErrors: errors.mergeErrors,

  resolveAll: resolve.resolveAll,
  resolveDuo: resolve.resolveDuo,
  resolveSingle: resolve.resolveSingle,
  resolveSingleArr: resolve.resolveSingleArr,
  resolveObjectProperties: resolve.resolveObjectProperties,
  resolveArguments: resolve.resolveArguments,

  createObject: resolve.createObject,
  createArray: resolve.createArray,

  finalizeUnobservedSinks: output.finalizeUnobservedSinks,
  CommandBuffer: buffer.CommandBuffer,
  createCommandBuffer: buffer.createCommandBuffer,

  guard,


  memberLookup: lookup.memberLookup,
  memberLookupAsync: lookup.memberLookupAsync,
  memberLookupScript: lookup.memberLookupScript,
  memberLookupScriptAsync: lookup.memberLookupScriptAsync,
  varOutputLookup: lookup.varOutputLookup,
  contextOrFrameLookup: lookup.contextOrFrameLookup,
  contextOrVarLookup: lookup.contextOrVarLookup,
  contextOrVarLookupScript: lookup.contextOrVarLookupScript,
  contextOrVarLookupScriptAsync: lookup.contextOrVarLookupScriptAsync,

  isArray: lib.isArray,
  keys: lib.keys,
  inOperator: lib.inOperator,

  callWrap: call.callWrap,
  callWrapAsync: call.callWrapAsync,
  callWrapAsyncForCommandArg: call.callWrapAsyncForCommandArg,
  sequentialCallWrapValue: sequential.sequentialCallWrapValue,
  handleError: errors.handleError,

  iterate: loop.iterate,
  asyncEach: loop.asyncEach,
  asyncAll: loop.asyncAll,
  fromIterator: loop.fromIterator,
  iterateAsyncSequential: loop.iterateAsyncSequential,
  iterateAsyncParallel: loop.iterateAsyncParallel,
  whileConditionIterator: loop.whileConditionIterator,
  setLoopBindings: loop.setLoopBindings,
  createLoopBindings: loop.createLoopBindings,
  setLoopValueBindings: loop.setLoopValueBindings,

  sequentialContextLookupValue: sequential.sequentialContextLookupValue,
  sequentialContextLookupScriptValue: sequential.sequentialContextLookupScriptValue,
  sequentialMemberLookupScriptAsyncValue: sequential.sequentialMemberLookupScriptAsyncValue,
  sequentialMemberLookupAsyncValue: sequential.sequentialMemberLookupAsyncValue,
  setPath: require('./set-path').setPath,
  STOP_WHILE: loop.STOP_WHILE,
  whileIterator: loop.whileIterator
};
