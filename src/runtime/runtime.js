'use strict';

var lib = require('../lib');
const errors = require('./errors');
const sequential = require('./sequential');
const lookup = require('./lookup');
const call = require('./call');
const frame = require('./frame');
const output = require('./channel');
const resolve = require('./resolve');
const buffer = require('./command-buffer');
const guard = require('./guard');
const loop = require('./loop');
const outputValue = require('./safe-output');
const commands = require('./commands');
const asyncBoundaries = require('./async-boundaries');
const markers = require('./markers');

function makeMacro(argNames, kwargNames, func, useAsyncMacroSignature = false) {
  const invokeCompiledMacro = function invokeCompiledMacro(executionContext, macroArgs, currentBuffer = null) {
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
      if (useAsyncMacroSignature && Object.keys(kwargs).length === 0) {
        args.push({});//kwargs
      }
    }

    if (useAsyncMacroSignature) {
      args.push(currentBuffer);
    }
    return func.apply(executionContext, args);
  };

  const macro = function macro(...macroArgs) {
    return invokeCompiledMacro(this, macroArgs, null);
  };
  macro.isMacro = true;
  macro._invoke = invokeCompiledMacro;
  return macro;
}

function invokeMacro(macro, executionContext, args, currentBuffer = null) {
  if (macro && typeof macro._invoke === 'function') {
    return macro._invoke(executionContext, args, currentBuffer);
  }
  return macro.apply(executionContext, args);
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
 * Link a composed child buffer into selected parent channel lanes.
 *
 * The compiler provides a conservative channel candidate list; this helper
 * performs a runtime intersection against `presenceMap` (typically child `_channels`)
 * to avoid linking lanes that do not exist for the child.
 */
function linkWithParentCompositionBuffer(parentBuffer, childBuffer, channelNames, presenceMap) {
  if (!parentBuffer || !childBuffer || !Array.isArray(channelNames) || channelNames.length === 0) {
    return;
  }
  if (!(presenceMap instanceof Map)) {
    return;
  }
  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
    const resolvedChannelName = childBuffer._resolveChannelName(channelName);
    if (presenceMap.has(resolvedChannelName)) {
      parentBuffer.addBuffer(childBuffer, resolvedChannelName);
    }
  }
}

module.exports = {
  makeMacro,
  invokeMacro,
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
  runControlFlowBoundary: asyncBoundaries.runControlFlowBoundary,
  runWaitedControlFlowBoundary: asyncBoundaries.runWaitedControlFlowBoundary,
  runRenderBoundary: asyncBoundaries.runRenderBoundary,
  runValueBoundary: asyncBoundaries.runValueBoundary,
  RETURN_UNSET: markers.RETURN_UNSET,
  SafeString: outputValue.SafeString,
  copySafeness: outputValue.copySafeness,
  markSafe: outputValue.markSafe,

  // Frame classes
  Frame: frame.Frame,
  AsyncFrame: frame.AsyncFrame,
  Channel: output.Channel,
  DataChannel: output.DataChannel,
  TextChannel: output.TextChannel,
  VarChannel: output.VarChannel,
  SequentialPathChannel: output.SequentialPathChannel,
  createChannel: output.createChannel,
  SinkChannel: output.SinkChannel,
  createSinkChannel: output.createSinkChannel,
  SequenceChannel: output.SequenceChannel,
  createSequenceChannel: output.createSequenceChannel,
  getChannel: output.getChannel,
  declareChannel: output.declareChannel,
  ChannelCommand: commands.ChannelCommand,
  TextCommand: commands.TextCommand,
  VarCommand: commands.VarCommand,
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

  resolveAll: resolve.resolveAll,
  resolveDuo: resolve.resolveDuo,
  resolveSingle: resolve.resolveSingle,
  resolveSingleArr: resolve.resolveSingleArr,
  resolveObjectProperties: resolve.resolveObjectProperties,
  resolveArguments: resolve.resolveArguments,
  normalizeFinalPromise: resolve.normalizeFinalPromise,
  RESOLVE_MARKER: markers.RESOLVE_MARKER,
  RESOLVED_VALUE_MARKER: markers.RESOLVED_VALUE_MARKER,

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
  varChannelLookup: lookup.varChannelLookup,
  contextOrFrameLookup: lookup.contextOrFrameLookup,
  contextOrVarLookup: lookup.contextOrVarLookup,
  contextOrVarLookupScript: lookup.contextOrVarLookupScript,
  contextOrVarLookupScriptAsync: lookup.contextOrVarLookupScriptAsync,

  isArray: lib.isArray,
  keys: lib.keys,
  inOperator: lib.inOperator,

  callWrap: call.callWrap,
  callWrapAsync: call.callWrapAsync,
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
  whileIterator: loop.whileIterator
};
