'use strict';

// Inheritance admission and dispatch runtime.
// Owns inherited/super/component call admission, unresolved wait behavior, and
// invocation-buffer linking once a target method entry becomes current.

const {
  createPoison,
  isPoison,
  PoisonError,
  RuntimeFatalError,
  RuntimePromise
} = require('./errors');
const { RESOLVE_MARKER } = require('./resolve');
const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');
const { declareBufferChannel } = require('./channel');
const { Command } = require('./commands');
const inheritanceStateRuntime = require('./inheritance-state');
const inheritanceConstants = require('../inheritance-constants');

const INHERITANCE_ADMISSION_CHANNEL = '__inheritance_admission__';
const { RETURN_CHANNEL_NAME } = inheritanceConstants;

function _hasAsyncMethodArgs(args) {
  return Array.isArray(args) && args.some((arg) =>
    arg &&
    !isPoison(arg) &&
    (typeof arg.then === 'function' || arg[RESOLVE_MARKER])
  );
}

function _validateMethodArgCount(methodEntry, args, name, errorContext) {
  const contract = methodEntry && methodEntry.contract;
  const inputNames = contract && Array.isArray(contract.inputNames) ? contract.inputNames : [];
  if (Array.isArray(args) && args.length > inputNames.length) {
    return createPoison(
      new Error(`Inherited method '${name}' received too many arguments`),
      errorContext.lineno,
      errorContext.colno,
      errorContext.errorContextString,
      errorContext.path
    );
  }
  return null;
}

function _mergePoisonedArgs(args) {
  const poisonedArgs = Array.isArray(args) ? args.filter(isPoison) : [];
  if (poisonedArgs.length === 0) {
    return null;
  }
  if (poisonedArgs.length === 1) {
    return poisonedArgs[0];
  }
  return createPoison(poisonedArgs.flatMap((value) => value.errors));
}

function _contextualizeRuntimeFatalError(err, errorContext) {
  if (!(err instanceof RuntimeFatalError) || !errorContext) {
    return err;
  }
  if (err.lineno !== undefined && err.lineno !== null && err.lineno !== 0) {
    return err;
  }
  const cause = err.cause || err.message;
  return new RuntimeFatalError(
    cause,
    errorContext.lineno,
    errorContext.colno,
    errorContext.errorContextString,
    errorContext.path
  );
}

function _resolveDispatchedValue(value, errorContext) {
  if (isPoison(value) || !value || typeof value.then !== 'function') {
    return { value };
  }
  return Promise.resolve(value).then(
    (resolvedValue) => ({ value: resolvedValue }),
    (err) => {
      if (err instanceof RuntimeFatalError) {
        throw _contextualizeRuntimeFatalError(err, errorContext);
      }
      return {
        value: createPoison(
          err,
          errorContext.lineno,
          errorContext.colno,
          errorContext.errorContextString,
          errorContext.path
        )
      };
    }
  );
}

function _finishInvocationBuffer(invocationBuffer) {
  if (invocationBuffer && typeof invocationBuffer.markFinishedAndPatchLinks === 'function') {
    invocationBuffer.markFinishedAndPatchLinks();
  }
}

function _registerPendingAdmissionBarrier(currentBuffer, barrierBuffer) {
  if (!isCommandBuffer(currentBuffer) || !isCommandBuffer(barrierBuffer)) {
    return false;
  }
  if (typeof currentBuffer.registerPendingSharedAdmissionBarrier !== 'function') {
    return false;
  }
  // While unresolved admission is stalled, newly registered shared lanes must
  // still pick up this barrier before shared-visible apply continues.
  currentBuffer.registerPendingSharedAdmissionBarrier(barrierBuffer);
  return true;
}

function _unregisterPendingAdmissionBarrier(command) {
  if (!command || !command._pendingBarrierTopologyWindow) {
    return;
  }
  if (
    isCommandBuffer(command.currentBuffer) &&
    isCommandBuffer(command.barrierBuffer) &&
    typeof command.currentBuffer.unregisterPendingSharedAdmissionBarrier === 'function'
  ) {
    command.currentBuffer.unregisterPendingSharedAdmissionBarrier(command.barrierBuffer);
  }
  command._pendingBarrierTopologyWindow = false;
}

function _finishAdmissionBuffers(command) {
  if (!command) {
    return;
  }
  _unregisterPendingAdmissionBarrier(command);
  // The invocation child must close before the barrier releases, otherwise the
  // barrier lane could yield upstream before the admitted body has finished
  // publishing its writes.
  _finishInvocationBuffer(command.invocationBuffer);
  if (command.barrierBuffer && command.barrierBuffer !== command.invocationBuffer) {
    _finishInvocationBuffer(command.barrierBuffer);
  }
}

