
import {declareBufferChannel} from './channels/index.js';
import {VarCommand} from './channels/var.js';

function createCompositionPayload(rootContext, payloadContext = rootContext) {
  return {
    rootContext: rootContext || {},
    payloadContext: payloadContext || {}
  };
}

function declareCompositionPayloadChannels(commandBuffer, context, skipNames = null) {
  const payloadContext = context.getCompositionPayloadVariables();
  if (!payloadContext) {
    return;
  }

  Object.keys(payloadContext).forEach((name) => {
    if (skipNames?.[name] || commandBuffer._channelTypes?.[name]) {
      return;
    }
    declareBufferChannel(commandBuffer, name, 'var', context, null);
    commandBuffer.add(new VarCommand({ channelName: name, args: [payloadContext[name]] }), name);
  });
}

export { createCompositionPayload, declareCompositionPayloadChannels };
