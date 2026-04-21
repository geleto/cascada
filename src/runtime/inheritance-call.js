'use strict';

const { Command } = require('./commands');
const inheritanceState = require('./inheritance-state');
const { RuntimeFatalError, handleError, isRuntimeFatalError } = require('./errors');

function _contextualizeFatalError(error, errorContext, fallbackMessage = null) {
  const lineno = errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0;
  const colno = errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0;
  const errorContextString = errorContext && errorContext.errorContextString ? errorContext.errorContextString : null;
  const path = errorContext && errorContext.path ? errorContext.path : null;
  const message = fallbackMessage || (error && error.message) || 'Inherited dispatch failed';
  const contextualError = new RuntimeFatalError(message, lineno, colno, errorContextString, path);
  if (error && error.code) {
    contextualError.code = error.code;
  }
  return contextualError;
}

function _hasResolvedErrorLocation(error) {
  return !!(
    error &&
    (
      error.path ||
      error.errorContextString ||
      (typeof error.lineno === 'number' && error.lineno !== 0) ||
      (typeof error.colno === 'number' && error.colno !== 0)
    )
  );
}

function _normalizeResolutionError(error, errorContext) {
  if (isRuntimeFatalError(error)) {
    if (!_hasResolvedErrorLocation(error)) {
      return _contextualizeFatalError(error, errorContext);
    }
    return error;
  }

  return handleError(
    error,
    errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
    errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
    errorContext ? errorContext.errorContextString : null,
    errorContext ? errorContext.path : null
  );
}

function _createInheritanceFatalError(message, code, errorContext = null) {
  return inheritanceState.withInheritanceErrorCode(
    _contextualizeFatalError(
      new RuntimeFatalError(message, 0, 0, null, null),
      errorContext
    ),
    code
  );
}

function _normalizeInheritedMethodInvocationError(error, methodName, errorContext) {
  if (error && error.code === inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND) {
    return _createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      errorContext
    );
  }
  return _normalizeResolutionError(error, errorContext);
}

function _findResolvedMethodEntryForOwner(methodMeta, ownerKey) {
  let current = methodMeta && methodMeta.entry ? methodMeta.entry : null;
  while (current && !inheritanceState.isPendingInheritanceEntry(current)) {
    if (current.ownerKey === ownerKey) {
      return current;
    }
    current = current.super;
  }
  return null;
}

