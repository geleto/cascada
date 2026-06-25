import {VarCommand} from '../commands/var.js';
import {Chain} from './base.js';
import {unwrapResolvedValue} from '../resolve.js';
import {createPoison, isPoison, markValuePromiseHandled, PoisonError} from '../errors.js';

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

  setValue(value, initializeIfNotSet = false) {
    const nextValue = normalizeVarValue(value);
    if (isPoison(nextValue)) {
      return this._setTarget(nextValue);
    }
    if (initializeIfNotSet && this._getTarget() !== undefined) {
      return this._getTarget();
    }
    return this._setTarget(nextValue);
  }

  setInitialValue(value) {
    return this.setValue(value);
  }

  _getCurrentResult() {
    return this._target;
  }

  _makeSnapshot() {
    if (this._fatalError) {
      throw this._fatalError;
    }
    return this._target;
  }
}

function normalizeVarValue(value) {
  const unwrapped = unwrapResolvedValue(value);
  if (isPoison(unwrapped)) {
    return createPoison(PoisonError.group(unwrapped.errors));
  }
  // Var storage may hold promises that are overwritten or never read; mark
  // them handled now and surface poison at the eventual read/inspection point.
  markValuePromiseHandled(unwrapped);
  return unwrapped;
}

export {VarChain};