function _invokeMethodEntry(methodEntry, context, inheritanceState, resolvedArgs, env, runtime, cb, invocationBuffer, errorContext, currentPayload = null) {
  const argMap = {};
  const inputNames = methodEntry && methodEntry.contract && Array.isArray(methodEntry.contract.inputNames)
    ? methodEntry.contract.inputNames
    : [];
  for (let i = 0; i < inputNames.length; i++) {
    argMap[inputNames[i]] = resolvedArgs[i];
  }
  const payload = currentPayload
    ? inheritanceStateRuntime.createSuperInheritancePayload(currentPayload, argMap)
    : inheritanceStateRuntime.createInheritancePayload(methodEntry && methodEntry.ownerKey, argMap, null);
  const preparedPayload = inheritanceStateRuntime.prepareInheritancePayloadForBlock(
    inheritanceState,
    methodEntry.fn,
    context && context.path ? context.path : null,
    payload
  );
  const renderCtx = methodEntry && methodEntry.contract && methodEntry.contract.withContext
    ? context.getRenderContextVariables()
    : undefined;
  const result = methodEntry.fn(env, context, runtime, cb, invocationBuffer, inheritanceState, preparedPayload, renderCtx);
  return result && typeof result.then === 'function'
    ? new RuntimePromise(result, errorContext)
    : result;
}

function _resolveMethodEntryForAdmission(resolveEntry, errorContext) {
  try {
    return _resolveDispatchedValue(resolveEntry(), errorContext);
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw _contextualizeRuntimeFatalError(err, errorContext);
    }
    return {
      value: createPoison(
        err,
        errorContext.lineno,
        errorContext.colno,
        errorContext.errorContextString,
        errorContext.path
      )
    };
  }
}

function _computeBarrierLinkedChannels(currentBuffer, inheritanceState, linkedChannels = null) {
  const barrierLinkedChannels = new Set();
  const seedChannels = Array.isArray(linkedChannels)
    ? linkedChannels
    : (
        isCommandBuffer(currentBuffer) &&
        inheritanceState
          ? inheritanceState.shared.getNames()
          : []
      );

  for (let i = 0; i < seedChannels.length; i++) {
    const channelName = seedChannels[i];
    if (!channelName || channelName === RETURN_CHANNEL_NAME) {
      continue;
    }
    if (!Array.isArray(linkedChannels)) {
      if (typeof currentBuffer.isLinkedChannel === 'function' && currentBuffer.isLinkedChannel(channelName)) {
        barrierLinkedChannels.add(channelName);
        continue;
      }
      if (!(typeof currentBuffer.getOwnChannel === 'function' && currentBuffer.getOwnChannel(channelName))) {
        continue;
      }
    }
    barrierLinkedChannels.add(channelName);
  }

  if (barrierLinkedChannels.size === 0) {
    barrierLinkedChannels.add(INHERITANCE_ADMISSION_CHANNEL);
  }
  return Array.from(barrierLinkedChannels);
}

function _ensureAdmissionChannel(buffer, context) {
  if (!buffer || typeof buffer.getOwnChannel !== 'function') {
    return;
  }
  if (!buffer.getOwnChannel(INHERITANCE_ADMISSION_CHANNEL)) {
    declareBufferChannel(buffer, INHERITANCE_ADMISSION_CHANNEL, 'var', context, null);
  }
}

function _createBarrierBuffer(currentBuffer, context, linkedChannels = null) {
  const parentBuffer = isCommandBuffer(currentBuffer) ? currentBuffer : null;
  const barrierLinkedChannels = _computeBarrierLinkedChannels(currentBuffer, null, linkedChannels);
  if (parentBuffer && barrierLinkedChannels.indexOf(INHERITANCE_ADMISSION_CHANNEL) !== -1) {
    _ensureAdmissionChannel(parentBuffer, parentBuffer._context || context);
  }
  // The barrier is the shared-root stall point. It is intentionally separate
  // from the later invocation buffer on unresolved admission.
  const barrierBuffer = createCommandBuffer(
    parentBuffer ? (parentBuffer._context || context) : context,
    parentBuffer,
    barrierLinkedChannels,
    parentBuffer
  );
  _ensureAdmissionChannel(barrierBuffer, context);
  return barrierBuffer;
}

function _createInvocationBuffer(parentBuffer, context, linkedChannels = null) {
  const invocationParent = isCommandBuffer(parentBuffer) ? parentBuffer : null;
  // The invocation buffer runs the admitted body. It shares the same structural
  // parent pattern as the barrier, but it does not own the admission lane.
  return createCommandBuffer(
    invocationParent ? (invocationParent._context || context) : context,
    invocationParent,
    Array.isArray(linkedChannels) && linkedChannels.length > 0 ? linkedChannels : null,
    invocationParent
  );
}

