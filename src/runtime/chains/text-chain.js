import {createPoison} from '../errors.js';
import {TextCommand} from '../commands/text.js';
import {Chain} from './base.js';

class TextChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    super(buffer, chainName, context, chainType, [], null);
  }

  invoke(...args) {
    if (!this._buffer) return;
    const errorContext = this._extractContextFromArgs(args);
    if (args.length === 0) return;
    this._buffer.addCommand(new TextCommand({
      chainName: this._chainName,
      args,
      normalizeArgs: true,
      errorContext
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

  _applyPoisonError(poison) {
    if (!Array.isArray(this._target)) {
      this._setTarget([]);
    }
    this._target.push(createPoison(poison));
    this._markStateChanged();
  }
}

export {TextChain};
