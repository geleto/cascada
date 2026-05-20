import {VarCommand} from '../commands/var.js';
import {Chain} from './base.js';

class VarChain extends Chain {
  constructor(buffer, chainName, context, chainType, initialValue = undefined) {
    super(buffer, chainName, context, chainType, initialValue, null);
  }

  invoke(...args) {
    if (!this._buffer) return;
    const errorContext = this._extractContextFromArgs(args);
    if (args.length !== 1) {
      throw new TypeError('VarChain.invoke requires exactly one value argument before errorContext');
    }
    this._buffer.addCommand(new VarCommand({
      chainName: this._chainName,
      args,
      errorContext
    }), this._chainName);
  }

  _getCurrentResult() {
    return this._target;
  }
}

export {VarChain};
