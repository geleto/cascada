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
  getInheritanceSharedBuffer,
  finalizeInheritanceMetadata
};
