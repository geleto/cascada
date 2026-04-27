'use strict';

import {CHANNEL_TYPE_FACTS} from '../../channel-types';
import {Channel, createCallableChannelFacade, inspectTargetForErrors} from './base';
import {TextChannel} from './text';
import {VarChannel} from './var';
import {SequentialPathChannel} from './sequential-path';
import {DataChannel} from './data';
import {SequenceChannel} from './sequence';

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
  return createChannel(buffer, channelName, context, 'sequence', targetObject);
}

function declareBufferChannel(buffer, channelName, channelType, context, initializer) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Channel "${channelName}" declared without an active CommandBuffer`);
  }

  targetBuffer._channelTypes = targetBuffer._channelTypes || Object.create(null);
  targetBuffer._channelTypes[channelName] = channelType;

  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  const channel = createChannel(targetBuffer, channelName, context, channelType, initializer);

  channel._buffer = targetBuffer;

  targetBuffer._registerChannel(channelName, channel);

  if (channelFacts && channelFacts.usesInitializerAsTarget) {
    targetBuffer._channelRegistry = targetBuffer._channelRegistry || Object.create(null);
    targetBuffer._channelRegistry[channelName] = channel;
  }

  return channel;
}

const __defaultExport = {
  Channel,
  DataChannel,
  TextChannel,
  VarChannel,
  SequentialPathChannel,
  inspectTargetForErrors,
  createChannel,
  SequenceChannel,
  createSequenceChannel,
  declareBufferChannel
};
export { Channel, DataChannel, TextChannel, VarChannel, SequentialPathChannel, inspectTargetForErrors, createChannel, SequenceChannel, createSequenceChannel, declareBufferChannel };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
