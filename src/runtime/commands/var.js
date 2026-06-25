import {ChainCommand} from './base.js';

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
    if (args.length === 0) {
      chain._setTarget(undefined);
      return;
    }
    chain.setValue(args[0], this.initializeIfNotSet);
  }
}

export {VarCommand};
