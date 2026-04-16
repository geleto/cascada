'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  handleError,
  RuntimePromise
} = require('./errors');
const { RESOLVE_MARKER, resolveAll } = require('./resolve');
const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');

/**
 * Sync call wrapper for templates.
 */
function callWrap(obj, name, context, args, currentBuffer = null) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                 !Object.prototype.hasOwnProperty.call(context.ctx, name);

  const executionContext = (obj.isMacro || isGlobal) ? context : context.ctx;
  if (obj.isMacro) {
    return obj._invoke(executionContext, args, currentBuffer);
  }
  return obj.apply(executionContext, args);
}

/**
 * Async call wrapper using sync-first hybrid pattern.
 */
function callWrapAsync(obj, name, context, args, errorContext, currentBuffer = null) {
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
    // _callWrapAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _callWrapAsyncComplex(obj, name, context, args, errorContext, currentBuffer);
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
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    const executionContext = isGlobal ? context : context.ctx;
    const result = obj.apply(executionContext, args);
    if (result && typeof result.then === 'function') {// && !isPoison(result)) {
      // add context to the promise that will be applied if it rejects
      return new RuntimePromise(result, errorContext);
    }
    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

async function _callWrapAsyncComplex(obj, name, context, args, errorContext, currentBuffer = null) {
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
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    const executionContext = isGlobal ? context : context.ctx;
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

function _hasAsyncArgs(args) {
  return Array.isArray(args) && args.some((arg) =>
    arg &&
    !isPoison(arg) &&
    (typeof arg.then === 'function' || arg[RESOLVE_MARKER])
  );
}

function _createMethodArgMap(contract, args) {
  const argMap = {};
  const inputNames = contract && Array.isArray(contract.inputNames) ? contract.inputNames : [];
  for (let i = 0; i < inputNames.length; i++) {
    argMap[inputNames[i]] = args[i];
  }
  return argMap;
}

function _prepareMethodInvocation(context, methodEntry, args, currentPayload = null) {
  const nextArgs = _createMethodArgMap(methodEntry && methodEntry.contract, args);
  if (currentPayload) {
    return context.createSuperInheritancePayload(currentPayload, nextArgs);
  }
  return context.createInheritancePayload(methodEntry && methodEntry.ownerKey, nextArgs, null);
}

function _getFallbackInvocationLinkedChannels(currentBuffer, inheritanceState = null) {
  const linkedChannels = new Set();
  if (currentBuffer && typeof currentBuffer._collectKnownChannelNames === 'function') {
    currentBuffer._collectKnownChannelNames()
      .filter((name) => name && name !== '__return__')
      .forEach((name) => linkedChannels.add(name));
  }
  if (inheritanceState && typeof inheritanceState.getRegisteredSharedChannelNames === 'function') {
    inheritanceState.getRegisteredSharedChannelNames()
      .filter((name) => name && name !== '__return__')
      .forEach((name) => linkedChannels.add(name));
  }
  return linkedChannels.size > 0 ? Array.from(linkedChannels) : null;
}

function _finishMethodInvocationBuffer(currentBuffer) {
  if (!currentBuffer || !currentBuffer.parent || typeof currentBuffer.markFinishedAndPatchLinks !== 'function') {
    return null;
  }
  currentBuffer.markFinishedAndPatchLinks();
}

function _createMethodInvocationParent(currentBuffer, context, inheritanceState = null, linkedChannels = null) {
  if (!isCommandBuffer(currentBuffer)) {
    return currentBuffer;
  }
  const invocationLinkedChannels =
    Array.isArray(linkedChannels)
      ? linkedChannels
      : _getFallbackInvocationLinkedChannels(currentBuffer, inheritanceState);
  return createCommandBuffer(
    currentBuffer._context || context,
    currentBuffer,
    invocationLinkedChannels,
    currentBuffer
  );
}

function _invokeMethodEntry(methodEntry, context, inheritanceState, args, env, runtime, cb, currentBuffer, currentPayload = null) {
  const payload = _prepareMethodInvocation(context, methodEntry, args, currentPayload);
  const preparedPayload = context.prepareInheritancePayloadForBlock(methodEntry.fn, payload);
  const renderCtx = methodEntry && methodEntry.contract && methodEntry.contract.withContext
    ? context.getRenderContextVariables()
    : undefined;
  return methodEntry.fn(env, context, runtime, cb, currentBuffer, inheritanceState, preparedPayload, renderCtx);
}

function _validateInheritedMethodArgCount(methodEntry, args, name, errorContext) {
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

function _mergePoisonArgs(args) {
  const poisonedArgs = Array.isArray(args) ? args.filter(isPoison) : [];
  if (poisonedArgs.length === 0) {
    return null;
  }
  if (poisonedArgs.length === 1) {
    return poisonedArgs[0];
  }
  return createPoison(poisonedArgs.flatMap((value) => value.errors));
}

async function _callInheritedMethodAsync(resolveEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const errors = [];
  let resolvedArgs = args;

  try {
    try {
      resolvedArgs = await resolveAll(args);
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path));
      }
    }

    if (errors.length > 0) {
      return createPoison(errors);
    }

    let methodEntry;
    try {
      methodEntry = await resolveEntry();
    } catch (err) {
      return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
    }

    const argCountError = _validateInheritedMethodArgCount(methodEntry, resolvedArgs, name, errorContext);
    if (argCountError) {
      return argCountError;
    }
    const result = _invokeMethodEntry(methodEntry, context, inheritanceState, resolvedArgs, env, runtime, cb, currentBuffer, currentPayload);
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext);
    }
    return result;
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  } finally {
    _finishMethodInvocationBuffer(currentBuffer);
  }
}

