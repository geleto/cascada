import {createPoison, PoisonError} from '../errors.js';
import {Chain} from './base.js';

class SequentialPathChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    super(buffer, chainName, context, chainType, true, null);
    this._sequentialPathPoison = null;
    this._sequentialPathLastResult = undefined;
  }

  _getSequentialPathPoisonError() {
    return this._sequentialPathPoison;
  }

  _applySequentialPathPoisonError(poisonError) {
    const mergedPoison = this._sequentialPathPoison
      ? PoisonError.group([this._sequentialPathPoison, poisonError])
      : poisonError;
    this._sequentialPathPoison = mergedPoison;
    this._setTarget(createPoison(mergedPoison));
  }

  _clearSequentialPathPoison() {
    this._sequentialPathPoison = null;
    this._setTarget(true);
  }

  _setSequentialPathLastResult(value) {
    this._sequentialPathLastResult = value;
    if (!this._sequentialPathPoison) {
      this._setTarget(value);
    }
  }

  _captureGuardState() {
    return {
      target: this._target,
      poisonError: this._sequentialPathPoison,
      lastResult: this._sequentialPathLastResult
    };
  }

  _restoreGuardState(state) {
    if (state && typeof state === 'object') {
      this._sequentialPathPoison = state.poisonError || null;
      this._sequentialPathLastResult = state.lastResult;
      if (Object.prototype.hasOwnProperty.call(state, 'target')) {
        this._setTarget(state.target);
        return;
      }
    }

    this._sequentialPathPoison = null;
    this._sequentialPathLastResult = state;
    this._setTarget(state);
  }

  _applyPoisonError(poisonError) {
    this._applySequentialPathPoisonError(poisonError);
  }

  _getCurrentResult() {
    return this._sequentialPathLastResult;
  }
}

export {SequentialPathChain};
