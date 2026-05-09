// Runs inheritance startup and parent-root rendering.
// Uses loaded/finalized state.

import {RuntimeFatalError} from '../errors.js';
import {setInheritanceSharedRootBuffer} from './state.js';

function runCompiledRootStartup({
  setup,
  env,
  context,
  runtime,
  cb,
  output,
  inheritanceState,
  extendsState
}) {
  if (inheritanceState) {
    setInheritanceSharedRootBuffer(inheritanceState, output);
  }
  if (typeof setup !== 'function') {
    return null;
  }
  return setup(env, context, runtime, cb, output, inheritanceState, extendsState);
}

function bootstrapInheritanceParentScript() {
  // Temporary until parent-chain loading/rendering is implemented.
  throw createUnsupportedFeatureError('script extends');
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
  const parentTemplate = await runtime.resolveSingle(templateOrPromise);
  if (parentTemplate === null || parentTemplate === undefined) {
    return null;
  }

  const chainToken = enterParentTemplatePath(inheritanceState, parentTemplate.path, context);
  try {
    parentTemplate.compile();
    const previousStartupPromise = inheritanceState?.startupPromise ?? null;
    const parentContext = compositionPayload
      ? context.forkForCompositionPayload(
        parentTemplate.path,
        compositionPayload,
        context.getRenderContextVariables()
      )
      : context.forkForPath(parentTemplate.path);

    const parentBuffer = parentTemplate.rootRenderFunc(
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

function getInheritanceSharedBuffer(inheritanceState, currentBuffer) {
  // Temporary fallback before shared-root ownership exists.
  return inheritanceState?.sharedRootBuffer || currentBuffer;
}

// Temporary helper for parent-chain unsupported boundaries.
function createUnsupportedFeatureError(feature) {
  return new RuntimeFatalError(
    `${feature} is not implemented yet`,
    0,
    0,
    null,
    null
  );
}

export {
  bootstrapInheritanceParentScript,
  getInheritanceSharedBuffer,
  linkCurrentBufferToParentChannels,
  renderInheritanceParentRoot,
  runCompiledRootStartup
};
