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
const inheritanceState = require('./inheritance-state');
const inheritanceBootstrap = require('./inheritance-bootstrap');
const inheritanceCall = require('./inheritance-call');
const componentRuntime = require('./component');

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

function validateExternInputs(externSpec, providedInputNames, availableValueNames, operationName = 'include') {
  const spec = Array.isArray(externSpec) ? externSpec : [];
  const providedNames = Array.isArray(providedInputNames) ? providedInputNames : [];
  const availableNames = new Set(Array.isArray(availableValueNames) ? availableValueNames : providedNames);
  const declaredNames = new Set();

  for (let i = 0; i < spec.length; i++) {
    const entry = spec[i];
    const names = entry && Array.isArray(entry.names) ? entry.names : [];
    for (let j = 0; j < names.length; j++) {
      declaredNames.add(names[j]);
    }
  }

  for (let i = 0; i < providedNames.length; i++) {
    const name = providedNames[i];
    if (!declaredNames.has(name)) {
      throw new Error(`${operationName} passed '${name}' but the child template does not declare it as extern`);
    }
  }

  for (let i = 0; i < spec.length; i++) {
    const entry = spec[i];
    if (!entry || !entry.required) {
      continue;
    }
    const names = Array.isArray(entry.names) ? entry.names : [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      if (!availableNames.has(name)) {
        throw new Error(`${operationName} is missing required extern '${name}'`);
      }
    }
  }
}

function validateIsolatedExternSpec(externSpec, operationName = 'import') {
  validateExternInputs(externSpec, [], [], operationName);
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
  ensureDefined: outputValue.ensureDefined,
  ensureDefinedAsync: outputValue.ensureDefinedAsync,
  promisify,
  withPath,
  validateExternInputs,
  validateIsolatedExternSpec,
  validateSharedInputs: inheritanceBootstrap.validateSharedInputs,
  preloadSharedInputs: inheritanceBootstrap.preloadSharedInputs,
  ensureSharedSchemaChannels: inheritanceBootstrap.ensureSharedSchemaChannels,
  bootstrapInheritanceMetadata: inheritanceBootstrap.bootstrapInheritanceMetadata,
  ensureCurrentBufferSharedLinks: inheritanceBootstrap.ensureCurrentBufferSharedLinks,
  beginInheritanceResolution: inheritanceBootstrap.beginInheritanceResolution,
  awaitInheritanceResolution: inheritanceBootstrap.awaitInheritanceResolution,
  deferUntilInheritanceResolution: inheritanceBootstrap.deferUntilInheritanceResolution,
  finishInheritanceResolution: inheritanceBootstrap.finishInheritanceResolution,
  getRegisteredAsyncBlock: inheritanceBootstrap.getRegisteredAsyncBlock,
  bridgeDynamicParentTemplate: inheritanceBootstrap.bridgeDynamicParentTemplate,
  renderDynamicTopLevelBlock: inheritanceBootstrap.renderDynamicTopLevelBlock,
  resolveDynamicParentTemplate: inheritanceBootstrap.resolveDynamicParentTemplate,
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
  declareBufferChannel: output.declareBufferChannel,
  declareSharedBufferChannel: output.declareSharedBufferChannel,
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

  CommandBuffer: buffer.CommandBuffer,
  createCommandBuffer: buffer.createCommandBuffer,
  createInheritanceState: inheritanceState.createInheritanceState,
  createComponentInstance: componentRuntime.createComponentInstance,
  InheritanceAdmissionCommand: inheritanceCall.InheritanceAdmissionCommand,
  ComponentOperationCommand: componentRuntime.ComponentOperationCommand,

  guard,


  memberLookup: lookup.memberLookup,
  memberLookupAsync: lookup.memberLookupAsync,
  memberLookupScript: lookup.memberLookupScript,
  channelLookup: lookup.channelLookup,
  contextOrChannelLookup: lookup.contextOrChannelLookup,
  captureCompositionValue: lookup.captureCompositionValue,
  contextOrScriptChannelLookup: lookup.contextOrScriptChannelLookup,
  captureCompositionScriptValue: lookup.captureCompositionScriptValue,

  isArray: lib.isArray,
  keys: lib.keys,
  inOperator: lib.inOperator,

  invokeCallable: call.invokeCallable,
  invokeCallableAsync: call.invokeCallableAsync,
  admitConstructorEntry: inheritanceCall.admitConstructorEntry,
  startParentConstructor: inheritanceCall.startParentConstructor,
  callInheritedMethod: inheritanceCall.callInheritedMethod,
  callSuperMethod: inheritanceCall.callSuperMethod,
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
  sequentialContextLookupScriptValue: sequential.sequentialContextLookupScriptValue,
  sequentialMemberLookupScriptValue: sequential.sequentialMemberLookupScriptValue,
  sequentialMemberLookupAsyncValue: sequential.sequentialMemberLookupAsyncValue,
  setPath: require('./set-path').setPath,
  whileIterator: loop.whileIterator
};
