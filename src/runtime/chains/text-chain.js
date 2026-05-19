import {createPoison} from '../errors.js';
import {TextCommand} from '../commands/text.js';
import {Chain} from './base.js';

class TextChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    super(buffer, chainName, context, chainType, [], null);
  }

  invoke(...args) {
    if (!this._buffer) return;
    if (args.length === 0) return;
    this._buffer.addCommand(new TextCommand({
      chainName: this._chainName,
      args,
      normalizeArgs: true
    }), this._chainName);
  }

  _getCurrentResult() {
    if (!Array.isArray(this._target) || this._target.length === 0) {
      this._setTarget(['']);
      return '';
    }
    const result = this._target.join('');
    this._setTarget([result]);
    return result;
  }

  _applyPoisonErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }
    if (!Array.isArray(this._target)) {
      this._setTarget([]);
    }
    this._target.push(createPoison(errors));
    this._markStateChanged();
  }
}

export {TextChain};
