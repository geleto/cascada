import {RuntimeFatalError} from '../errors.js';
import {applyChainInitializer} from '../../chain-types.js';
import {declareBufferChain} from '../chains/index.js';

const claimedSharedDefaults = new WeakSet();

function declareInheritanceSharedChain(buffer, chainName, chainType, context, initializer, errorContext = null) {
  const hasInitializer = initializer !== undefined;
  const existingChain = buffer.getOwnChain(chainName);
  if (existingChain) {
    if (existingChain.chainType !== chainType) {
      throw new RuntimeFatalError(
        `shared chain '${chainName}' was declared as '${existingChain.chainType}' and '${chainType}'`,
        errorContext
      );
    }
    if (hasInitializer) {
      applyChainInitializer(existingChain, chainType, initializer);
    }
    return existingChain;
  }

  return declareBufferChain(buffer, chainName, chainType, context, initializer);
}

function claimInheritanceSharedDefault(buffer, chainName) {
  // TODO(Step 7): Replace constructor-emitted shared default claims with
  // finalized-schema-driven default initialization.
  // Remove when shared-root setup evaluates only the finalized schema default.
  const chain = buffer.getOwnChain(chainName);
  if (!chain || claimedSharedDefaults.has(chain)) {
    return false;
  }
  claimedSharedDefaults.add(chain);
  return true;
}

export {
  declareInheritanceSharedChain,
  claimInheritanceSharedDefault
};
