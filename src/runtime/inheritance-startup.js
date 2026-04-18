'use strict';

// Inheritance startup orchestration.
// Owns parent constructor startup, context forking, and completion timing for
// entering an already-bootstrapped parent hierarchy.

const inheritanceBootstrap = require('./inheritance-bootstrap');
const inheritanceCall = require('./inheritance-call');

function _forkContextForParent(parentTemplate, registrationContext, compositionPayload) {
  const parentPath = parentTemplate && parentTemplate.path ? parentTemplate.path : null;
  if (!registrationContext || typeof registrationContext.forkForPath !== 'function') {
    return registrationContext;
  }
  if (!compositionPayload) {
    return registrationContext.forkForPath(parentPath);
  }
  return registrationContext.forkForComposition(
    parentPath,
    compositionPayload.rootContext,
    registrationContext.getRenderContextVariables(),
    compositionPayload.externContext
  );
}

function _startDynamicParentConstructor(parentTemplate, registrationContext, compositionPayload, inheritanceState, env, runtime, cb, currentBuffer, shouldAwaitCompletion = false) {
  const parentContext = _forkContextForParent(parentTemplate, registrationContext, compositionPayload);
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

function bootstrapResolvedHierarchyTarget({
  targetTemplate,
  registrationContext,
  constructorContext = registrationContext,
  inputValues = null,
  inputOperationName = 'extends',
  inheritanceState,
  env,
  runtime,
  cb,
  currentBuffer,
  errorContext,
  shouldAwaitCompletion = false
}) {
  inheritanceBootstrap.bootstrapInheritanceMetadata(
    inheritanceState,
    targetTemplate && targetTemplate.methods ? targetTemplate.methods : {},
    targetTemplate && targetTemplate.sharedSchema ? targetTemplate.sharedSchema : [],
    currentBuffer,
    registrationContext
  );
  if (inputValues && typeof inputValues === 'object' && Object.keys(inputValues).length > 0) {
    inheritanceBootstrap.preloadSharedInputs(
      targetTemplate && targetTemplate.sharedSchema ? targetTemplate.sharedSchema : [],
      inputValues,
      currentBuffer,
      registrationContext,
      errorContext,
      inputOperationName
    );
  }
  inheritanceBootstrap.ensureCurrentBufferSharedLinks(
    targetTemplate && targetTemplate.sharedSchema ? targetTemplate.sharedSchema : [],
    currentBuffer
  );
  const admission = inheritanceCall.admitConstructorEntry(
    constructorContext,
    inheritanceState,
    targetTemplate && targetTemplate.methods ? targetTemplate.methods.__constructor__ : null,
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

function _startStaticParentConstructor(parentTemplate, registrationContext, compositionPayload, inheritanceState, env, runtime, cb, currentBuffer, errorContext, shouldAwaitCompletion = false) {
  const parentContext = _forkContextForParent(parentTemplate, registrationContext, compositionPayload);
  return bootstrapResolvedHierarchyTarget({
    targetTemplate: parentTemplate,
    registrationContext,
    constructorContext: parentContext,
    inheritanceState,
    env,
    runtime,
    cb,
    currentBuffer,
    errorContext,
    shouldAwaitCompletion
  });
}

function startParentConstructor(parentTemplate, registrationContext, compositionPayload, inheritanceState, env, runtime, cb, currentBuffer, errorContext, shouldAwaitCompletion = false) {
  if (parentTemplate && parentTemplate.hasDynamicExtends) {
    return _startDynamicParentConstructor(
      parentTemplate,
      registrationContext,
      compositionPayload,
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
    compositionPayload,
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
  bootstrapResolvedHierarchyTarget,
  startParentConstructor
};
