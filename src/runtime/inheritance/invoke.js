import {RuntimeFatalError} from '../errors.js';
import {getKeywordArgs, numArgs} from '../macro.js';

function getInvocationArgs(args) {
  const sourceArgs = Array.isArray(args) ? args : [];
  const values = sourceArgs.slice(0, numArgs(sourceArgs));
  const kwargs = getKeywordArgs(sourceArgs);
  return { values, kwargs };
}

function createInheritanceCallableArgumentFrame(
  methodData,
  args,
  errorContext
) {
  const argNames = methodData.signature.argNames;
  const invocationArgs = getInvocationArgs(args);
  const values = invocationArgs.values;
  const kwargs = invocationArgs.kwargs;

  if (values.length > argNames.length) {
    throw new RuntimeFatalError(
      `Inherited callable '${methodData.name}' received too many arguments`,
      errorContext
    );
  }

  const argumentFrame = {};
  values.forEach((value, index) => {
    argumentFrame[argNames[index]] = value;
  });
  argNames.forEach((name) => {
    if (
      !Object.prototype.hasOwnProperty.call(argumentFrame, name) &&
      Object.prototype.hasOwnProperty.call(kwargs, name)
    ) {
      argumentFrame[name] = kwargs[name];
    }
  });
  return argumentFrame;
}

function linkInheritanceCallableFootprintChannels(parentBuffer, currentBuffer, channelNames, linkedMutatedChannelNames = null) {
  if (parentBuffer === currentBuffer) {
    return currentBuffer;
  }

  const linkedMutatedChannelSet = new Set(linkedMutatedChannelNames || []);
  for (const channelName of channelNames) {
    const channel = parentBuffer.getChannel(channelName);
    if (currentBuffer.getChannelIfExists(channelName) === channel) {
      if (linkedMutatedChannelSet.has(channelName)) {
        currentBuffer._markLinkedMutatedChannel(channelName);
      }
      continue;
    }
    if (currentBuffer.hasChannel(channelName)) {
      throw new RuntimeFatalError(
        `Cannot link channel '${channelName}' because the current buffer already has a different channel object`,
        0,
        0,
        null,
        null
      );
    }
    if (parentBuffer.isChannelFinished(channelName) || parentBuffer.isFinished()) {
      currentBuffer._installLinkedChannel(channelName, channel);
      if (linkedMutatedChannelSet.has(channelName)) {
        currentBuffer._markLinkedMutatedChannel(channelName);
      }
      continue;
    }
    parentBuffer.addBuffer(currentBuffer, channelName);
    if (linkedMutatedChannelSet.has(channelName)) {
      currentBuffer._markLinkedMutatedChannel(channelName);
    }
  }

  return currentBuffer;
}

export {
  createInheritanceCallableArgumentFrame,
  linkInheritanceCallableFootprintChannels
};
