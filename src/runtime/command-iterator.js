class CommandIterator {
  constructor(buffer, chainName) {
    this.buffer = buffer;
    this.chainName = buffer._resolveAliasedChainName(chainName);
    this.nextIndex = 0;
    this.waiting = null;
    this._disposed = false;

    this.buffer._registerActiveIterator(this, this.chainName);
  }

  async *[Symbol.asyncIterator]() {
    try {
      while (true) {
        const item = this.next();
        const entry = item && typeof item.then === 'function'
          ? await item
          : item;
        if (entry === null) {
          return;
        }
        yield entry;
      }
    } finally {
      this.dispose();
    }
  }

  next() {
    const entry = this._nextReadyEntry();
    if (entry) {
      return entry;
    }
    if (this.isClosedAndConsumed()) {
      return null;
    }
    return this._waitForAppendOrFinish();
  }

  onAnyChange() {
    this._wake();
  }

  isClosedAndConsumed() {
    const lane = this._lane();
    const length = lane ? lane.length : 0;
    return this.buffer.isChainFinished(this.chainName) && this.nextIndex >= length;
  }

  releaseFinishedLane() {
    if (this.chainName in this.buffer.arrays) {
      this.buffer.arrays[this.chainName] = null;
    }
  }

  dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.buffer._unregisterActiveIterator(this, this.chainName);
    this._wake();
  }

  _nextReadyEntry() {
    const lane = this._lane();
    if (!lane || this.nextIndex >= lane.length) {
      return null;
    }

    const index = this.nextIndex;
    this.nextIndex += 1;
    return new CommandIteratorEntry(this.buffer, this.chainName, index, lane[index]);
  }

  _lane() {
    return this.buffer.arrays[this.chainName];
  }

  _waitForAppendOrFinish() {
    if (!this.waiting) {
      this.waiting = new IteratorWaitToken(() => this.next());
    }
    return this.waiting;
  }

  _wake() {
    if (!this.waiting) {
      return;
    }
    const waiting = this.waiting;
    this.waiting = null;
    waiting.resolve();
  }
}

// Single-consumer thenable with resolve method.
class IteratorWaitToken {
  constructor(getValue) {
    this.getValue = getValue;
    this.resolved = false;
    this.callback = null;
  }

  then(onFulfilled) {
    if (this.resolved) {
      return this._continue(onFulfilled);
    }
    if (this.callback) {
      throw new Error('CommandIterator wait token was consumed more than once');
    }
    return new Promise((resolve, reject) => {
      this.callback = () => {
        try {
          resolve(this._continue(onFulfilled));
        } catch (err) {
          reject(err);
        }
      };
    });
  }

  resolve() {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    const callback = this.callback;
    this.callback = null;
    if (callback) {
      callback();
    }
  }

  _continue(onFulfilled) {
    const value = this.getValue();
    return onFulfilled ? onFulfilled(value) : value;
  }
}

class CommandIteratorEntry {
  constructor(buffer, chainName, index, value) {
    this.buffer = buffer;
    this.chainName = chainName;
    this.index = index;
    this.value = value;
    this.released = false;
  }

  release() {
    if (this.released) {
      return;
    }
    this.released = true;
    const lane = this.buffer && this.buffer.arrays[this.chainName];
    if (lane && this.index < lane.length) {
      lane[this.index] = null;
    }
  }
}

export {CommandIterator};
