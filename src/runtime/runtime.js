'use strict';

import lib from '../lib.js';
import errors from './errors.js';
import sequential from './sequential.js';
import lookup from './lookup.js';
import call from './call.js';
import frame from './frame.js';
import {
  Channel,
  DataChannel,
  TextChannel,
  VarChannel,
  SequentialPathChannel,
  createChannel,
  SequenceChannel,
  createSequenceChannel,
  declareBufferChannel
} from './channels/index.js';
import resolve from './resolve.js';
import buffer from './command-buffer.js';
import guard from './guard.js';
import loop from './loop.js';
import outputValue from './safe-output.js';
import {ChannelCommand} from './channels/command-base.js';
import {TextCommand} from './channels/text.js';
import {VarCommand} from './channels/var.js';
import {WaitResolveCommand, WaitCurrentCommand} from './channels/timing.js';
import {
  SnapshotCommand,
  RawSnapshotCommand,
  ReturnIsUnsetCommand,
  IsErrorCommand,
  GetErrorCommand,
  RestoreGuardStateCommand
} from './channels/observation.js';
import {DataCommand} from './channels/data.js';
import {SequenceCallCommand, SequenceGetCommand} from './channels/sequence.js';
import {
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand
} from './channels/sequential-path.js';
import {ErrorCommand, TargetPoisonCommand} from './channels/error.js';
const commands = {
  ChannelCommand,
  TextCommand,
  VarCommand,
  WaitResolveCommand,
  WaitCurrentCommand,
  SnapshotCommand,
  RawSnapshotCommand,
  ReturnIsUnsetCommand,
  IsErrorCommand,
  GetErrorCommand,
  RestoreGuardStateCommand,
  DataCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand,
  ErrorCommand,
  TargetPoisonCommand
};
import asyncBoundaries from './async-boundaries.js';
import markers from './markers.js';
import inheritanceState from './inheritance-state.js';
import inheritanceSharedChannels from './inheritance-shared-channels.js';
import inheritanceBootstrap from './inheritance-bootstrap.js';
import inheritanceCall from './inheritance-call.js';
import componentRuntime from './component.js';
import compositionPayload from './composition-payload.js';
import {setPath} from './set-path.js';

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

function declareCompositionPayloadChannels(commandBuffer, context, skipNames = null) {
  const payloadContext = context.getCompositionPayloadVariables();
  if (!payloadContext) {
    return;
  }

  Object.keys(payloadContext).forEach((name) => {
    if (skipNames?.[name] || commandBuffer._channelTypes?.[name]) {
      return;
    }
    declareBufferChannel(commandBuffer, name, 'var', context, null);
    commandBuffer.add(new commands.VarCommand({ channelName: name, args: [payloadContext[name]] }), name);
  });
}

