import {RuntimeError} from '../errors.js';
import {getKeywordArgs, numArgs} from '../macro.js';

// Helpers used while invoking inherited callables. This file owns argument
// frame construction and the generated callable-body buffer links needed to
// make finalized callable chain footprints visible at the invocation site.

function getInvocationArgs(args) {
  const values = args.slice(0, numArgs(args));
  const kwargs = getKeywordArgs(args);
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
    RuntimeError.reportAndThrow(
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

function linkInheritanceCallableFootprintChains(parentBuffer, currentBuffer, boundaryLinkedChainNames, errorContext) {
  if (parentBuffer === currentBuffer) {
    return currentBuffer;
  }

  for (const chainName of boundaryLinkedChainNames) {
    const chain = parentBuffer.getChain(chainName);
    if (currentBuffer.getChainIfExists(chainName) === chain) {
      continue;
    }
    if (currentBuffer.hasChain(chainName)) {
      RuntimeError.reportAndThrow(
        `Cannot link chain '${chainName}' because the current buffer already has a different chain object`,
        errorContext
      );
    }
    if (parentBuffer.isChainFinished(chainName) || parentBuffer.isFinished()) {
      currentBuffer._installLinkedChain(chainName, chain);
      continue;
    }
    parentBuffer.addBuffer(currentBuffer, chainName);
  }

  return currentBuffer;
}

export {
  createInheritanceCallableArgumentFrame,
  linkInheritanceCallableFootprintChains
};
