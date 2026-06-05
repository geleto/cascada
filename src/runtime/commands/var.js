import {ChainCommand} from './base.js';
import {unwrapResolvedValue} from '../resolve.js';
import {isPoison, PoisonError} from '../errors.js';

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
    if (!chain) return;
    const args = Array.isArray(this.arguments) ? this.arguments : [];
    const valueArgs = args.length === 0 ? [] : [unwrapResolvedValue(args[0])];
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
    const value = valueArgs[0];
    if (isPoison(value)) {
      chain._setTarget(this.toPoisonValue(PoisonError.group(value.errors)));
      return;
    }
    chain._setTarget(value);
  }
}

export {VarCommand};
