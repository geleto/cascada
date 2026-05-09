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

function renderInheritanceParentRoot() {
  // Temporary until parent-chain loading/rendering is implemented.
  throw createUnsupportedFeatureError('template extends');
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
  // Falls back to the current buffer before shared-root ownership exists.
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
