'use strict';

const {
  ErrorCommand,
  TargetPoisonCommand,
  TextCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  SnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  SinkRepairCommand
} = require('./commands');
const { checkFinishedBuffer } = require('./checks');
const { handleError } = require('./errors');

class CommandBuffer {
  constructor(context, parent = null) {
    this._context = context;
    this.parent = parent;
    this.finished = false;

    // Create arrays namespace (handlers created lazily on first write/snapshot).
    this.arrays = Object.create(null);
    // Shared registry of Output objects for this buffer hierarchy.
    this._outputs = parent ? parent._outputs : new Map();
    // Iterators currently visiting this buffer keyed by output name.
    this._visitingIterators = new Map();
    // Pending reserved slots that are not filled yet.
    this._pendingReservedSlots = 0;
    // finish was requested, but may be deferred until pending slots are filled.
    this._finishRequested = false;
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
  }

  onLeaveBuffer(iterator, outputName) {
    if (!iterator || !outputName) {
      return;
    }
    const current = this._visitingIterators.get(outputName);
    if (current === iterator) {
      this._visitingIterators.delete(outputName);
    }
  }

  _reserveSlot(outputName) {
    if (!this.arrays[outputName]) {
      this.arrays[outputName] = [];
    }
    const slot = this.arrays[outputName].length;
    this.arrays[outputName][slot] = null;
    this._pendingReservedSlots++;
    return slot;
  }

  addText(value, pos = null, outputName = 'text') {
    const textPos = pos && typeof pos === 'object'
      ? pos
      : { lineno: 0, colno: 0 };
    return this.add(new TextCommand({
      handler: 'text',
      args: [value],
      pos: textPos
    }), outputName);
  }

  addPoison(errors, outputName) {
    const errs = Array.isArray(errors) ? errors : [errors];
    return this.add(new ErrorCommand(errs), outputName);
  }

  add(value, outputName) {
    checkFinishedBuffer(this);

    const slot = this._reserveSlot(outputName);
    const target = this.arrays[outputName];
    this._setSlotValue(target, slot, value);

    if (isCommandBuffer(value)) {
      value.parent = this;
    }

    this._notifySlotFilled(outputName);
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
    this.add(cmd, outputName);
    return cmd.promise;
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
    this.add(cmd, outputName);
    return cmd.promise;
  }

  addSnapshot(outputName, pos = null) {
    const cmd = new SnapshotCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addObservationCommand(cmd, outputName);
  }

  addIsError(outputName, pos = null) {
    const cmd = new IsErrorCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addObservationCommand(cmd, outputName);
  }

  addGetError(outputName, pos = null) {
    const cmd = new GetErrorCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addObservationCommand(cmd, outputName);
  }

  addSinkRepair(outputName, pos = null) {
    const cmd = new SinkRepairCommand({
      handler: outputName,
      pos: pos && typeof pos === 'object' ? pos : { lineno: 0, colno: 0 }
    });
    return this._addObservationCommand(cmd, outputName);
  }

  _addObservationCommand(cmd, outputName) {
    if (!this.finished) {
      this.add(cmd, outputName);
      return cmd.promise;
    }

    const output = (this._outputs instanceof Map) ? this._outputs.get(outputName) : null;
    const path = (this._context && this._context.path) ? this._context.path : null;
    if (!output) {
      cmd.rejectResult(handleError(new Error(`CommandBuffer output '${outputName}' is unavailable`), cmd.pos.lineno, cmd.pos.colno, null, path));
      return cmd.promise;
    }

    const applySnapshot = () => {
      try {
        cmd.apply(output);
      } catch (err) {
        const outputPath = output && output._context && output._context.path ? output._context.path : path;
        cmd.rejectResult(handleError(err, cmd.pos.lineno, cmd.pos.colno, null, outputPath));
      }
      return cmd.promise;
    };

    if (!output._completionResolved && output._completionPromise) {
      return Promise.resolve(output._completionPromise).then(applySnapshot);
    }

    return applySnapshot();
  }

  async addAsyncArgsCommand(outputName, valueOrPromise, runtime, context, lineno, colno, errorContextString, cb = null) {
    const slot = this._reserveSlot(outputName);
    try {
      const value = await Promise.resolve(valueOrPromise);
      this._fillSlot(slot, value, outputName);
      return slot;
    } catch (e) {
      if (runtime && e instanceof runtime.RuntimeFatalError) {
        if (cb) {
          cb(e);
        }
        throw e;
      }

      const errors = runtime && runtime.isPoisonError && runtime.isPoisonError(e) ? e.errors : [e];
      const processedErrors = runtime && runtime.handleError
        ? errors.map(err => runtime.handleError(err, lineno, colno, errorContextString, context ? context.path : null))
        : errors;

      try {
        this._fillSlot(slot, new TargetPoisonCommand({
          handler: outputName,
          errors: processedErrors,
          pos: { lineno, colno }
        }), outputName);
      } catch (fillErr) {
        if (runtime && runtime.RuntimeFatalError) {
          const fatal = fillErr instanceof runtime.RuntimeFatalError
            ? fillErr
            : new runtime.RuntimeFatalError(
              fillErr,
              lineno,
              colno,
              errorContextString,
              context ? context.path : null
            );
          if (typeof cb === 'function') {
            cb(fatal);
          }
          throw fatal;
        }

        if (typeof cb === 'function') {
          cb(fillErr);
        }
        throw fillErr;
      }

      return slot;
    }
  }

  _fillSlot(slot, value, outputName) {
    const target = this.arrays[outputName];
    this._setSlotValue(target, slot, value);

    if (isCommandBuffer(value)) {
      value.parent = this;
    }

    this._notifySlotFilled(outputName);
  }

  _notifySlotFilled(outputName) {
    const iterator = this._visitingIterators.get(outputName);
    if (iterator) {
      iterator.onSlotFilled(this);
    }
  }

  _setSlotValue(target, slot, value) {
    if (target[slot] == null) {
      this._pendingReservedSlots = Math.max(0, this._pendingReservedSlots - 1);
    }
    target[slot] = value;
    this._tryCompleteFinish();
  }

  _tryCompleteFinish() {
    if (!this._finishRequested || this.finished || this._pendingReservedSlots > 0) {
      return;
    }
    this.finished = true;
    this._notifyBufferFinished();
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

function createCommandBuffer(context, parent = null) {
  return new CommandBuffer(context, parent);
}

function isCommandBuffer(value) {
  return value instanceof CommandBuffer;
}

module.exports = {
  CommandBuffer,
  createCommandBuffer,
  isCommandBuffer
};
