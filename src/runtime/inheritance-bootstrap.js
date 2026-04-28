'use strict';

import inheritanceState from './inheritance-state.js';
import inheritanceCall from './inheritance-call.js';

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
    state.sharedRootBuffer = currentBuffer;
  }
  const shouldLinkNewSharedChannels =
    state.sharedRootBuffer &&
    currentBuffer &&
    state.sharedRootBuffer !== currentBuffer;
  let previousSharedNames = null;
  if (shouldLinkNewSharedChannels) {
    previousSharedNames = Object.keys(state.sharedSchema).reduce((acc, name) => {
      acc[name] = true;
      return acc;
    }, Object.create(null));
  }
  inheritanceState.registerInheritanceSharedSchema(state, sharedSchema, context);
  if (shouldLinkNewSharedChannels) {
    const newlyRegisteredChannels = Object.keys(sharedSchema).filter((name) =>
      !previousSharedNames[name]
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

async function waitForParentRootRender(parentOutputBuffer, currentBuffer, inheritanceStateValue, componentMode) {
  if (componentMode) {
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

async function renderInheritanceParentRoot(spec) {
  const {
    templateOrPromise,
    compositionPayload,
    context,
    env,
    runtime: runtimeApi,
    cb,
    currentBuffer,
    inheritanceState: inheritanceStateValue
  } = spec;
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
      ? context.forkForCompositionPayload(
        parentTemplate.path,
        compositionPayload,
        context.getRenderContextVariables()
      )
      : context.forkForPath(parentTemplate.path);
    const parentComponentMode = inheritanceState.isComponentCompositionMode(inheritanceStateValue);
    const parentOutputBuffer = parentTemplate.rootRenderFunc(
      env,
      parentContext,
      runtimeApi,
      cb,
      true,
      currentBuffer,
      inheritanceStateValue,
      parentComponentMode
    );
    if (parentComponentMode) {
      const startupPromise = inheritanceState.awaitInheritanceStartup(inheritanceStateValue);
      if (startupPromise) {
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
      parentComponentMode
    );
    return parentOutputBuffer;
  } finally {
    if (leaveChainPathOnReturn) {
      inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken);
    }
  }
}

async function bootstrapInheritanceParentScript(spec) {
  const {
    scriptOrPromise,
    compositionPayload,
    context,
    env,
    runtime: runtimeApi,
    cb,
    currentBuffer,
    inheritanceState: inheritanceStateValue
  } = spec;
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
      ? context.forkForCompositionPayload(
        parentScript.path,
        compositionPayload,
        context.getRenderContextVariables()
      )
      : context.forkForPath(parentScript.path);

    const parentInheritanceSpec = parentScript.inheritanceSpec;
    if (typeof parentInheritanceSpec.setup !== 'function') {
      throw new Error('Parent script did not expose a compiled setup function');
    }

    runtimeApi.bootstrapInheritanceMetadata(
      inheritanceStateValue,
      parentInheritanceSpec.methods,
      parentInheritanceSpec.sharedSchema,
      parentInheritanceSpec.invokedMethods,
      currentBuffer,
      parentContext
    );
    if (!parentInheritanceSpec.hasExtends) {
      runtimeApi.finalizeInheritanceMetadata(inheritanceStateValue, parentContext);
    }

    const startupPromise = runtimeApi.runCompiledRootStartup({
      setup: parentInheritanceSpec.setup,
      compiledMethods: parentInheritanceSpec.methods,
      inheritanceState: inheritanceStateValue,
      env,
      context: parentContext,
      runtime: runtimeApi,
      cb,
      output: currentBuffer,
      extendsState: null,
      options: { resolveExports: true }
    });

    if (startupPromise) {
      await startupPromise;
    }

    return currentBuffer;
  } finally {
    inheritanceState.leaveInheritanceChainPath(inheritanceStateValue, chainToken);
  }
}

function getLocalRootConstructorEntry(compiledMethods) {
  return compiledMethods.__constructor__ ?? null;
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
    return currentStartupPromise ?? null;
  }

  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  // The readiness `.then` intentionally makes even a synchronous constructor
  // participate in startup merging when metadata is still being finalized.
  let constructorResult = metadataReadyPromise
    ? metadataReadyPromise.then(() => localEntry.fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState))
    : localEntry.fn(env, context, runtime, cb, output, inheritanceStateValue, extendsState);
  if (constructorResult && typeof constructorResult.then === 'function') {
    return inheritanceState.mergeInheritanceStartupPromise(
      inheritanceStateValue,
      constructorResult,
      currentStartupPromise
    );
  }
  inheritanceState.setInheritanceStartupPromise(inheritanceStateValue, currentStartupPromise);
  return currentStartupPromise ?? null;
}

