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
  inheritanceState.registerInheritanceMethods(state, methods);
  return state;
}

function linkCurrentBufferToResolvedParentSharedChannels(inheritanceStateValue, currentBuffer, parentOutputBuffer) {
  if (!inheritanceStateValue || !currentBuffer || !parentOutputBuffer) {
    return currentBuffer;
  }

  const sharedSchema = inheritanceStateValue.sharedSchema && typeof inheritanceStateValue.sharedSchema === 'object'
    ? inheritanceStateValue.sharedSchema
    : null;
  const parentSharedBuffer =
    inheritanceStateValue.sharedRootBuffer || parentOutputBuffer;
  const channelNames = sharedSchema ? Object.keys(sharedSchema) : [];

  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
    if (
      parentOutputBuffer !== currentBuffer &&
      typeof currentBuffer.hasLinkedBuffer === 'function' &&
      !currentBuffer.hasLinkedBuffer(parentOutputBuffer, channelName)
    ) {
      currentBuffer.addBuffer(parentOutputBuffer, channelName);
    }
    if (
      parentSharedBuffer &&
      parentSharedBuffer !== currentBuffer &&
      typeof parentSharedBuffer.hasLinkedBuffer === 'function' &&
      !parentSharedBuffer.hasLinkedBuffer(currentBuffer, channelName)
    ) {
      parentSharedBuffer.addBuffer(currentBuffer, channelName);
    }
  }

  return currentBuffer;
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
  linkCurrentBufferToResolvedParentSharedChannels,
  linkCurrentBufferToParentChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
