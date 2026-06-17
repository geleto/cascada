
import {assertChainLaneAvailable, checkFinishedBuffer} from './checks.js';
import {isObservableCommand} from './commands/base.js';
import {getRenderState, isCompactErrorContext} from './error-context.js';
import {markPromiseHandled, RuntimeError} from './errors.js';
import {CommandIterator} from './command-iterator.js';

const CHAIN_FACTS_LINKED = 0;
const CHAIN_FACTS_OWN = 1;
const CHAIN_FACTS_PARENT = 2;
const NO_ITERATOR_ITEM = Symbol('NO_ITERATOR_ITEM');

class CommandBuffer {
  constructor(context, parent = null, observedFacts = null, mutatedFacts = null, linkTarget = null, bufferStackErrorContext, traceParent = null, renderState = null) {
    if (!isCompactErrorContext(bufferStackErrorContext)) {
      throw new TypeError('CommandBuffer requires compact bufferStackErrorContext');
    }
    if (observedFacts != null && !Array.isArray(observedFacts)) {
      RuntimeError.reportAndThrow('CommandBuffer observedFacts must be an array when provided', bufferStackErrorContext);
    }
    if (mutatedFacts != null && !Array.isArray(mutatedFacts)) {
      RuntimeError.reportAndThrow('CommandBuffer mutatedFacts must be an array when provided', bufferStackErrorContext);
    }

    this._context = context;
    this.parent = parent;
    this.traceParent = traceParent || null;
    // The caller may pass a shared static context or an owned clone. Only owned
    // clones may be mutated after construction.
    this.bufferStackErrorContext = bufferStackErrorContext;
    this.renderState = renderState || getRenderState(this.bufferStackErrorContext) || (parent && parent.renderState) || null;
    this.finished = false;
    this._finishedChains = Object.create(null);
    // Local addressability map. Entries may be owned by this buffer or linked
    // from an explicit parent lane; ownership is derived from chain._buffer.
    this._chains = Object.create(null);
    // Per-lane command arrays. Local chain declarations and linked parent
    // chains are the lane sources.
    this.arrays = Object.create(null);
    this._boundaryLinkedChains = new Set(observedFacts?.[CHAIN_FACTS_LINKED] ?? []);
    this._boundaryLinkedMutatedChains = new Set(mutatedFacts?.[CHAIN_FACTS_LINKED] ?? []);
    this._observedChains = new Set(observedFacts?.[CHAIN_FACTS_OWN] ?? []);
    this._mutatedChains = new Set(mutatedFacts?.[CHAIN_FACTS_OWN] ?? []);
    this._observedChainsFromParent = new Set(observedFacts?.[CHAIN_FACTS_PARENT] ?? []);
    this._mutatedChainsFromParent = new Set(mutatedFacts?.[CHAIN_FACTS_PARENT] ?? []);
    this._startedChains = new Set();
    this._finishedPromise = null;
    this._finishedResolver = null;

    // Active lane runners keyed by chain name. A buffer lane is started once.
    this._activeIterators = new Map();
    this._configureCommandMethod();
    if (parent && parent._chainAliases) {
      // Propagate explicit chain-binding aliases down the buffer tree so
      // nested child buffers can continue routing formal names to the same
      // caller-owned runtime chains.
      this._inheritChainAliases(parent._chainAliases);
    }

    const effectiveLinkTarget = linkTarget || parent;
    if (effectiveLinkTarget && this._boundaryLinkedChains.size > 0) {
      for (const chainName of this._boundaryLinkedChains) {
        effectiveLinkTarget.addBuffer(this, chainName);
      }
    }
  }

  _configureCommandMethod() {
    const needsObserve = hasObserveOnlyLinkedChain(this._boundaryLinkedChains, this._boundaryLinkedMutatedChains) ||
      this._observedChains.size > 0 ||
      this._observedChainsFromParent.size > 0;
    const needsMutate = this._boundaryLinkedMutatedChains.size > 0 ||
      this._mutatedChains.size > 0 ||
      this._mutatedChainsFromParent.size > 0;

    this.observe = needsObserve && !needsMutate ? this._observe : null;
    this.mutate = needsMutate && !needsObserve ? this._mutate : null;
  }

  _createLane(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (!resolvedChainName) {
      return null;
    }
    if (resolvedChainName in this.arrays) {
      RuntimeError.reportAndThrow(
        `Chain '${resolvedChainName}' was registered more than once on the same CommandBuffer`,
        this.bufferStackErrorContext
      );
    }
    this.arrays[resolvedChainName] = [];
    return resolvedChainName;
  }

