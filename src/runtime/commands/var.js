import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';
import {contextualizeChainError} from './errors.js';

class VarCommand extends ChainCommand {
  constructor({ chainName, args = null, pos = null, initializeIfNotSet = false }) {
    super({
      chainName,
      args: args || [],
      pos
    });
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, chain, (resolvedArgs) => {
      if (!chain) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        chain._setTarget(this.toPoisonValue(poisonErrors));
        return;
      }
      if (args.length === 0) {
        chain._setTarget(undefined);
        return;
      }
      if (args.length > 1) {
        chain._setTarget(this.toPoisonValue([
          contextualizeChainError(chain, this.pos, new Error('var chain accepts exactly one argument'))
        ]));
        return;
      }
      if (this.initializeIfNotSet && chain._getTarget() !== undefined) {
        return;
      }
      chain._setTarget(args[0]);
    });
  }
}

export {VarCommand};