function runCompiledRootStartup(spec) {
  const {
    setup,
    compiledMethods,
    inheritanceState: inheritanceStateValue,
    env,
    context,
    runtime,
    cb,
    output,
    extendsState = null,
    options = null
  } = spec;
  const metadataReadyYield = inheritanceState.consumeInheritanceMetadataReadyYield(inheritanceStateValue);
  if (metadataReadyYield) {
    return metadataReadyYield.then(() => runCompiledRootStartup({
      setup,
      compiledMethods,
      inheritanceState: inheritanceStateValue,
      env,
      context,
      runtime,
      cb,
      output,
      extendsState,
      options
    }));
  }

  const opts = options ?? {};
  let startupPromise = null;

  if (typeof setup === 'function') {
    startupPromise = setup(
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

  if (opts.resolveExports && !inheritanceState.isComponentCompositionMode(inheritanceStateValue)) {
    context.resolveExports();
  }

  return startupPromise;
}

function linkCurrentBufferToParentChannels(parentBuffer, currentBuffer, channelNames) {
  if (parentBuffer === currentBuffer) {
    return currentBuffer;
  }

  for (const channelName of channelNames) {
    if (!channelName) {
      continue;
    }
    if (inheritanceCall.hasLinkedChannelPath(parentBuffer, currentBuffer, channelName)) {
      continue;
    }
    if (parentBuffer.hasLinkedBuffer(currentBuffer, channelName)) {
      continue;
    }
    if (parentBuffer.isFinished(channelName) || parentBuffer.finished) {
      currentBuffer._registerLinkedChannel(channelName);
      continue;
    }
    parentBuffer.addBuffer(currentBuffer, channelName);
  }

  return currentBuffer;
}

function getInheritanceSharedBuffer(currentBuffer, inheritanceStateValue) {
  return inheritanceStateValue.sharedRootBuffer ?? currentBuffer;
}

function finalizeInheritanceMetadata(state, context = null) {
  if (inheritanceState.isInheritanceMetadataReadinessResolved(state)) {
    return state;
  }
  try {
    const structuralErrors = [];

    // Phase 1: validate chain-level structural metadata before building resolved
    // callable data. Later phases assume missing methods/super targets are known.
    inheritanceState.ensureInheritanceSharedSchemaTable(state);
    inheritanceState.finalizeInheritanceMethods(state, context, structuralErrors);
    inheritanceState.validateInheritanceSharedMethodNameCollisions(state, context, structuralErrors);

    // Phase 2: build direct resolved method metadata and file-level invoked
    // catalogs from one recursive construction path, then compute final
    // transitive channel footprints from that resolved graph.
    const errorContext = {
      path: context?.path ?? null
    };
    inheritanceCall.finalizeResolvedMethodMetadata(state, errorContext, structuralErrors);
    if (structuralErrors.length > 0) {
      const aggregateError = inheritanceState.createInheritanceMetadataAggregateError(structuralErrors, context);
      throw aggregateError || structuralErrors[0];
    }
    // Method finalization publishes direct execution entries before bootstrap
    // metadata is released; callers after readiness must never see raw entries.
    inheritanceState.releaseInheritanceBootstrapMetadata(state);
    inheritanceState.resolveInheritanceMetadataReadiness(state, state);
    return state;
  } catch (error) {
    inheritanceState.rejectInheritanceMetadataReadiness(state, error);
    throw error;
  }
}

export default {
  bootstrapInheritanceMetadata,
  bootstrapInheritanceParentScript,
  runCompiledRootStartup,
  renderInheritanceParentRoot,
  linkCurrentBufferToParentChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
export { bootstrapInheritanceMetadata, bootstrapInheritanceParentScript, runCompiledRootStartup, renderInheritanceParentRoot, linkCurrentBufferToParentChannels, getInheritanceSharedBuffer, finalizeInheritanceMetadata };
