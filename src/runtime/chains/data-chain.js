import {createPoison, isPoison, isPoisonError} from '../errors.js';
import {DataCommand} from '../commands/data.js';
import {DataChainTarget} from './data-target.js';
import {Chain, cloneSnapshotValue, mergePoisonErrors} from './base.js';

class DataChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    const env = context && context.env ? context.env : null;
    const base = new DataChainTarget(context && context.getVariables ? context.getVariables() : {}, env);
    super(buffer, chainName, context, chainType, base.data, base);
    this._snapshotShared = false;
    this._installCommandMethods();
  }

  _getCurrentResult() {
    return this._target;
  }

  _installCommandMethods() {
    const methods = this._base && this._base.methods ? this._base.methods : null;
    if (!methods) {
      return;
    }

    Object.keys(methods).forEach((methodName) => {
      if (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError') {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(this, methodName) || typeof this[methodName] !== 'undefined') {
        return;
      }
      Object.defineProperty(this, methodName, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: (...args) => {
          if (!this._buffer) return;
          this._buffer.addCommand(new DataCommand({
            chainName: this._chainName,
            operation: methodName,
            args
          }), this._chainName);
        }
      });
    });
  }

  _resolveSnapshotCommandResult() {
    const value = super._resolveSnapshotCommandResult();
    if (value && typeof value === 'object') {
      this._snapshotShared = true;
    }
    return value;
  }

  _beforeApplyCommand(cmd) {
    if (!cmd || cmd.isObservable || !this._snapshotShared || !this._base) {
      return;
    }

    const cloned = cloneSnapshotValue(this._target);
    this._setTarget(cloned);
    this._base.data = cloned;
    this._snapshotShared = false;
  }

  _captureGuardState() {
    return {
      target: cloneSnapshotValue(this._target)
    };
  }

  _restoreGuardState(state) {
    const nextTarget = state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'target')
      ? state.target
      : state;
    this._setTarget(nextTarget);
    if (this._base) {
      this._base.data = nextTarget;
    }
    this._snapshotShared = false;
  }

  _applyPoisonErrors(errors, cmd = null) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }

    const mergedRootErrors = mergePoisonErrors(extractPoisonErrors(this._getTarget()), errors);
    const poison = createPoison(mergedRootErrors);
    const rawPath = cmd && Array.isArray(cmd.arguments) && cmd.arguments.length > 0 ? cmd.arguments[0] : null;
    const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;

    if (this._base) {
      try {
        this._base.set(path, poison);
        this._setTarget(this._base.data);
        return;
      } catch (err) {
        void err;
      }
    }

    this._setTarget(poison);
  }
}

function extractPoisonErrors(value) {
  if (isPoison(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  if (isPoisonError(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  return [];
}

export {DataChain};