  // Permissive lane creation for linked chains, whose owner chain object
  // may arrive before or after other link metadata.
  _ensureLane(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (!resolvedChainName) {
      return null;
    }
    if (!(resolvedChainName in this.arrays)) {
      this.arrays[resolvedChainName] = [];
    }
    return resolvedChainName;
  }

  _registerChain(chainName, chain) {
    // Chain declarations also honor explicit alias bindings so a formal name
    // can attach to a caller-owned runtime chain name when a feature such as
    // macro by-reference uses this buffer-level mechanism.
    const resolvedChainName = this._createLane(chainName);
    this._chains[resolvedChainName] = chain;

    this.start(resolvedChainName);
  }

  getFinishedPromise() {
    if (this.finished) {
      return Promise.resolve();
    }
    if (!this._finishedPromise) {
      this._finishedPromise = new Promise((resolve) => {
        this._finishedResolver = resolve;
      });
    }
    return this._finishedPromise;
  }

  getDiagnosticStack() {
    const stack = [];
    let buffer = this;

    while (buffer) {
      stack.push(buffer.bufferStackErrorContext);
      buffer = buffer.traceParent || buffer.parent || null;
    }

    return stack;
  }

  finish() {
    if (this.finished) {
      return;
    }
    for (const chainName of Object.keys(this.arrays)) {
      this.finishChain(chainName);
    }
    this._completeBufferIfAllChainsFinished();
  }

  finishChain(chainName) {
    // Finishing an individual lane only wakes chain iterators. Aggregate
    // buffer completion is still gated by finish().
    if (this.finished) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (!resolvedChainName || this._finishedChains[resolvedChainName]) {
      return;
    }
    assertChainLaneAvailable(this, resolvedChainName);
    this._finishedChains[resolvedChainName] = true;
    this._notifyLaneChanged(resolvedChainName);
  }

  isFinished() {
    return this.finished;
  }

  isChainFinished(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    return this._finishedChains[resolvedChainName] === true;
  }

  _registerActiveIterator(iterator, chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    assertChainLaneAvailable(this, resolvedChainName);
    const activeIterator = this._activeIterators.get(resolvedChainName);
    if (activeIterator && activeIterator !== iterator) {
      RuntimeError.reportAndThrow(
        `CommandBuffer lane '${resolvedChainName}' has more than one active iterator`,
        this.bufferStackErrorContext
      );
    }
    this._activeIterators.set(resolvedChainName, iterator);
  }

  _unregisterActiveIterator(iterator, chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (this._activeIterators.get(resolvedChainName) === iterator) {
      this._activeIterators.delete(resolvedChainName);
    }
  }

  _add(value, chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    checkFinishedBuffer(this, resolvedChainName);
    assertChainLaneAvailable(this, resolvedChainName);
    // Normalize command chain/path keys at ingress so all downstream runtime
    // lookups operate on the resolved runtime chain name. This is why the
    // alias layer lives in CommandBuffer: once a command enters the buffer tree,
    // the rest of the runtime should not need to care whether it came from a
    // formal alias such as a by-reference macro parameter.
    if (!(value instanceof CommandBuffer) && value && typeof value === 'object') {
      if ('chainName' in value) {
        value.chainName = resolvedChainName;
      }
      if ('pathKey' in value) {
        value.pathKey = resolvedChainName;
      }
    }
    if (value instanceof CommandBuffer) {
      const chain = this.getChainIfExists(resolvedChainName);
      value._assertCanInstallLinkedChain(resolvedChainName, chain);
      value.parent = this;
      if (this._chainAliases) {
        // Nested child buffers must preserve the same explicit alias bindings,
        // otherwise async control-flow inside a macro could stop routing formal
        // names to the caller-owned runtime chains they were bound to.
        value._inheritChainAliases(this._chainAliases);
      }
      value._installLinkedChainResolved(resolvedChainName, chain);
    }

    const target = this.arrays[resolvedChainName];
    target.push(value);
    const slot = target.length - 1;
    this._notifyLaneChanged(resolvedChainName);
    return slot;
  }

