import {CommandIterator} from './command-iterator.js';
import {markPromiseHandled, RuntimeError} from './errors.js';

const NO_ITERATOR_ITEM = Symbol('NO_ITERATOR_ITEM');

class BufferLaneEntry {
  // Executable view of one buffer lane. When inserted into a parent lane it is
  // the child-buffer entry; when used by CommandBuffer.start(...) it is the
  // transient runner for the buffer's own lane.
  constructor(buffer, chainName, observes, mutates) {
    this.buffer = buffer;
    this.chainName = chainName;

    if (observes && !mutates) {
      // The caller-visible phase method is installed only when facts prove the
      // whole lane is uniform for that phase.
      this.observe = this._observe;
    } else if (mutates && !observes) {
      this.mutate = this._mutate;
    }
  }

  _observe(chain) {
    const observations = [];
    const iterator = new CommandIterator(this.buffer, this.chainName);
    const handleObservationFailure = (err) => {
      this.buffer._handleLaneFailure(err, this.chainName);
      throw err;
    };
    return this._runLaneEntries(
      iterator,
      this.chainName,
      (entry) => {
        if (!entry.observe) {
          this._throwLaneEntryMethodError(
            `CommandBuffer lane '${chain.name}' expected an observable entry`,
            entry
          );
        }
        const observeDone = entry.observe(chain);
        if (observeDone && typeof observeDone.then === 'function') {
          observations.push(observeDone);
        }
      },
      () => {
        if (observations.length > 0) {
          return Promise.all(observations).catch(handleObservationFailure);
        }
        return undefined;
      },
      () => undefined
    );
  }

  _mutate(chain) {
    const iterator = new CommandIterator(this.buffer, this.chainName);
    return this._runLaneEntries(
      iterator,
      this.chainName,
      (entry) => {
        if (entry.mutate) {
          return entry.mutate(chain);
        }
        this._throwLaneEntryMethodError(
          `CommandBuffer lane '${chain.name}' expected a mutable entry`,
          entry
        );
      },
      null,
      () => undefined
    );
  }

  iterate(chain, observerState) {
    const completion = createIterationCompletion();
    const iterator = new CommandIterator(this.buffer, this.chainName);
    iterator.observerState = observerState;
    if (!observerState.attachObserveOwner(
      () => iterator.isClosedAndConsumed(),
      completion.resolveObserveDone,
      completion.rejectObserveDone
    )) {
      completion.observeDone = undefined;
    }
    const laneRun = this._runLaneEntries(
      iterator,
      this.chainName,
      (entry) => this._processMixedEntry(entry, chain, observerState),
      () => {
        completion.resolveMutateDone();
        observerState.checkObserveDone();
      },
      (err) => {
        completion.reject(err);
        return undefined;
      }
    );
    if (laneRun && typeof laneRun.then === 'function') {
      markPromiseHandled(laneRun.catch((err) => {
        this.buffer._handleLaneFailure(err, this.chainName);
        completion.reject(err);
      }));
    }
    return completion;
  }

  _runLaneEntries(iterator, chainName, processEntry, finishLane = null, handleSyncError = null) {
    const fail = (err) => {
      iterator.dispose();
      this.buffer._handleLaneFailure(err, chainName);
      if (handleSyncError) {
        return handleSyncError(err);
      }
      throw err;
    };
    const advance = (readyItem = NO_ITERATOR_ITEM) => {
      try {
        while (true) {
          this.buffer._throwIfFatalLaneAbandoned(chainName);
          const item = readyItem === NO_ITERATOR_ITEM ? iterator.next() : readyItem;
          readyItem = NO_ITERATOR_ITEM;
          if (item === null) {
            iterator.releaseFinishedLane();
            iterator.dispose();
            return finishLane ? finishLane() : undefined;
          }
          if (item && typeof item.then === 'function') {
            return item.then(advance, fail);
          }
          const entry = item.value;
          if (!entry) {
            item.release();
            continue;
          }
          // Release the consumed slot even when the entry throws synchronously;
          // async failures release through the rejection branch below.
          let done;
          try {
            done = processEntry(entry);
          } catch (err) {
            item.release();
            throw err;
          }
          if (done && typeof done.then === 'function') {
            return done.then(
              () => {
                item.release();
                return advance();
              },
              (err) => {
                item.release();
                return fail(err);
              }
            );
          }
          item.release();
        }
      } catch (err) {
        return fail(err);
      }
    };
    return advance();
  }

  _processMixedEntry(entry, chain, observerState) {
    // Commands expose observe or mutate. Buffer lane entries expose observe,
    // mutate, or iterate when the child lane is mixed/unknown.
    if (entry.observe) {
      const observeDone = entry.observe(chain);
      observerState.track(observeDone);
      return;
    }
    if (entry.mutate) {
      return runAfter(observerState.drain(), () => {
        this.buffer._throwIfFatalLaneAbandoned(this.chainName);
        return entry.mutate(chain);
      });
    }
    if (entry.iterate) {
      const childCompletion = entry.iterate(chain, observerState);
      return childCompletion.mutateDone;
    }

    this._throwLaneEntryMethodError(
      `CommandBuffer cannot classify entry for chain '${chain.name}'`,
      entry
    );
  }

