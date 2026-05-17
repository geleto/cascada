import {createPoison} from '../errors.js';
import {Chain, mergePoisonErrors} from './base.js';

class SequentialPathChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    super(buffer, chainName, context, chainType, true, null);
    this._sequentialPathPoisonErrors = null;
    this._sequentialPathLastResult = undefined;
  }

  _getSequentialPathPoisonErrors() {
    return this._sequentialPathPoisonErrors ? this._sequentialPathPoisonErrors.slice() : null;
  }

  _applySequentialPathPoisonErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }

    const merged = mergePoisonErrors(this._sequentialPathPoisonErrors || [], errors);
    this._sequentialPathPoisonErrors = merged;
    this._setTarget(createPoison(merged));
  }

  _clearSequentialPathPoison() {
    this._sequentialPathPoisonErrors = null;
    this._setTarget(true);
  }

  _setSequentialPathLastResult(value) {
    this._sequentialPathLastResult = value;
    if (!this._sequentialPathPoisonErrors || this._sequentialPathPoisonErrors.length === 0) {
      this._setTarget(value);
    }
  }

  _captureGuardState() {
    return {
      target: this._target,
      poisonErrors: this._sequentialPathPoisonErrors ? this._sequentialPathPoisonErrors.slice() : null,
      lastResult: this._sequentialPathLastResult
    };
  }

  _restoreGuardState(state) {
    if (state && typeof state === 'object') {
      this._sequentialPathPoisonErrors = Array.isArray(state.poisonErrors)
        ? state.poisonErrors.slice()
        : null;
      this._sequentialPathLastResult = state.lastResult;
      if (Object.prototype.hasOwnProperty.call(state, 'target')) {
        this._setTarget(state.target);
        return;
      }
    }

    this._sequentialPathPoisonErrors = null;
    this._sequentialPathLastResult = state;
    this._setTarget(state);
  }

  _applyPoisonErrors(errors) {
    this._applySequentialPathPoisonErrors(errors);
  }

  _getCurrentResult() {
    return this._sequentialPathLastResult;
  }
}

export {SequentialPathChain};
