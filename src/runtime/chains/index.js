
import {Chain, inspectTargetForErrors} from './base.js';
import {applyChainInitializer, createChain} from '../../chain-types.js';
import {TextChain} from './text-chain.js';
import {VarChain} from './var-chain.js';
import {SequentialPathChain} from './sequential-path-chain.js';
import {DataChain} from './data-chain.js';
import {SequenceChain} from './sequence-chain.js';

function declareBufferChain(buffer, chainName, chainType, context, initializer) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Chain "${chainName}" declared without an active CommandBuffer`);
  }

  const chain = createChain(targetBuffer, chainName, context, chainType);

  chain._buffer = targetBuffer;

  targetBuffer._registerChain(chainName, chain);
  targetBuffer._chainTypes = targetBuffer._chainTypes || Object.create(null);
  targetBuffer._chainTypes[chainName] = chainType;

  if (initializer !== undefined) {
    applyChainInitializer(chain, chainType, initializer);
  }

  return chain;
}

export { Chain, DataChain, TextChain, VarChain, SequentialPathChain, inspectTargetForErrors, createChain, SequenceChain, declareBufferChain };
