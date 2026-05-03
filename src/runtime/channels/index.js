
import {Channel, createCallableChannelFacade, inspectTargetForErrors} from './base.js';
import {TextChannel} from './text.js';
import {VarChannel} from './var.js';
import {SequentialPathChannel} from './sequential-path.js';
import {DataChannel} from './data.js';
import {SequenceChannel} from './sequence.js';

function createChannel(buffer, channelName, context, channelType = null, initializer) {
  const type = channelType || channelName;
  switch (type) {
    case 'text':
      return createCallableChannelFacade(new TextChannel(buffer, channelName, context, type));
    case 'var':
      return createCallableChannelFacade(new VarChannel(buffer, channelName, context, type, initializer));
    case 'sequential_path':
      return new SequentialPathChannel(buffer, channelName, context, type);
    case 'data':
      return new DataChannel(buffer, channelName, context, type);
    case 'sequence':
      return new SequenceChannel(buffer, channelName, context, initializer);
    default:
      throw new Error(`Unsupported channel type '${type}'`);
  }
}

function createSequenceChannel(buffer, channelName, context, targetObject) {
  return declareBufferChannel(buffer, channelName, 'sequence', context, targetObject);
}

function declareBufferChannel(buffer, channelName, channelType, context, initializer) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Channel "${channelName}" declared without an active CommandBuffer`);
  }

  const channel = createChannel(targetBuffer, channelName, context, channelType, initializer);

  channel._buffer = targetBuffer;

  targetBuffer._registerChannel(channelName, channel);
  targetBuffer._channelTypes = targetBuffer._channelTypes || Object.create(null);
  targetBuffer._channelTypes[channelName] = channelType;

  return channel;
}

export { Channel, DataChannel, TextChannel, VarChannel, SequentialPathChannel, inspectTargetForErrors, createChannel, SequenceChannel, createSequenceChannel, declareBufferChannel };
