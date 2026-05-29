import {createPoison, isPoison, isPoisonError, PoisonError} from '../errors.js';
import {DataCommand} from '../commands/data.js';
import {DataChainTarget} from './data-target.js';
import {Chain, cloneSnapshotValue} from './base.js';

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
          const errorContext = this._extractContextFromArgs(args, `DataChain.${methodName}`);
          this._buffer.addCommand(new DataCommand({
            chainName: this._chainName,
            operation: methodName,
            args,
            errorContext
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

  _applyPoisonError(poisonError, cmd = null) {
    const existingPoison = getPoisonError(this._getTarget());
    const poisonValue = createPoison(
      existingPoison ? PoisonError.group([existingPoison, poisonError]) : poisonError
    );
    const rawPath = cmd && Array.isArray(cmd.arguments) && cmd.arguments.length > 0 ? cmd.arguments[0] : null;
    const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;

    if (this._base) {
      try {
        this._base.set(path, poisonValue);
        this._setTarget(this._base.data);
        return;
      } catch (err) {
        void err;
      }
    }

    this._setTarget(poisonValue);
  }
}

function getPoisonError(value) {
  if (isPoison(value)) {
    return PoisonError.group(value.errors);
  }
  if (isPoisonError(value)) {
    return value;
  }
  return null;
}

export {DataChain};