  addCommand(cmd, chainName = null) {
    chainName = chainName || (cmd && cmd.chainName);
    if (!this.isChainFinished(chainName)) {
      this._add(cmd, chainName);
      return cmd.promise;
    }

    if (isObservableCommand(cmd)) {
      const resolvedChainName = this._resolveAliasedChainName(chainName);
      const chain = this.getChainIfExists(resolvedChainName);
      if (!chain) {
        RuntimeError.reportAndThrow(
          `Chain '${resolvedChainName}' is unavailable on finished CommandBuffer`,
          cmd.errorContext
        );
      }
      if (!chain._buffer.isChainFinished(resolvedChainName)) {
        RuntimeError.reportAndThrow(
          `${cmd.constructor.name} on finished buffer is allowed only if the target chain stream is finished`,
          cmd.errorContext
        );
      }
      return this._runObservationCommandOnFinishedBuffer(cmd, resolvedChainName);
    }

    RuntimeError.reportAndThrow(
      `Adding command '${cmd?.constructor ? cmd.constructor.name : 'unknown'}' is not allowed on a finished CommandBuffer`,
      cmd.errorContext
    );
  }

  addBuffer(buffer, chainName) {
    return this._add(buffer, chainName);
  }

  start(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    assertChainLaneAvailable(this, resolvedChainName);
    if (this._startedChains.has(resolvedChainName)) {
      RuntimeError.reportAndThrow(
        `CommandBuffer lane '${resolvedChainName}' was started more than once`,
        this.bufferStackErrorContext
      );
    }
    this._startedChains.add(resolvedChainName);
    const chain = this.getChain(resolvedChainName);
    let observeDone;
    let mutateDone;

    if (this.observe) {
      observeDone = this.observe(chain);
    } else if (this.mutate) {
      mutateDone = this.mutate(chain);
    } else {
      const completion = this.iterate(chain, new ObserverState());
      observeDone = completion.observeDone;
      mutateDone = completion.mutateDone;
    }

    if (observeDone && typeof observeDone.then === 'function') {
      markPromiseHandled(observeDone.catch((err) => {
        this._handleLaneFailure(err, chain.name);
      }));
    }

    if (!mutateDone || typeof mutateDone.then !== 'function') {
      chain._resolveChainCompletion();
      return;
    }

    markPromiseHandled(mutateDone.then(
      () => {
        chain._resolveChainCompletion();
      },
      (err) => {
        this._handleLaneFailure(err, chain.name);
        chain._resolveChainCompletion();
      }
    ));
  }

  _observe(chain) {
    const observations = [];
    const iterator = new CommandIterator(this, chain.name);
    return this._runLaneEntries(
      iterator,
      chain.name,
      (entry) => {
        let observeDone;
        if (entry.observe) {
          observeDone = entry.observe(chain);
        } else if (entry.mutate) {
          // Transitional until command-buffer methods are assigned per lane:
          // whole-buffer projections can still contain differently-shaped entries.
          observeDone = entry.mutate(chain);
        } else if (entry.iterate) {
          const completion = entry.iterate(chain, new ObserverState());
          observeDone = runAfter(completion.mutateDone, () => completion.observeDone);
        } else {
          RuntimeError.reportAndThrow(
            `CommandBuffer cannot process entry for chain '${chain.name}' in observe phase`,
            this.bufferStackErrorContext
          );
        }
        if (observeDone && typeof observeDone.then === 'function') {
          observations.push(observeDone);
        }
      },
      () => {
        if (observations.length > 0) {
          return Promise.allSettled(observations).then((results) => {
            const rejected = results.find((result) => result.status === 'rejected');
            if (rejected) {
              throw rejected.reason;
            }
          });
        }
        return undefined;
      },
      () => undefined
    );
  }

  _mutate(chain) {
    const iterator = new CommandIterator(this, chain.name);
    return this._runLaneEntries(
      iterator,
      chain.name,
      (entry) => {
        if (entry.mutate) {
          return entry.mutate(chain);
        }
        if (entry.observe) {
          // Transitional until command-buffer methods are assigned per lane:
          // whole-buffer projections can still contain differently-shaped entries.
          return entry.observe(chain);
        }
        if (entry.iterate) {
          const completion = entry.iterate(chain, new ObserverState());
          return runAfter(completion.mutateDone, () => completion.observeDone);
        }
        RuntimeError.reportAndThrow(
          `CommandBuffer cannot process entry for chain '${chain.name}' in mutate phase`,
          this.bufferStackErrorContext
        );
      },
      null,
      () => undefined
    );
  }

