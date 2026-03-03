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

    // Create arrays namespace (handlers created lazily on first write/snapshot).
    this.arrays = Object.create(null);
    // Shared registry of Output objects for this buffer hierarchy.
    this._outputs = parent ? parent._outputs : new Map();
    // Iterators currently visiting this buffer keyed by output name.
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
  }

  _registerOutput(handlerName, output) {
    if (!(this._outputs instanceof Map)) {
      this._outputs = new Map();
    }
    this._outputs.set(handlerName, output);

    const iterator = ensureOutputIterator(output);
    if (iterator) {
      iterator.bindToCurrentBuffer();
    }
  }

  markFinishedAndPatchLinks() {
    this._finishRequested = true;
    this._tryCompleteFinish();
  }

  onEnterBuffer(iterator, outputName) {
    if (!iterator || !outputName) {
      return;
    }
    this._visitingIterators.set(outputName, iterator);
    if (this._enableWaitApplied) {
      this._activeWaitAppliedCount++;
    }
  }

  onLeaveBuffer(iterator, outputName) {
    if (!iterator || !outputName) {
      return;
    }
    const current = this._visitingIterators.get(outputName);
    if (current === iterator) {
      this._visitingIterators.delete(outputName);
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

  addText(value, pos = null, outputName = 'text') {
    const textPos = pos && typeof pos === 'object'
      ? pos
      : { lineno: 0, colno: 0 };
    const cmd = new TextCommand({
      handler: 'text',
      args: [value],
      pos: textPos
    });
    return this._addCommand(cmd, outputName);
  }

  addPoison(errors, outputName) {
    const errs = Array.isArray(errors) ? errors : [errors];
    const cmd = new ErrorCommand(errs);
    return this._addCommand(cmd, outputName);
  }

  add(value, outputName) {
    checkFinishedBuffer(this);
    if (!this.arrays[outputName]) {
      this.arrays[outputName] = [];
    }
    const target = this.arrays[outputName];
    target.push(value);
    const slot = target.length - 1;

    if (isCommandBuffer(value)) {
      value.parent = this;
    }

    this._notifyCommandOrBufferAdded(outputName);
    return slot;
  }

  addBuffer(buffer, outputName) {
    return this.add(buffer, outputName);
  }

  addSequenceGet(outputName, command, subpath = null, pos = null) {
    const cmd = new SequenceGetCommand({
      handler: outputName,
      command: command || null,
      subpath: Array.isArray(subpath) ? subpath : [],
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, outputName);
  }

  addSequenceCall(outputName, command, subpath = null, args = null, pos = null) {
    const cmd = new SequenceCallCommand({
      handler: outputName,
      command: command || null,
      subpath: Array.isArray(subpath) ? subpath : [],
      args: Array.isArray(args) ? args : [],
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, outputName);
  }

  addSequentialPathRead(outputName, operation, pos = null, repair = false) {
    const CommandClass = repair ? RepairReadCommand : SequentialPathReadCommand;
    const cmd = new CommandClass({
      handler: outputName,
      pathKey: outputName,
      operation,
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, outputName);
  }

  addSequentialPathWrite(outputName, operation, pos = null, repair = false) {
    const CommandClass = repair ? RepairWriteCommand : SequentialPathWriteCommand;
    const cmd = new CommandClass({
      handler: outputName,
      pathKey: outputName,
      operation,
      pos: pos || { lineno: 0, colno: 0 },
      withDeferredResult: true
    });
    return this._addCommand(cmd, outputName);
  }

  addSnapshot(outputName, pos = null) {
    const cmd = new SnapshotCommand({
      handler: outputName,
      pos
    });
    if (this.finished) {
      const output = this._outputs.get(outputName);
      const path = (this._context && this._context.path) ? this._context.path : null;
      if (!output._buffer.finished) {
        throw new RuntimeFatalError(
          'Snapshot command on finished buffer is allowed only if the whole output is finished',
          pos?.lineno ?? 0,
          pos?.colno ?? 0,
          null,
          path
        );
      }
      return this._runFinishedSnapshotCommand(cmd, outputName);
    }
    return this._addCommand(cmd, outputName);
  }

  // addRawSnapshot enqueues an ordered raw read command.
  // Unlike addSnapshot, this does not inspect nested poison state; it returns
  // the current output target directly.
  addRawSnapshot(outputName, pos = null) {
    const cmd = new RawSnapshotCommand({
      handler: outputName,
      pos
    });
    if (this.finished) {
      const output = this._outputs.get(outputName);
      const path = (this._context && this._context.path) ? this._context.path : null;
      if (!output._buffer.finished) {
        throw new RuntimeFatalError(
          'Raw snapshot command on finished buffer is allowed only if the whole output is finished',
          pos?.lineno ?? 0,
          pos?.colno ?? 0,
          null,
          path
        );
      }
      return this._runFinishedSnapshotCommand(cmd, outputName);
    }
    return this._addCommand(cmd, outputName);
  }

  addIsError(outputName, pos = null) {
    const cmd = new IsErrorCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, outputName);
  }

  addGetError(outputName, pos = null) {
    const cmd = new GetErrorCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, outputName);
  }

  addCaptureGuardState(outputName, pos = null) {
    const cmd = new CaptureGuardStateCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, outputName);
  }

  addSinkRepair(outputName, pos = null) {
    const cmd = new SinkRepairCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, outputName);
  }

  addRestoreGuardState(outputName, target, pos = null) {
    const cmd = new RestoreGuardStateCommand({
      handler: outputName,
      target,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addCommand(cmd, outputName);
  }

  _addCommand(cmd, outputName) {

    if (!this.finished) {
      this.add(cmd, outputName);
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

  _runFinishedSnapshotCommand(cmd, outputName) {
    const output = this._outputs.get(outputName);
    const path = (this._context && this._context.path) ? this._context.path : null;

    const applySnapshot = () => {
      try {
        cmd.apply(output);
      } catch (err) {
        const outputPath = output && output._context && output._context.path ? output._context.path : path;
        cmd.rejectResult(handleError(err, cmd.pos.lineno, cmd.pos.colno, null, outputPath));
      }
      return cmd.promise;
    };

    // Snapshot-on-finished-buffer is allowed only after the entire output stream is complete.
    if (!output._completionResolved && output._completionPromise) {
      return Promise.resolve(output._completionPromise).then(applySnapshot);
    }

    return applySnapshot();
  }

  _notifyCommandOrBufferAdded(outputName) {
    const iterator = this._visitingIterators.get(outputName);
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

  getOutput(outputName = 'text') {
    if (!(this._outputs instanceof Map)) {
      throw new Error('CommandBuffer outputs are unavailable');
    }
    const output = this._outputs.get(outputName);
    if (!output) {
      throw new Error(`CommandBuffer output '${outputName}' is unavailable`);
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
}

function ensureOutputIterator(output) {
  if (!output || typeof output !== 'object') {
    return null;
  }

  if (!output._iterator) {
    // Lazy require avoids top-level cycle: command-buffer <-> buffer-iterator.
    const { BufferIterator } = require('./buffer-iterator');
    output._iterator = new BufferIterator(output);
  }

  return output._iterator;
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
