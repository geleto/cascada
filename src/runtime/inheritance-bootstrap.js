'use strict';

const inheritanceState = require('./inheritance-state');

function bootstrapInheritanceMetadata(stateValue, methods, sharedSchema, currentBuffer, context = null) {
  if (!stateValue || typeof stateValue !== 'object') {
    throw new Error('bootstrapInheritanceMetadata requires an existing inheritance state');
  }
  const state = stateValue;
  if (!state.sharedRootBuffer) {
    state.sharedRootBuffer = currentBuffer || null;
  }
  inheritanceState.registerInheritanceSharedSchema(state, sharedSchema, context);
  if (
    state.sharedRootBuffer &&
    currentBuffer &&
    state.sharedRootBuffer !== currentBuffer &&
    sharedSchema &&
    typeof sharedSchema === 'object'
  ) {
    linkCurrentBufferToParentChannels(
      state.sharedRootBuffer,
      currentBuffer,
      Object.keys(sharedSchema)
    );
  }
  inheritanceState.registerInheritanceMethods(state, methods);
  return state;
}

async function waitForParentRootRender(parentOutputBuffer, currentBuffer, inheritanceStateValue, compositionMode) {
  if (compositionMode === inheritanceState.COMPONENT_COMPOSITION_MODE) {
    return parentOutputBuffer;
  }

  if (parentOutputBuffer === currentBuffer) {
    const startupPromise = inheritanceState.awaitInheritanceStartup(inheritanceStateValue);
    if (startupPromise) {
      await startupPromise;
    }
    return parentOutputBuffer;
  }

  if (parentOutputBuffer && typeof parentOutputBuffer.getFinishedPromise === 'function') {
    await parentOutputBuffer.getFinishedPromise();
  }

  return parentOutputBuffer;
}

async function renderInheritanceParentRoot(
  templateOrPromise,
  compositionPayload,
  context,
  env,
  runtimeApi,
  cb,
  currentBuffer,
  inheritanceStateValue
) {
  const parentTemplate = await runtimeApi.resolveSingle(templateOrPromise);
  if (parentTemplate === null || parentTemplate === undefined) {
    return null;
  }

  parentTemplate.compile();

  const parentContext = compositionPayload
    ? context.forkForComposition(
        parentTemplate.path,
        compositionPayload.rootContext || {},
        context.getRenderContextVariables(),
        compositionPayload.externContext || {}
      )
    : context.forkForPath(parentTemplate.path);
  const parentCompositionMode = inheritanceState.isInheritanceCompositionMode(
    inheritanceStateValue,
    runtimeApi.COMPONENT_COMPOSITION_MODE
  ) ? runtimeApi.COMPONENT_COMPOSITION_MODE : true;
  const parentOutputBuffer = parentTemplate.rootRenderFunc(
    env,
    parentContext,
    runtimeApi,
    cb,
    parentCompositionMode,
    currentBuffer,
    inheritanceStateValue
  );
  await waitForParentRootRender(
    parentOutputBuffer,
    currentBuffer,
    inheritanceStateValue,
    parentCompositionMode
  );
  return parentOutputBuffer;
}

function getLocalRootConstructorEntry(compiledMethods) {
  const methods = compiledMethods && typeof compiledMethods === 'object' ? compiledMethods : null;
  return methods && Object.prototype.hasOwnProperty.call(methods, '__constructor__')
    ? methods.__constructor__
    : null;
}

function invokeLocalRootConstructor(compiledMethods, env, context, runtime, cb, output, inheritanceStateValue, extendsState = null) {
  const entry = getLocalRootConstructorEntry(compiledMethods);
  const fn = entry && entry.fn;
  if (typeof fn !== 'function') {
    return null;
  }
  return fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState);
}

function startInheritanceRootConstructor(
  compiledMethods,
  inheritanceStateValue,
  env,
  context,
  runtime,
  cb,
  output,
  extendsState = null,
  currentStartupPromise = null
) {
  const localEntry = getLocalRootConstructorEntry(compiledMethods);
  const hasLocalConstructor = !!(localEntry && typeof localEntry.fn === 'function');
  let constructorResult = hasLocalConstructor
    ? localEntry.fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState)
    : null;
  if (constructorResult && typeof constructorResult.then === 'function') {
    return inheritanceState.mergeInheritanceStartupPromise(
      inheritanceStateValue,
      constructorResult,
      currentStartupPromise
    );
  }
  inheritanceState.setInheritanceStartupPromise(inheritanceStateValue, currentStartupPromise);
  return currentStartupPromise && typeof currentStartupPromise.then === 'function'
    ? currentStartupPromise
    : null;
}

function linkCurrentBufferToParentChannels(parentBuffer, currentBuffer, channelNames) {
  if (!parentBuffer || !currentBuffer || parentBuffer === currentBuffer || !Array.isArray(channelNames)) {
    return currentBuffer;
  }

  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
    if (!channelName) {
      continue;
    }
    if (
      typeof parentBuffer.hasLinkedBuffer === 'function' &&
      parentBuffer.hasLinkedBuffer(currentBuffer, channelName)
    ) {
      continue;
    }
    if (
      typeof parentBuffer.isFinished === 'function' &&
      (parentBuffer.isFinished(channelName) || parentBuffer.finished)
    ) {
      if (typeof currentBuffer._registerLinkedChannel === 'function') {
        currentBuffer._registerLinkedChannel(channelName);
      }
      continue;
    }
    if (typeof parentBuffer.addBuffer === 'function') {
      parentBuffer.addBuffer(currentBuffer, channelName);
    }
  }

  return currentBuffer;
}

function getInheritanceSharedBuffer(currentBuffer, inheritanceStateValue) {
  if (inheritanceStateValue && inheritanceStateValue.sharedRootBuffer) {
    return inheritanceStateValue.sharedRootBuffer;
  }
  return currentBuffer;
}

function finalizeInheritanceMetadata(state, context = null) {
  if (!state || typeof state !== 'object') {
    return state;
  }
  inheritanceState.finalizeInheritanceSharedSchema(state, context);
  inheritanceState.finalizeInheritanceMethods(state, context);
  return state;
}

module.exports = {
  bootstrapInheritanceMetadata,
  invokeLocalRootConstructor,
  startInheritanceRootConstructor,
  renderInheritanceParentRoot,
  waitForParentRootRender,
  linkCurrentBufferToParentChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
