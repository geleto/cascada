'use strict';

const inheritanceState = require('./inheritance-state');
const { RuntimeFatalError, handleError, isRuntimeFatalError } = require('./errors');

function _contextualizeFatalError(error, errorContext, fallbackMessage = null) {
  const lineno = errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0;
  const colno = errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0;
  const errorContextString = errorContext && errorContext.errorContextString ? errorContext.errorContextString : null;
  const path = errorContext && errorContext.path ? errorContext.path : null;
  const message = fallbackMessage || (error && error.message) || 'Inherited dispatch failed';

  return new RuntimeFatalError(message, lineno, colno, errorContextString, path);
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

async function _resolveEffectiveInheritanceMethodFromEntry(entry, methodName, errorContext) {
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

    if (resolvedEntry.super) {
      const superMeta = await _resolveEffectiveInheritanceMethodFromEntry(
        resolvedEntry.super,
        methodName,
        errorContext
      );
      superMeta.usedChannels.forEach((name) => usedChannels.add(name));
      superMeta.mutatedChannels.forEach((name) => mutatedChannels.add(name));
    }

    const linkedChannels = Array.from(new Set([
      ...usedChannels,
      ...mutatedChannels
    ]));
    const contract = resolvedEntry.contract || { argNames: [], withContext: false };
    const effectiveMeta = {
      entry: resolvedEntry,
      usedChannels: Array.from(usedChannels),
      mutatedChannels: Array.from(mutatedChannels),
      linkedChannels,
      contract
    };

    resolvedEntry.linkedChannels = linkedChannels;
    resolvedEntry._resolvedInheritanceMethodMeta = effectiveMeta;
    return effectiveMeta;
  })();

  return resolvedEntry._resolvedInheritanceMethodMetaPromise;
}

function resolveInheritanceMethod(state, methodName, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(methods, methodName)) {
    return Promise.reject(_contextualizeFatalError(
      new RuntimeFatalError(`Inherited method '${methodName}' was not found`, 0, 0, null, null),
      errorContext
    ));
  }

  return _resolveEffectiveInheritanceMethodFromEntry(methods[methodName], methodName, errorContext);
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
    return Promise.reject(_contextualizeFatalError(
      new RuntimeFatalError(`Shared channel '${channelName}' was not found`, 0, 0, null, null),
      errorContext
    ));
  }

  return _resolvePendingInheritanceEntryChain(
    sharedSchema[channelName],
    (error) => _normalizeResolutionError(error, errorContext)
  );
}

function _createMethodPayload(methodMeta, args, errorContext, label) {
  const contract = methodMeta && methodMeta.contract ? methodMeta.contract : { argNames: [], withContext: false };
  const argNames = Array.isArray(contract.argNames) ? contract.argNames : [];
  const values = Array.isArray(args) ? args : [];

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
    originalArgs,
    localsByTemplate: Object.create(null)
  };
}

function _createAdmissionBarrier(context, runtime, currentBuffer, inheritanceStateValue) {
  const barrierBuffer = runtime.createCommandBuffer(context, currentBuffer);
  const linkedChannelNames = new Set(['__return__']);
  const sharedSchema = inheritanceStateValue && inheritanceStateValue.sharedSchema && typeof inheritanceStateValue.sharedSchema === 'object'
    ? inheritanceStateValue.sharedSchema
    : null;

  if (sharedSchema) {
    Object.keys(sharedSchema).forEach((name) => linkedChannelNames.add(name));
  }

  linkedChannelNames.forEach((channelName) => {
    currentBuffer.addBuffer(barrierBuffer, channelName);
  });

  return barrierBuffer;
}

function _finishAdmissionBarrier(barrierBuffer, currentBuffer) {
  if (!barrierBuffer || typeof barrierBuffer.markFinishedAndPatchLinks !== 'function') {
    return;
  }
  barrierBuffer.markFinishedAndPatchLinks();
}

async function _invokeMethodMeta(methodMeta, args, context, env, runtime, cb, currentBuffer, inheritanceStateValue, errorContext, label) {
  const payload = _createMethodPayload(methodMeta, args, errorContext, label);
  const renderCtx = methodMeta.contract && methodMeta.contract.withContext &&
    context && typeof context.getRenderContextVariables === 'function'
    ? context.getRenderContextVariables()
    : undefined;

  return methodMeta.entry.fn(
    env,
    context,
    runtime,
    cb,
    currentBuffer,
    payload,
    renderCtx,
    inheritanceStateValue
  );
}

function invokeInheritedMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const barrierBuffer = _createAdmissionBarrier(context, runtime, currentBuffer, inheritanceStateValue);

  return resolveInheritanceMethod(inheritanceStateValue, methodName, errorContext)
    .then((methodMeta) => {
      const result = _invokeMethodMeta(
        methodMeta,
        args,
        context,
        env,
        runtime,
        cb,
        barrierBuffer,
        inheritanceStateValue,
        errorContext,
        `Inherited method '${methodName}'`
      );
      // Current compiled method entry functions synchronously register any child
      // async work onto the barrier buffer before returning the promise. Phase 7
      // replaces this temporary helper-owned barrier path with caller-side
      // admission/linking.
      _finishAdmissionBarrier(barrierBuffer, currentBuffer);
      return result;
    }, (error) => {
      _finishAdmissionBarrier(barrierBuffer, currentBuffer);
      throw error;
    });
}

function invokeSuperMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const barrierBuffer = _createAdmissionBarrier(context, runtime, currentBuffer, inheritanceStateValue);

  return resolveInheritanceMethod(inheritanceStateValue, methodName, errorContext)
    .then((methodMeta) => {
      if (!methodMeta.entry.super) {
        throw _contextualizeFatalError(
          new RuntimeFatalError(`super() for method '${methodName}' was not defined by any ancestor`, 0, 0, null, null),
          errorContext
        );
      }
      return _resolveEffectiveInheritanceMethodFromEntry(methodMeta.entry.super, methodName, errorContext);
    })
    .then((superMeta) => {
      const result = _invokeMethodMeta(
        superMeta,
        args,
        context,
        env,
        runtime,
        cb,
        barrierBuffer,
        inheritanceStateValue,
        errorContext,
        `super() for method '${methodName}'`
      );
      _finishAdmissionBarrier(barrierBuffer, currentBuffer);
      return result;
    }, (error) => {
      _finishAdmissionBarrier(barrierBuffer, currentBuffer);
      throw error;
    });
}

module.exports = {
  resolveInheritanceMethod,
  resolveInheritanceSharedChannel,
  invokeInheritedMethod,
  invokeSuperMethod
};