async function _resolvePendingInheritanceEntryChain(entry, normalizeError) {
  let current = entry;
  while (inheritanceState.isPendingInheritanceEntry(current)) {
    try {
      current = await current.promise;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  return current;
}

async function _resolveEffectiveInheritanceMethodFromEntry(entry, errorContext) {
  const resolvedEntry = await _resolvePendingInheritanceEntryChain(
    entry,
    (error) => _normalizeResolutionError(error, errorContext)
  );

  if (resolvedEntry._resolvedInheritanceMethodMeta) {
    return resolvedEntry._resolvedInheritanceMethodMeta;
  }
  if (resolvedEntry._resolvedInheritanceMethodMetaPromise) {
    return resolvedEntry._resolvedInheritanceMethodMetaPromise;
  }

  resolvedEntry._resolvedInheritanceMethodMetaPromise = (async () => {
    const usedChannels = new Set(Array.isArray(resolvedEntry.usedChannels) ? resolvedEntry.usedChannels : []);
    const mutatedChannels = new Set(Array.isArray(resolvedEntry.mutatedChannels) ? resolvedEntry.mutatedChannels : []);
    let contract = resolvedEntry.contract || { argNames: [], withContext: false };

    if (resolvedEntry.super) {
      const superMeta = await _resolveEffectiveInheritanceMethodFromEntry(
        resolvedEntry.super,
        errorContext
      );
      superMeta.usedChannels.forEach((name) => usedChannels.add(name));
      superMeta.mutatedChannels.forEach((name) => mutatedChannels.add(name));

      const localArgNames = Array.isArray(contract.argNames) ? contract.argNames : [];
      const superArgNames = Array.isArray(superMeta.contract && superMeta.contract.argNames)
        ? superMeta.contract.argNames
        : [];
      if (localArgNames.length === 0 && superArgNames.length > 0) {
        contract = {
          argNames: superArgNames.slice(),
          withContext: !!(contract.withContext || (superMeta.contract && superMeta.contract.withContext))
        };
      } else if (!contract.withContext && superMeta.contract && superMeta.contract.withContext) {
        contract = {
          argNames: localArgNames.slice(),
          withContext: true
        };
      }
    }

    const linkedChannels = Array.from(new Set([
      ...usedChannels,
      ...mutatedChannels
    ]));
    const effectiveMeta = {
      entry: resolvedEntry,
      usedChannels: Array.from(usedChannels),
      mutatedChannels: Array.from(mutatedChannels),
      linkedChannels,
      contract
    };

    resolvedEntry._resolvedInheritanceMethodMeta = effectiveMeta;
    return effectiveMeta;
  })();

  return resolvedEntry._resolvedInheritanceMethodMetaPromise;
}

function resolveInheritanceMethod(state, methodName, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(methods, methodName)) {
    return Promise.reject(_createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      errorContext
    ));
  }

  return _resolveEffectiveInheritanceMethodFromEntry(methods[methodName], errorContext);
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
    return Promise.reject(_createInheritanceFatalError(
      `Shared channel '${channelName}' was not found`,
      inheritanceState.ERR_SHARED_CHANNEL_NOT_FOUND,
      errorContext
    ));
  }

  return _resolvePendingInheritanceEntryChain(
    sharedSchema[channelName],
    (error) => _normalizeResolutionError(error, errorContext)
  );
}

function _normalizeMethodMeta(methodMetaOrEntry) {
  if (!methodMetaOrEntry || typeof methodMetaOrEntry !== 'object') {
    throw new RuntimeFatalError(
      'Inherited dispatch resolved to an invalid method entry',
      0,
      0,
      null,
      null
    );
  }

  const entry = methodMetaOrEntry.entry || methodMetaOrEntry;

  return {
    entry,
    contract: methodMetaOrEntry.contract || (entry && entry.contract) || { argNames: [], withContext: false },
    linkedChannels: _collectAllChannelNames(methodMetaOrEntry),
    usedChannels: Array.isArray(methodMetaOrEntry.usedChannels) ? methodMetaOrEntry.usedChannels.slice() : [],
    mutatedChannels: Array.isArray(methodMetaOrEntry.mutatedChannels) ? methodMetaOrEntry.mutatedChannels.slice() : []
  };
}

function _addChannelNames(target, names) {
  if (!Array.isArray(names)) {
    return;
  }

  for (let i = 0; i < names.length; i++) {
    if (names[i]) {
      target.add(names[i]);
    }
  }
}

function _collectAllChannelNames(source) {
  const linkedChannels = new Set();

  _addChannelNames(linkedChannels, source && source.linkedChannels);
  _addChannelNames(linkedChannels, source && source.usedChannels);
  _addChannelNames(linkedChannels, source && source.mutatedChannels);

  return Array.from(linkedChannels);
}

function _enqueueCurrentPositionWaits(currentBuffer, runtime, channelNames) {
  if (
    !currentBuffer ||
    !runtime ||
    typeof runtime.waitForCurrentBufferChannel !== 'function' ||
    !Array.isArray(channelNames) ||
    channelNames.length === 0
  ) {
    return null;
  }

  const waits = [];
  const seen = new Set();
  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
    if (!channelName || seen.has(channelName)) {
      continue;
    }
    seen.add(channelName);
    if (
      currentBuffer &&
      typeof currentBuffer.isFinished === 'function' &&
      (currentBuffer.isFinished(channelName) || currentBuffer.finished)
    ) {
      continue;
    }
    waits.push(runtime.waitForCurrentBufferChannel(currentBuffer, channelName));
  }

  if (waits.length === 0) {
    return null;
  }

  return Promise.all(waits);
}

