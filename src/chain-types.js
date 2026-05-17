
import {createCallableChainFacade} from './runtime/chains/base.js';
import {DataChain} from './runtime/chains/data.js';
import {SequentialPathChain} from './runtime/chains/sequential-path.js';
import {SequenceChain} from './runtime/chains/sequence.js';
import {TextChain} from './runtime/chains/text.js';
import {VarChain} from './runtime/chains/var.js';

const CHAIN_TYPE_FACTS = Object.freeze({
  data: Object.freeze({
    chainDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'DataCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    applyInitializer: null,
    createChain(buffer, chainName, context, chainType) {
      return new DataChain(buffer, chainName, context, chainType);
    }
  }),
  text: Object.freeze({
    chainDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'TextCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    applyInitializer: null,
    createChain(buffer, chainName, context, chainType) {
      return createCallableChainFacade(new TextChain(buffer, chainName, context, chainType));
    }
  }),
  var: Object.freeze({
    chainDeclarationTag: false,
    runtimeOnly: false,
    commandClass: 'VarCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    createChain(buffer, chainName, context, chainType) {
      return createCallableChainFacade(new VarChain(buffer, chainName, context, chainType));
    },
    applyInitializer(chain, initializer) {
      chain.setInitialValue(initializer);
    }
  }),
  sequence: Object.freeze({
    chainDeclarationTag: true,
    runtimeOnly: false,
    commandClass: 'SequenceCallCommand',
    requiresInitializer: true,
    supportsValueInitializer: false,
    createChain(buffer, chainName, context) {
      return new SequenceChain(buffer, chainName, context);
    },
    applyInitializer(chain, initializer) {
      chain.setInitialValue(initializer);
    }
  }),
  'sequential_path': Object.freeze({
    chainDeclarationTag: false,
    runtimeOnly: true,
    commandClass: null,
    requiresInitializer: false,
    supportsValueInitializer: false,
    applyInitializer: null,
    createChain(buffer, chainName, context, chainType) {
      return new SequentialPathChain(buffer, chainName, context, chainType);
    }
  })
});

const CHAIN_TYPES = Object.freeze(
  Object.keys(CHAIN_TYPE_FACTS).filter((type) => !CHAIN_TYPE_FACTS[type].runtimeOnly)
);

function createChain(buffer, chainName, context, chainType) {
  const chainFacts = CHAIN_TYPE_FACTS[chainType];
  if (!chainFacts || !chainFacts.createChain) {
    throw new Error(`Unsupported chain type '${chainType}'`);
  }
  return chainFacts.createChain(buffer, chainName, context, chainType);
}

function applyChainInitializer(chain, chainType, initializer) {
  const applyInitializer = CHAIN_TYPE_FACTS[chainType].applyInitializer;
  if (applyInitializer) {
    applyInitializer(chain, initializer);
  }
}

export { CHAIN_TYPE_FACTS, CHAIN_TYPES, createChain, applyChainInitializer };
