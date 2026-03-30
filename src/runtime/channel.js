'use strict';

const {
  TextCommand,
  VarCommand,
  DataCommand,
  SinkCommand
} = require('./commands');
const { RESOLVE_MARKER } = require('./resolve');
const DataChannelTarget = require('../script/data-channel');
const { BufferIterator } = require('./buffer-iterator');
const { PoisonError, isPoison, isPoisonError, createPoison, handleError } = require('./errors');

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
    this._inspectionCache = {
      version: -1,
      hasError: false,
      poisonError: null
    };
    this._completionResolved = false;
    this._completionPromise = new Promise((resolve) => {
      this._resolveCompletion = resolve;
    });

    if (this._buffer) {
      this._buffer._registerChannel(this._channelName, this);
    }
  }

  _enqueueCommand(command, args) {
    if (!this._buffer) return;
    let entry;
    if (this._channelType === 'text') {
      entry = new TextCommand({
        channelName: this._channelName,
        args,
        normalizeArgs: true,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._channelType === 'var') {
      entry = new VarCommand({
        channelName: this._channelName,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._channelType === 'data') {
      entry = new DataCommand({
        channelName: this._channelName,
        command: command || null,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._channelType === 'sink') {
      entry = new SinkCommand({
        channelName: this._channelName,
        command: command || null,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else {
      throw new Error(`Unsupported channel type '${this._channelType}' for command enqueueing`);
    }
    this._buffer.add(entry, this._channelName);
  }

  _getTarget() {
    return this._target;
  }

  _setTarget(nextTarget) {
    this._target = nextTarget;
    this._markStateChanged();
    return this._target;
  }

  _invalidateInspectionCache() {
    this._inspectionCache = {
      version: -1,
      hasError: false,
      poisonError: null
    };
  }

  _markStateChanged() {
    this._stateVersion += 1;
    this._invalidateInspectionCache();
    return this._stateVersion;
  }

  async _inspectTargetForErrors(target) {
    return inspectTargetForErrors(target);
  }

  async _ensureInspection() {
    if (this._inspectionCache.version === this._stateVersion) {
      return {
        hasError: this._inspectionCache.hasError,
        error: this._inspectionCache.poisonError
      };
    }

    const inspection = await this._inspectTargetForErrors(this._getTarget());
    const hasError = !!(inspection && inspection.hasError);
    const poisonError = hasError && inspection && inspection.error && Array.isArray(inspection.error.errors)
      ? new PoisonError(inspection.error.errors.slice())
      : null;

    this._inspectionCache = {
      version: this._stateVersion,
      hasError,
      poisonError
    };

    return {
      hasError: this._inspectionCache.hasError,
      error: this._inspectionCache.poisonError
    };
  }

  _getCurrentResult() {
    throw new Error(`Channel type '${this._channelType}' must implement _getCurrentResult()`);
  }

  _recordError(err, cmd = null) {
    if (!err) return;
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

  _onIteratorFinished() {
    if (this._completionResolved) {
      return;
    }
    this._completionResolved = true;
    this._resolveCompletion();
  }

  _getResultOrThrow() {
    const finalize = (inspection) => {
      if (inspection && inspection.error) {
        throw inspection.error;
      }
      return this._getCurrentResult();
    };

    const inspection = this._ensureInspection();
    if (inspection && typeof inspection.then === 'function') {
      return Promise.resolve(inspection).then(finalize);
    }
    return finalize(inspection);
  }

  _resolveSnapshotCommandResult() {
    return this._getResultOrThrow();
  }

  _isErrorNow() {
    return this._ensureInspection().then((inspection) => !!(inspection && inspection.hasError));
  }

  _getErrorNow() {
    return this._ensureInspection().then((inspection) => (inspection ? inspection.error : null));
  }

  _captureGuardState() {
    return {
      target: cloneSnapshotValue(this._target)
    };
  }

  _restoreGuardState(state) {
    if (state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'target')) {
      this._setTarget(state.target);
      this._invalidateInspectionCache();
      return;
    }
    this._setTarget(state);
  }

  finalSnapshot() {
    try {
      if (this._completionResolved) {
        return Promise.resolve(this._resolveSnapshotCommandResult());
      }
      return Promise.resolve(this._completionPromise).then(() => this._resolveSnapshotCommandResult());
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

// Shared properties exposed on channel facades (proxy/callable).
// These must read/write the underlying Channel instance.
const CHANNEL_API_PROPS = new Set([
  '_channelName',
  '_channelType',
  '_context',
  '_target',
  '_base',
  '_buffer',
  '_iterator',
  '_stateVersion',
  '_inspectionCache',
  '_completionResolved'
]);

// Create a facade that can be callable (text/var) or dynamic-command (data).
// The proxy makes _target/_base/_buffer read/write-through to the Channel instance
// so the flattener's writes are visible to snapshot().
function createChannelFacade(output, options) {
  const { callable, dynamicCommands } = options;
  const target = callable
    ? (...args) => output.invoke(...args)
    : output;

  return new Proxy(target, {
    get: (proxyTarget, prop) => {
      if (prop === 'finalSnapshot') {
        if (!output._finalSnapshotCallable) {
          output._finalSnapshotCallable = output.finalSnapshot.bind(output);
        }
        return output._finalSnapshotCallable;
      }
      if (prop === '_applyCommand') {
        return output._applyCommand.bind(output);
      }
      if (prop === '_onIteratorFinished') {
        return output._onIteratorFinished.bind(output);
      }
      if (prop === '_resolveSnapshotCommandResult') {
        return output._resolveSnapshotCommandResult.bind(output);
      }
      if (prop === '_captureGuardState') {
        return output._captureGuardState.bind(output);
      }
      if (prop === '_restoreGuardState') {
        return output._restoreGuardState.bind(output);
      }
      if (prop === '_getTarget') {
        return output._getTarget.bind(output);
      }
      if (prop === '_setTarget') {
        return output._setTarget.bind(output);
      }
      if (prop === '_markStateChanged') {
        return output._markStateChanged.bind(output);
      }
      if (prop === '_ensureInspection') {
        return output._ensureInspection.bind(output);
      }
      if (prop === '_inspectTargetForErrors') {
        return output._inspectTargetForErrors.bind(output);
      }
      if (CHANNEL_API_PROPS.has(prop)) {
        return output[prop];
      }
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return proxyTarget[prop];
      }
      if (Object.prototype.hasOwnProperty.call(output, prop) || typeof output[prop] !== 'undefined') {
        const value = output[prop];
        if (typeof value === 'function') {
          return value.bind(output);
        }
        return value;
      }
      if (dynamicCommands) {
        if (prop === 'snapshot' || prop === 'isError' || prop === 'getError') {
          return undefined;
        }
        // Proxy allows arbitrary channel commands (e.g., channel.set(...)) without
        // predefining methods on the class. It preserves the dynamic command API.
        return (...args) => output._enqueueCommand(prop, args);
      }
      return proxyTarget[prop];
    },
    set: (proxyTarget, prop, value) => {
      if (CHANNEL_API_PROPS.has(prop)) {
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
    this._enqueueCommand(null, args);
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
  constructor(buffer, channelName, context, channelType, initialValue = null) {
    // Keep declaration-only var channels aligned with `none` semantics unless
    // a caller provides an explicit initializer.
    super(buffer, channelName, context, channelType, initialValue, null);
  }

  invoke(value) {
    if (!this._buffer) return;
    this._enqueueCommand(null, [value]);
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
  }

  _getCurrentResult() {
    return this._target;
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

function _createChannel(buffer, channelName, context, channelType = null, initializer = null) {
  const type = channelType || channelName;
  if (type === 'text') {
    // Text channel is callable; args are appended to the text buffer.
    return createChannelFacade(new TextChannel(buffer, channelName, context, type), {
      callable: true,
      dynamicCommands: false
    });
  }
  if (type === 'var') {
    // Var channel is callable; args replace the current value.
    return createChannelFacade(new VarChannel(buffer, channelName, context, type, initializer), {
      callable: true,
      dynamicCommands: false
    });
  }
  if (type === 'sequential_path') {
    return createChannelFacade(new SequentialPathChannel(buffer, channelName, context, type), {
      callable: false,
      dynamicCommands: false
    });
  }
  if (type === 'data') {
    // Data channel supports arbitrary commands (set, push, merge, etc.).
    return createChannelFacade(new DataChannel(buffer, channelName, context, type), {
      callable: false,
      dynamicCommands: true
    });
  }
  throw new Error(`Unsupported channel type '${type}'`);
}

class SinkChannel extends Channel {
  constructor(buffer, channelName, context, sink) {
    super(buffer, channelName, context, 'sink', undefined, null);
    this._sink = sink;
    this._sinkReady = false;
    this._sinkReadyPromise = null;
  }

  _resolveSink() {
    return this._sink;
  }

  _repairNow() {
    this._setTarget(undefined);

    const runRepair = (sink) => {
      if (!sink || typeof sink.repair !== 'function') {
        return undefined;
      }
      try {
        const result = sink.repair();
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).catch((err) => {
            this._setTarget(createPoison([err]));
            throw err;
          });
        }
        return result;
      } catch (err) {
        this._setTarget(createPoison([err]));
        throw err;
      }
    };

    const sink = this._ensureSinkResolved();
    if (sink && typeof sink.then === 'function') {
      return Promise.resolve(sink).then(runRepair, (err) => {
        this._setTarget(createPoison([err]));
        throw err;
      });
    }
    return runRepair(sink);
  }

  repair(pos = null) {
    const commandPos = normalizeCommandPos(pos);
    if (this._buffer) {
      return this._buffer.addSinkRepair(this._channelName, commandPos);
    }
    return Promise.resolve(this._repairNow());
  }

  _ensureSinkResolved() {
    if (this._sinkReady) {
      return this._sink;
    }
    if (!this._sinkReadyPromise) {
      const sinkVal = this._resolveSink();
      if (!sinkVal || typeof sinkVal.then !== 'function') {
        this._sink = sinkVal;
        this._sinkReady = true;
        return this._sink;
      }
      this._sinkReadyPromise = Promise.resolve(sinkVal)
        .then((resolvedSink) => {
          this._sink = resolvedSink;
          this._sinkReady = true;
          return resolvedSink;
        });
    }
    return this._sinkReadyPromise;
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
      const sink = this._ensureSinkResolved();
      const apply = () => cmd.apply(this);
      const result = (sink && typeof sink.then === 'function')
        ? Promise.resolve(sink).then(apply)
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

  _snapshotFromSink(sink) {
    if (!sink) return sink;
    if (typeof sink.snapshot === 'function') return sink.snapshot();
    if (typeof sink.getReturnValue === 'function') return sink.getReturnValue();
    if (typeof sink.finalize === 'function') return sink.finalize();
    return sink;
  }

  _resolveSnapshotCommandResult() {
    const sinkVal = this._ensureSinkResolved();
    if (sinkVal && typeof sinkVal.then === 'function') {
      return sinkVal.then((resolved) => {
        const target = this._getTarget();
        if (isPoison(target)) {
          throw new PoisonError(target.errors.slice());
        }
        return this._snapshotFromSink(resolved);
      });
    }
    const target = this._getTarget();
    if (isPoison(target)) {
      throw new PoisonError(target.errors.slice());
    }
    return super._resolveSnapshotCommandResult();
  }

  _getCurrentResult() {
    return this._snapshotFromSink(this._sink);
  }

  _captureGuardState() {
    const sinkVal = this._ensureSinkResolved();
    const capture = (sink) => {
      if (!sink || typeof sink.snapshot !== 'function') {
        return undefined;
      }
      return sink.snapshot();
    };
    const normalizeCapture = (captured) => {
      if (captured && typeof captured.then === 'function') {
        return Promise.resolve(captured);
      }
      return captured;
    };
    if (sinkVal && typeof sinkVal.then === 'function') {
      return Promise.resolve(sinkVal).then((sink) => normalizeCapture(capture(sink)));
    }
    return normalizeCapture(capture(sinkVal));
  }

  _restoreGuardState(state) {
    const sinkVal = this._ensureSinkResolved();
    const restore = (sink, recoveredState) => {
      this._setTarget(undefined);
      if (!sink || typeof sink.recover !== 'function') {
        return undefined;
      }
      return sink.recover(recoveredState);
    };

    const sinkIsPromise = !!(sinkVal && typeof sinkVal.then === 'function');
    const stateIsPromise = !!(state && typeof state.then === 'function');
    if (sinkIsPromise || stateIsPromise) {
      return Promise.all([Promise.resolve(sinkVal), Promise.resolve(state)])
        .then(([sink, recoveredState]) => restore(sink, recoveredState));
    }
    return restore(sinkVal, state);
  }
}

function _createSinkChannel(buffer, channelName, context, sink) {
  return new SinkChannel(buffer, channelName, context, sink);
}

class SequenceChannel extends SinkChannel {
  constructor(buffer, channelName, context, sink) {
    super(buffer, channelName, context, sink);
    this._channelType = 'sequence';
  }

  beginTransaction() {
    const sinkVal = this._ensureSinkResolved();
    const begin = (sink) => {
      if (!sink || typeof sink.begin !== 'function') {
        return { active: false, token: undefined };
      }
      const token = sink.begin();
      if (token && typeof token.then === 'function') {
        return Promise.resolve(token).then((resolvedToken) => ({ active: true, token: resolvedToken }));
      }
      return { active: true, token };
    };
    if (sinkVal && typeof sinkVal.then === 'function') {
      return Promise.resolve(sinkVal).then(begin);
    }
    return begin(sinkVal);
  }

  commitTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }
    const sinkVal = this._ensureSinkResolved();
    const commit = (sink) => {
      if (!sink || typeof sink.commit !== 'function') {
        return undefined;
      }
      return sink.commit(tx.token);
    };
    if (sinkVal && typeof sinkVal.then === 'function') {
      return Promise.resolve(sinkVal).then(commit);
    }
    return commit(sinkVal);
  }

  rollbackTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }
    const sinkVal = this._ensureSinkResolved();
    const rollback = (sink) => {
      if (!sink || typeof sink.rollback !== 'function') {
        return undefined;
      }
      return sink.rollback(tx.token);
    };
    if (sinkVal && typeof sinkVal.then === 'function') {
      return Promise.resolve(sinkVal).then(rollback);
    }
    return rollback(sinkVal);
  }
}

function _createSequenceChannel(buffer, channelName, context, sink) {
  return new SequenceChannel(buffer, channelName, context, sink);
}

function createChannel(buffer, channelName, context, channelType = null, initializer = null) {
  return _createChannel(buffer, channelName, context, channelType, initializer);
}

function createSinkChannel(buffer, channelName, context, sink) {
  return _createSinkChannel(buffer, channelName, context, sink);
}

function createSequenceChannel(buffer, channelName, context, sink) {
  return _createSequenceChannel(buffer, channelName, context, sink);
}

function declareBufferChannel(buffer, channelName, channelType, context, initializer = null) {
  const targetBuffer = buffer;
  if (!targetBuffer) {
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Channel "${channelName}" declared without an active CommandBuffer`);
  }

  targetBuffer._channelTypes = targetBuffer._channelTypes || Object.create(null);
  targetBuffer._channelTypes[channelName] = channelType;

  const channel = (channelType === 'sink')
    ? _createSinkChannel(targetBuffer, channelName, context, initializer)
    : (channelType === 'sequence')
      ? _createSequenceChannel(targetBuffer, channelName, context, initializer)
      : _createChannel(targetBuffer, channelName, context, channelType, initializer);

  channel._buffer = targetBuffer;

  targetBuffer._registerChannel(channelName, channel);

  if (channelType === 'sink' || channelType === 'sequence') {
    targetBuffer._channelRegistry = targetBuffer._channelRegistry || Object.create(null);
    targetBuffer._channelRegistry[channelName] = channel;
  }

  return channel;
}

function declareChannel(frame, buffer, channelName, channelType, context, initializer = null) {
  const channel = declareBufferChannel(buffer, channelName, channelType, context, initializer);
  frame._channels = frame._channels || Object.create(null);
  frame._channels[channelName] = channel;
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
  SinkChannel,
  createSinkChannel,
  SequenceChannel,
  createSequenceChannel,
  declareBufferChannel,
  declareChannel
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

function normalizeCommandPos(pos) {
  if (!pos || typeof pos !== 'object') {
    return { lineno: 0, colno: 0 };
  }
  const lineno = typeof pos.lineno === 'number' ? pos.lineno : 0;
  const colno = typeof pos.colno === 'number' ? pos.colno : 0;
  return { lineno, colno };
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
