
import {RESOLVE_MARKER} from '../resolve.js';

import {
  PoisonError,
  isPoison,
  isPoisonError,
  isRuntimeFatalError,
  createPoison,
  handleError,
} from '../errors.js';
import {BufferIterator} from '../buffer-iterator.js';

class Channel {
  constructor(buffer, channelName, context, channelType = null, target = undefined, base = null) {
    this._channelName = channelName;
    this._channelType = channelType || channelName;
    this._context = context;
    this._buffer = buffer;
    this._target = target;
    this._base = base;

    this._iterator = new BufferIterator(this);
    this._stateVersion = 0;
    this._fatalError = null;
    this._errorStateCache = {
      version: -1,
      hasError: false,
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

  _setTarget(nextTarget) {
    this._target = nextTarget;
    this._markStateChanged();
    return this._target;
  }

  _invalidateErrorStateCache() {
    this._errorStateCache = {
      version: -1,
      hasError: false,
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
      return {
        hasError: this._errorStateCache.hasError,
        error: this._errorStateCache.error
      };
    }

    if (this._fatalError) {
      this._errorStateCache = {
        version: this._stateVersion,
        hasError: true,
        error: this._fatalError
      };
      return {
        hasError: true,
        error: this._fatalError
      };
    }

    const errorState = await this._computeTargetErrorState(this._getTarget());
    const hasError = !!(errorState && errorState.hasError);
    const error = hasError && errorState && errorState.error && Array.isArray(errorState.error.errors)
      ? new PoisonError(errorState.error.errors.slice())
      : null;

    this._errorStateCache = {
      version: this._stateVersion,
      hasError,
      error
    };

    return {
      hasError: this._errorStateCache.hasError,
      error: this._errorStateCache.error
    };
  }

  _getCurrentResult() {
    throw new Error(`Channel type '${this._channelType}' must implement _getCurrentResult()`);
  }

  _setFatalError(err, cmd = null) {
    const lineno = cmd && cmd.pos && typeof cmd.pos.lineno === 'number' ? cmd.pos.lineno : 0;
    const colno = cmd && cmd.pos && typeof cmd.pos.colno === 'number' ? cmd.pos.colno : 0;
    const path = this._context && this._context.path ? this._context.path : null;
    this._fatalError = handleError(err, lineno, colno, null, path);
    this._markStateChanged();
  }

  _recordError(err, cmd = null) {
    if (!err) return;
    if (isRuntimeFatalError(err)) {
      this._setFatalError(err, cmd);
      return;
    }
    const errors = isPoisonError(err) && Array.isArray(err.errors)
      ? err.errors
      : [err];
    this._applyPoisonErrors(contextualizeCommandErrors(this, cmd, errors), cmd);
  }

  _applyPoisonErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }
    const merged = mergePoisonErrors(extractPoisonErrors(this._getTarget()), errors);
    this._setTarget(createPoison(merged));
  }

  _beforeApplyCommand(cmd) {
    // Hook for channel types that need copy-on-write before mutations.
  }

  _applyCommand(cmd) {
    if (!cmd) return;
    try {
      cmd.resolved = true;
      this._beforeApplyCommand(cmd);
      const result = cmd.apply(this);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((err) => {
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
    const finalize = (inspection) => {
      if (inspection && inspection.error) {
        throw inspection.error;
      }
      return this._getCurrentResult();
    };

    const errorState = this._ensureErrorState();
    if (errorState && typeof errorState.then === 'function') {
      return Promise.resolve(errorState).then(finalize);
    }
    return finalize(errorState);
  }

  _resolveSnapshotCommandResult() {
    return this._getResultOrThrow();
  }

  _isErrorNow() {
    return this._ensureErrorState().then((errorState) => !!(errorState && errorState.hasError));
  }

  _getErrorNow() {
    return this._ensureErrorState().then((errorState) => (errorState ? errorState.error : null));
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

function createCallableChannelFacade(channel) {
  const target = (...args) => channel.invoke(...args);
  return new Proxy(target, {
    get: (proxyTarget, prop) => {
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return proxyTarget[prop];
      }
      if (prop in channel) {
        const value = channel[prop];
        if (typeof value === 'function') {
          const cacheName = `_bound_${String(prop)}`;
          if (!channel[cacheName]) {
            Object.defineProperty(channel, cacheName, {
              configurable: true,
              enumerable: false,
              writable: true,
              value: value.bind(channel)
            });
          }
          return channel[cacheName];
        }
        return value;
      }
      return proxyTarget[prop];
    },
    set: (proxyTarget, prop, value) => {
      if (prop in channel) {
        channel[prop] = value;
        return true;
      }
      proxyTarget[prop] = value;
      return true;
    }
  });
}

export { Channel, createCallableChannelFacade, cloneSnapshotValue, extractPoisonErrors, mergePoisonErrors, inspectTargetForErrors, contextualizeCommandErrors };

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

function extractPoisonErrors(value) {
  if (isPoison(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  if (isPoisonError(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  return [];
}

function mergePoisonErrors(existingErrors, nextErrors) {
  const merged = [];
  if (Array.isArray(existingErrors) && existingErrors.length > 0) {
    merged.push(...existingErrors);
  }
  if (Array.isArray(nextErrors) && nextErrors.length > 0) {
    merged.push(...nextErrors);
  }
  return merged;
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
          addError(err);
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
          addError(err);
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

  if (errors.length === 0) {
    return { hasError: false, error: null };
  }

  const deduped = new PoisonError(errors).errors.slice();
  return {
    hasError: deduped.length > 0,
    error: deduped.length > 0 ? new PoisonError(deduped) : null
  };
}

function contextualizeCommandErrors(channel, cmd, errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const lineno = cmd && cmd.pos && typeof cmd.pos.lineno === 'number' ? cmd.pos.lineno : 0;
  const colno = cmd && cmd.pos && typeof cmd.pos.colno === 'number' ? cmd.pos.colno : 0;
  const path = channel && channel._context && channel._context.path ? channel._context.path : null;
  return errors.map((err) => handleError(err, lineno, colno, null, path));
}
