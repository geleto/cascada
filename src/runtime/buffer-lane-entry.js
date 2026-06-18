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
          // Observation rejections at this layer are fatal scheduler failures,
          // not dataflow poison aggregation. First failure wins; the Promise.all
          // input handlers still keep every started observation handled.
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
    const completion = new IterationCompletion();
    const iterator = new CommandIterator(this.buffer, this.chainName);
    iterator.observerState = observerState;
    // Owned run (fresh ObserverState) computes its own observeDone via this owner.
    // An inherited Stage 2 run shares the ancestor's owner, so attach fails here:
    // the parent ignores this child's observeDone and drains the shared set instead.
    const ownsObserveCompletion = observerState.attachObserveOwner(
      () => iterator.isClosedAndConsumed(),
      () => completion.resolveObserveDone(),
      (err) => completion.rejectObserveDone(err)
    );
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
      completion.ensureMutateDone();
      if (ownsObserveCompletion) {
        completion.ensureObserveDone();
      }
      markPromiseHandled(laneRun.catch((err) => {
        this.buffer._handleLaneFailure(err, this.chainName);
        completion.reject(err);
      }));
    } else if (ownsObserveCompletion && (observerState.pendingObservers.size > 0 || observerState.failure)) {
      // The lane input was consumed synchronously, but observations may still
      // settle later. Materialize observeDone now so owners that read it once
      // can observe completion/failure of the residual observation work.
      completion.ensureObserveDone();
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
        // drain() may have awaited pending observations; a fatal could have been
        // reported while we waited, so re-check before mutating into a dead render.
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
    // Root starts read completion.observeDone only once. If observeDone is
    // materialized after that read, this callback is the fatal-reporting
    // backstop for late observation failures.
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
    // Owned observeDone settles only once no more entries can arrive
    // (isInputConsumed) and every tracked observation has finished. A failure
    // rejects it immediately; an abort leaves it for the fatal path to settle.
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

const PHASE_PENDING = 0;
const PHASE_RESOLVED = 1;
const PHASE_REJECTED = 2;

// One phase's completion, sync-first: a phase that settles synchronously
// allocates no promise (`value` stays undefined). ensure() materializes the
// thenable only when an async consumer needs one, replaying a pending rejection.
class LazyPhaseCompletion {
  constructor() {
    this.promise = null;
    this.resolvePromise = null;
    this.rejectPromise = null;
    this.state = PHASE_PENDING;
    this.error = null;
  }

  get value() {
    return this.promise || undefined;
  }

  ensure() {
    // Resolved synchronously: nothing to await, so keep value undefined.
    if (this.state === PHASE_RESOLVED) {
      return undefined;
    }
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => {
        this.resolvePromise = resolve;
        this.rejectPromise = reject;
      });
      markPromiseHandled(this.promise);
      if (this.state === PHASE_REJECTED) {
        this.rejectPromise(this.error);
      }
    }
    return this.promise;
  }

  resolve() {
    if (this.state !== PHASE_PENDING) {
      return;
    }
    this.state = PHASE_RESOLVED;
    if (this.resolvePromise) {
      this.resolvePromise();
    }
  }

  reject(err) {
    if (this.state !== PHASE_PENDING) {
      return;
    }
    this.state = PHASE_REJECTED;
    this.error = err;
    if (this.rejectPromise) {
      this.rejectPromise(err);
    }
  }
}

// Completion record returned by iterate(...). Phase work starts immediately;
// only the completion promises are lazy. Fully synchronous phases never need a
// promise, so undefined means "resolved synchronously" for completion fields.
// Call ensure* only when a phase really needs an externally visible thenable.
class IterationCompletion {
  constructor() {
    this.mutateCompletion = new LazyPhaseCompletion();
    this.observeCompletion = new LazyPhaseCompletion();
  }

  get mutateDone() {
    return this.mutateCompletion.value;
  }

  get observeDone() {
    return this.observeCompletion.value;
  }

  ensureMutateDone() {
    return this.mutateCompletion.ensure();
  }

  ensureObserveDone() {
    return this.observeCompletion.ensure();
  }

  resolveMutateDone() {
    this.mutateCompletion.resolve();
  }

  resolveObserveDone() {
    this.observeCompletion.resolve();
  }

  rejectObserveDone(err) {
    // Failed phases must materialize a thenable; otherwise a later read of
    // observeDone would look like a synchronous success.
    this.observeCompletion.ensure();
    this.observeCompletion.reject(err);
  }

  reject(err) {
    // Failed phases must materialize thenables; otherwise later reads of
    // completion fields would look like synchronous success.
    this.mutateCompletion.ensure();
    this.observeCompletion.ensure();
    this.mutateCompletion.reject(err);
    this.observeCompletion.reject(err);
  }
}

// Sync-first sequencing: run next() immediately unless value is a real thenable,
// so synchronous phases never pay a microtask hop.
function runAfter(value, next) {
  if (value && typeof value.then === 'function') {
    return value.then(next);
  }
  return next();
}

export {BufferLaneEntry, ObserverState};
