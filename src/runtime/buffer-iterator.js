'use strict';

const { isCommandBuffer } = require('./command-buffer');

class BufferIterator {
  constructor(output) {
    this.output = output;
    this.stack = [];
    this._enteredBuffer = null;
  }

  bindToCurrentBuffer() {
    this._reset(this.output._buffer);
  }

  onSlotFilled(buffer) {
    this._advance();
  }

  onBufferFinished(buffer) {
    this._advance();
  }

  _reset(rootBuffer) {
    if (this._enteredBuffer && this.outputName) {
      this._enteredBuffer.onLeaveBuffer(this, this.outputName);
    }

    this.stack = [];
    this._enteredBuffer = null;

    if (!rootBuffer) {
      return;
    }

    this.stack.push({ buffer: rootBuffer, index: -1 });
    this._setCurrentBuffer(rootBuffer);
    this._advance();
  }

  _advance() {
    while (this.stack.length > 0) {
      const cursor = this._currentCursor();
      const buffer = cursor.buffer;
      const arr = buffer.arrays[this.outputName];
      const nextIndex = cursor.index + 1;

      if (arr && nextIndex < arr.length && arr[nextIndex] != null) {
        cursor.index = nextIndex;
        const item = arr[nextIndex];
        if (isCommandBuffer(item)) {
          this._enterChild(item);
        } else {
          this._linkCommand(item);
        }
      }
      else if (buffer.finished && this.stack.length > 1) {
        this._leaveCurrentToParent();
      } else {
        return; // buffer not finished or no parent
      }
    }
  }

  _linkCommand(cmd) {
    if (!cmd) {
      return;
    }

    const output = this.output;
    const prev = output._lastChainedCommand || null;
    if (prev) {
      prev.next = cmd;
    } else if (!output._firstChainedCommand) {
      output._firstChainedCommand = cmd;
    }
    output._lastChainedCommand = cmd;
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
      leaving.buffer.onLeaveBuffer(this, this.outputName);
    }

    this._setCurrentBuffer(parentCursor.buffer, true);
  }

  _setCurrentBuffer(buffer, skipLeave = false) {
    if (!skipLeave && this._enteredBuffer && this.outputName) {
      this._enteredBuffer.onLeaveBuffer(this, this.outputName);
    }
    this._enteredBuffer = buffer || null;
    if (buffer && this.outputName) {
      buffer.onEnterBuffer(this, this.outputName);
    }
  }

  _currentCursor() {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  get outputName() {
    return this.output ? this.output._outputName : null;
  }
}

module.exports = {
  BufferIterator
};