function _canAttachBarrierLane(parentBuffer, childBuffer, channelName) {
  if (!isCommandBuffer(parentBuffer) || !isCommandBuffer(childBuffer) || !channelName) {
    return false;
  }
  const resolvedChannelName = typeof parentBuffer._resolveAliasedChannelName === 'function'
    ? parentBuffer._resolveAliasedChannelName(channelName)
    : channelName;
  if (typeof childBuffer.isLinkedChannel === 'function' && childBuffer.isLinkedChannel(resolvedChannelName)) {
    return false;
  }
  return typeof parentBuffer.canAddChannelBuffer === 'function'
    ? parentBuffer.canAddChannelBuffer(resolvedChannelName)
    : false;
}

function _ensureBufferLinkedChannels(parentBuffer, childBuffer, linkedChannels) {
  if (!Array.isArray(linkedChannels)) {
    return;
  }
  for (let i = 0; i < linkedChannels.length; i++) {
    const channelName = linkedChannels[i];
    if (!_canAttachBarrierLane(parentBuffer, childBuffer, channelName)) {
      continue;
    }
    parentBuffer.addBuffer(childBuffer, channelName);
  }
}

// Real observable command for constructor/inherited-method admission.
//
// Promise contract:
// - `.promise` resolves when the admitted method value is ready for the caller
// - `.completion` resolves when the admission buffer has fully finished
//
// Constructor callers that still need both timings should keep using those two
// explicit command fields rather than recreating a `{ value, completion }`
// wrapper around them.
class InheritanceAdmissionCommand extends Command {
  constructor({
    name,
    resolveMethodEntry,
    args = null,
    context,
    inheritanceState,
    env,
    runtime,
    cb,
    barrierBuffer,
    invocationBuffer,
    errorContext,
    currentPayload = null,
    currentBuffer = null
  }) {
    super({ withDeferredResult: true });
    this.isObservable = true;
    this.name = name;
    this.resolveMethodEntry = resolveMethodEntry;
    this.arguments = Array.isArray(args) ? args : [];
    this.context = context;
    this.inheritanceState = inheritanceState;
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.barrierBuffer = barrierBuffer;
    this.invocationBuffer = invocationBuffer;
    this.currentBuffer = currentBuffer;
    this.errorContext = errorContext || { lineno: 0, colno: 0, errorContextString: null, path: null };
    this.currentPayload = currentPayload;
    // On the deferred path the invocation buffer does not exist yet. Because it
    // is later created as a child of the barrier, the barrier's finish-complete
    // promise still covers the full lifecycle from stall through admitted body.
    const completionBuffer = this.barrierBuffer;
    this.completion = completionBuffer && typeof completionBuffer.getFinishCompletePromise === 'function'
      ? completionBuffer.getFinishCompletePromise()
      : Promise.resolve();
    if (this.completion && typeof this.completion.catch === 'function') {
      this.completion.catch(() => {});
    }
    this._applyStarted = false;
    this._applyPromise = null;
    this._pendingBarrierTopologyWindow = false;
  }

  getError() {
    const poisonedArgs = _mergePoisonedArgs(this.arguments);
    return poisonedArgs && Array.isArray(poisonedArgs.errors)
      ? new PoisonError(poisonedArgs.errors.slice())
      : null;
  }

  apply() {
    if (this._applyStarted) {
      return this._applyPromise || this.promise;
    }
    this._applyStarted = true;

    try {
      const poisonedArgs = _mergePoisonedArgs(this.arguments);
      if (poisonedArgs && !_hasAsyncMethodArgs(this.arguments)) {
        _finishAdmissionBuffers(this);
        this.resolveResult(poisonedArgs);
        this._applyPromise = this.promise;
        return poisonedArgs;
      }

      const resolvedMethodEntry = _resolveMethodEntryForAdmission(
        this.resolveMethodEntry,
        this.errorContext
      );
      if (resolvedMethodEntry && typeof resolvedMethodEntry.then === 'function') {
        this._applyPromise = resolvedMethodEntry.then(
          ({ value }) => this._invokeResolvedMethodEntry(value),
          (err) => this._rejectAndRethrow(err)
        );
        return this._applyPromise;
      }
      return this._invokeResolvedMethodEntry(resolvedMethodEntry.value);
    } catch (err) {
      return this._rejectAndRethrow(err);
    }
  }

