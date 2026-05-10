// Runs root setup, parent-chain rendering, and startup buffer wiring.

import {RuntimeFatalError} from '../errors.js';
import {setInheritanceSharedRootBuffer, setInheritanceStartupPromise} from './state.js';

function runCompiledRootStartup({
  setup,
  env,
  context,
  runtime,
  cb,
  output,
  inheritanceState,
  extendsState,
  options = null
}) {
  if (inheritanceState) {
    setInheritanceSharedRootBuffer(inheritanceState, output);
  }
  if (typeof setup !== 'function') {
    return null;
  }
  const startupPromise = setup(env, context, runtime, cb, output, inheritanceState, extendsState, options);
  if (inheritanceState) {
    setInheritanceStartupPromise(inheritanceState, startupPromise);
  }
  if (options?.resolveExports && !options.componentMode && typeof context?.resolveExports === 'function') {
    context.resolveExports();
  }
  return startupPromise;
}

async function bootstrapInheritanceParentScript({
  scriptOrPromise,
  compositionPayload,
  context,
  env,
  runtime,
  cb,
  currentBuffer,
  inheritanceState
}) {
  return renderParentRoot({
    rootOrPromise: scriptOrPromise,
    compositionPayload,
    context,
    env,
    runtime,
    cb,
    currentBuffer,
    inheritanceState
  });
}

async function renderInheritanceParentRoot({
  templateOrPromise,
  compositionPayload,
  context,
  env,
  runtime,
  cb,
  currentBuffer,
  inheritanceState
}) {
  return renderParentRoot({
    rootOrPromise: templateOrPromise,
    compositionPayload,
    context,
    env,
    runtime,
    cb,
    currentBuffer,
    inheritanceState
  });
}

async function renderParentRoot({
  rootOrPromise,
  compositionPayload,
  context,
  env,
  runtime,
  cb,
  currentBuffer,
  inheritanceState
}) {
  const parentRoot = await runtime.resolveSingle(rootOrPromise);
  if (parentRoot === null || parentRoot === undefined) {
    return null;
  }

  const chainToken = enterParentTemplatePath(inheritanceState, parentRoot.path, context);
  try {
    parentRoot.compile();
    const previousStartupPromise = inheritanceState?.startupPromise ?? null;
    const parentContext = compositionPayload
      ? context.forkForCompositionPayload(
        parentRoot.path,
        compositionPayload,
        context.getRenderContextVariables()
      )
      : context.forkForPath(parentRoot.path);

    const parentBuffer = parentRoot.rootRenderFunc(
      env,
      parentContext,
      runtime,
      cb,
      true,
      currentBuffer,
      inheritanceState,
      false
    );
    const startupPromise = inheritanceState?.startupPromise;
    if (startupPromise && startupPromise !== previousStartupPromise) {
      await startupPromise;
    }
    return parentBuffer;
  } finally {
    leaveParentTemplatePath(inheritanceState, chainToken);
  }
}

function enterParentTemplatePath(inheritanceState, path, context) {
  const loading = inheritanceState?.loading;
  if (!loading) {
    return null;
  }
  // Parent-chain rendering runs before finalization clears loading state.
  const normalizedPath = path == null ? '__anonymous__' : String(path);
  if (loading.chainPaths.includes(normalizedPath)) {
    throw new RuntimeFatalError(
      `Inheritance cycle detected: ${loading.chainPaths.join(' -> ')} -> ${normalizedPath}`,
      0,
      0,
      'Inheritance',
      context?.path ?? null
    );
  }
  loading.chainPaths.push(normalizedPath);
  return normalizedPath;
}

function leaveParentTemplatePath(inheritanceState, token) {
  const chainPaths = inheritanceState?.loading?.chainPaths;
  if (!token || !chainPaths) {
    return;
  }
  chainPaths.pop();
}

function linkCurrentBufferToParentChannels(parentBuffer, currentBuffer, channelNames, linkedMutatedChannelNames = null) {
  if (!parentBuffer || !currentBuffer || !Array.isArray(channelNames)) {
    return;
  }
  for (const channelName of channelNames) {
    parentBuffer.addBuffer(currentBuffer, channelName);
  }
  if (Array.isArray(linkedMutatedChannelNames) && currentBuffer._linkedMutatedChannels) {
    for (const channelName of linkedMutatedChannelNames) {
      currentBuffer._linkedMutatedChannels.add(channelName);
    }
  }
}

function getInheritanceSharedBuffer(currentBuffer, inheritanceState) {
  if (inheritanceState?.sharedRootBuffer) {
    return inheritanceState.sharedRootBuffer;
  }
  throw new RuntimeFatalError(
    'Inheritance shared root buffer is not initialized',
    0,
    0,
    null,
    currentBuffer?._context?.path ?? null
  );
}

export {
  bootstrapInheritanceParentScript,
  getInheritanceSharedBuffer,
  linkCurrentBufferToParentChannels,
  renderInheritanceParentRoot,
  runCompiledRootStartup
};
