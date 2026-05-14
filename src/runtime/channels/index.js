
import {Channel, inspectTargetForErrors} from './base.js';
import {applyChannelInitializer, createChannel} from '../../channel-types.js';
import {TextChannel} from './text.js';
import {VarChannel} from './var.js';
import {SequentialPathChannel} from './sequential-path.js';
import {DataChannel} from './data.js';
import {SequenceChannel} from './sequence.js';

function declareBufferChannel(buffer, channelName, channelType, context, initializer) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Channel "${channelName}" declared without an active CommandBuffer`);
  }

  const channel = createChannel(targetBuffer, channelName, context, channelType);

  channel._buffer = targetBuffer;

  targetBuffer._registerChannel(channelName, channel);
  targetBuffer._channelTypes = targetBuffer._channelTypes || Object.create(null);
  targetBuffer._channelTypes[channelName] = channelType;

  if (initializer !== undefined) {
    applyChannelInitializer(channel, channelType, initializer);
  }

  return channel;
}

export { Channel, DataChannel, TextChannel, VarChannel, SequentialPathChannel, inspectTargetForErrors, createChannel, SequenceChannel, declareBufferChannel };
