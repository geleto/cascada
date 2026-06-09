
import {RESOLVE_MARKER} from '../resolve.js';

import {
  PoisonError,
  RuntimeError,
  isPoison,
  isPoisonError,
  isRuntimeError,
  createPoison,
  poisonOrReportedFatal,
} from '../errors.js';
import {BufferIterator} from '../buffer-iterator.js';

class Chain {
  constructor(buffer, chainName, context, chainType = null, target = undefined, base = null) {
    this._chainName = chainName;
    this._chainType = chainType || chainName;
    this._context = context;
    this._buffer = buffer;
    this._target = target;
    this._base = base;

    this._iterator = new BufferIterator(this);
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

  async _computeTargetErrorState(target) {
    return inspectTargetForErrors(target);
  }

  async _ensureErrorState() {
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
    const error = await this._computeTargetErrorState(inspectedTarget);

    if (this._stateVersion === inspectedVersion) {
      this._errorStateCache = {
        version: inspectedVersion,
        error
      };
    }

    return error;
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
    // Hook for chain types that need copy-on-write before mutations.
  }

  _applyCommand(cmd) {
    if (!cmd) return;
    if (cmd.isObservable) {
      return this._applyObservableCommand(cmd);
    }
    return this._applyMutatingCommand(cmd);
  }

  _applyObservableCommand(cmd) {
    try {
      cmd.resolved = true;
      this._beforeApplyCommand(cmd);
      const result = cmd.apply(this);
      if (result && typeof result.then === 'function') {
        return result.then(undefined, (err) => {
          cmd.rejectResult(poisonOrReportedFatal(err, cmd.errorContext));
        });
      }
      return result;
    } catch (err) {
      cmd.rejectResult(poisonOrReportedFatal(err, cmd.errorContext));
    }
  }

  _applyMutatingCommand(cmd) {
    try {
      cmd.resolved = true;
      this._beforeApplyCommand(cmd);
      const result = cmd.apply(this);
      if (result && typeof result.then === 'function') {
        return result.then(undefined, (err) => {
          this._recordError(err, cmd);
        });
      }
      return result;
    } catch (err) {
      this._recordError(err, cmd);
    }
  }

  _resolveIteratorCompletion() {
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
      target: cloneSnapshotValue(this._target)
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
          const cacheName = `_bound_${String(prop)}`;
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

export { Chain, createCallableChainFacade, cloneSnapshotValue, inspectTargetForErrors };

function cloneSnapshotValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneSnapshotValue(item));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        out[key] = cloneSnapshotValue(value[key]);
      }
    }
    return out;
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
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

async function inspectTargetForErrors(target) {
  const seenObjects = new Set();
  const errors = [];

  const addError = (err) => {
    if (!err) {
      return;
    }
    errors.push(err);
  };

  const addErrors = (list) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const err of list) {
      addError(err);
    }
  };

  const visit = async (value) => {
    if (isPoison(value)) {
      addErrors(value.errors);
      return;
    }

    if (value && typeof value.then === 'function') {
      try {
        const resolved = await value;
        await visit(resolved);
      } catch (err) {
        if (isPoisonError(err)) {
          addErrors(err.errors);
        } else {
          // This diagnostic walker has no source context of its own; raw
          // promise/marker failures must surface unchanged as fatal errors.
          throw err;
        }
      }
      return;
    }

    if (value && value[RESOLVE_MARKER]) {
      try {
        await value[RESOLVE_MARKER];
      } catch (err) {
        if (isPoisonError(err)) {
          addErrors(err.errors);
        } else {
          // This diagnostic walker has no source context of its own; raw
          // promise/marker failures must surface unchanged as fatal errors.
          throw err;
        }
        return;
      }
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    if (seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
      await Promise.all(value.map((entry) => visit(entry)));
      return;
    }

    if (isPlainObject(value)) {
      const values = [];
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // Error inspection must not trigger accessor side effects on external objects.
        if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
          continue;
        }
        values.push(value[key]);
      }
      await Promise.all(values.map((entry) => visit(entry)));
    }
  };

  await visit(target);

  return errors.length === 0 ? null : PoisonError.group(errors);
}

