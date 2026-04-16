'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  RuntimeFatalError,
  handleError,
  RuntimePromise
} = require('./errors');
const { RESOLVE_MARKER, resolveAll } = require('./resolve');
const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');

// Ordinary callable invocation

/**
 * Sync ordinary-callable wrapper for templates.
 */
function invokeCallable(obj, name, context, args, currentBuffer = null) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  const executionContext = _getCallableExecutionContext(obj, name, context);
  if (obj.isMacro) {
    return obj._invoke(executionContext, args, currentBuffer);
  }
  return obj.apply(executionContext, args);
}

/**
 * Async ordinary-callable wrapper using sync-first hybrid pattern.
 */
function invokeCallableAsync(obj, name, context, args, errorContext, currentBuffer = null) {
  if (obj && obj.isMacro) {
    // Macros are promise/poison-transparent Cascada boundaries. They receive
    // raw argument values and any thrown/rejected error must propagate as a
    // real fatal error rather than being normalized into FunCall poison here.
    return obj._invoke(context, args, currentBuffer);
  }

  // Check if we need async path: obj or any arg is a promise
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasAsyncArgs = Array.isArray(args) && args.some(arg =>
    arg &&
    !isPoison(arg) &&
    (typeof arg.then === 'function' || arg[RESOLVE_MARKER])
  );

  if (objIsPromise || hasAsyncArgs) {
    // Must use async path to await all promises before making decisions
    // _invokeCallableAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _invokeCallableAsyncComplex(obj, name, context, args, errorContext, currentBuffer);
  }

  // All values are non-promises - collect all errors synchronously
  const objPoison = isPoison(obj);
  const poisonedArgs = args.filter(isPoison);

  // Optimize: avoid creating new poison if only one source is poisoned
  if (objPoison && poisonedArgs.length === 0) {
    return obj; // Only obj is poisoned - return it directly
  } else if (!objPoison && poisonedArgs.length === 1) {
    return poisonedArgs[0]; // Only one arg is poisoned - return it directly
  } else if (objPoison || poisonedArgs.length > 0) {
    // Multiple sources poisoned - merge all errors
    const errors = [
      ...(objPoison ? obj.errors : []),
      ...poisonedArgs.flatMap(p => p.errors)
    ];
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - validate and call
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const executionContext = _getCallableExecutionContext(obj, name, context);
    const result = obj.apply(executionContext, args);
    if (result && typeof result.then === 'function') {
      // Add context to the promise so a rejection is contextualized later.
      return new RuntimePromise(result, errorContext);
    }
    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

async function _invokeCallableAsyncComplex(obj, name, context, args, errorContext, currentBuffer = null) {
  const errors = [];

  // Await obj if it's a promise and check for poison
  if (obj && typeof obj.then === 'function' && !isPoison(obj)) {
    try {
      obj = await obj;
      if (isPoison(obj)) {
        errors.push(...obj.errors);
      }
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        // Add context to the error when catching from await
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        errors.push(contextualError);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  if (obj && obj.isMacro) {
    // Macros are promise/poison-transparent Cascada boundaries. Keep promise-
    // valued args untouched and let any thrown/rejected error propagate as a
    // real fatal error to the nearest cb()-owning boundary.
    return obj._invoke(context, args, currentBuffer);
  }

  let resolvedArgs = args;
  try {
    resolvedArgs = await resolveAll(args);
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      errors.push(contextualError);
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }

  // All resolved successfully - validate and call the function
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const executionContext = _getCallableExecutionContext(obj, name, context);
    const result = obj.apply(executionContext, resolvedArgs);

    // Wrap promise results to preserve error context
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext);
    }

    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

function _getCallableExecutionContext(obj, name, context) {
  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
    !Object.prototype.hasOwnProperty.call(context.ctx, name);
  return (obj && obj.isMacro) || isGlobal ? context : context.ctx;
}

// Inheritance dispatch admission

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
  if (!admission || typeof admission.then !== 'function') {
    return admission && Object.prototype.hasOwnProperty.call(admission, 'value')
      ? admission.value
      : admission;
  }
  return admission.then((admissionResult) =>
    admissionResult && Object.prototype.hasOwnProperty.call(admissionResult, 'value')
      ? admissionResult.value
      : admissionResult
  );
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

function _invokeMethodEntry(methodEntry, context, inheritanceState, resolvedArgs, env, runtime, cb, invocationBuffer, errorContext, currentPayload = null) {
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
    _finishInvocationBuffer(invocationBuffer);
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
  const finishEarly = (result) => {
    resolveCompletion(undefined);
    _finishInvocationBuffer(invocationBuffer);
    return result;
  };
  const value = _resolveDispatchedValue(resolveAll(args), errorContext)
    .then((resolvedArgsResult) => {
      const resolvedArgs = resolvedArgsResult.value;
      if (isPoison(resolvedArgs)) {
        return finishEarly(resolvedArgs);
      }

      const argCountError = _validateMethodArgCount(methodEntry, resolvedArgs, name, errorContext);
      if (argCountError) {
        return finishEarly(argCountError);
      }

      const result = _invokeMethodEntry(
        methodEntry,
        context,
        inheritanceState,
        resolvedArgs,
        env,
        runtime,
        cb,
        invocationBuffer,
        errorContext,
        currentPayload
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
      resolveCompletion(startedOwnRegistration ? nextRegistration.promise : undefined);
      return result;
    })
    .catch((err) => {
      rejectCompletion(err);
      throw err;
    });

  return {
    value,
    completion: completion
  };
}

function _admitKnownMethodValue(methodEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  return _resolveDispatchedValue(resolveAll(args), errorContext)
    .then((resolvedArgsResult) => {
      const resolvedArgs = resolvedArgsResult.value;
      if (isPoison(resolvedArgs)) {
        return resolvedArgs;
      }

      const argCountError = _validateMethodArgCount(methodEntry, resolvedArgs, name, errorContext);
      if (argCountError) {
        return argCountError;
      }

      return _invokeMethodEntry(
        methodEntry,
        context,
        inheritanceState,
        resolvedArgs,
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
    });
}

async function _admitDeferredMethodEntry(resolveEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null, invocationBufferOverride = null) {
  const overrideInvocationBuffer = invocationBufferOverride || null;
  try {
    const resolvedArgs = (await _resolveDispatchedValue(resolveAll(args), errorContext)).value;
    if (isPoison(resolvedArgs)) {
      _finishInvocationBuffer(overrideInvocationBuffer);
      return _createSettledMethodAdmission(resolvedArgs);
    }

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

    const argCountError = _validateMethodArgCount(methodEntry, resolvedArgs, name, errorContext);
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
        resolvedArgs,
        env,
        runtime,
        cb,
        activeInvocationBuffer,
        errorContext,
        currentPayload
      ),
      completion: activeInvocationBuffer && typeof activeInvocationBuffer.getFinishedPromise === 'function'
        ? activeInvocationBuffer.getFinishedPromise()
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
  if (!_hasAsyncMethodArgs(args)) {
    return _invokeImmediateMethodEntry(
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
  return _admitDirectMethod(
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
  invokeCallable,
  invokeCallableAsync,
  callWrap: invokeCallable,
  callWrapAsync: invokeCallableAsync,
  admitMethodEntry,
  admitMethodEntryWithCompletion,
  callInheritedMethod,
  callSuperMethod
};
