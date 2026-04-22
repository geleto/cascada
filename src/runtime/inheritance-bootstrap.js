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
    const constructorBoundary = inheritanceState.awaitInheritanceConstructorBoundary(inheritanceStateValue);
    if (constructorBoundary) {
      await constructorBoundary;
    }
    return parentOutputBuffer;
  }

  if (parentOutputBuffer && typeof parentOutputBuffer.getFinishedPromise === 'function') {
    await parentOutputBuffer.getFinishedPromise();
  }

  return parentOutputBuffer;
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
  waitForParentRootRender,
  linkCurrentBufferToParentChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
