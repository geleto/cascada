// Dispatches finalized inherited callables.
// Validates arguments and calls the compiled callable body.
// Invocation commands will replace the temporary direct call path.

import {RuntimeFatalError} from '../errors.js';

/*
// Runtime method entry after finalization.
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  super: RuntimeMethodEntry | null, // owner-relative parent method
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}

// Runtime invocation arguments before mapping into block/method locals.
type InvocationArgs = {
  values: unknown[],
  names: string[] | null // named placement binding names, or null for positional calls
}
*/

function invokeInheritedCallable(inheritanceState, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const method = getMethod(inheritanceState, methodName, errorContext, context);
  const invocationArgs = normalizeInvocationArgs(methodName, args, errorContext, context);
  return invokeMethod(inheritanceState, method, invocationArgs, context, env, runtime, cb, currentBuffer, errorContext);
}

function invokeSuperCallable(inheritanceState, methodData, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  if (!inheritanceState || !inheritanceState.finalized) {
    throw createRuntimeError(
      'super() requires finalized inheritance metadata',
      errorContext,
      context
    );
  }
  if (!methodData || methodData.name !== methodName) {
    throw createRuntimeError(
      `super() called from unexpected callable context for "${methodName}"`,
      errorContext,
      context
    );
  }
  if (!methodData.super) {
    throw createRuntimeError(
      `super() has no parent implementation for "${methodName}"`,
      errorContext,
      context
    );
  }
  const invocationArgs = normalizeInvocationArgs(methodName, args, errorContext, context);
  return invokeMethod(inheritanceState, methodData.super, invocationArgs, context, env, runtime, cb, currentBuffer, errorContext);
}

function getCallableLinkedChannels(methodData, errorContext = null) {
  return getChannelFootprint(methodData, 'mergedLinkedChannels', errorContext);
}

function getCallableMutatedChannels(methodData, errorContext = null) {
  return getChannelFootprint(methodData, 'mergedMutatedChannels', errorContext);
}

function getMethod(inheritanceState, methodName, errorContext, context) {
  if (!inheritanceState || !inheritanceState.finalized) {
    throw createRuntimeError(
      'Inherited callable dispatch requires finalized inheritance metadata',
      errorContext,
      context
    );
  }

  const method = inheritanceState.methods[methodName];
  if (!method) {
    throw createRuntimeError(
      `Missing inherited callable "${methodName}"`,
      errorContext,
      context
    );
  }
  return method;
}

function normalizeInvocationArgs(methodName, args, errorContext, context) {
  if (Array.isArray(args)) {
    return { values: args, names: null };
  }
  if (args && typeof args === 'object') {
    if (!Array.isArray(args.values)) {
      throw createRuntimeError(
        `Inherited callable "${methodName}" received invalid argument metadata`,
        errorContext,
        context
      );
    }
    if (args.names !== null && args.names !== undefined && !Array.isArray(args.names)) {
      throw createRuntimeError(
        `Inherited callable "${methodName}" received invalid argument names`,
        errorContext,
        context
      );
    }
    return {
      values: args.values,
      names: args.names ?? null
    };
  }
  throw createRuntimeError(
    `Inherited callable "${methodName}" received invalid argument payload`,
    errorContext,
    context
  );
}

function invokeMethod(inheritanceState, method, invocationArgs, context, env, runtime, cb, currentBuffer, errorContext) {
  const payload = createInvocationPayload(method.name, method, invocationArgs, errorContext, context);

  // Temporary direct call until invocation commands own admission.
  return method.fn(
    env,
    context,
    runtime,
    cb,
    currentBuffer,
    payload,
    context?.getRenderContextVariables ? context.getRenderContextVariables() : undefined,
    inheritanceState,
    method
  );
}

function createInvocationPayload(methodName, method, invocationArgs, errorContext, context) {
  const values = invocationArgs.values;
  const names = invocationArgs.names;
  const argNames = method.signature.argNames;
  if (values.length > argNames.length) {
    throw createRuntimeError(
      `Inherited callable "${methodName}" received too many arguments`,
      errorContext,
      context
    );
  }
  if (values.length < argNames.length) {
    throw createRuntimeError(
      `Inherited callable "${methodName}" received too few arguments`,
      errorContext,
      context
    );
  }
  if (names && names.length !== values.length) {
    throw createRuntimeError(
      `Inherited callable "${methodName}" received mismatched argument metadata`,
      errorContext,
      context
    );
  }

  const originalArgs = {};
  if (names) {
    const expectedNames = new Set(argNames);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (Object.prototype.hasOwnProperty.call(originalArgs, name)) {
        throw createRuntimeError(
          `Inherited callable "${methodName}" received duplicate argument "${name}"`,
          errorContext,
          context
        );
      }
      if (!expectedNames.has(name)) {
        throw createRuntimeError(
          `Inherited callable "${methodName}" received unknown argument "${name}"`,
          errorContext,
          context
        );
      }
      originalArgs[name] = values[i];
    }
  } else {
    for (let i = 0; i < values.length; i++) {
      originalArgs[argNames[i]] = values[i];
    }
  }

  return { originalArgs };
}

function getChannelFootprint(methodData, fieldName, errorContext) {
  const value = methodData[fieldName];
  if (!Array.isArray(value)) {
    throw createRuntimeError(
      `Inherited callable metadata is missing ${fieldName}`,
      errorContext,
      null
    );
  }
  return value;
}

function createRuntimeError(message, errorContext, context) {
  return new RuntimeFatalError(
    message,
    errorContext?.lineno ?? 0,
    errorContext?.colno ?? 0,
    errorContext?.errorContextString ?? null,
    errorContext?.path ?? context?.path ?? null
  );
}

export {
  getCallableLinkedChannels,
  getCallableMutatedChannels,
  invokeInheritedCallable,
  invokeSuperCallable
};
