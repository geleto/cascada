
import {cloneDataValue, inspectTargetForErrors} from '../data-values.js';

import {
  PoisonError,
  RuntimeError,
  isPoison,
  isPoisonError,
  isRuntimeError,
  createPoison,
} from '../errors.js';

class Chain {
  constructor(buffer, chainName, context, chainType = null, target = undefined, base = null) {
    this._chainName = chainName;
    this._chainType = chainType || chainName;
    this._context = context;
    this._buffer = buffer;
    this._target = target;
    this._base = base;

    this._stateVersion = 0;
    this._fatalError = null;
    this._errorStateCache = {
      version: -1,
      error: null
    };
    this._completionResolved = false;
    this._completionPromise = new Promise((resolve) => {
      this._resolveCompletion = resolve;
    });

  }

  _getTarget() {
    return this._target;
  }

  get chainType() {
    return this._chainType;
  }

  get name() {
    return this._buffer
      ? this._buffer._resolveAliasedChainName(this._chainName)
      : this._chainName;
  }

  _setTarget(nextTarget) {
    this._target = nextTarget;
    this._markStateChanged();
    return this._target;
  }

  setInitialValue(value) {
    return this._setTarget(value);
  }

  _invalidateErrorStateCache() {
    this._errorStateCache = {
      version: -1,
      error: null
    };
  }

  _markStateChanged() {
    this._stateVersion += 1;
    this._invalidateErrorStateCache();
    return this._stateVersion;
  }

  _computeTargetErrorState(target) {
    return inspectTargetForErrors(target);
  }

  _ensureErrorState() {
    if (this._errorStateCache.version === this._stateVersion) {
      return this._errorStateCache.error;
    }

    if (this._fatalError) {
      this._errorStateCache = {
        version: this._stateVersion,
        error: this._fatalError
      };
      return this._fatalError;
    }

    const inspectedVersion = this._stateVersion;
    const inspectedTarget = this._getTarget();
    const error = this._computeTargetErrorState(inspectedTarget);
    const cache = (settledError) => {
      if (this._stateVersion === inspectedVersion) {
        this._errorStateCache = {
          version: inspectedVersion,
          error: settledError
        };
      }
      return settledError;
    };

    if (error && typeof error.then === 'function') {
      return error.then(cache);
    }

    return cache(error);
  }

  _getCurrentResult() {
    throw new Error(`Chain type '${this._chainType}' must implement _getCurrentResult()`);
  }

  _extractContextFromArgs(args, label = `${this.constructor.name}.invoke`) {
    if (args.length === 0) {
      throw new TypeError(`${label} requires a compact errorContext as the last argument (got no arguments)`);
    }
    const errorContext = args.pop();
    if (!Array.isArray(errorContext)) {
      const received = errorContext === null ? 'null' : typeof errorContext;
      throw new TypeError(`${label} requires a compact errorContext as the last argument (got ${received})`);
    }
    return errorContext;
  }

  _setFatalError(err, cmd = null) {
    this._fatalError = RuntimeError.report(err, cmd.errorContext);
    this._markStateChanged();
  }

  _recordError(err, cmd = null) {
    if (!err) return;
    if (isRuntimeError(err)) {
      this._setFatalError(err, cmd);
      return;
    }
    if (isPoisonError(err)) {
      this._applyPoisonError(err, cmd);
      return;
    }
    RuntimeError.reportAndThrow(err, cmd.errorContext);
  }

  _applyPoisonError(poisonError) {
    const existingPoison = getPoisonError(this._getTarget());
    this._setTarget(createPoison(
      existingPoison ? PoisonError.group([existingPoison, poisonError]) : poisonError
    ));
  }

  _beforeApplyCommand(cmd) {
    // Hook for chain types that need copy-on-write or readiness gating before
    // applying a command. Return a thenable to defer command application.
  }

  _resolveChainCompletion() {
    if (this._completionResolved) {
      return;
    }
    this._completionResolved = true;
    if (this._resolveCompletion) {
      this._resolveCompletion();
    }
    this._resolveCompletion = null;
    this._completionPromise = null;
  }

  _getResultOrThrow() {
    const finalize = (error) => {
      if (error) {
        throw error;
      }
      return this._getCurrentResult();
    };

    const error = this._ensureErrorState();
    if (error && typeof error.then === 'function') {
      return error.then(finalize);
    }
    return finalize(error);
  }

  _resolveSnapshotCommandResult() {
    return this._getResultOrThrow();
  }

  _makeSnapshot() {
    return this._resolveSnapshotCommandResult();
  }

  _isError() {
    const error = this._ensureErrorState();
    if (error && typeof error.then === 'function') {
      return error.then((settledError) => !!settledError);
    }
    return !!error;
  }

  _getErrors() {
    const error = this._ensureErrorState();
    if (error && typeof error.then === 'function') {
      return error.then((settledError) => settledError || null);
    }
    return error || null;
  }

  getFinishedPromise() {
    if (this._completionResolved) {
      return Promise.resolve();
    }
    return this._completionPromise;
  }

  _captureGuardState() {
    return {
      target: cloneDataValue(this._target)
    };
  }

  _restoreGuardState(state) {
    if (state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'target')) {
      this._setTarget(state.target);
      this._invalidateErrorStateCache();
      return;
    }
    this._setTarget(state);
  }

  finalSnapshot() {
    try {
      if (this._completionResolved) {
        return this._resolveSnapshotCommandResult();
      }
      return this._completionPromise.then(() => this._resolveSnapshotCommandResult());
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

function createCallableChainFacade(chain) {
  const target = (...args) => chain.invoke(...args);
  return new Proxy(target, {
    get: (proxyTarget, prop) => {
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return proxyTarget[prop];
      }
      if (prop in chain) {
        const value = chain[prop];
        if (typeof value === 'function') {
          const cacheName = `_bound_${prop}`;
          if (!chain[cacheName]) {
            Object.defineProperty(chain, cacheName, {
              configurable: true,
              enumerable: false,
              writable: true,
              value: value.bind(chain)
            });
          }
          return chain[cacheName];
        }
        return value;
      }
      return proxyTarget[prop];
    },
    set: (proxyTarget, prop, value) => {
      if (prop in chain) {
        chain[prop] = value;
        return true;
      }
      proxyTarget[prop] = value;
      return true;
    }
  });
}

export { Chain, createCallableChainFacade };

function getPoisonError(value) {
  if (isPoison(value)) {
    return PoisonError.group(value.errors);
  }
  if (isPoisonError(value)) {
    return value;
  }
  return null;
}