function _createMethodPayload(methodMeta, args, errorContext, label, context = null, fallbackToContextOriginalArgs = false) {
  const contract = methodMeta && methodMeta.contract ? methodMeta.contract : { argNames: [], withContext: false };
  const argNames = Array.isArray(contract.argNames) ? contract.argNames : [];
  let values = Array.isArray(args) ? args : [];

  if (
    fallbackToContextOriginalArgs &&
    values.length === 0 &&
    argNames.length > 0 &&
    context &&
    typeof context.getCompositionContextVariables === 'function'
  ) {
    const originalArgs = context.getCompositionContextVariables() || {};
    values = argNames.map((name) => originalArgs[name]);
  }

  if (values.length > argNames.length) {
    throw new RuntimeFatalError(
      `${label} received too many arguments`,
      errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
      errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
      errorContext ? errorContext.errorContextString : null,
      errorContext ? errorContext.path : null
    );
  }

  const originalArgs = {};
  for (let i = 0; i < values.length; i++) {
    originalArgs[argNames[i]] = values[i];
  }

  return {
    originalArgs
  };
}

function _getInitialAdmissionChannels(inheritanceStateValue, methodMetaOrEntry = null) {
  const methodLinkedChannels =
    methodMetaOrEntry && typeof methodMetaOrEntry === 'object'
      ? _collectAllChannelNames(methodMetaOrEntry)
      : [];
  const sharedSchema = inheritanceStateValue && inheritanceStateValue.sharedSchema && typeof inheritanceStateValue.sharedSchema === 'object'
    ? inheritanceStateValue.sharedSchema
    : null;
  const sharedChannelNames = sharedSchema ? Object.keys(sharedSchema) : [];
  return Array.from(new Set([
    ...methodLinkedChannels,
    ...sharedChannelNames,
    '__return__'
  ]));
}

function _getPrimaryAdmissionChannel(channelNames) {
  // Any linked lane can host the admission command; keep the choice stable by
  // using the first lane in the already-computed link set.
  return Array.isArray(channelNames) && channelNames.length > 0
    ? channelNames[0]
    : '__return__';
}

function _createAdmissionBarrier(context, runtime, currentBuffer, linkedChannels) {
  if (!currentBuffer) {
    throw new Error('Inheritance admission requires a current buffer');
  }
  if (!runtime || typeof runtime.createCommandBuffer !== 'function') {
    throw new Error('Inheritance admission requires runtime.createCommandBuffer');
  }
  return runtime.createCommandBuffer(context, currentBuffer, linkedChannels, currentBuffer);
}

function _linkBarrierChannel(currentBuffer, barrierBuffer, channelName) {
  if (!channelName || !currentBuffer || !barrierBuffer || barrierBuffer === currentBuffer) {
    // `barrierBuffer === currentBuffer` only occurs in the pre-seeded
    // invocation-buffer compatibility hook used by later-phase tests.
    if (barrierBuffer && channelName) {
      barrierBuffer._registerLinkedChannel(channelName);
    }
    return;
  }
  if (barrierBuffer.isLinkedChannel(channelName)) {
    return;
  }
  if (currentBuffer.isFinished(channelName) || currentBuffer.finished) {
    barrierBuffer._registerLinkedChannel(channelName);
    return;
  }
  currentBuffer.addBuffer(barrierBuffer, channelName);
}

function _markBufferFinish(buffer) {
  if (!buffer) {
    return;
  }
  buffer.markFinishedAndPatchLinks();
}

