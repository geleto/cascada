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

function _startStaticParentConstructor(parentTemplate, registrationContext, compositionPayload, inheritanceState, env, runtime, cb, currentBuffer, errorContext, shouldAwaitCompletion = false) {
  const parentContext = _forkContextForParent(parentTemplate, registrationContext, compositionPayload);
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
  const admission = inheritanceCall.admitConstructorEntry(
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
  startParentConstructor
};
