'use strict';

const {
  ErrorCommand,
  TextCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand,
  SnapshotCommand,
  RawSnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  CaptureGuardStateCommand,
  SinkRepairCommand,
  RestoreGuardStateCommand
} = require('./commands');
const { checkFinishedBuffer } = require('./checks');
const { handleError, RuntimeFatalError } = require('./errors');

class CommandBuffer {
  constructor(context, parent = null, frame = null, enableWaitApplied = false) {
    if (!frame || typeof frame !== 'object') {
      throw new Error('CommandBuffer requires an owning frame');
    }
    this._context = context;
    this.parent = parent;
    this.finished = false;

    // Create arrays namespace (channels created lazily on first write/snapshot).
    this.arrays = Object.create(null);
    // Shared registry of Channel objects for this buffer hierarchy.
    this._channels = parent ? parent._channels : new Map();
    // Iterators currently visiting this buffer keyed by channel name.
    this._visitingIterators = new Map();
    // finish was requested and will complete once finish preconditions are met.
    this._finishRequested = false;
    // waitApplied tracking is only needed for limited-loop iteration buffers.
    this._enableWaitApplied = enableWaitApplied;
    if (this._enableWaitApplied) {
      // Number of active iterator presences currently traversing this buffer.
      this._activeWaitAppliedCount = 0;
      // Deferred waitApplied promise state.
      this._waitAppliedPromise = null;
      this._waitAppliedResolve = null;
    }
    if (parent && parent._boundaryAliases) {
      // Propagate include-boundary alias projection down the buffer tree.
      this._inheritBoundaryAliases(parent._boundaryAliases);
    }
  }

  _registerChannel(channelName, channel) {
    if (!(this._channels instanceof Map)) {
      this._channels = new Map();
    }
    this._channels.set(channelName, channel);

    const iterator = ensureChannelIterator(channel);
    if (iterator) {
      iterator.bindToCurrentBuffer();
    }
  }

  markFinishedAndPatchLinks() {
    this._finishRequested = true;
    this._tryCompleteFinish();
  }

  onEnterBuffer(iterator, channelName) {
    if (!iterator || !channelName) {
      return;
    }
    const resolvedChannelName = this._resolveChannelName(channelName);
    this._visitingIterators.set(resolvedChannelName, iterator);
    if (this._enableWaitApplied) {
      this._activeWaitAppliedCount++;
    }
  }

  onLeaveBuffer(iterator, channelName) {
    if (!iterator || !channelName) {
      return;
    }
    const resolvedChannelName = this._resolveChannelName(channelName);
    const current = this._visitingIterators.get(resolvedChannelName);
    if (current === iterator) {
      this._visitingIterators.delete(resolvedChannelName);
    }
    if (this._enableWaitApplied && this._activeWaitAppliedCount > 0) {
      this._activeWaitAppliedCount--;
    }
    this._resolveWaitAppliedIfReady();
  }

  waitApplied() {
    if (this._isWaitAppliedReady()) {
      return Promise.resolve();
    }
    if (!this._waitAppliedPromise) {
      this._waitAppliedPromise = new Promise((resolve) => {
        this._waitAppliedResolve = resolve;
      });
    }
    return this._waitAppliedPromise;
  }

  addText(value, pos = null, channelName = 'text') {
    const textPos = pos && typeof pos === 'object'
      ? pos
      : { lineno: 0, colno: 0 };
    const cmd = new TextCommand({
      channelName: 'text',
      args: [value],
      pos: textPos
    });
    return this._addCommand(cmd, channelName);
  }

  addPoison(errors, channelName) {
    const errs = Array.isArray(errors) ? errors : [errors];
    const cmd = new ErrorCommand(errs);
    return this._addCommand(cmd, channelName);
  }

