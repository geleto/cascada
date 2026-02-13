'use strict';

const { ErrorCommand, TextCommand } = require('./commands');
const { checkFinishedBuffer } = require('./checks');

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
    if (iterator && typeof iterator.bindToCurrentBuffer === 'function') {
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
      if (value._outputs !== this._outputs) {
        value._outputs = this._outputs;
      }
    }

    this._notifySlotFilled(outputName);
    return slot;
  }

  addBuffer(buffer, outputName) {
    return this.add(buffer, outputName);
  }

  async addAsyncArgsCommand(outputName, producer, runtime, context, lineno, colno, errorContextString, cb = null) {
    const slot = this._reserveSlot(outputName);
    try {
      const value = await producer();
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
      if (value._outputs !== this._outputs) {
        value._outputs = this._outputs;
      }
    }

    this._notifySlotFilled(outputName);
  }

  _notifySlotFilled(outputName) {
    const iterator = this._visitingIterators.get(outputName);
    if (iterator && typeof iterator.onSlotFilled === 'function') {
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
      if (typeof iterator.onBufferFinished === 'function') {
        iterator.onBufferFinished(this);
      }
    }
  }

  patchLinksAfterClear(handlerNames = null) {
    const names = handlerNames || Object.keys(this.arrays);
    names.forEach((name) => {
      if (this.arrays[name]) {
        this.arrays[name].length = 0;
      }
    });

    // Clear is used by guard recovery to discard current output and continue writing.
    // Keep the buffer writable after reset.
    this.finished = false;
    this._finishRequested = false;
    this._pendingReservedSlots = 0;

    const iterators = new Set(this._visitingIterators.values());
    for (const iterator of iterators) {
      if (!iterator || typeof iterator.bindToCurrentBuffer !== 'function') {
        continue;
      }
      const output = iterator.output;
      if (!output || !output._buffer || !output._outputName) {
        iterator.bindToCurrentBuffer();
        continue;
      }

      resetOutputChainLinks(output._buffer, output._outputName);
      output._firstChainedCommand = null;
      output._lastChainedCommand = null;
      iterator.bindToCurrentBuffer();
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
      arr.forEach((item) => {
        if (isCommandBuffer(item)) {
          allErrors.push(...item.getPosonedBufferErrors(allowedHandlers));
        } else if (item) {
          const err = item.getError();
          if (err) {
            allErrors.push(...err.errors);
          }
        }
      });
    });

    return allErrors;
  }
}

function resetOutputChainLinks(buffer, outputName, seen = null) {
  if (!buffer || !isCommandBuffer(buffer)) {
    return;
  }

  const visited = seen || new Set();
  if (visited.has(buffer)) {
    return;
  }
  visited.add(buffer);

  const arr = buffer.arrays[outputName];
  if (!arr || arr.length === 0) {
    return;
  }

  for (const item of arr) {
    if (!item) {
      continue;
    }
    if (isCommandBuffer(item)) {
      resetOutputChainLinks(item, outputName, visited);
      continue;
    }
    item.next = null;
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

function clearBuffer(buffer, handlerNames = null) {
  if (!buffer) {
    return;
  }

  if (buffer instanceof CommandBuffer) {
    buffer.patchLinksAfterClear(handlerNames || null);
    return;
  }

  if (Array.isArray(buffer)) {
    buffer.length = 0;
  }
}

function getPosonedBufferErrors(buffer, allowedHandlers = null) {
  if (!buffer || !(buffer instanceof CommandBuffer)) {
    return [];
  }
  return buffer.getPosonedBufferErrors(allowedHandlers);
}

module.exports = {
  CommandBuffer,
  createCommandBuffer,
  clearBuffer,
  getPosonedBufferErrors,
  isCommandBuffer
};
