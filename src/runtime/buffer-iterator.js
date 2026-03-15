'use strict';

const { isCommandBuffer } = require('./command-buffer');

class BufferIterator {
  constructor(output) {
    this.output = output;
    this.stack = [];
    this._enteredBuffer = null;
    this._pendingObservables = new Set();
    this.finished = false;
    this._isAdvancing = false;
    this._needsAdvance = false;
  }

  bindToCurrentBuffer() {
    this._reset(this.output._buffer);
  }

  onCommandOrBufferAdded(buffer) {
    this._requestAdvance();
  }

  onBufferFinished(buffer) {
    this._requestAdvance();
  }

  _reset(rootBuffer) {
    if (this._enteredBuffer && this.channelName) {
      this._enteredBuffer.onLeaveBuffer(this, this.channelName);
    }

    this.stack = [];
    this._enteredBuffer = null;
    this._pendingObservables.clear();
    this.finished = false;

    if (!rootBuffer) {
      return;
    }

    this.stack.push({ buffer: rootBuffer, index: -1 });
    this._setCurrentBuffer(rootBuffer);
    this._requestAdvance();
  }

  _requestAdvance() {
    if (this.finished) {
      return;
    }

    if (this._isAdvancing) {
      this._needsAdvance = true;
      return;
    }

    this._isAdvancing = true;
    this._advanceLoop();
  }

  _advanceLoop() {
    if (this.finished) {
      this._isAdvancing = false;
      return;
    }

    while (this.stack.length > 0) {
      const cursor = this._currentCursor();
      const buffer = cursor.buffer;
      const arr = buffer.arrays[this.channelName];
      const nextIndex = cursor.index + 1;

      if (arr && nextIndex < arr.length && arr[nextIndex] != null) {
        cursor.index = nextIndex;
        const item = arr[nextIndex];
        if (isCommandBuffer(item)) {
          this._enterChild(item);
        } else {
          const applyResult = this._applyCommand(item);
          if (applyResult && typeof applyResult.then === 'function') {
            Promise.resolve(applyResult).finally(() => {
              if (this.finished) {
                this._isAdvancing = false;
                return;
              }
              this._advanceLoop();
            });
            return;
          }
        }
      }
      else if (buffer.finished && this.stack.length > 1) {
        this._leaveCurrentToParent();
      } else if (buffer.finished) {
        this.stack.pop();
        this._setCurrentBuffer(null);
        this.finished = true;
        if (this.output) {
          this.output._onIteratorFinished();
        }
        this._isAdvancing = false;
        return;
      } else {
        this._isAdvancing = false;
        if (this._needsAdvance && !this.finished) {
          this._needsAdvance = false;
          this._requestAdvance();
        }
        return; // buffer not finished or no parent
      }
    }

    this._isAdvancing = false;
  }

  _applyCommand(cmd) {
    if (!cmd || !this.output) {
      return;
    }
    if (cmd.isObservable) {
      this._applyObservable(cmd);
      return;
    }
    return this._applyMutable(cmd);
  }

  _applyObservable(cmd) {
    if (!cmd || !this.output) {
      return;
    }
    const promise = this.output._applyCommand(cmd);
    if (!promise || typeof promise.then !== 'function') {
      return;
    }
    this._pendingObservables.add(promise);
    promise.finally(() => {
      this._pendingObservables.delete(promise);
    });
  }

  _applyMutable(cmd) {
    if (!cmd || !this.output) {
      return;
    }
    if (this._pendingObservables.size === 0) {
      return this.output._applyCommand(cmd);
    }

    return Promise
      .allSettled(Array.from(this._pendingObservables))
      .then(() => this.output._applyCommand(cmd));
  }

  _enterChild(childBuffer) {
    this.stack.push({ buffer: childBuffer, index: -1 });
    this._setCurrentBuffer(childBuffer);
  }

  _leaveCurrentToParent() {
    const leaving = this.stack.pop();
    const parentCursor = this._currentCursor();
    if (!parentCursor) {
      this._setCurrentBuffer(null);
      return;
    }

    if (leaving && leaving.buffer) {
      leaving.buffer.onLeaveBuffer(this, this.channelName);
    }

    this._setCurrentBuffer(parentCursor.buffer, true);
  }

  _setCurrentBuffer(buffer, skipLeave = false) {
    if (!skipLeave && this._enteredBuffer && this.channelName) {
      this._enteredBuffer.onLeaveBuffer(this, this.channelName);
    }
    this._enteredBuffer = buffer || null;
    if (buffer && this.channelName) {
      buffer.onEnterBuffer(this, this.channelName);
    }
  }

  _currentCursor() {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  get channelName() {
    if (!this.output) {
      return null;
    }
    return this.output._channelName;
  }
}

module.exports = {
  BufferIterator
};