  iterate(chain, observerState) {
    const completion = createIterationCompletion();
    const iterator = new CommandIterator(this, chain.name);
    if (!observerState.attachObserveOwner(
      () => iterator.isClosedAndConsumed(),
      completion.resolveObserveDone
    )) {
      completion.observeDone = undefined;
    }
    const laneRun = this._runLaneEntries(
      iterator,
      chain.name,
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
        this._handleLaneFailure(err, chain.name);
        completion.reject(err);
      }));
    }
    return completion;
  }

  _runLaneEntries(iterator, chainName, processEntry, finishLane = null, handleSyncError = null) {
    const advance = (readyItem = NO_ITERATOR_ITEM) => {
      try {
        while (true) {
          this._throwIfFatalLaneAbandoned(chainName);
          const item = readyItem === NO_ITERATOR_ITEM ? iterator.next() : readyItem;
          readyItem = NO_ITERATOR_ITEM;
          if (item === null) {
            iterator.releaseFinishedLane();
            iterator.dispose();
            return finishLane ? finishLane() : undefined;
          }
          if (item && typeof item.then === 'function') {
            return item.then(advance);
          }
          const entry = item.value;
          if (!entry) {
            item.release();
            continue;
          }
          const done = processEntry(entry);
          if (done && typeof done.then === 'function') {
            return done.then(
              () => {
                item.release();
                return advance();
              },
              (err) => {
                item.release();
                throw err;
              }
            );
          }
          item.release();
        }
      } catch (err) {
        iterator.dispose();
        this._handleLaneFailure(err, chainName);
        if (handleSyncError) {
          return handleSyncError(err);
        }
        throw err;
      }
    };
    return advance();
  }

  _processMixedEntry(entry, chain, observerState) {
    if (entry.observe) {
      const observeDone = entry.observe(chain);
      observerState.track(observeDone);
      return;
    }
    if (entry.mutate) {
      return runAfter(observerState.drain(), () => entry.mutate(chain));
    }
    if (entry.iterate) {
      const childCompletion = entry.iterate(chain, observerState);
      return childCompletion.mutateDone;
    }

    RuntimeError.reportAndThrow(
      `CommandBuffer cannot classify entry for chain '${chain.name}'`,
      this.bufferStackErrorContext
    );
  }

  _handleLaneFailure(err, chainName) {
    if (!err) {
      return;
    }
    const chain = this.getChainIfExists(chainName);
    if (chain && !chain._fatalError) {
      chain._setFatalError(err, { errorContext: this.bufferStackErrorContext });
    }
    if (this.renderState && this.renderState.isFatalErrorReported()) {
      this._rejectPendingCommandResultsAfterFatal(chainName, this.renderState.error || err);
    }
    if (this.renderState && !this.renderState.isFatalErrorReported()) {
      this.renderState.reportFatalError(err, this.bufferStackErrorContext, this);
    }
  }

  _throwIfFatalLaneAbandoned(chainName) {
    if (!this.renderState || !this.renderState.isFatalErrorReported()) {
      return;
    }
    const fatalError = this.renderState.error;
    this._rejectPendingCommandResultsAfterFatal(chainName, fatalError);
    throw fatalError;
  }

  _rejectPendingCommandResultsAfterFatal(chainName, err) {
    if (!err || !chainName || !this.arrays) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    const lane = this.arrays[resolvedChainName];
    if (!lane) {
      return;
    }
    for (const entry of lane) {
      if (!entry) {
        continue;
      }
      if (entry && entry.iterate) {
        entry._rejectPendingCommandResultsAfterFatal(resolvedChainName, err);
        continue;
      }
      if (typeof entry.rejectResult === 'function' && entry.reject) {
        entry.rejectResult(err);
      }
    }
  }

  _runObservationCommandOnFinishedBuffer(cmd, chainName) {
    const chain = this.getChainIfExists(chainName);
    if (!chain) {
      RuntimeError.reportAndThrow(
        `Chain '${chainName}' is unavailable on finished CommandBuffer`,
        cmd.errorContext
      );
    }

    const applyObservation = () => {
      return cmd.observe(chain) || cmd.promise;
    };

    // Finished-buffer observations are allowed only after the target chain stream is complete.
    if (!chain._completionResolved && chain._completionPromise) {
      return chain._completionPromise.then(applyObservation);
    }

    return applyObservation();
  }

  _notifyLaneChanged(chainName) {
    const iterator = this._activeIterators.get(chainName);
    if (iterator) {
      iterator.onAnyChange();
    }
  }

  _completeBufferIfAllChainsFinished() {
    if (!Object.keys(this.arrays).every(name => this._finishedChains[name])) {
      return;
    }
    this.finished = true;
    if (this._finishedResolver) {
      this._finishedResolver();
      this._finishedResolver = null;
      this._finishedPromise = null;
    }
  }

  getChain(chainName = 'text') {
    const chain = this.getChainIfExists(chainName);
    if (!chain) {
      const resolvedChainName = this._resolveAliasedChainName(chainName);
      throw new Error(`CommandBuffer chain '${resolvedChainName}' is unavailable`);
    }
    return chain;
  }

  getOwnChain(chainName = 'text') {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    const chain = this._chains[resolvedChainName];
    return chain && chain._buffer === this ? chain : undefined;
  }

  hasChain(chainName = 'text') {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    return !!this._chains[resolvedChainName];
  }

  // Optional local-only chain probe for runtime paths where absence is a
  // valid branch. Use getChain(...) when missing chains are invariant bugs.
  getChainIfExists(chainName = 'text') {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    return this._chains[resolvedChainName];
  }

  isBoundaryLinkedMutatedChain(chainName) {
    return this._boundaryLinkedMutatedChains.has(this._resolveAliasedChainName(chainName));
  }

  // Currently only used in tests, see how it shall work when implementing
  // macro by-reference parameters that need to alias parent chains.
  _setChainAliases(map) {
    if (!map) {
      return;
    }
    // Narrow runtime substrate for explicit chain binding, such as future
    // macro by-reference aliases. This must not be treated as a generic
    // ambient composition-visibility mechanism.
    this._chainAliases = Object.assign(Object.create(null), map);
  }

  _inheritChainAliases(parentMap) {
    if (!parentMap) {
      return;
    }
    if (!this._chainAliases) {
      // Fast path: reuse parent alias object until this buffer gets its own
      // explicit alias projection.
      this._chainAliases = parentMap;
      return;
    }
    this._chainAliases = Object.assign(Object.create(null), parentMap, this._chainAliases);
  }

  _resolveAliasedChainName(name) {
    if (typeof name !== 'string') {
      return name;
    }
    if (/#\d+$/.test(name)) {
      // Already a resolved runtime chain name (e.g. someVar#7). Do not
      // remap canonical runtime names through the alias table again.
      return name;
    }
    // Alias resolution is intentionally narrow: only explicit chain bindings
    // installed on this buffer may remap the name. Unknown names stay unknown.
    const mapped = this._chainAliases && this._chainAliases[name];
    return mapped || name;
  }

  // Late inheritance callable linking may need to attach an already-finished
  // parent lane to an existing invocation buffer. Constructor-time child
  // buffers should prefer the normal chain-facts constructor path.
  _installLinkedChain(chainName, chain = null) {
    if (!chainName) {
      return;
    }
    const resolvedChainName = this._assertCanInstallLinkedChain(chainName, chain);
    this._installLinkedChainResolved(resolvedChainName, chain);
  }

  _installLinkedChainResolved(resolvedChainName, chain) {
    this._chains[resolvedChainName] = chain;
    this._ensureLane(resolvedChainName);
  }

  _assertCanInstallLinkedChain(chainName, chain) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (!chain) {
      RuntimeError.reportAndThrow(
        `Cannot link chain '${resolvedChainName}' without a registered chain object`,
        this.bufferStackErrorContext
      );
    }
    return resolvedChainName;
  }

}

