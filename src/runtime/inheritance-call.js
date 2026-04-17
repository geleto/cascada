'use strict';

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
const inheritanceBootstrap = require('./inheritance-bootstrap');

const INHERITANCE_ADMISSION_CHANNEL = '__inheritance_admission__';

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

function _invokeMethodEntry(methodEntry, context, inheritanceState, resolvedArgs, env, runtime, cb, invocationBuffer, errorContext, currentPayload = null, autoFinishInvocationBuffer = true) {
  let result;
  try {
    const argMap = {};
    const inputNames = methodEntry && methodEntry.contract && Array.isArray(methodEntry.contract.inputNames)
      ? methodEntry.contract.inputNames
      : [];
    for (let i = 0; i < inputNames.length; i++) {
      argMap[inputNames[i]] = resolvedArgs[i];
    }
    const payload = currentPayload
      ? context.createSuperInheritancePayload(currentPayload, argMap)
      : context.createInheritancePayload(methodEntry && methodEntry.ownerKey, argMap, null);
    const preparedPayload = context.prepareInheritancePayloadForBlock(methodEntry.fn, payload);
    const renderCtx = methodEntry && methodEntry.contract && methodEntry.contract.withContext
      ? context.getRenderContextVariables()
      : undefined;
    result = methodEntry.fn(env, context, runtime, cb, invocationBuffer, inheritanceState, preparedPayload, renderCtx);
  } finally {
    if (autoFinishInvocationBuffer) {
      _finishInvocationBuffer(invocationBuffer);
    }
  }
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

function _getDeferredAdmissionLinkedChannels(currentBuffer, inheritanceState) {
  const admissionChannelNames = new Set();
  if (isCommandBuffer(currentBuffer) && inheritanceState && typeof inheritanceState.getRegisteredSharedChannelNames === 'function') {
    inheritanceState.getRegisteredSharedChannelNames().forEach((name) => {
      if (!name || name === '__return__') {
        return;
      }
      if (typeof currentBuffer.isLinkedChannel === 'function' && currentBuffer.isLinkedChannel(name)) {
        admissionChannelNames.add(name);
        return;
      }
      if (typeof currentBuffer.getOwnChannel === 'function' && currentBuffer.getOwnChannel(name)) {
        admissionChannelNames.add(name);
      }
    });
  }
  return Array.from(admissionChannelNames);
}

function _createAdmissionBuffer(currentBuffer, context, linkedChannels = null) {
  const parentBuffer = isCommandBuffer(currentBuffer) ? currentBuffer : null;
  const admissionBuffer = createCommandBuffer(
    parentBuffer ? (parentBuffer._context || context) : context,
    parentBuffer,
    Array.isArray(linkedChannels) && linkedChannels.length > 0 ? linkedChannels : null,
    parentBuffer
  );
  declareBufferChannel(admissionBuffer, INHERITANCE_ADMISSION_CHANNEL, 'var', context, null);
  return admissionBuffer;
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
    admissionBuffer,
    errorContext,
    currentPayload = null
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
    this.admissionBuffer = admissionBuffer;
    this.errorContext = errorContext || { lineno: 0, colno: 0, errorContextString: null, path: null };
    this.currentPayload = currentPayload;
    this.completion = admissionBuffer && typeof admissionBuffer.getFinishCompletePromise === 'function'
      ? admissionBuffer.getFinishCompletePromise()
      : Promise.resolve();
    if (this.completion && typeof this.completion.catch === 'function') {
      this.completion.catch(() => {});
    }
    this._applyStarted = false;
    this._applyPromise = null;
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
        _finishInvocationBuffer(this.admissionBuffer);
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
      _finishInvocationBuffer(this.admissionBuffer);
      this.resolveResult(methodEntry);
      this._applyPromise = this.promise;
      return methodEntry;
    }

    const argCountError = _validateMethodArgCount(methodEntry, this.arguments, this.name, this.errorContext);
    if (argCountError) {
      _finishInvocationBuffer(this.admissionBuffer);
      this.resolveResult(argCountError);
      this._applyPromise = this.promise;
      return argCountError;
    }

    try {
      const result = _invokeMethodEntry(
        methodEntry,
        this.context,
        this.inheritanceState,
        this.arguments,
        this.env,
        this.runtime,
        this.cb,
        this.admissionBuffer,
        this.errorContext,
        this.currentPayload
      );
      if (result && typeof result.then === 'function') {
        this._applyPromise = result.then(
          (value) => {
            this.resolveResult(value);
            return value;
          },
          (err) => this._rejectAndRethrow(err)
        );
        return this._applyPromise;
      }
      this.resolveResult(result);
      this._applyPromise = this.promise;
      return result;
    } catch (err) {
      return this._rejectAndRethrow(err);
    }
  }

  _rejectAndRethrow(err) {
    _finishInvocationBuffer(this.admissionBuffer);
    this._applyPromise = this._applyPromise || this.promise;
    this.rejectResult(err);
    throw err;
  }
}

