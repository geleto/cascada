import {createPoison, isPoison, PoisonError} from '../errors.js';
import {isObservableCommand} from '../commands/base.js';
import {DataCommand} from '../commands/data.js';
import {DataChainTarget} from './data-target.js';
import {Chain} from './base.js';
import {cloneDataValue, inspectSettledTargetForErrors} from '../data-values.js';

class DataChain extends Chain {
  constructor(buffer, chainName, context, chainType) {
    const env = context && context.env ? context.env : null;
    const base = new DataChainTarget(context && context.getVariables ? context.getVariables() : {}, env);
    super(buffer, chainName, context, chainType, base.data, base);
    this._snapshotShared = false;
    this._installCommandMethods();
  }

  // Data commands consume their arguments before mutation. For now, built-in
  // and custom data methods are assumed to commit synchronously resolved values,
  // so an applied data command leaves no unresolved promises or lazy markers in
  // _target. Snapshot observations can therefore capture the current object
  // immediately and rely on copy-on-write for later mutations.
  // TODO: Converge data initializers on non-command initialization once _target supports promises.
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

  _makeSnapshot() {
    if (this._fatalError) {
      throw this._fatalError;
    }
    const value = this._target;
    if (value && typeof value === 'object') {
      this._snapshotShared = true;
    }
    return value;
  }

  _isError() {
    if (this._fatalError) {
      return true;
    }
    return !!inspectSettledTargetForErrors(this._target);
  }

  _getErrors() {
    if (this._fatalError) {
      return this._fatalError;
    }
    return inspectSettledTargetForErrors(this._target);
  }

  _computeTargetErrorState(target) {
    return inspectSettledTargetForErrors(target);
  }

  _beforeApplyCommand(cmd) {
    if (!cmd || isObservableCommand(cmd) || !this._snapshotShared || !this._base) {
      return;
    }

    const cloned = cloneDataValue(this._target);
    this._setTarget(cloned);
    this._base.data = cloned;
    this._snapshotShared = false;
  }

  _captureGuardState() {
    return {
      target: cloneDataValue(this._target)
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
  return null;
}

export {DataChain};
