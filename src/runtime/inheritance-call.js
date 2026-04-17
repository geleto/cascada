'use strict';

const {
  createPoison,
  isPoison,
  RuntimeFatalError,
  RuntimePromise
} = require('./errors');
const { RESOLVE_MARKER } = require('./resolve');
const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');

function _hasAsyncMethodArgs(args) {
  return Array.isArray(args) && args.some((arg) =>
    arg &&
    !isPoison(arg) &&
    (typeof arg.then === 'function' || arg[RESOLVE_MARKER])
  );
}

function _createMethodInvocationBuffer(currentBuffer, context, linkedChannels = null) {
  if (!isCommandBuffer(currentBuffer)) {
    return currentBuffer;
  }
  return createCommandBuffer(
    currentBuffer._context || context,
    currentBuffer,
    Array.isArray(linkedChannels) && linkedChannels.length > 0 ? linkedChannels : null,
    currentBuffer
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

function _enqueueDeferredMethodAdmission(currentBuffer, context, inheritanceState, start) {
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
  const admissionBuffer = isCommandBuffer(currentBuffer)
    ? _createMethodInvocationBuffer(
      currentBuffer,
      context,
      Array.from(admissionChannelNames)
    )
    : null;
  return _unwrapAdmissionValue(start(admissionBuffer));
}

function _unwrapAdmissionValue(admission) {
  return Promise.resolve(admission).then((resolvedAdmission) => resolvedAdmission.value);
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

function _createSettledMethodAdmission(value) {
  return {
    value,
    completion: Promise.resolve()
  };
}

function _createMethodCompletion(invocationBuffer) {
  return invocationBuffer && typeof invocationBuffer.getFinishCompletePromise === 'function'
    ? invocationBuffer.getFinishCompletePromise()
    : Promise.resolve();
}

function _awaitMethodAdmissionResult(admission) {
  return Promise.resolve(admission).then((resolvedAdmission) => {
    const valueResult = resolvedAdmission.value && typeof resolvedAdmission.value.then === 'function'
      ? resolvedAdmission.value
      : Promise.resolve(resolvedAdmission.value);
    const completionResult = resolvedAdmission.completion && typeof resolvedAdmission.completion.then === 'function'
      ? resolvedAdmission.completion
      : null;

    if (!completionResult) {
      return valueResult;
    }

    return valueResult.then(
      (value) => completionResult.then(() => value),
      (err) => completionResult.then(
        () => { throw err; },
        () => { throw err; }
      )
    );
  });
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

function _invokeImmediateMethodEntry(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const invocationBuffer = _createMethodInvocationBuffer(
    currentBuffer,
    context,
    methodEntry && methodEntry.linkedChannels
  );
  try {
    const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
    if (argCountError) {
      _finishInvocationBuffer(invocationBuffer);
      return argCountError;
    }
    return _invokeMethodEntry(
      methodEntry,
      context,
      inheritanceState,
      args,
      env,
      runtime,
      cb,
      invocationBuffer,
      errorContext,
      currentPayload
    );
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw _contextualizeRuntimeFatalError(err, errorContext);
    }
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

function _admitKnownMethodWithTrackedCompletion(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const invocationBuffer = _createMethodInvocationBuffer(
    currentBuffer,
    context,
    methodEntry && methodEntry.linkedChannels
  );
  const readRegistrationState = () => ({
    promise: context && context.asyncExtendsBlocksPromise
      ? context.asyncExtendsBlocksPromise
      : null,
    count: context && typeof context.asyncExtendsBlocksPendingCount === 'number'
      ? context.asyncExtendsBlocksPendingCount
      : 0
  });
  const priorRegistration = readRegistrationState();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const finishAfterRegistration = (registrationPromise) => {
    if (!registrationPromise || typeof registrationPromise.then !== 'function') {
      _finishInvocationBuffer(invocationBuffer);
      resolveCompletion(undefined);
      return;
    }
    resolveCompletion(registrationPromise.then(
      () => {
        _finishInvocationBuffer(invocationBuffer);
      },
      (err) => {
        _finishInvocationBuffer(invocationBuffer);
        throw err;
      }
    ));
  };
  const finishEarly = (result) => {
    _finishInvocationBuffer(invocationBuffer);
    resolveCompletion(undefined);
    return result;
  };
  const value = Promise.resolve().then(() => {
    const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
    if (argCountError) {
      return finishEarly(argCountError);
    }

    const result = _invokeMethodEntry(
      methodEntry,
      context,
      inheritanceState,
      args,
      env,
      runtime,
      cb,
      invocationBuffer,
      errorContext,
      currentPayload,
      false
    );

    // The compiled constructor/method body installs any nested extends
    // boundary synchronously while it is executing, so reading the legacy
    // registration promise/count immediately after the invocation is enough
    // to detect whether this admission started new registration work.
    const nextRegistration = readRegistrationState();
    const startedOwnRegistration = !!nextRegistration.promise && (
      nextRegistration.promise !== priorRegistration.promise ||
      nextRegistration.count > priorRegistration.count
    );
    finishAfterRegistration(startedOwnRegistration ? nextRegistration.promise : null);
    return result;
  })
    .catch((err) => {
      _finishInvocationBuffer(invocationBuffer);
      rejectCompletion(err);
      throw err;
    });

  return {
    value,
    completion
  };
}

function _admitKnownMethodValue(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
  if (argCountError) {
    return argCountError;
  }

  return _invokeMethodEntry(
    methodEntry,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    _createMethodInvocationBuffer(
      currentBuffer,
      context,
      methodEntry && methodEntry.linkedChannels
    ),
    errorContext,
    currentPayload
  );
}

function _admitKnownMethodWithBufferCompletion(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const invocationBuffer = _createMethodInvocationBuffer(
    currentBuffer,
    context,
    methodEntry && methodEntry.linkedChannels
  );
  const finishEarly = (value) => {
    _finishInvocationBuffer(invocationBuffer);
    return _createSettledMethodAdmission(value);
  };

  if (!_hasAsyncMethodArgs(args)) {
    const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
    if (argCountError) {
      return finishEarly(argCountError);
    }
    return {
      value: _invokeMethodEntry(
        methodEntry,
        context,
        inheritanceState,
        args,
        env,
        runtime,
        cb,
        invocationBuffer,
        errorContext,
        currentPayload
      ),
      completion: _createMethodCompletion(invocationBuffer)
    };
  }

  const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
  if (argCountError) {
    return finishEarly(argCountError);
  }

  return {
    value: Promise.resolve().then(() =>
      _invokeMethodEntry(
        methodEntry,
        context,
        inheritanceState,
        args,
        env,
        runtime,
        cb,
        invocationBuffer,
        errorContext,
        currentPayload
      )
    )
      .catch((err) => {
        _finishInvocationBuffer(invocationBuffer);
        throw err;
      }),
    completion: _createMethodCompletion(invocationBuffer)
  };
}

async function _admitDeferredMethodEntry(resolveEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null, invocationBufferOverride = null) {
  const overrideInvocationBuffer = invocationBufferOverride || null;
  try {
    const methodEntry = (await _resolveDispatchedValue((() => {
      try {
        return resolveEntry();
      } catch (err) {
        if (err instanceof RuntimeFatalError) {
          throw _contextualizeRuntimeFatalError(err, errorContext);
        }
        return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      }
    })(), errorContext)).value;
    if (isPoison(methodEntry)) {
      _finishInvocationBuffer(overrideInvocationBuffer);
      return _createSettledMethodAdmission(methodEntry);
    }

    const argCountError = _validateMethodArgCount(methodEntry, args, name, errorContext);
    if (argCountError) {
      _finishInvocationBuffer(overrideInvocationBuffer);
      return _createSettledMethodAdmission(argCountError);
    }

    const activeInvocationBuffer = overrideInvocationBuffer || _createMethodInvocationBuffer(
      currentBuffer,
      context,
      methodEntry && methodEntry.linkedChannels
    );
    return {
      value: _invokeMethodEntry(
        methodEntry,
        context,
        inheritanceState,
        args,
        env,
        runtime,
        cb,
        activeInvocationBuffer,
        errorContext,
        currentPayload
      ),
      completion: activeInvocationBuffer && typeof activeInvocationBuffer.getFinishCompletePromise === 'function'
        ? activeInvocationBuffer.getFinishCompletePromise()
        : Promise.resolve()
    };
  } catch (err) {
    _finishInvocationBuffer(overrideInvocationBuffer);
    if (err instanceof RuntimeFatalError) {
      throw _contextualizeRuntimeFatalError(err, errorContext);
    }
    throw err;
  }
}

function _dispatchMethodCall(getImmediateMethodEntry, resolveMethodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const poisonedArgs = _mergePoisonedArgs(args);
  if (poisonedArgs && !_hasAsyncMethodArgs(args)) {
    return poisonedArgs;
  }
  const immediateMethodEntry = getImmediateMethodEntry();
  if (immediateMethodEntry) {
    if (!_hasAsyncMethodArgs(args)) {
      return _invokeImmediateMethodEntry(
        immediateMethodEntry,
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
      );
    }
    return _admitDirectMethod(
      immediateMethodEntry,
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
    );
  }
  return _enqueueDeferredMethodAdmission(
    currentBuffer,
    context,
    inheritanceState,
    (admissionBuffer) => _admitDeferredMethodEntry(
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
      currentPayload,
      admissionBuffer
    )
  );
}

function _admitDirectMethod(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  return _admitKnownMethodValue(
    methodEntry,
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
  );
}

function _admitDirectMethodWithCompletion(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const poisonedArgs = _mergePoisonedArgs(args);
  if (poisonedArgs && !_hasAsyncMethodArgs(args)) {
    return _createSettledMethodAdmission(poisonedArgs);
  }
  return _admitKnownMethodWithTrackedCompletion(
    methodEntry,
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
  );
}

function callInheritedMethod(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  return _dispatchMethodCall(
    () => inheritanceState && typeof inheritanceState.getImmediateInheritedMethodEntry === 'function'
      ? inheritanceState.getImmediateInheritedMethodEntry(name)
      : null,
    () => inheritanceState.resolveInheritedMethodEntry(context, name),
    name,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext
  );
}

function callInheritedMethodDetailed(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  const poisonedArgs = _mergePoisonedArgs(args);
  if (poisonedArgs && !_hasAsyncMethodArgs(args)) {
    return Promise.resolve(poisonedArgs);
  }

  const immediateMethodEntry = inheritanceState && typeof inheritanceState.getImmediateInheritedMethodEntry === 'function'
    ? inheritanceState.getImmediateInheritedMethodEntry(name)
    : null;
  if (immediateMethodEntry) {
    return _awaitMethodAdmissionResult(_admitKnownMethodWithBufferCompletion(
      immediateMethodEntry,
      name,
      context,
      inheritanceState,
      args,
      env,
      runtime,
      cb,
      currentBuffer,
      errorContext
    ));
  }

  return _awaitMethodAdmissionResult(_admitDeferredMethodEntry(
    () => inheritanceState.resolveInheritedMethodEntry(context, name),
    name,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext
  ));
}

function callSuperMethod(context, inheritanceState, name, ownerKey, args, env, runtime, cb, currentBuffer, currentPayload, errorContext) {
  return _dispatchMethodCall(
    () => inheritanceState && typeof inheritanceState.getImmediateSuperMethodEntry === 'function'
      ? inheritanceState.getImmediateSuperMethodEntry(name, ownerKey)
      : null,
    () => inheritanceState.resolveSuperMethodEntry(context, name, ownerKey),
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
  );
}

function admitMethodEntry(context, inheritanceState, methodEntry, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  return _admitDirectMethodWithCompletion(
    methodEntry,
    '__constructor__',
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    currentPayload
  ).value;
}

function admitMethodEntryWithCompletion(context, inheritanceState, methodEntry, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  return _admitDirectMethodWithCompletion(
    methodEntry,
    '__constructor__',
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    currentPayload
  );
}

module.exports = {
  admitMethodEntry,
  admitMethodEntryWithCompletion,
  callInheritedMethod,
  callInheritedMethodDetailed,
  callSuperMethod
};
