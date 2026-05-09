// Owns inheritance shared-channel schema and runtime shared-channel operations.

import {CHANNEL_TYPE_FACTS} from '../../channel-types.js';
import {declareBufferChannel} from '../channels/index.js';
import {RuntimeFatalError} from '../errors.js';

/*
// Finalized shared schema for one inheritance chain.
type SharedSchema = Record<string, string> // shared channel name -> channel type
*/

const claimedSharedDefaults = new WeakSet();

function ensureInheritanceSharedSchemaTable(state) {
  if (!state.sharedSchema) {
    state.sharedSchema = Object.create(null);
  }
  return state.sharedSchema;
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  if (!state) {
    throw new RuntimeFatalError(
      'Inheritance shared state is required',
      errorContext?.lineno ?? 0,
      errorContext?.colno ?? 0,
      errorContext?.errorContextString ?? null,
      errorContext?.path ?? null
    );
  }
  const sharedSchema = ensureInheritanceSharedSchemaTable(state);
  if (Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
    return sharedSchema[channelName];
  }
  throw new RuntimeFatalError(
    `Unknown shared channel "${channelName}"`,
    errorContext?.lineno ?? 0,
    errorContext?.colno ?? 0,
    errorContext?.errorContextString ?? null,
    errorContext?.path ?? null
  );
}

function declareInheritanceSharedChannel(buffer, channelName, channelType, context) {
  const existingChannel = buffer.getOwnChannel(channelName);
  if (existingChannel) {
    if (existingChannel._channelType !== channelType) {
      throw new RuntimeFatalError(
        `Shared channel "${channelName}" was declared as "${existingChannel._channelType}" and "${channelType}"`,
        0,
        0,
        null,
        context?.path ?? null
      );
    }
    return existingChannel;
  }

  return declareBufferChannel(buffer, channelName, channelType, context);
}

function claimInheritanceSharedDefault(buffer, channelName) {
  const channel = buffer.getOwnChannel(channelName);
  if (!channel || claimedSharedDefaults.has(channel)) {
    return false;
  }
  claimedSharedDefaults.add(channel);
  return true;
}

function initializeInheritanceSharedChannelDefault(buffer, channelName, channelType, context, initializer) {
  const channel = declareInheritanceSharedChannel(buffer, channelName, channelType, context);
  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  if (channelFacts && channelFacts.usesInitializerAsTarget) {
    if (typeof channel._setSequenceTarget !== 'function') {
      throw new RuntimeFatalError(
        `Shared channel "${channelName}" cannot be initialized as "${channelType}"`,
        0,
        0,
        null,
        context?.path ?? null
      );
    }
    channel._setSequenceTarget(initializer);
  }
  return channel;
}

function linkCurrentBufferToSharedChannels(currentBuffer, inheritanceState, channelNames, linkedMutatedChannelNames = null) {
  const sharedRootBuffer = inheritanceState?.sharedRootBuffer;
  const sharedSchema = inheritanceState?.sharedSchema;
  if (!currentBuffer || !sharedRootBuffer || !sharedSchema || !Array.isArray(channelNames)) {
    return;
  }

  for (const channelName of channelNames) {
    if (!Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
      continue;
    }
    if (currentBuffer === sharedRootBuffer) {
      continue;
    }
    const existingChannel = currentBuffer.getChannelIfExists(channelName);
    if (existingChannel) {
      if (currentBuffer.hasLinkedChannelFromBuffer(channelName, sharedRootBuffer)) {
        continue;
      }
      throw new RuntimeFatalError(
        `Cannot link shared channel "${channelName}" because the current buffer already has a local channel with that name`,
        0,
        0,
        null,
        currentBuffer._context?.path ?? null
      );
    }
    sharedRootBuffer.addBuffer(currentBuffer, channelName);
  }

  if (Array.isArray(linkedMutatedChannelNames) && currentBuffer._linkedMutatedChannels) {
    for (const channelName of linkedMutatedChannelNames) {
      if (Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
        currentBuffer._linkedMutatedChannels.add(channelName);
      }
    }
  }
}

export {
  claimInheritanceSharedDefault,
  declareInheritanceSharedChannel,
  ensureInheritanceSharedSchemaTable,
  initializeInheritanceSharedChannelDefault,
  linkCurrentBufferToSharedChannels,
  resolveInheritanceSharedChannel
};
