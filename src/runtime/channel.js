'use strict';

const {
  TextCommand,
  VarCommand,
  DataCommand
} = require('./commands');
const { RESOLVE_MARKER } = require('./resolve');
const DataChannelTarget = require('../script/data-channel');
const { BufferIterator } = require('./buffer-iterator');
const {
  CHANNEL_TYPE_FACTS
} = require('../channel-types');
const {
  PoisonError,
  RuntimeFatalError,
  isPoison,
  isPoisonError,
  isRuntimeFatalError,
  createPoison,
  handleError
} = require('./errors');

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
    this._inheritanceSharedDefaultClaimed = false;
    this._completionResolved = false;
    this._completionPromise = new Promise((resolve) => {
      this._resolveCompletion = resolve;
    });

    if (this._buffer) {
      this._buffer._registerChannel(this._channelName, this);
    }
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

// Create a callable facade for channels that are invoked like functions
// from compiled/user code, e.g. log("text") or x(value).
function createCallableChannelFacade(output) {
  const target = (...args) => output.invoke(...args);
  return new Proxy(target, {
    get: (proxyTarget, prop) => {
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return proxyTarget[prop];
      }
      if (prop in output) {
        const value = output[prop];
        if (typeof value === 'function') {
          const cacheName = `_bound_${String(prop)}`;
          if (!Object.prototype.hasOwnProperty.call(output, cacheName)) {
            Object.defineProperty(output, cacheName, {
              configurable: true,
              enumerable: false,
              writable: true,
              value: value.bind(output)
            });
          }
          return output[cacheName];
        }
        return value;
      }
      return proxyTarget[prop];
    },
    set: (proxyTarget, prop, value) => {
      if (prop in output) {
        output[prop] = value;
        return true;
      }
      proxyTarget[prop] = value;
      return true;
    }
  });
}

class TextChannel extends Channel {
  constructor(buffer, channelName, context, channelType) {
    super(buffer, channelName, context, channelType, [], null);
  }

  invoke(...args) {
    if (!this._buffer) return;
    if (args.length === 0) return;
    this._buffer.add(new TextCommand({
      channelName: this._channelName,
      args,
      normalizeArgs: true,
      pos: { lineno: 0, colno: 0 }
    }), this._channelName);
  }

  _getCurrentResult() {
    if (!Array.isArray(this._target) || this._target.length === 0) {
      this._setTarget(['']);
      return '';
    }
    const result = this._target.join('');
    // Compact accumulated fragments so future appends keep O(1)-ish growth.
    this._setTarget([result]);
    return result;
  }

  _applyPoisonErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }
    if (!Array.isArray(this._target)) {
      this._setTarget([]);
    }
    this._target.push(createPoison(errors));
    this._markStateChanged();
  }
}

class VarChannel extends Channel {
  constructor(buffer, channelName, context, channelType, initialValue = undefined) {
    // Keep declaration-only var channels aligned with `none` semantics unless
    // a caller provides an explicit initializer.
    super(buffer, channelName, context, channelType, initialValue, null);
  }

  invoke(value) {
    if (!this._buffer) return;
    this._buffer.add(new VarCommand({
      channelName: this._channelName,
      args: [value],
      pos: { lineno: 0, colno: 0 }
    }), this._channelName);
  }

  _getCurrentResult() {
    return this._target;
  }
}

