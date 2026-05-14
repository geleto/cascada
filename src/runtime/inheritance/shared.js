import {RuntimeFatalError} from '../errors.js';
import {declareBufferChannel} from '../channels/index.js';

const claimedSharedDefaults = new WeakSet();

function getInheritanceSharedRootBuffer(currentBuffer, inheritanceState) {
  // TODO(Step 4): Remove this transitional selector. Instance invocation must
  // pass the exact buffer it needs: public entrypoints use the shared/root
  // buffer, while internal this/super calls use the current invocation buffer.
  return inheritanceState.sharedRootBuffer ?? currentBuffer;
}

function declareInheritanceSharedChannel(buffer, channelName, channelType, context, initializer) {
  const hasInitializer = initializer !== undefined;
  const existingChannel = buffer.getOwnChannel(channelName);
  if (existingChannel) {
    if (existingChannel._channelType !== channelType) {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' was declared as '${existingChannel._channelType}' and '${channelType}'`,
        0,
        0,
        null,
        context?.path ?? null
      );
    }
    if (channelType === 'sequence' && hasInitializer) {
      existingChannel._setSequenceTarget(initializer);
    }
    return existingChannel;
  }

  return declareBufferChannel(buffer, channelName, channelType, context, initializer);
}

function claimInheritanceSharedDefault(buffer, channelName) {
  // TODO(Step 5): Transitional guard for constructor-emitted shared defaults.
  // Remove when shared-root setup evaluates only the finalized schema default.
  const channel = buffer.getOwnChannel(channelName);
  if (!channel || claimedSharedDefaults.has(channel)) {
    return false;
  }
  claimedSharedDefaults.add(channel);
  return true;
}

export {
  getInheritanceSharedRootBuffer,
  declareInheritanceSharedChannel,
  claimInheritanceSharedDefault
};