class InheritanceAdmissionCommand extends Command {
  constructor({
    name,
    label = null,
    resolveMethodEntry,
    normalizeError,
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    barrierBuffer,
    invocationBuffer = null,
    currentBuffer,
    errorContext = null
  }) {
    super({ withDeferredResult: true });
    this.name = name;
    this.label = label || `Inherited method '${name}'`;
    this.resolveMethodEntry = resolveMethodEntry;
    this.normalizeError = typeof normalizeError === 'function'
      ? normalizeError
      : (error) => _normalizeResolutionError(error, errorContext);
    this.args = Array.isArray(args) ? args : [];
    this.context = context;
    this.inheritanceState = inheritanceStateValue;
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.barrierBuffer = barrierBuffer;
    this.invocationBuffer = invocationBuffer;
    this.currentBuffer = currentBuffer;
    this.errorContext = errorContext;
    this.isObservable = true;
    this.completion = null;
    this.resolvedMethodMetaPromise = null;
    this._resolvedMethodMeta = null;
    this._normalizedError = null;
    this._startPromise = null;
    this._finishedBuffers = false;
    this._resultSettled = false;
    this.fallbackToContextOriginalArgs = false;
    this.preWaitPromise = null;
  }

  getError() {
    return this._normalizedError;
  }

  apply() {
    return this._start();
  }

  _start() {
    if (this._startPromise) {
      return this._startPromise;
    }

    this._startPromise = (async () => {
      try {
        if (this.preWaitPromise && typeof this.preWaitPromise.then === 'function') {
          await this.preWaitPromise;
        }
        const methodMeta = _normalizeMethodMeta(await this.resolveMethodEntry());
        this._resolvedMethodMeta = methodMeta;
        const invocationBuffer = this._ensureInvocationBuffer(methodMeta.entry || methodMeta);
        const result = await this._invokeResolvedMethodMeta(methodMeta, invocationBuffer);
        this._resolveObservableResult(result);
        this._finishAdmissionBuffers(invocationBuffer);
        return result;
      } catch (error) {
        const normalizedError = this.normalizeError(error);
        this._normalizedError = normalizedError;
        this._rejectObservableResult(normalizedError);
        try {
          // Preserve the primary invocation error if best-effort buffer cleanup
          // also fails while unwinding.
          this._finishAdmissionBuffers(this.invocationBuffer);
        } catch (finishError) {
          void finishError;
        }
        throw normalizedError;
      }
    })();

    this.completion = this._startPromise;
    this.completion.catch(() => {});
    this.resolvedMethodMetaPromise = this._startPromise.then(() => this._resolvedMethodMeta);
    this.resolvedMethodMetaPromise.catch(() => {});
    return this._startPromise;
  }

  _resolveObservableResult(value) {
    if (this._resultSettled) {
      return;
    }
    this._resultSettled = true;
    this.resolveResult(value);
  }

  _rejectObservableResult(error) {
    if (this._resultSettled) {
      return;
    }
    this._resultSettled = true;
    this.rejectResult(error);
  }

  _ensureInvocationBuffer(methodMetaOrEntry) {
    const methodChannels = _collectAllChannelNames(methodMetaOrEntry);
    const sharedSchema =
      this.inheritanceState && this.inheritanceState.sharedSchema && typeof this.inheritanceState.sharedSchema === 'object'
        ? this.inheritanceState.sharedSchema
        : null;
    const sharedChannels = sharedSchema ? Object.keys(sharedSchema) : [];
    const linkedChannels = Array.from(new Set([
      ...methodChannels,
      ...sharedChannels
    ]));
    for (let i = 0; i < linkedChannels.length; i++) {
      _linkBarrierChannel(this.currentBuffer, this.barrierBuffer, linkedChannels[i]);
    }

    if (!this.invocationBuffer) {
      this.invocationBuffer = this.runtime.createCommandBuffer(
        this.context,
        this.barrierBuffer,
        linkedChannels,
        this.barrierBuffer
      );
      return this.invocationBuffer;
    }

    // Compatibility hook for tests and later cleanup phases: when a caller
    // pre-seeds an invocation buffer, we only finish the late channel wiring.
    if (this.invocationBuffer !== this.barrierBuffer && this.barrierBuffer) {
      for (let i = 0; i < linkedChannels.length; i++) {
        const channelName = linkedChannels[i];
        if (!this.invocationBuffer.isLinkedChannel(channelName)) {
          if (this.barrierBuffer.isFinished(channelName) || this.barrierBuffer.finished) {
            this.invocationBuffer._registerLinkedChannel(channelName);
          } else {
            this.barrierBuffer.addBuffer(this.invocationBuffer, channelName);
          }
        }
      }
    }

    return this.invocationBuffer;
  }

