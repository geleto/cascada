
import {createCallableChannelFacade} from './runtime/channels/base.js';
import {DataChannel} from './runtime/channels/data.js';
import {SequentialPathChannel} from './runtime/channels/sequential-path.js';
import {SequenceChannel} from './runtime/channels/sequence.js';
import {TextChannel} from './runtime/channels/text.js';
import {VarChannel} from './runtime/channels/var.js';

const CHANNEL_TYPE_FACTS = Object.freeze({
  data: Object.freeze({
    channelDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'DataCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    applyInitializer: null,
    createChannel(buffer, channelName, context, channelType) {
      return new DataChannel(buffer, channelName, context, channelType);
    }
  }),
  text: Object.freeze({
    channelDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'TextCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    applyInitializer: null,
    createChannel(buffer, channelName, context, channelType) {
      return createCallableChannelFacade(new TextChannel(buffer, channelName, context, channelType));
    }
  }),
  var: Object.freeze({
    channelDeclarationTag: false,
    runtimeOnly: false,
    commandClass: 'VarCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    createChannel(buffer, channelName, context, channelType) {
      return createCallableChannelFacade(new VarChannel(buffer, channelName, context, channelType));
    },
    applyInitializer(channel, initializer) {
      channel.setInitialValue(initializer);
    }
  }),
  sequence: Object.freeze({
    channelDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'SequenceCallCommand',
    requiresInitializer: true,
    supportsValueInitializer: false,
    createChannel(buffer, channelName, context) {
      return new SequenceChannel(buffer, channelName, context);
    },
    applyInitializer(channel, initializer) {
      channel.setInitialValue(initializer);
    }
  }),
  'sequential_path': Object.freeze({
    channelDeclarationTag: false,
    runtimeOnly: true,
    commandClass: null,
    requiresInitializer: false,
    supportsValueInitializer: false,
    applyInitializer: null,
    createChannel(buffer, channelName, context, channelType) {
      return new SequentialPathChannel(buffer, channelName, context, channelType);
    }
  })
});

const CHANNEL_TYPES = Object.freeze(
  Object.keys(CHANNEL_TYPE_FACTS).filter((type) => !CHANNEL_TYPE_FACTS[type].runtimeOnly)
);

function createChannel(buffer, channelName, context, channelType) {
  const channelFacts = CHANNEL_TYPE_FACTS[channelType];
  if (!channelFacts || !channelFacts.createChannel) {
    throw new Error(`Unsupported channel type '${channelType}'`);
  }
  return channelFacts.createChannel(buffer, channelName, context, channelType);
}

function applyChannelInitializer(channel, channelType, initializer) {
  const applyInitializer = CHANNEL_TYPE_FACTS[channelType].applyInitializer;
  if (applyInitializer) {
    applyInitializer(channel, initializer);
  }
}

export { CHANNEL_TYPE_FACTS, CHANNEL_TYPES, createChannel, applyChannelInitializer };
