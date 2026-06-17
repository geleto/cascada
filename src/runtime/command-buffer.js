
import {assertChainLaneAvailable, checkFinishedBuffer} from './checks.js';
import {isObservableCommand} from './commands/base.js';
import {getRenderState, isCompactErrorContext} from './error-context.js';
import {markPromiseHandled, RuntimeError} from './errors.js';
import {BufferLaneEntry, ObserverState} from './buffer-lane-entry.js';

const LINKED_FACTS_OBSERVED_CHAINS = 0;
const LINKED_FACTS_MUTATED_CHAINS = 1;
const OWN_FACTS_OBSERVED_CHAINS = 0;
const OWN_FACTS_MUTATED_CHAINS = 1;

class CommandBuffer {
  constructor(context, parent = null, linkedFacts = null, ownFacts = null, linkTarget = null, bufferStackErrorContext, traceParent = null, renderState = null) {
    if (!isCompactErrorContext(bufferStackErrorContext)) {
      throw new TypeError('CommandBuffer requires compact bufferStackErrorContext');
    }
    if (linkedFacts != null && !Array.isArray(linkedFacts)) {
      RuntimeError.reportAndThrow('CommandBuffer linkedFacts must be an array when provided', bufferStackErrorContext);
    }
    if (ownFacts != null && !Array.isArray(ownFacts)) {
      RuntimeError.reportAndThrow('CommandBuffer ownFacts must be an array when provided', bufferStackErrorContext);
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
    // Explicit facts enable strict add-time shape validation. Null facts are
    // the permissive manual/test-buffer mode; compiler-created buffers pass
    // explicit vectors, including [] for "no known lanes".
    this._hasExplicitLinkedFacts = linkedFacts !== null;
    this._hasExplicitOwnFacts = ownFacts !== null;
    this._boundaryLinkedObservedChains = new Set(linkedFacts?.[LINKED_FACTS_OBSERVED_CHAINS] ?? []);
    this._boundaryLinkedMutatedChains = new Set(linkedFacts?.[LINKED_FACTS_MUTATED_CHAINS] ?? []);
    this._observedChains = new Set(ownFacts?.[OWN_FACTS_OBSERVED_CHAINS] ?? []);
    this._mutatedChains = new Set(ownFacts?.[OWN_FACTS_MUTATED_CHAINS] ?? []);
    this._startedChains = new Set();
    this._finishedPromise = null;
    this._finishedResolver = null;

    // Active lane runners keyed by chain name. A buffer lane is started once.
    this._activeIterators = new Map();
    this._fatalAbortBroadcasted = false;
    if (parent && parent._chainAliases) {
      // Propagate explicit chain-binding aliases down the buffer tree so
      // nested child buffers can continue routing formal names to the same
      // caller-owned runtime chains.
      this._inheritChainAliases(parent._chainAliases);
    }

    const effectiveLinkTarget = linkTarget || parent;
    const boundaryLinkedChains = new Set([
      ...this._boundaryLinkedObservedChains,
      ...this._boundaryLinkedMutatedChains
    ]);
    if (effectiveLinkTarget && boundaryLinkedChains.size > 0) {
      for (const chainName of boundaryLinkedChains) {
        effectiveLinkTarget.addBuffer(this, chainName);
      }
    }
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

  _createLaneEntry(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    assertChainLaneAvailable(this, resolvedChainName);
    return this._createLaneEntryWithFacts(
      resolvedChainName,
      this._observedChains.has(resolvedChainName),
      this._mutatedChains.has(resolvedChainName)
    );
  }

  _createLinkedLaneEntry(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    assertChainLaneAvailable(this, resolvedChainName);
    const mutates = this._boundaryLinkedMutatedChains.has(resolvedChainName);
    return this._createLaneEntryWithFacts(
      resolvedChainName,
      this._boundaryLinkedObservedChains.has(resolvedChainName),
      mutates
    );
  }

  _createLaneEntryWithFacts(resolvedChainName, observes, mutates) {
    return new BufferLaneEntry(
      this,
      resolvedChainName,
      observes,
      mutates
    );
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
    if (value instanceof CommandBuffer) {
      RuntimeError.reportAndThrow(
        'Use addBuffer(...) to add child CommandBuffer lanes',
        this.bufferStackErrorContext
      );
    }
    // Normalize command chain/path keys at ingress so all downstream runtime
    // lookups operate on the resolved runtime chain name. This is why the
    // alias layer lives in CommandBuffer: once a command enters the buffer tree,
    // the rest of the runtime should not need to care whether it came from a
    // formal alias such as a by-reference macro parameter.
    if (value && typeof value === 'object') {
      if ('chainName' in value) {
        value.chainName = resolvedChainName;
      }
      if ('pathKey' in value) {
        value.pathKey = resolvedChainName;
      }
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
      this._assertLaneEntryMatchesOwnFacts(cmd, chainName);
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
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    checkFinishedBuffer(this, resolvedChainName);
    assertChainLaneAvailable(this, resolvedChainName);
    const chain = this.getChainIfExists(resolvedChainName);
    buffer._assertCanInstallLinkedChain(resolvedChainName, chain);
    buffer.parent = this;
    if (this._chainAliases) {
      // Nested child buffers must preserve the same explicit alias bindings,
      // otherwise async control-flow inside a macro could stop routing formal
      // names to the caller-owned runtime chains they were bound to.
      buffer._inheritChainAliases(this._chainAliases);
    }
    buffer._installLinkedChainResolved(resolvedChainName, chain);
    buffer._assertLinkedLaneFacts(resolvedChainName);
    const entry = buffer._createLinkedLaneEntry(resolvedChainName);
    this._assertLaneEntryMatchesOwnFacts(entry, resolvedChainName);
    return this._add(entry, resolvedChainName);
  }

  _assertLaneEntryMatchesOwnFacts(entry, chainName) {
    if (!this._hasExplicitOwnFacts) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    const observes = this._observedChains.has(resolvedChainName);
    const mutates = this._mutatedChains.has(resolvedChainName);
    this._assertEntryShapeMatchesFacts(entry, resolvedChainName, observes, mutates, 'own');
  }

  _assertLinkedLaneFacts(chainName) {
    if (!this._hasExplicitLinkedFacts) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    const observes = this._boundaryLinkedObservedChains.has(resolvedChainName);
    const mutates = this._boundaryLinkedMutatedChains.has(resolvedChainName);
    if (observes || mutates) {
      return;
    }
    RuntimeError.reportAndThrow(
      `CommandBuffer linked facts do not declare lane '${resolvedChainName}'`,
      this.bufferStackErrorContext
    );
  }

  _assertEntryShapeMatchesFacts(entry, chainName, observes, mutates, factKind) {
    const needsObservation = !!(entry && entry.observe);
    const needsMutation = !!(entry && entry.mutate);
    const needsMixedIteration = !!(entry && !entry.observe && !entry.mutate && entry.iterate);
    const hasPhaseMethod = needsObservation || needsMutation || needsMixedIteration;
    const shapeMatches =
      hasPhaseMethod &&
      (!needsObservation || observes) &&
      (!needsMutation || mutates) &&
      (!needsMixedIteration || (observes && mutates));
    if (shapeMatches) {
      return;
    }

    const entryName = entry && entry.constructor ? entry.constructor.name : 'unknown';
    RuntimeError.reportAndThrow(
      `CommandBuffer ${factKind} facts for lane '${chainName}' do not match ${entryName} phase shape`,
      entry?.errorContext || this.bufferStackErrorContext
    );
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
    const entry = this._createLaneEntry(resolvedChainName);
    let observeDone;
    let mutateDone;

    if (entry.observe) {
      observeDone = entry.observe(chain);
    } else if (entry.mutate) {
      mutateDone = entry.mutate(chain);
    } else {
      const completion = entry.iterate(chain, new ObserverState((err) => {
        this._handleLaneFailure(err, chain.name);
      }));
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

  _handleLaneFailure(err, chainName) {
    if (!err) {
      return;
    }
    const chain = this.getChainIfExists(chainName);
    if (chain && !chain._fatalError) {
      chain._setFatalError(err, { errorContext: this.bufferStackErrorContext });
    }
    if (this.renderState && !this.renderState.isFatalErrorReported()) {
      this.renderState.reportFatalError(err, this.bufferStackErrorContext, this);
    }
    if (this.renderState && this.renderState.isFatalErrorReported()) {
      const fatalError = this.renderState.error || err;
      this._rejectPendingCommandResultsAfterFatal(chainName, fatalError);
      this._abortActiveLaneRuns(fatalError);
    }
  }

  _abortActiveLaneRuns(err) {
    if (this._fatalAbortBroadcasted) {
      return;
    }
    this._fatalAbortBroadcasted = true;
    for (const iterator of Array.from(this._activeIterators.values())) {
      iterator.abort(err);
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
      if (entry && entry._rejectPendingCommandResultsAfterFatal) {
        entry._rejectPendingCommandResultsAfterFatal(err);
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

export { CommandBuffer, ObserverState };
