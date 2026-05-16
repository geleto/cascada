import {RuntimeFatalError} from '../errors.js';
import {applyChannelInitializer} from '../../channel-types.js';
import {declareBufferChannel} from '../channels/index.js';

const claimedSharedDefaults = new WeakSet();

function declareInheritanceSharedChannel(buffer, channelName, channelType, context, initializer) {
  const hasInitializer = initializer !== undefined;
  const existingChannel = buffer.getOwnChannel(channelName);
  if (existingChannel) {
    if (existingChannel.channelType !== channelType) {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' was declared as '${existingChannel.channelType}' and '${channelType}'`,
        context
      );
    }
    if (hasInitializer) {
      applyChannelInitializer(existingChannel, channelType, initializer);
    }
    return existingChannel;
  }

  return declareBufferChannel(buffer, channelName, channelType, context, initializer);
}

function claimInheritanceSharedDefault(buffer, channelName) {
  // TODO(Step 7): Replace constructor-emitted shared default claims with
  // finalized-schema-driven default initialization.
  // Remove when shared-root setup evaluates only the finalized schema default.
  const channel = buffer.getOwnChannel(channelName);
  if (!channel || claimedSharedDefaults.has(channel)) {
    return false;
  }
  claimedSharedDefaults.add(channel);
  return true;
}

export {
  declareInheritanceSharedChannel,
  claimInheritanceSharedDefault
};