function _enqueueAdmissionCommand(command) {
  command.admissionBuffer.add(command, INHERITANCE_ADMISSION_CHANNEL);
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
  const admissionBuffer = _createAdmissionBuffer(
    currentBuffer,
    context,
    knownMethod
      ? immediateMethodEntry && immediateMethodEntry.linkedChannels
      : _getDeferredAdmissionLinkedChannels(currentBuffer, inheritanceState)
  );
  return _enqueueAdmissionCommand(new InheritanceAdmissionCommand({
    name,
    resolveMethodEntry: knownMethod ? () => immediateMethodEntry : resolveMethodEntry,
    args,
    context,
    inheritanceState,
    env,
    runtime,
    cb,
    admissionBuffer,
    errorContext,
    currentPayload
  }));
}

function admitInheritedMethod(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  const immediateMethodEntry = inheritanceState && typeof inheritanceState.getImmediateInheritedMethodEntry === 'function'
    ? inheritanceState.getImmediateInheritedMethodEntry(name)
    : null;
  return _admitMethodCommand({
    immediateMethodEntry,
    resolveMethodEntry: () => inheritanceState.resolveInheritedMethodEntry(name),
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
  const immediateMethodEntry = inheritanceState && typeof inheritanceState.getImmediateSuperMethodEntry === 'function'
    ? inheritanceState.getImmediateSuperMethodEntry(name, ownerKey)
    : null;
  const admissionCommand = _admitMethodCommand({
    immediateMethodEntry,
    resolveMethodEntry: () => inheritanceState.resolveSuperMethodEntry(name, ownerKey),
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

function _startDynamicParentConstructor(parentTemplate, parentContext, inheritanceState, env, runtime, cb, currentBuffer, shouldAwaitCompletion) {
  const compositionBuffer = parentTemplate.rootRenderFunc(
    env,
    parentContext,
    runtime,
    cb,
    true,
    currentBuffer,
    inheritanceState
  );
  if (!shouldAwaitCompletion) {
    return null;
  }
  return compositionBuffer && typeof compositionBuffer.getFinishedPromise === 'function'
    ? compositionBuffer.getFinishedPromise()
    : null;
}

function _startStaticParentConstructor(parentTemplate, registrationContext, parentContext, inheritanceState, env, runtime, cb, currentBuffer, errorContext, shouldAwaitCompletion) {
  inheritanceBootstrap.bootstrapInheritanceMetadata(
    inheritanceState,
    parentTemplate && parentTemplate.methods ? parentTemplate.methods : {},
    parentTemplate && parentTemplate.sharedSchema ? parentTemplate.sharedSchema : [],
    parentTemplate ? parentTemplate.path : null,
    currentBuffer,
    registrationContext
  );
  inheritanceBootstrap.ensureCurrentBufferSharedLinks(
    parentTemplate && parentTemplate.sharedSchema ? parentTemplate.sharedSchema : [],
    currentBuffer
  );
  const admission = admitConstructorEntry(
    parentContext,
    inheritanceState,
    parentTemplate && parentTemplate.methods ? parentTemplate.methods.__constructor__ : null,
    [],
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext
  );
  return shouldAwaitCompletion && admission && admission.completion && typeof admission.completion.then === 'function'
    ? admission.completion
    : null;
}

function startParentConstructor(parentTemplate, registrationContext, parentContext, inheritanceState, env, runtime, cb, currentBuffer, errorContext, options = null) {
  const opts = options || {};
  const shouldAwaitCompletion = !!opts.awaitCompletion;

  if (parentTemplate && parentTemplate.hasDynamicExtends) {
    return _startDynamicParentConstructor(
      parentTemplate,
      parentContext,
      inheritanceState,
      env,
      runtime,
      cb,
      currentBuffer,
      shouldAwaitCompletion
    );
  }

  return _startStaticParentConstructor(
    parentTemplate,
    registrationContext,
    parentContext,
    inheritanceState,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    shouldAwaitCompletion
  );
}

module.exports = {
  InheritanceAdmissionCommand,
  admitConstructorEntry,
  startParentConstructor,
  admitInheritedMethod,
  callInheritedMethod,
  callSuperMethod
};
