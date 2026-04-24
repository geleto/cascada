'use strict';

const inheritanceState = require('./inheritance-state');
const inheritanceCall = require('./inheritance-call');

function bootstrapInheritanceMetadata(
  stateValue,
  methods,
  sharedSchema,
  invokedMethods = Object.create(null),
  currentBuffer = null,
  context = null
) {
  if (!stateValue || typeof stateValue !== 'object') {
    throw new Error('bootstrapInheritanceMetadata requires an existing inheritance state');
  }
  const state = stateValue;
  inheritanceState.beginInheritanceMetadataReadiness(state);
  if (!state.sharedRootBuffer) {
    state.sharedRootBuffer = currentBuffer || null;
  }
  const shouldLinkNewSharedChannels =
    state.sharedRootBuffer &&
    currentBuffer &&
    state.sharedRootBuffer !== currentBuffer &&
    sharedSchema &&
    typeof sharedSchema === 'object';
  let previousSharedNames = null;
  if (shouldLinkNewSharedChannels) {
    const previousSharedSchema = state.sharedSchema && typeof state.sharedSchema === 'object'
      ? state.sharedSchema
      : {};
    previousSharedNames = Object.keys(previousSharedSchema).reduce((acc, name) => {
      acc[name] = true;
      return acc;
    }, Object.create(null));
  }
  inheritanceState.registerInheritanceSharedSchema(state, sharedSchema, context);
  if (shouldLinkNewSharedChannels) {
    const newlyRegisteredChannels = Object.keys(sharedSchema).filter((name) =>
      !previousSharedNames || !previousSharedNames[name]
    );
    linkCurrentBufferToParentChannels(
      state.sharedRootBuffer,
      currentBuffer,
      newlyRegisteredChannels
    );
  }
  inheritanceState.registerInheritanceMethods(state, methods, context);
  inheritanceState.registerInheritanceInvokedMethods(state, invokedMethods, context);
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
  const chainToken = inheritanceState.enterInheritanceChainPath(
    inheritanceStateValue,
    parentTemplate.path,
    context
  );

  let leaveChainPathOnReturn = true;
  try {
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
    if (parentCompositionMode === runtimeApi.COMPONENT_COMPOSITION_MODE) {
      const startupPromise = inheritanceState.awaitInheritanceStartup(inheritanceStateValue);
      if (startupPromise && typeof startupPromise.then === 'function') {
        leaveChainPathOnReturn = false;
        startupPromise.then(
          () => inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken),
          () => inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken)
        );
      }
    }
    await waitForParentRootRender(
      parentOutputBuffer,
      currentBuffer,
      inheritanceStateValue,
      parentCompositionMode
    );
    return parentOutputBuffer;
  } finally {
    if (leaveChainPathOnReturn) {
      inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken);
    }
  }
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
  const chainToken = inheritanceState.enterInheritanceChainPath(
    inheritanceStateValue,
    parentScript.path,
    context
  );

  try {
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
      parentScript.invokedMethods || {},
      currentBuffer,
      parentContext
    );
    if (!parentScript.hasExtends) {
      runtimeApi.finalizeInheritanceMetadata(inheritanceStateValue, parentContext);
      // Give metadata-ready waiters released by finalization one turn to
      // enqueue before this parent starts constructor/startup work.
      await Promise.resolve();
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
  } finally {
    inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken);
  }
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
  if (!hasLocalConstructor) {
    inheritanceState.setInheritanceStartupPromise(inheritanceStateValue, currentStartupPromise);
    return currentStartupPromise && typeof currentStartupPromise.then === 'function'
      ? currentStartupPromise
      : null;
  }

  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  // The readiness `.then` intentionally makes even a synchronous constructor
  // participate in startup merging when metadata is still being finalized.
  let constructorResult = metadataReadyPromise && typeof metadataReadyPromise.then === 'function'
    ? metadataReadyPromise.then(() =>
        localEntry.fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState)
      )
    : localEntry.fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState);
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
  const metadataReadyYield = inheritanceState.consumeInheritanceMetadataReadyYield(inheritanceStateValue);
  if (metadataReadyYield && typeof metadataReadyYield.then === 'function') {
    return metadataReadyYield.then(() => runCompiledRootStartup(
      setupRenderFunc,
      compiledMethods,
      inheritanceStateValue,
      env,
      context,
      runtime,
      cb,
      output,
      extendsState,
      options
    ));
  }

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
  if (startupPromise && typeof startupPromise.then === 'function') {
    inheritanceState.setInheritanceStartupPromise(inheritanceStateValue, startupPromise);
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
    if (inheritanceCall.hasLinkedChannelPath(parentBuffer, currentBuffer, channelName)) {
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
  if (inheritanceState.isInheritanceMetadataReadinessResolved(state)) {
    return state;
  }
  try {
    const structuralErrors = [];

    // Phase 1: validate chain-level structural metadata before building resolved
    // callable data. Later phases assume missing methods/super targets are known.
    inheritanceState.ensureInheritanceSharedSchemaTable(state);
    inheritanceState.finalizeInheritanceMethods(state, context, structuralErrors);

    // Phase 2: build direct resolved method metadata and file-level invoked
    // catalogs from one recursive construction path, then compute final
    // transitive channel footprints from that resolved graph.
    const errorContext = {
      path: context && context.path ? context.path : null
    };
    inheritanceCall.finalizeResolvedMethodMetadata(state, errorContext, structuralErrors);
    if (structuralErrors.length > 0) {
      const aggregateError = inheritanceState.createInheritanceMetadataAggregateError(structuralErrors, context);
      throw aggregateError || structuralErrors[0];
    }
    inheritanceState.resolveInheritanceMetadataReadiness(state, state);
    return state;
  } catch (error) {
    inheritanceState.rejectInheritanceMetadataReadiness(state, error);
    throw error;
  }
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
