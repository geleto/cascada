'use strict';

const { CHANNEL_TYPE_FACTS } = require('../../channel-types');
const { Channel, createCallableChannelFacade, inspectTargetForErrors } = require('./base');
const { TextChannel } = require('./text');
const { VarChannel } = require('./var');
const { SequentialPathChannel } = require('./sequential-path');
const { DataChannel } = require('./data');
const { SequenceChannel } = require('./sequence');

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

module.exports = {
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
