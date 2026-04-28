'use strict';

import {CHANNEL_TYPE_FACTS} from '../channel-types.js';
import {RuntimeFatalError} from './errors.js';
import {declareBufferChannel} from './channels/index.js';

const claimedSharedDefaults = new WeakSet();

function claimInheritanceSharedDefault(buffer, channelName) {
  const channel = buffer && typeof buffer.getOwnChannel === 'function'
    ? buffer.getOwnChannel(channelName)
    : null;
  if (!channel) {
    return false;
  }
  if (claimedSharedDefaults.has(channel)) {
    return false;
  }
  claimedSharedDefaults.add(channel);
  return true;
}

function declareInheritanceSharedChannel(buffer, channelName, channelType, context) {
  const existingChannel = buffer && typeof buffer.getOwnChannel === 'function'
    ? buffer.getOwnChannel(channelName)
    : null;
  if (existingChannel) {
    if (existingChannel._channelType !== channelType) {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' was declared as '${existingChannel._channelType}' and '${channelType}'`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      );
    }
    return existingChannel;
  }

  return declareBufferChannel(buffer, channelName, channelType, context);
}

// Caller must first win claimInheritanceSharedDefault(...). Keeping the claim
// separate lets generated code skip evaluating ignored ancestor defaults.
function initializeInheritanceSharedChannelDefault(buffer, channelName, channelType, context, initializer) {
  const channel = declareInheritanceSharedChannel(buffer, channelName, channelType, context);
  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  if (channelFacts && channelFacts.usesInitializerAsTarget) {
    if (typeof channel._setSequenceTarget !== 'function') {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' cannot be initialized as '${channelType}'`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      );
    }
    channel._setSequenceTarget(initializer);
    return channel;
  }
  return channel;
}

export default {
  declareInheritanceSharedChannel,
  claimInheritanceSharedDefault,
  initializeInheritanceSharedChannelDefault
};
export { declareInheritanceSharedChannel, claimInheritanceSharedDefault, initializeInheritanceSharedChannelDefault };