  _invokeResolvedMethodMeta(methodMeta, invocationBuffer) {
    if (this.name === '__constructor__') {
      return methodMeta.entry.fn(
        this.env,
        this.context,
        this.runtime,
        this.cb,
        invocationBuffer,
        this.inheritanceState
      );
    }

    const payload = _createMethodPayload(
      methodMeta,
      this.args,
      this.errorContext,
      this.label,
      this.context,
      this.fallbackToContextOriginalArgs
    );
    const renderCtx = methodMeta.contract && methodMeta.contract.withContext &&
      this.context && typeof this.context.getRenderContextVariables === 'function'
      ? this.context.getRenderContextVariables()
      : undefined;

    // Script methods return through the synthetic `__return__` channel; the
    // admission path owns finishing the invocation/barrier buffers afterwards.
    return methodMeta.entry.fn(
      this.env,
      this.context,
      this.runtime,
      this.cb,
      invocationBuffer,
      payload,
      renderCtx,
      this.inheritanceState
    );
  }

  _finishAdmissionBuffers(invocationBuffer) {
    if (this._finishedBuffers) {
      return;
    }
    this._finishedBuffers = true;

    _markBufferFinish(invocationBuffer);
    if (this.barrierBuffer && this.barrierBuffer !== invocationBuffer) {
      _markBufferFinish(this.barrierBuffer);
    }
  }
}

function _enqueueAdmissionCommand(command, barrierBuffer, linkedChannels) {
  const targetBuffer = barrierBuffer || command.currentBuffer;
  const primaryChannel = _getPrimaryAdmissionChannel(linkedChannels);
  targetBuffer.add(command, primaryChannel);
  // Start resolution immediately so ancestry lookup and late link wiring can
  // overlap with surrounding buffer work before the iterator reaches this slot.
  command._start();
  return {
    // `promise` is the observable method return value. `completion` also
    // includes admission-buffer teardown and is only needed by constructor
    // startup paths that must wait for the full admission lifecycle.
    promise: command.promise,
    completion: command.completion
  };
}

function admitConstructorEntry(context, inheritanceStateValue, methodEntry, args, env, runtime, cb, currentBuffer, errorContext = null) {
  const linkedChannels = _getInitialAdmissionChannels(inheritanceStateValue, methodEntry);
  const barrierBuffer = _createAdmissionBarrier(context, runtime, currentBuffer, linkedChannels);
  const command = new InheritanceAdmissionCommand({
    name: '__constructor__',
    label: 'Parent constructor',
    resolveMethodEntry: () => Promise.resolve(methodEntry),
    normalizeError: (error) => _normalizeResolutionError(error, errorContext),
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    barrierBuffer,
    currentBuffer,
    errorContext
  });

  return _enqueueAdmissionCommand(command, barrierBuffer, linkedChannels);
}

function invokeInheritedMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null, options = null) {
  const preWaitChannels =
    options && options.preWaitCurrentPosition && inheritanceStateValue && inheritanceStateValue.methods &&
    Object.prototype.hasOwnProperty.call(inheritanceStateValue.methods, methodName) &&
    !inheritanceState.isPendingInheritanceEntry(inheritanceStateValue.methods[methodName])
      ? _collectAllChannelNames(inheritanceStateValue.methods[methodName])
      : [];
  const preWaitPromise = _enqueueCurrentPositionWaits(currentBuffer, runtime, preWaitChannels);
  const linkedChannels = _getInitialAdmissionChannels(inheritanceStateValue, null);
  const barrierBuffer = _createAdmissionBarrier(context, runtime, currentBuffer, linkedChannels);
  const command = new InheritanceAdmissionCommand({
    name: methodName,
    label: `Inherited method '${methodName}'`,
    resolveMethodEntry: () => resolveInheritanceMethod(inheritanceStateValue, methodName, errorContext),
    normalizeError: (error) => _normalizeInheritedMethodInvocationError(error, methodName, errorContext),
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    barrierBuffer,
    currentBuffer,
    errorContext
  });
  command.preWaitPromise = preWaitPromise;

  const admission = _enqueueAdmissionCommand(command, barrierBuffer, linkedChannels);
  if (admission.promise && admission.completion) {
    // Component dispatch uses the shared returned promise surface: `.completion`
    // waits for full admission teardown, while `.resolvedMethodMeta` exposes
    // the already-resolved inherited method metadata without triggering a
    // second ancestry walk just to learn linked channels.
    admission.promise.completion = admission.completion;
    admission.promise.resolvedMethodMeta = command.resolvedMethodMetaPromise;
  }
  return admission.promise;
}

function invokeSuperMethod(inheritanceStateValue, methodName, ownerKey, args, context, env, runtime, cb, currentBuffer, errorContext = null, options = null) {
  let preWaitChannels = [];
  if (
    options &&
    options.preWaitCurrentPosition &&
    inheritanceStateValue &&
    inheritanceStateValue.methods &&
    Object.prototype.hasOwnProperty.call(inheritanceStateValue.methods, methodName) &&
    !inheritanceState.isPendingInheritanceEntry(inheritanceStateValue.methods[methodName])
  ) {
    const ownerEntry = _findResolvedMethodEntryForOwner(
      { entry: inheritanceStateValue.methods[methodName] },
      ownerKey
    );
    if (ownerEntry) {
      preWaitChannels = _collectAllChannelNames(ownerEntry);
    }
  }
  const preWaitPromise = _enqueueCurrentPositionWaits(currentBuffer, runtime, preWaitChannels);
  const linkedChannels = _getInitialAdmissionChannels(inheritanceStateValue, null);
  const barrierBuffer = _createAdmissionBarrier(context, runtime, currentBuffer, linkedChannels);
  const command = new InheritanceAdmissionCommand({
    name: methodName,
    label: `super() for method '${methodName}'`,
    resolveMethodEntry: async () => {
      const methodMeta = await resolveInheritanceMethod(inheritanceStateValue, methodName, errorContext);
      const ownerEntry = _findResolvedMethodEntryForOwner(methodMeta, ownerKey);
      if (!ownerEntry || !ownerEntry.super) {
        throw _createInheritanceFatalError(
          `super() for method '${methodName}' was not found`,
          inheritanceState.ERR_SUPER_METHOD_NOT_FOUND,
          errorContext
        );
      }
      return _resolveEffectiveInheritanceMethodFromEntry(ownerEntry.super, errorContext);
    },
    normalizeError: (error) => _normalizeResolutionError(error, errorContext),
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    barrierBuffer,
    currentBuffer,
    errorContext
  });
  command.fallbackToContextOriginalArgs = true;
  command.preWaitPromise = preWaitPromise;

  return _enqueueAdmissionCommand(command, barrierBuffer, linkedChannels).promise;
}

module.exports = {
  InheritanceAdmissionCommand,
  admitConstructorEntry,
  resolveInheritanceMethod,
  resolveInheritanceSharedChannel,
  invokeInheritedMethod,
  invokeSuperMethod
};