  _invokeResolvedMethodEntry(methodEntry) {
    if (isPoison(methodEntry)) {
      _finishAdmissionBuffers(this);
      this.resolveResult(methodEntry);
      this._applyPromise = this.promise;
      return methodEntry;
    }

    const argCountError = _validateMethodArgCount(methodEntry, this.arguments, this.name, this.errorContext);
    if (argCountError) {
      _finishAdmissionBuffers(this);
      this.resolveResult(argCountError);
      this._applyPromise = this.promise;
      return argCountError;
    }

    try {
      const invocationBuffer = this._ensureInvocationBuffer(methodEntry);
      const result = _invokeMethodEntry(
        methodEntry,
        this.context,
        this.inheritanceState,
        this.arguments,
        this.env,
        this.runtime,
        this.cb,
        invocationBuffer,
        this.errorContext,
        this.currentPayload
      );
      if (result && typeof result.then === 'function') {
        this._applyPromise = result.then(
          (value) => {
            _finishAdmissionBuffers(this);
            this.resolveResult(value);
            return value;
          },
          (err) => this._rejectAndRethrow(err)
        );
        return this._applyPromise;
      }
      _finishAdmissionBuffers(this);
      this.resolveResult(result);
      this._applyPromise = this.promise;
      return result;
    } catch (err) {
      return this._rejectAndRethrow(err);
    }
  }

  _ensureInvocationBuffer(methodEntry) {
    if (this.invocationBuffer) {
      return this.invocationBuffer;
    }

    _unregisterPendingAdmissionBarrier(this);
    const exactLinkedChannels = Array.isArray(methodEntry && methodEntry.linkedChannels)
      ? methodEntry.linkedChannels
      : [];
    _ensureBufferLinkedChannels(this.currentBuffer, this.barrierBuffer, exactLinkedChannels);
    this.invocationBuffer = _createInvocationBuffer(
      this.barrierBuffer,
      this.context,
      exactLinkedChannels
    );
    return this.invocationBuffer;
  }

  _rejectAndRethrow(err) {
    _finishAdmissionBuffers(this);
    this._applyPromise = this._applyPromise || this.promise;
    this.rejectResult(err);
    throw err;
  }
}

function _enqueueAdmissionCommand(command) {
  if (!command || !command.barrierBuffer) {
    throw new Error('InheritanceAdmissionCommand requires a barrier buffer');
  }
  command.barrierBuffer.add(command, INHERITANCE_ADMISSION_CHANNEL);
  return command;
}

function _admitMethodCommand({
  immediateMethodEntry,
  resolveMethodEntry,
  name,
  context,
  inheritanceState,
  args,
  env,
  runtime,
  cb,
  currentBuffer,
  errorContext,
  currentPayload = null
}) {
  const knownMethod = !!immediateMethodEntry;
  const barrierBuffer = _createBarrierBuffer(
    currentBuffer,
    context,
    knownMethod
      ? immediateMethodEntry && immediateMethodEntry.linkedChannels
      : _computeBarrierLinkedChannels(currentBuffer, inheritanceState)
  );
  const invocationBuffer = knownMethod ? barrierBuffer : null;
  const admissionCommand = new InheritanceAdmissionCommand({
    name,
    resolveMethodEntry: knownMethod ? () => immediateMethodEntry : resolveMethodEntry,
    args,
    context,
    inheritanceState,
    env,
    runtime,
    cb,
    barrierBuffer,
    invocationBuffer,
    errorContext,
    currentPayload,
    currentBuffer
  });
  if (!knownMethod) {
    admissionCommand._pendingBarrierTopologyWindow = _registerPendingAdmissionBarrier(currentBuffer, barrierBuffer);
  }
  return _enqueueAdmissionCommand(admissionCommand);
}

function admitInheritedMethod(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  const immediateMethodEntry = inheritanceState
    ? inheritanceState.methods.getImmediateInherited(name)
    : null;
  return _admitMethodCommand({
    immediateMethodEntry,
    resolveMethodEntry: () => inheritanceState.methods.resolveInherited(name),
    name,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext
  });
}

function callInheritedMethod(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  return admitInheritedMethod(
    context,
    inheritanceState,
    name,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext
  ).promise;
}

function callSuperMethod(context, inheritanceState, name, ownerKey, args, env, runtime, cb, currentBuffer, currentPayload, errorContext) {
  const immediateMethodEntry = inheritanceState
    ? inheritanceState.methods.getImmediateSuper(name, ownerKey)
    : null;
  const admissionCommand = _admitMethodCommand({
    immediateMethodEntry,
    resolveMethodEntry: () => inheritanceState.methods.resolveSuper(name, ownerKey),
    name,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    currentPayload
  });
  return admissionCommand.promise;
}

function admitConstructorEntry(context, inheritanceState, methodEntry, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  return _admitMethodCommand({
    immediateMethodEntry: methodEntry,
    resolveMethodEntry: () => methodEntry,
    name: '__constructor__',
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    currentPayload
  });
}

module.exports = {
  InheritanceAdmissionCommand,
  admitConstructorEntry,
  admitInheritedMethod,
  callInheritedMethod,
  callSuperMethod
};
