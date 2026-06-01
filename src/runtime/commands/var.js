import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';
import {contextualizeChainError} from './errors.js';

class VarCommand extends ChainCommand {
  constructor({ chainName, args = null, errorContext, initializeIfNotSet = false }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, (resolvedArgs) => {
      if (!chain) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonError = this.getPoisonFromArgs(args);
      if (poisonError) {
        chain._setTarget(this.toPoisonValue(poisonError));
        return;
      }
      if (args.length === 0) {
        chain._setTarget(undefined);
        return;
      }
      if (args.length > 1) {
        chain._setTarget(this.toPoisonValue(
          contextualizeChainError(this.errorContext, new Error('var chain accepts exactly one argument'))
        ));
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