  _throwLaneEntryMethodError(message, entry) {
    const error = RuntimeError.create(message, this.buffer.bufferStackErrorContext);
    if (entry && entry._rejectPendingCommandResultsAfterFatal) {
      entry._rejectPendingCommandResultsAfterFatal(error);
    } else if (entry && typeof entry.rejectResult === 'function') {
      entry.rejectResult(error);
    }
    RuntimeError.reportAndThrow(error, this.buffer.bufferStackErrorContext);
  }

  _rejectPendingCommandResultsAfterFatal(err) {
    this.buffer._rejectPendingCommandResultsAfterFatal(this.chainName, err);
  }
}

class ObserverState {
  constructor(handleFailure = null) {
    this.pendingObservers = new Set();
    this.pendingObserversEmpty = null;
    this.resolvePendingObserversEmpty = null;
    this.failure = null;
    this.observeOwner = null;
    this.aborted = false;
    this.handleFailure = handleFailure;
  }

  attachObserveOwner(isInputConsumed, resolveObserveDone, rejectObserveDone) {
    if (this.observeOwner) {
      return false;
    }
    this.observeOwner = {
      done: false,
      isInputConsumed,
      resolveObserveDone,
      rejectObserveDone
    };
    this.checkObserveDone();
    return true;
  }

  track(observeDone) {
    if (!observeDone || typeof observeDone.then !== 'function') {
      return;
    }
    const observerToken = {};
    if (!this.pendingObserversEmpty) {
      this.pendingObserversEmpty = new Promise((resolve) => {
        this.resolvePendingObserversEmpty = resolve;
      });
    }
    this.pendingObservers.add(observerToken);
    markPromiseHandled(observeDone.then(
      () => this._finishObserver(observerToken),
      (err) => this._finishObserver(observerToken, err)
    ));
  }

  _finishObserver(observerToken, err = null) {
    if (err) {
      this.fail(err);
    }
    this.pendingObservers.delete(observerToken);
    if (this.pendingObservers.size === 0 && this.resolvePendingObserversEmpty) {
      const resolve = this.resolvePendingObserversEmpty;
      this.pendingObserversEmpty = null;
      this.resolvePendingObserversEmpty = null;
      resolve();
    }
    this.checkObserveDone();
  }

  abort(err) {
    this.aborted = true;
    if (err) {
      this.fail(err);
    }
    this.pendingObservers.clear();
    if (this.resolvePendingObserversEmpty) {
      const resolve = this.resolvePendingObserversEmpty;
      this.pendingObserversEmpty = null;
      this.resolvePendingObserversEmpty = null;
      resolve();
    }
  }

  checkObserveDone() {
    const owner = this.observeOwner;
    if (!owner || owner.done) {
      return;
    }
    if (this.failure) {
      owner.done = true;
      owner.rejectObserveDone(this.failure);
      return;
    }
    if (this.aborted) {
      return;
    }
    if (owner.isInputConsumed() && this.pendingObservers.size === 0) {
      owner.done = true;
      owner.resolveObserveDone();
    }
  }

  drain() {
    if (this.pendingObservers.size === 0) {
      if (this.failure) {
        throw this.failure;
      }
      return undefined;
    }
    return this._drainAsync();
  }

  async _drainAsync() {
    while (this.pendingObservers.size > 0) {
      await this.pendingObserversEmpty;
      if (this.failure) {
        throw this.failure;
      }
    }
  }

  fail(err) {
    if (this.failure) {
      return;
    }
    this.failure = err;
    if (this.handleFailure) {
      this.handleFailure(err);
    }
    if (this.resolvePendingObserversEmpty) {
      const resolve = this.resolvePendingObserversEmpty;
      this.pendingObserversEmpty = null;
      this.resolvePendingObserversEmpty = null;
      resolve();
    }
    this.checkObserveDone();
  }
}

function createIterationCompletion() {
  let resolveMutateDone;
  let rejectMutateDone;
  let resolveObserveDone;
  let rejectObserveDone;
  const mutateDone = new Promise((resolve, reject) => {
    resolveMutateDone = resolve;
    rejectMutateDone = reject;
  });
  const observeDone = new Promise((resolve, reject) => {
    resolveObserveDone = resolve;
    rejectObserveDone = reject;
  });
  markPromiseHandled(mutateDone);
  markPromiseHandled(observeDone);
  return {
    mutateDone,
    observeDone,
    resolveMutateDone,
    resolveObserveDone,
    rejectObserveDone,
    reject(err) {
      rejectMutateDone(err);
      rejectObserveDone(err);
    }
  };
}

function runAfter(value, next) {
  if (value && typeof value.then === 'function') {
    return value.then(next);
  }
  return next();
}

export {BufferLaneEntry, ObserverState};
