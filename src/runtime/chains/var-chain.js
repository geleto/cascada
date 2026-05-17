import {VarCommand} from '../commands/var.js';
import {Chain} from './base.js';

class VarChain extends Chain {
  constructor(buffer, chainName, context, chainType, initialValue = undefined) {
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

export {VarChain};
