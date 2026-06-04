import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';
import {isPoison, PoisonError, poisonIfNaN} from '../errors.js';

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
      const valueArgs = args.length === 0 ? [] : [args[0]];
      const poisonError = this.getPoisonFromArgs(valueArgs);
      if (poisonError) {
        chain._setTarget(this.toPoisonValue(poisonError));
        return;
      }
      if (valueArgs.length === 0) {
        chain._setTarget(undefined);
        return;
      }
      if (this.initializeIfNotSet && chain._getTarget() !== undefined) {
        return;
      }
      const value = poisonIfNaN(valueArgs[0], this.errorContext);
      if (isPoison(value)) {
        chain._setTarget(this.toPoisonValue(PoisonError.group(value.errors)));
        return;
      }
      chain._setTarget(value);
    });
  }
}

export {VarCommand};
