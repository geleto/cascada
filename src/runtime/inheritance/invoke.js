// Dispatches finalized inherited callables.
// Validates arguments, creates invocation buffers, links channels, and runs the
// callable body.

import {RuntimeFatalError} from '../errors.js';

/*
// Runtime method entry after finalization.
type RuntimeMethodEntry = {
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  super: RuntimeMethodEntry | null, // owner-relative parent method
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}
*/

function invokeInheritedCallable(inheritanceState, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const method = getMethod(inheritanceState, methodName, errorContext, context);
  const values = Array.isArray(args) ? args : [];
  validateZeroArgOnlyInvocation(methodName, method, values, errorContext, context);

  // Temporary direct call until invocation commands own admission.
  return method.fn(
    env,
    context,
    runtime,
    cb,
    currentBuffer,
    { originalArgs: {} },
    context?.getRenderContextVariables ? context.getRenderContextVariables() : undefined,
    inheritanceState,
    method
  );
}

function invokeSuperCallable() {
  // Temporary until owner-relative super links are finalized.
  throw new RuntimeFatalError(
    'super() is not implemented yet',
    0,
    0,
    null,
    null
  );
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

// Temporary until inherited callable arguments are implemented.
function validateZeroArgOnlyInvocation(methodName, method, values, errorContext, context) {
  const argNames = method.signature?.argNames || [];
  if (argNames.length > 0 || values.length > 0) {
    throw createRuntimeError(
      `Inherited callable "${methodName}" arguments are not implemented yet`,
      errorContext,
      context
    );
  }
}

function getChannelFootprint(methodData, fieldName, errorContext) {
  const value = methodData && methodData[fieldName];
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
