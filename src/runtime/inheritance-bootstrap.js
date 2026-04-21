'use strict';

const inheritanceState = require('./inheritance-state');

function bootstrapInheritanceMetadata(stateValue, methods, sharedSchema, currentBuffer, context = null) {
  const state = stateValue || inheritanceState.createInheritanceState();
  if (!state.sharedRootBuffer) {
    state.sharedRootBuffer = currentBuffer || null;
  }
  inheritanceState.ensureInheritanceSharedSchemaTable(state).registerSchema(sharedSchema, context);
  inheritanceState.ensureInheritanceMethodsTable(state).registerCompiled(methods);
  ensureCurrentBufferSharedLinks(state.sharedSchema, currentBuffer);
  return state;
}

function ensureCurrentBufferSharedLinks(sharedSchema, currentBuffer) {
  if (!sharedSchema || !currentBuffer || !currentBuffer._registerLinkedChannel) {
    return currentBuffer;
  }

  const channelNames = Object.keys(sharedSchema);
  for (let i = 0; i < channelNames.length; i++) {
    currentBuffer._registerLinkedChannel(channelNames[i]);
  }
  return currentBuffer;
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

function linkCurrentBufferToParentSharedChannels(inheritanceStateValue, parentBuffer, currentBuffer) {
  if (!inheritanceStateValue || !parentBuffer || !currentBuffer || parentBuffer === currentBuffer) {
    return currentBuffer;
  }

  const sharedSchema = inheritanceStateValue.sharedSchema && typeof inheritanceStateValue.sharedSchema === 'object'
    ? inheritanceStateValue.sharedSchema
    : null;
  const channelNames = sharedSchema ? Object.keys(sharedSchema) : [];

  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
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
  ensureCurrentBufferSharedLinks,
  linkCurrentBufferToResolvedParentSharedChannels,
  linkCurrentBufferToParentSharedChannels,
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