const runtimeApi = {
  makeMacro,
  invokeMacro,
  makeKeywordArgs,
  numArgs,
  suppressValue: outputValue.suppressValue,
  suppressValueAsync: outputValue.suppressValueAsync,
  suppressValueScript: outputValue.suppressValueScript,
  materializeTemplateTextValue: outputValue.materializeTemplateTextValue,
  ensureDefined: outputValue.ensureDefined,
  ensureDefinedAsync: outputValue.ensureDefinedAsync,
  promisify,
  withPath,
  declareCompositionPayloadChannels,
  createCompositionPayload: compositionPayload.createCompositionPayload,
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
  markChannelBufferScope: frame.markChannelBufferScope,
  Channel,
  DataChannel,
  TextChannel,
  VarChannel,
  SequentialPathChannel,
  createChannel,
  SequenceChannel,
  createSequenceChannel,
  declareBufferChannel,
  declareInheritanceSharedChannel: inheritanceSharedChannels.declareInheritanceSharedChannel,
  claimInheritanceSharedDefault: inheritanceSharedChannels.claimInheritanceSharedDefault,
  initializeInheritanceSharedChannelDefault: inheritanceSharedChannels.initializeInheritanceSharedChannelDefault,
  getInheritanceSharedBuffer: inheritanceBootstrap.getInheritanceSharedBuffer,
  startComponentInstance: componentRuntime.startComponentInstance,
  callComponentMethod: componentRuntime.callComponentMethod,
  observeComponentChannel: componentRuntime.observeComponentChannel,
  ChannelCommand: commands.ChannelCommand,
  TextCommand: commands.TextCommand,
  VarCommand: commands.VarCommand,
  WaitResolveCommand: commands.WaitResolveCommand,
  WaitCurrentCommand: commands.WaitCurrentCommand,
  DataCommand: commands.DataCommand,
  SequenceCallCommand: commands.SequenceCallCommand,
  SequenceGetCommand: commands.SequenceGetCommand,
  SequentialPathReadCommand: commands.SequentialPathReadCommand,
  RepairReadCommand: commands.RepairReadCommand,
  SequentialPathWriteCommand: commands.SequentialPathWriteCommand,
  RepairWriteCommand: commands.RepairWriteCommand,
  ErrorCommand: commands.ErrorCommand,
  TargetPoisonCommand: commands.TargetPoisonCommand,
  SnapshotCommand: commands.SnapshotCommand,
  RawSnapshotCommand: commands.RawSnapshotCommand,
  ReturnIsUnsetCommand: commands.ReturnIsUnsetCommand,
  IsErrorCommand: commands.IsErrorCommand,
  GetErrorCommand: commands.GetErrorCommand,
  RestoreGuardStateCommand: commands.RestoreGuardStateCommand,


  // Poison value infrastructure
  PoisonedValue: errors.PoisonedValue,
  PoisonError: errors.PoisonError,
  RuntimeError: errors.RuntimeError,
  RuntimeFatalError: errors.RuntimeFatalError,
  createPoison: errors.createPoison,
  isPoison: errors.isPoison,
  isPoisonError: errors.isPoisonError,
  isRuntimeFatalError: errors.isRuntimeFatalError,
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

  CommandBuffer: buffer.CommandBuffer,
  createCommandBuffer: buffer.createCommandBuffer,
  createInheritanceState: inheritanceState.createInheritanceState,
  setInheritanceStartupPromise: inheritanceState.setInheritanceStartupPromise,
  bootstrapInheritanceMetadata: inheritanceBootstrap.bootstrapInheritanceMetadata,
  bootstrapInheritanceParentScript: inheritanceBootstrap.bootstrapInheritanceParentScript,
  renderInheritanceParentRoot: inheritanceBootstrap.renderInheritanceParentRoot,
  runCompiledRootStartup: inheritanceBootstrap.runCompiledRootStartup,
  linkCurrentBufferToParentChannels: inheritanceBootstrap.linkCurrentBufferToParentChannels,
  finalizeInheritanceMetadata: inheritanceBootstrap.finalizeInheritanceMetadata,
  getCallableBodyLinkedChannels: inheritanceCall.getCallableBodyLinkedChannels,
  invokeInheritedMethod: inheritanceCall.invokeInheritedMethod,
  invokeSuperMethod: inheritanceCall.invokeSuperMethod,

  guard,


  memberLookup: lookup.memberLookup,
  memberLookupAsync: lookup.memberLookupAsync,
  memberLookupScript: lookup.memberLookupScript,
  observeInheritanceSharedChannel: lookup.observeInheritanceSharedChannel,
  channelLookup: lookup.channelLookup,

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
  createLoopBindings: loop.createLoopBindings,
  setLoopValueBindings: loop.setLoopValueBindings,

  sequentialContextLookupValue: sequential.sequentialContextLookupValue,
  sequentialMemberLookupScriptValue: sequential.sequentialMemberLookupScriptValue,
  sequentialMemberLookupAsyncValue: sequential.sequentialMemberLookupAsyncValue,
  setPath,
  whileIterator: loop.whileIterator
};

export default runtimeApi;
