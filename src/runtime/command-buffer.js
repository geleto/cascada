'use strict';

const {
  ErrorCommand,
  TextCommand,
  SequenceCallCommand,
  SequenceGetCommand,
  SnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  SinkRepairCommand,
  SetTargetCommand
} = require('./commands');
const { checkFinishedBuffer } = require('./checks');
const { handleError, isPoison, isPoisonError } = require('./errors');
const { RESOLVE_MARKER } = require('./resolve');

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
        this._fillSlot(slot, new ErrorCommand(processedErrors), outputName);
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

  getPosonedBufferErrors(allowedHandlers = null) {
    const allErrors = [];
    if (Array.isArray(allowedHandlers) && allowedHandlers.length === 0) {
      return allErrors;
    }

    const names = allowedHandlers || Object.keys(this.arrays);
    names.forEach((name) => {
      const arr = this.arrays[name];
      if (!arr) {
        return;
      }
      const handlerErrors = [];
      arr.forEach((item) => {
        if (item instanceof SetTargetCommand) {
          handlerErrors.length = 0;
          return;
        }
        if (isCommandBuffer(item)) {
          handlerErrors.push(...item.getPosonedBufferErrors(allowedHandlers));
        } else if (item) {
          const err = item.getError();
          if (err) {
            handlerErrors.push(...err.errors);
          }
        }
      });
      allErrors.push(...handlerErrors);
    });

    return allErrors;
  }

  async getPosonedBufferErrorsAsync(allowedHandlers = null) {
    const allErrors = [];
    if (Array.isArray(allowedHandlers) && allowedHandlers.length === 0) {
      return allErrors;
    }

    const names = allowedHandlers || Object.keys(this.arrays);
    for (const name of names) {
      const arr = this.arrays[name];
      if (!arr) {
        continue;
      }
      const handlerErrors = [];
      for (const item of arr) {
        if (item instanceof SetTargetCommand) {
          handlerErrors.length = 0;
          continue;
        }
        if (isCommandBuffer(item)) {
          const nested = await item.getPosonedBufferErrorsAsync(allowedHandlers);
          handlerErrors.push(...nested);
          continue;
        }
        if (!item) {
          continue;
        }
        const err = item.getError();
        if (err && Array.isArray(err.errors)) {
          handlerErrors.push(...err.errors);
        }
        if (Array.isArray(item.arguments)) {
          const argErrors = await collectErrorsFromCommandArgs(item.arguments);
          if (argErrors.length > 0) {
            handlerErrors.push(...argErrors);
          }
        }
      }
      allErrors.push(...handlerErrors);
    }

    return allErrors;
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

function getPosonedBufferErrors(buffer, allowedHandlers = null) {
  if (!buffer || !(buffer instanceof CommandBuffer)) {
    return [];
  }
  return buffer.getPosonedBufferErrors(allowedHandlers);
}

async function collectErrorsFromCommandArgs(args) {
  const errors = [];
  const seenObjects = new Set();
  const PROBE_TIMEOUT_MS = 20;

  const awaitWithTimeout = async (promise, timeoutMs) => {
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve(promise).then(
          (value) => ({ timedOut: false, value }),
          (error) => ({ timedOut: false, error })
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        })
      ]);
      return result;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const visit = async (value) => {
    if (value == null) {
      return;
    }

    if (value && typeof value.then === 'function') {
      const outcome = await awaitWithTimeout(value, PROBE_TIMEOUT_MS);
      if (outcome.timedOut) {
        Promise.resolve(value).catch(() => {});
        return;
      }
      if (outcome.error) {
        const err = outcome.error;
        if (isPoisonError(err) && Array.isArray(err.errors)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return;
      }
      await visit(outcome.value);
      return;
    }

    if (isPoison(value) && Array.isArray(value.errors)) {
      errors.push(...value.errors);
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    const marker = value && value[RESOLVE_MARKER];
    if (marker && typeof marker.then === 'function') {
      const outcome = await awaitWithTimeout(marker, PROBE_TIMEOUT_MS);
      if (outcome.timedOut) {
        Promise.resolve(marker).catch(() => {});
      } else if (outcome.error) {
        const err = outcome.error;
        if (isPoisonError(err) && Array.isArray(err.errors)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
      }
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        await visit(entry);
      }
      return;
    }

    const keys = Object.keys(value);
    for (const key of keys) {
      await visit(value[key]);
    }
  };

  await visit(args);
  return errors;
}

async function getPosonedBufferErrorsAsync(buffer, allowedHandlers = null) {
  if (!buffer || !(buffer instanceof CommandBuffer)) {
    return [];
  }
  return buffer.getPosonedBufferErrorsAsync(allowedHandlers);
}

module.exports = {
  CommandBuffer,
  createCommandBuffer,
  getPosonedBufferErrors,
  getPosonedBufferErrorsAsync,
  isCommandBuffer
};
