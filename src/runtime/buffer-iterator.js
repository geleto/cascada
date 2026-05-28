
import {markPromiseHandled} from './errors.js';

function isCommandBufferLike(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    value.arrays &&
    typeof value.isFinished === 'function' &&
    typeof value.isChainFinished === 'function' &&
    typeof value.onIteratorEnterBuffer === 'function'
  );
}

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

  onBufferFinished(buffer, chainName) {
    if (chainName && chainName !== this.chainName) {
      return;
    }
    this._requestAdvance();
  }

  _reset(rootBuffer) {
    if (this._enteredBuffer && this.chainName) {
      this._enteredBuffer.onIteratorLeaveBuffer(this, this.chainName);
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
      if (buffer.renderState && buffer.renderState.isFatalErrorReported()) {
        this._stopAfterFatalReport();
        return;
      }
      const arr = buffer.arrays[this.chainName];
      const nextIndex = cursor.index + 1;

      if (arr && nextIndex < arr.length && arr[nextIndex] != null) {
        cursor.index = nextIndex;
        const item = arr[nextIndex];
        if (isCommandBufferLike(item)) {
          this._enterChild(item);
        } else {
          const applyResult = this._applyCommand(item);
          if (item && item.isObservable) {
            this._releaseProcessedEntry(buffer, nextIndex);
            continue;
          }
          if (applyResult && typeof applyResult.then === 'function') {
            // The chain/command path owns the apply result. This chained
            // promise only performs iterator cleanup and must not surface a
            // duplicate unhandled rejection if applyResult rejects.
            markPromiseHandled(Promise.resolve(applyResult).finally(() => {
              this._releaseProcessedEntry(buffer, nextIndex);
              if (this.finished) {
                this._isAdvancing = false;
                return;
              }
              this._advanceLoop();
            }));
            return;
          }
          this._releaseProcessedEntry(buffer, nextIndex);
        }
      }
      else if (buffer.isChainFinished(this.chainName) && this.stack.length > 1) {
        this._leaveCurrentToParent();
      } else if (buffer.isChainFinished(this.chainName)) {
        this.stack.pop();
        this._setCurrentBuffer(null);
        this.finished = true;
        this._releaseFinishedIterator();
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
    if (this._pendingObservables) {
      this._pendingObservables.add(promise);
    }
    markPromiseHandled(promise.finally(() => {
      if (this._pendingObservables) {
        this._pendingObservables.delete(promise);
      }
    }));
  }

  _applyMutable(cmd) {
    if (!cmd || !this.output) {
      return;
    }
    if (!this._pendingObservables || this._pendingObservables.size === 0) {
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
      leaving.buffer.onIteratorLeaveBuffer(this, this.chainName);
      this._releaseFinishedLane(leaving.buffer);
    }
    if (parentCursor.index >= 0) {
      this._releaseProcessedEntry(parentCursor.buffer, parentCursor.index);
    }

    this._setCurrentBuffer(parentCursor.buffer, true);
  }

  _releaseProcessedEntry(buffer, index) {
    if (!buffer || index < 0 || !this.chainName) {
      return;
    }
    const arr = buffer.arrays[this.chainName];
    if (!arr || index >= arr.length) {
      return;
    }
    arr[index] = null;
  }

  _releaseFinishedLane(buffer) {
    if (!buffer || !this.chainName || !buffer.arrays) {
      return;
    }
    if (!(this.chainName in buffer.arrays)) {
      return;
    }
    buffer.arrays[this.chainName] = null;
  }

  _setCurrentBuffer(buffer, skipLeave = false) {
    if (!skipLeave && this._enteredBuffer && this.chainName) {
      this._enteredBuffer.onIteratorLeaveBuffer(this, this.chainName);
    }
    this._enteredBuffer = buffer || null;
    if (buffer && this.chainName) {
      buffer.onIteratorEnterBuffer(this, this.chainName);
    }
  }

  _currentCursor() {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  _releaseFinishedIterator() {
    const output = this.output;
    if (output && output._buffer) {
      this._releaseFinishedLane(output._buffer);
    }
    if (output) {
      output._resolveIteratorCompletion();
      if (output._iterator === this) {
        output._iterator = null;
      }
    }
    this.stack = [];
    this._enteredBuffer = null;
    if (this._pendingObservables) {
      this._pendingObservables.clear();
    }
    this._pendingObservables = null;
    this.output = null;
    this._needsAdvance = false;
  }

  _stopAfterFatalReport() {
    // Fatal render state owns the reported error. Stop applying later commands
    // so unrelated buffered work cannot keep running after render failure.
    for (const cursor of this.stack) {
      if (cursor && cursor.buffer) {
        cursor.buffer.onIteratorLeaveBuffer(this, this.chainName);
        this._releaseFinishedLane(cursor.buffer);
      }
    }
    this.stack = [];
    this._setCurrentBuffer(null, true);
    this.finished = true;
    this._releaseFinishedIterator();
    this._isAdvancing = false;
  }

  get chainName() {
    if (!this.output) {
      return null;
    }
    return this.output._chainName;
  }
}

export { BufferIterator };