  add(value, channelName) {
    checkFinishedBuffer(this);
    const resolvedChannelName = this._resolveChannelName(channelName);
    // Normalize command channel/path keys at ingress so all downstream runtime
    // lookups operate on canonical channel names.
    if (!isCommandBuffer(value) && value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, 'channelName')) {
        value.channelName = resolvedChannelName;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'pathKey')) {
        value.pathKey = resolvedChannelName;
      }
    }
    if (!this.arrays[resolvedChannelName]) {
      this.arrays[resolvedChannelName] = [];
    }
    const target = this.arrays[resolvedChannelName];
    target.push(value);
    const slot = target.length - 1;

    if (isCommandBuffer(value)) {
      value.parent = this;
      if (this._boundaryAliases) {
        value._inheritBoundaryAliases(this._boundaryAliases);
      }
    }

    this._notifyCommandOrBufferAdded(resolvedChannelName);
    return slot;
  }

  addBuffer(buffer, channelName) {
    return this.add(buffer, channelName);
  }

  addSequenceGet(channelName, command, subpath = null, pos = null) {
    const cmd = new SequenceGetCommand({
      channelName,
      command: command || null,
      subpath: Array.isArray(subpath) ? subpath : [],
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, channelName);
  }

  addSequenceCall(channelName, command, subpath = null, args = null, pos = null) {
    const cmd = new SequenceCallCommand({
      channelName,
      command: command || null,
      subpath: Array.isArray(subpath) ? subpath : [],
      args: Array.isArray(args) ? args : [],
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, channelName);
  }

  addSequentialPathRead(channelName, operation, pos = null, repair = false) {
    const CommandClass = repair ? RepairReadCommand : SequentialPathReadCommand;
    const cmd = new CommandClass({
      channelName,
      pathKey: channelName,
      operation,
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, channelName);
  }

  addSequentialPathWrite(channelName, operation, pos = null, repair = false) {
    const CommandClass = repair ? RepairWriteCommand : SequentialPathWriteCommand;
    const cmd = new CommandClass({
      channelName,
      pathKey: channelName,
      operation,
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, channelName);
  }

  addSnapshot(channelName, pos = null) {
    const cmd = new SnapshotCommand({
      channelName,
      pos
    });
    if (this.finished) {
      const resolvedChannelName = this._resolveChannelName(channelName);
      const output = this._channels.get(resolvedChannelName);
      const path = (this._context && this._context.path) ? this._context.path : null;
      if (!output._buffer.finished) {
        throw new RuntimeFatalError(
          'Snapshot command on finished buffer is allowed only if the whole channel stream is finished',
          pos?.lineno ?? 0,
          pos?.colno ?? 0,
          null,
          path
        );
      }
      return this._runFinishedSnapshotCommand(cmd, resolvedChannelName);
    }
    return this._addCommand(cmd, channelName);
  }

  // addRawSnapshot enqueues an ordered raw read command.
  // Unlike addSnapshot, this does not inspect nested poison state; it returns
  // the current channel target directly.
  addRawSnapshot(channelName, pos = null) {
    const cmd = new RawSnapshotCommand({
      channelName,
      pos
    });
    if (this.finished) {
      const resolvedChannelName = this._resolveChannelName(channelName);
      const output = this._channels.get(resolvedChannelName);
      const path = (this._context && this._context.path) ? this._context.path : null;
      if (!output._buffer.finished) {
        throw new RuntimeFatalError(
          'Raw snapshot command on finished buffer is allowed only if the whole channel stream is finished',
          pos?.lineno ?? 0,
          pos?.colno ?? 0,
          null,
          path
        );
      }
      return this._runFinishedSnapshotCommand(cmd, resolvedChannelName);
    }
    return this._addCommand(cmd, channelName);
  }

  addIsError(channelName, pos = null) {
    const cmd = new IsErrorCommand({
      channelName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, channelName);
  }

  addGetError(channelName, pos = null) {
    const cmd = new GetErrorCommand({
      channelName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, channelName);
  }

  addCaptureGuardState(channelName, pos = null) {
    const cmd = new CaptureGuardStateCommand({
      channelName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, channelName);
  }

  addSinkRepair(channelName, pos = null) {
    const cmd = new SinkRepairCommand({
      channelName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, channelName);
  }

  addRestoreGuardState(channelName, target, pos = null) {
    const cmd = new RestoreGuardStateCommand({
      channelName,
      target,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, channelName);
  }

  _addCommand(cmd, channelName) {

    if (!this.finished) {
      this.add(cmd, channelName);
      return cmd.promise;
    }

    const path = (this._context && this._context.path) ? this._context.path : null;
    throw new RuntimeFatalError(
      `Adding command '${cmd && cmd.constructor ? cmd.constructor.name : 'unknown'}' is not allowed on a finished CommandBuffer`,
      cmd && cmd.pos ? cmd.pos.lineno : 0,
      cmd && cmd.pos ? cmd.pos.colno : 0,
      null,
      path
    );
  }

  _runFinishedSnapshotCommand(cmd, channelName) {
    const channel = this._channels.get(channelName);
    const path = (this._context && this._context.path) ? this._context.path : null;

    const applySnapshot = () => {
      try {
        cmd.apply(channel);
      } catch (err) {
        const channelPath = channel && channel._context && channel._context.path ? channel._context.path : path;
        cmd.rejectResult(handleError(err, cmd.pos.lineno, cmd.pos.colno, null, channelPath));
      }
      return cmd.promise;
    };

    // Snapshot-on-finished-buffer is allowed only after the entire channel stream is complete.
    if (!channel._completionResolved && channel._completionPromise) {
      return Promise.resolve(channel._completionPromise).then(applySnapshot);
    }

    return applySnapshot();
  }

  _notifyCommandOrBufferAdded(channelName) {
    const iterator = this._visitingIterators.get(channelName);
    if (iterator) {
      iterator.onCommandOrBufferAdded(this);
    }
  }

  _tryCompleteFinish() {
    if (!this._finishRequested || this.finished) {
      return;
    }
    this.finished = true;
    this._notifyBufferFinished();
    this._resolveWaitAppliedIfReady();
  }

  _notifyBufferFinished() {
    const seen = new Set();

    for (const iterator of this._visitingIterators.values()) {
      if (!iterator || seen.has(iterator)) {
        continue;
      }
      seen.add(iterator);
      iterator.onBufferFinished(this);
    }
  }

  getChannel(channelName = 'text') {
    const resolvedChannelName = this._resolveChannelName(channelName);
    if (!(this._channels instanceof Map)) {
      throw new Error('CommandBuffer channels are unavailable');
    }
    const output = this._channels.get(resolvedChannelName);
    if (!output) {
      throw new Error(`CommandBuffer channel '${resolvedChannelName}' is unavailable`);
    }
    return output;
  }

  _isWaitAppliedReady() {
    if (!this._enableWaitApplied) {
      return this.finished;
    }
    return this.finished && this._activeWaitAppliedCount === 0;
  }

  _resolveWaitAppliedIfReady() {
    if (!this._waitAppliedResolve || !this._isWaitAppliedReady()) {
      return;
    }
    const resolve = this._waitAppliedResolve;
    this._waitAppliedResolve = null;
    this._waitAppliedPromise = null;
    resolve();
  }

  _setBoundaryAliases(map) {
    if (!map) {
      return;
    }
    this._boundaryAliases = Object.create(null);
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      this._boundaryAliases[key] = map[key];
    }
  }

  _inheritBoundaryAliases(parentMap) {
    if (!parentMap) {
      return;
    }
    if (!this._boundaryAliases) {
      // Fast path: reuse parent alias object until this buffer gets own aliases.
      this._boundaryAliases = parentMap;
      return;
    }
    const inherited = Object.create(null);
    const own = this._boundaryAliases;
    const parentKeys = Object.keys(parentMap);
    for (let i = 0; i < parentKeys.length; i++) {
      const key = parentKeys[i];
      inherited[key] = parentMap[key];
    }
    const ownKeys = Object.keys(own);
    for (let i = 0; i < ownKeys.length; i++) {
      const key = ownKeys[i];
      inherited[key] = own[key];
    }
    this._boundaryAliases = inherited;
  }

  _resolveChannelName(name) {
    if (typeof name !== 'string') {
      return name;
    }
    if (/#\d+$/.test(name)) {
      // Already canonical (e.g. loop#4).
      return name;
    }
    const mapped = this._boundaryAliases && this._boundaryAliases[name];
    return mapped || name;
  }
}

function ensureChannelIterator(channel) {
  if (!channel || typeof channel !== 'object') {
    return null;
  }

  if (!channel._iterator) {
    // Lazy require avoids top-level cycle: command-buffer <-> buffer-iterator.
    const { BufferIterator } = require('./buffer-iterator');
    channel._iterator = new BufferIterator(channel);
  }

  return channel._iterator;
}

function createCommandBuffer(context, parent = null, frame = null, enableWaitApplied = false) {
  return new CommandBuffer(context, parent, frame, enableWaitApplied);
}

function isCommandBuffer(value) {
  return value instanceof CommandBuffer;
}

module.exports = {
  CommandBuffer,
  createCommandBuffer,
  isCommandBuffer
};