function _callInheritedMethodCommon(resolveImmediateEntry, resolveEntry, name, context, inheritanceState, args, env, runtime, cb, currentBuffer, errorContext, currentPayload = null) {
  const poisonedArgs = _mergePoisonArgs(args);
  if (poisonedArgs && !_hasAsyncArgs(args)) {
    return poisonedArgs;
  }

  const immediateEntry = resolveImmediateEntry();
  const invocationParent = _createMethodInvocationParent(
    currentBuffer,
    context,
    inheritanceState,
    immediateEntry && immediateEntry.linkedChannels
  );
  if (immediateEntry && !_hasAsyncArgs(args)) {
    try {
      const argCountError = _validateInheritedMethodArgCount(immediateEntry, args, name, errorContext);
      if (argCountError) {
        return argCountError;
      }
      const result = _invokeMethodEntry(immediateEntry, context, inheritanceState, args, env, runtime, cb, invocationParent, currentPayload);
      if (result && typeof result.then === 'function') {
        return new RuntimePromise(result, errorContext);
      }
      return result;
    } catch (err) {
      return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
    } finally {
      _finishMethodInvocationBuffer(invocationParent);
    }
  }

  return _callInheritedMethodAsync(resolveEntry, name, context, inheritanceState, args, env, runtime, cb, invocationParent, errorContext, currentPayload);
}

function callInheritedMethod(context, inheritanceState, name, args, env, runtime, cb, currentBuffer, errorContext) {
  return _callInheritedMethodCommon(
    () => inheritanceState.getImmediateInheritedMethodEntry(name),
    () => inheritanceState.resolveInheritedMethodEntry(context, name),
    name,
    context,
    inheritanceState,
    args,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    null
  );
}

function callSuperMethod(context, inheritanceState, name, ownerKey, args, env, runtime, cb, currentBuffer, currentPayload, errorContext) {
  return _callInheritedMethodCommon(
    () => inheritanceState.getImmediateSuperMethodEntry(name, ownerKey),
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

module.exports = {
  callWrap,
  callWrapAsync,
  callInheritedMethod,
  callSuperMethod
};