class ObserverState {
  constructor() {
    this.pendingObservers = new Set();
    this.pendingObserversEmpty = null;
    this.resolvePendingObserversEmpty = null;
    this.observeOwner = null;
  }

  attachObserveOwner(isInputConsumed, resolveObserveDone) {
    if (this.observeOwner) {
      return false;
    }
    this.observeOwner = {
      done: false,
      isInputConsumed,
      resolveObserveDone
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
    markPromiseHandled(observeDone.finally(() => {
      this.pendingObservers.delete(observerToken);
      if (this.pendingObservers.size === 0 && this.resolvePendingObserversEmpty) {
        const resolve = this.resolvePendingObserversEmpty;
        this.pendingObserversEmpty = null;
        this.resolvePendingObserversEmpty = null;
        resolve();
      }
      this.checkObserveDone();
    }));
  }

  checkObserveDone() {
    const owner = this.observeOwner;
    if (!owner || owner.done) {
      return;
    }
    if (owner.isInputConsumed() && this.pendingObservers.size === 0) {
      owner.done = true;
      owner.resolveObserveDone();
    }
  }

  drain() {
    if (this.pendingObservers.size === 0) {
      return undefined;
    }
    return this._drainAsync();
  }

  async _drainAsync() {
    while (this.pendingObservers.size > 0) {
      await this.pendingObserversEmpty;
    }
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

function hasObserveOnlyLinkedChain(linkedChains, linkedMutatedChains) {
  for (const chainName of linkedChains) {
    if (!linkedMutatedChains.has(chainName)) {
      return true;
    }
  }
  return false;
}

export { CommandBuffer, ObserverState };