class SequentialPathChannel extends Channel {
  constructor(buffer, channelName, context, channelType) {
    super(buffer, channelName, context, channelType, true, null);
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

class DataChannel extends Channel {
  constructor(buffer, channelName, context, channelType) {
    const env = context && context.env ? context.env : null;
    const base = new DataChannelTarget(context && context.getVariables ? context.getVariables() : {}, env);
    super(
      buffer,
      channelName,
      context,
      channelType,
      base.data,
      base
    );
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
          this._buffer.add(new DataCommand({
            channelName: this._channelName,
            command: methodName,
            args,
            pos: { lineno: 0, colno: 0 }
          }), this._channelName);
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

function createChannel(buffer, channelName, context, channelType = null, initializer) {
  const type = channelType || channelName;
  switch (type) {
    case 'text':
      return createCallableChannelFacade(new TextChannel(buffer, channelName, context, type));
    case 'var':
      return createCallableChannelFacade(new VarChannel(buffer, channelName, context, type, initializer));
    case 'sequential_path':
      return new SequentialPathChannel(buffer, channelName, context, type);
    case 'data':
      return new DataChannel(buffer, channelName, context, type);
    case 'sequence':
      return new SequenceChannel(buffer, channelName, context, initializer);
    default:
      throw new Error(`Unsupported channel type '${type}'`);
  }
}

class SequenceObjectChannel extends Channel {
  constructor(buffer, channelName, context, targetObject) {
    super(buffer, channelName, context, 'sequence', undefined, null);
    this._sequenceTarget = targetObject;
    this._sequenceTargetReady = false;
    this._sequenceTargetReadyPromise = null;
  }

  _resolveSequenceTarget() {
    return this._sequenceTarget;
  }

  _setSequenceTarget(targetObject) {
    this._sequenceTarget = targetObject;
    this._sequenceTargetReady = false;
    this._sequenceTargetReadyPromise = null;
    this._setTarget(undefined);
    return this._sequenceTarget;
  }

  _ensureSequenceTargetResolved() {
    if (this._sequenceTargetReady) {
      return this._sequenceTarget;
    }
    if (!this._sequenceTargetReadyPromise) {
      const targetValue = this._resolveSequenceTarget();
      if (!targetValue || typeof targetValue.then !== 'function') {
        this._sequenceTarget = targetValue;
        this._sequenceTargetReady = true;
        return this._sequenceTarget;
      }
      this._sequenceTargetReadyPromise = Promise.resolve(targetValue)
        .then((resolvedTarget) => {
          this._sequenceTarget = resolvedTarget;
          this._sequenceTargetReady = true;
          this._sequenceTargetReadyPromise = null;
          return resolvedTarget;
        });
    }
    return this._sequenceTargetReadyPromise;
  }

  _applyCommand(cmd) {
    if (!cmd) return;
    try {
      cmd.resolved = true;
      if (cmd.isObservable) {
        const result = cmd.apply(this);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).catch((err) => {
            this._recordError(err, cmd);
          });
        }
        return result;
      }
      const sequenceTarget = this._ensureSequenceTargetResolved();
      const apply = () => cmd.apply(this);
      const result = (sequenceTarget && typeof sequenceTarget.then === 'function')
        ? Promise.resolve(sequenceTarget).then(apply)
        : apply();
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

  _snapshotFromSequenceTarget(sequenceTarget) {
    if (!sequenceTarget) return sequenceTarget;
    if (typeof sequenceTarget.snapshot === 'function') return sequenceTarget.snapshot();
    if (typeof sequenceTarget.getReturnValue === 'function') return sequenceTarget.getReturnValue();
    if (typeof sequenceTarget.finalize === 'function') return sequenceTarget.finalize();
    return sequenceTarget;
  }

  _resolveSnapshotCommandResult() {
    const targetValue = this._ensureSequenceTargetResolved();
    if (targetValue && typeof targetValue.then === 'function') {
      return targetValue.then((resolved) => {
        const target = this._getTarget();
        if (isPoison(target)) {
          throw new PoisonError(target.errors.slice());
        }
        return this._snapshotFromSequenceTarget(resolved);
      });
    }
    const target = this._getTarget();
    if (isPoison(target)) {
      throw new PoisonError(target.errors.slice());
    }
    return super._resolveSnapshotCommandResult();
  }

  _getCurrentResult() {
    return this._snapshotFromSequenceTarget(this._sequenceTarget);
  }

  _captureGuardState() {
    const targetValue = this._ensureSequenceTargetResolved();
    const capture = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.snapshot !== 'function') {
        return undefined;
      }
      return sequenceTarget.snapshot();
    };
    const normalizeCapture = (captured) => {
      if (captured && typeof captured.then === 'function') {
        return Promise.resolve(captured);
      }
      return captured;
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then((sequenceTarget) => normalizeCapture(capture(sequenceTarget)));
    }
    return normalizeCapture(capture(targetValue));
  }

  _restoreGuardState(state) {
    const targetValue = this._ensureSequenceTargetResolved();
    const restore = (sequenceTarget, recoveredState) => {
      this._setTarget(undefined);
      if (!sequenceTarget || typeof sequenceTarget.recover !== 'function') {
        return undefined;
      }
      return sequenceTarget.recover(recoveredState);
    };

    const targetIsPromise = !!(targetValue && typeof targetValue.then === 'function');
    const stateIsPromise = !!(state && typeof state.then === 'function');
    if (targetIsPromise || stateIsPromise) {
      return Promise.all([Promise.resolve(targetValue), Promise.resolve(state)])
        .then(([sequenceTarget, recoveredState]) => restore(sequenceTarget, recoveredState));
    }
    return restore(targetValue, state);
  }
}

class SequenceChannel extends SequenceObjectChannel {
  constructor(buffer, channelName, context, targetObject) {
    super(buffer, channelName, context, targetObject);
    this._channelType = 'sequence';
  }

  beginTransaction() {
    const targetValue = this._ensureSequenceTargetResolved();
    const begin = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.begin !== 'function') {
        return { active: false, token: undefined };
      }
      const token = sequenceTarget.begin();
      if (token && typeof token.then === 'function') {
        return Promise.resolve(token).then((resolvedToken) => ({ active: true, token: resolvedToken }));
      }
      return { active: true, token };
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(begin);
    }
    return begin(targetValue);
  }

  commitTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }
    const targetValue = this._ensureSequenceTargetResolved();
    const commit = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.commit !== 'function') {
        return undefined;
      }
      return sequenceTarget.commit(tx.token);
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(commit);
    }
    return commit(targetValue);
  }

  rollbackTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }
    const targetValue = this._ensureSequenceTargetResolved();
    const rollback = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.rollback !== 'function') {
        return undefined;
      }
      return sequenceTarget.rollback(tx.token);
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(rollback);
    }
    return rollback(targetValue);
  }
}

function createSequenceChannel(buffer, channelName, context, targetObject) {
  return createChannel(buffer, channelName, context, 'sequence', targetObject);
}

function declareBufferChannel(buffer, channelName, channelType, context, initializer) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Channel "${channelName}" declared without an active CommandBuffer`);
  }

  targetBuffer._channelTypes = targetBuffer._channelTypes || Object.create(null);
  targetBuffer._channelTypes[channelName] = channelType;

  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  const channel = createChannel(targetBuffer, channelName, context, channelType, initializer);

  channel._buffer = targetBuffer;

  targetBuffer._registerChannel(channelName, channel);

  if (channelFacts && channelFacts.usesInitializerAsTarget) {
    targetBuffer._channelRegistry = targetBuffer._channelRegistry || Object.create(null);
    targetBuffer._channelRegistry[channelName] = channel;
  }

  return channel;
}

function claimInheritanceSharedDefault(buffer, channelName) {
  const channel = buffer && typeof buffer.getOwnChannel === 'function'
    ? buffer.getOwnChannel(channelName)
    : null;
  if (!channel) {
    return false;
  }
  if (channel._inheritanceSharedDefaultClaimed) {
    return false;
  }
  channel._inheritanceSharedDefaultClaimed = true;
  return true;
}

function declareInheritanceSharedChannel(buffer, channelName, channelType, context) {
  const existingChannel = buffer && typeof buffer.getOwnChannel === 'function'
    ? buffer.getOwnChannel(channelName)
    : null;
  if (existingChannel) {
    if (existingChannel._channelType !== channelType) {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' was declared as '${existingChannel._channelType}' and '${channelType}'`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      );
    }
    return existingChannel;
  }

  return declareBufferChannel(buffer, channelName, channelType, context);
}

// Caller must first win claimInheritanceSharedDefault(...). Keeping the claim
// separate lets generated code skip evaluating ignored ancestor defaults.
function initializeInheritanceSharedChannelDefault(buffer, channelName, channelType, context, initializer) {
  const channel = declareInheritanceSharedChannel(buffer, channelName, channelType, context);
  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  if (channelFacts && channelFacts.usesInitializerAsTarget) {
    if (typeof channel._setSequenceTarget !== 'function') {
      throw new RuntimeFatalError(
        `shared channel '${channelName}' cannot be initialized as '${channelType}'`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      );
    }
    channel._setSequenceTarget(initializer);
    return channel;
  }
  return channel;
}

module.exports = {
  Channel,
  DataChannel,
  TextChannel,
  VarChannel,
  SequentialPathChannel,
  inspectTargetForErrors,
  createChannel,
  SequenceChannel,
  createSequenceChannel,
  declareBufferChannel,
  declareInheritanceSharedChannel,
  claimInheritanceSharedDefault,
  initializeInheritanceSharedChannelDefault
};

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

function contextualizeCommandErrors(output, cmd, errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const lineno = cmd && cmd.pos && typeof cmd.pos.lineno === 'number' ? cmd.pos.lineno : 0;
  const colno = cmd && cmd.pos && typeof cmd.pos.colno === 'number' ? cmd.pos.colno : 0;
  const path = output && output._context && output._context.path ? output._context.path : null;
  return errors.map((err) => handleError(err, lineno, colno, null, path));
}
