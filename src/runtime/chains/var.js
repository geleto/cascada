
import {ChainCommand, runWithResolvedArguments, contextualizeChainError} from './command-base.js';
import {Chain} from './base.js';

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

class VarChain extends Chain {
  constructor(buffer, chainName, context, chainType, initialValue = undefined) {

    // Keep declaration-only var chains aligned with `none` semantics unless

    // a caller provides an explicit initializer.

    super(buffer, chainName, context, chainType, initialValue, null);

  }



  invoke(value) {

    if (!this._buffer) return;

    this._buffer.addCommand(new VarCommand({

      chainName: this._chainName,

      args: [value],

      pos: { lineno: 0, colno: 0 }

    }), this._chainName);

  }



  _getCurrentResult() {

    return this._target;

  }

}

export { VarChain, VarCommand };
