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

async function bootstrapInheritanceParentScript(
  scriptOrPromise,
  compositionPayload,
  context,
  env,
  runtimeApi,
  cb,
  currentBuffer,
  inheritanceStateValue
) {
  const parentScript = await runtimeApi.resolveSingle(scriptOrPromise);
  if (parentScript === null || parentScript === undefined) {
    return null;
  }

  parentScript.compile();

  const parentContext = compositionPayload
    ? context.forkForComposition(
        parentScript.path,
        compositionPayload.rootContext || {},
        context.getRenderContextVariables(),
        compositionPayload.externContext || {}
      )
    : context.forkForPath(parentScript.path);

  if (typeof parentScript.setupRenderFunc !== 'function') {
    throw new Error('Parent script did not expose a compiled setupRenderFunc');
  }

  runtimeApi.bootstrapInheritanceMetadata(
    inheritanceStateValue,
    parentScript.methods || {},
    parentScript.sharedSchema || {},
    currentBuffer,
    parentContext
  );
  if (!parentScript.hasExtends) {
    runtimeApi.finalizeInheritanceMetadata(inheritanceStateValue, parentContext);
  }

  const startupPromise = runtimeApi.runCompiledRootStartup(
    parentScript.setupRenderFunc,
    parentScript.methods || {},
    inheritanceStateValue,
    env,
    parentContext,
    runtimeApi,
    cb,
    currentBuffer,
    null,
    { resolveExports: true }
  );

  if (startupPromise && typeof startupPromise.then === 'function') {
    await startupPromise;
  }

  return currentBuffer;
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

function runCompiledRootStartup(
  setupRenderFunc,
  compiledMethods,
  inheritanceStateValue,
  env,
  context,
  runtime,
  cb,
  output,
  extendsState = null,
  options = null
) {
  const opts = options && typeof options === 'object' ? options : {};
  let startupPromise = null;

  if (typeof setupRenderFunc === 'function') {
    startupPromise = setupRenderFunc(
      env,
      context,
      runtime,
      cb,
      output,
      inheritanceStateValue,
      extendsState
    );
  }

  startupPromise = startInheritanceRootConstructor(
    compiledMethods,
    inheritanceStateValue,
    env,
    context,
    runtime,
    cb,
    output,
    extendsState,
    startupPromise
  );

  if (opts.resolveExports && !runtime.isInheritanceCompositionMode(inheritanceStateValue, runtime.COMPONENT_COMPOSITION_MODE)) {
    context.resolveExports();
  }

  return startupPromise;
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
  bootstrapInheritanceParentScript,
  invokeLocalRootConstructor,
  startInheritanceRootConstructor,
  runCompiledRootStartup,
  renderInheritanceParentRoot,
  waitForParentRootRender,
  linkCurrentBufferToParentChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
