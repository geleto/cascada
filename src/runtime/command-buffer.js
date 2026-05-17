
import {assertChainLaneAvailable, checkFinishedBuffer} from './checks.js';
import {handleError, RuntimeFatalError} from './errors.js';

class CommandBuffer {
  constructor(context, parent = null, linkedChains = null, linkedParent = null, linkedMutatedChains = null) {
    const linkedLaneNames = validateLaneNames(linkedChains, 'linkedChains', context);
    const linkedMutatedLaneNames = validateLaneNames(linkedMutatedChains, 'linkedMutatedChains', context);

    this._context = context;
    this.parent = parent;
    this.finished = false;
    this._finishedChains = Object.create(null);
    // Local addressability map. Entries may be owned by this buffer or linked
    // from an explicit parent lane; ownership is derived from chain._buffer.
    this._chains = Object.create(null);
    // Per-lane command arrays. Local chain declarations and linked parent
    // chains are the lane sources.
    this.arrays = Object.create(null);
    // Linked parent lanes this buffer may mutate. This is metadata for future
    // scheduling that can let read-only child buffers stop blocking siblings.
    this._linkedMutatedChains = new Set(linkedMutatedLaneNames || []);
    this._finishedPromise = null;
    this._finishedResolver = null;

    // Iterators currently visiting this buffer keyed by chain name.
    this._visitingIterators = new Map();
    if (parent && parent._chainAliases) {
      // Propagate explicit chain-binding aliases down the buffer tree so
      // nested child buffers can continue routing formal names to the same
      // caller-owned runtime chains.
      this._inheritChainAliases(parent._chainAliases);
    }

    const linkTarget = linkedParent || parent;
    if (linkTarget && linkedLaneNames) {
      for (let i = 0; i < linkedLaneNames.length; i++) {
        linkTarget.addBuffer(this, linkedLaneNames[i]);
      }
    }
  }

  _createLane(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (!resolvedChainName) {
      return null;
    }
    if (resolvedChainName in this.arrays) {
      throw new RuntimeFatalError(
        `Chain '${resolvedChainName}' was registered more than once on the same CommandBuffer`,
        this._context
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

    chain._iterator.bindToCurrentBuffer();
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
    this._notifyChainFinished(resolvedChainName);
  }

  isFinished() {
    return this.finished;
  }

  isChainFinished(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    return this._finishedChains[resolvedChainName] === true;
  }

  onIteratorEnterBuffer(iterator, chainName) {
    if (!iterator || !chainName) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    assertChainLaneAvailable(this, resolvedChainName);
    this._visitingIterators.set(resolvedChainName, iterator);
  }

  onIteratorLeaveBuffer(iterator, chainName) {
    if (!iterator || !chainName) {
      return;
    }
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    const current = this._visitingIterators.get(resolvedChainName);
    if (current === iterator) {
      this._visitingIterators.delete(resolvedChainName);
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
    this._notifyCommandOrBufferAdded(resolvedChainName);
    return slot;
  }

  addCommand(cmd, chainName = null) {
    chainName = chainName || (cmd && cmd.chainName);
    if (!this.isChainFinished(chainName)) {
      this._add(cmd, chainName);
      return cmd.promise;
    }

    if (cmd && cmd.isObservable) {
      const resolvedChainName = this._resolveAliasedChainName(chainName);
      const chain = this.getChainIfExists(resolvedChainName);
      const path = this._context?.path || null;
      if (!chain) {
        throw new RuntimeFatalError(
          `Chain '${resolvedChainName}' is unavailable on finished CommandBuffer`,
          {...cmd.pos, path}
        );
      }
      if (!chain._buffer.isChainFinished(resolvedChainName)) {
        throw new RuntimeFatalError(
          `${cmd.constructor.name} on finished buffer is allowed only if the target chain stream is finished`,
          {...cmd.pos, path}
        );
      }
      return this._runObservationCommandOnFinishedBuffer(cmd, resolvedChainName);
    }

    const path = this._context?.path || null;
    throw new RuntimeFatalError(
      `Adding command '${cmd?.constructor ? cmd.constructor.name : 'unknown'}' is not allowed on a finished CommandBuffer`,
      {...cmd?.pos, path}
    );
  }

  addBuffer(buffer, chainName) {
    return this._add(buffer, chainName);
  }

  _runObservationCommandOnFinishedBuffer(cmd, chainName) {
    const chain = this.getChainIfExists(chainName);
    const path = this._context?.path || null;
    if (!chain) {
      throw new RuntimeFatalError(
        `Chain '${chainName}' is unavailable on finished CommandBuffer`,
        {...cmd.pos, path}
      );
    }

    const applyObservation = () => {
      try {
        cmd.apply(chain);
      } catch (err) {
        const chainPath = chain && chain._context && chain._context.path ? chain._context.path : path;
        cmd.rejectResult(handleError(err, cmd.pos.lineno, cmd.pos.colno, null, chainPath));
      }
      return cmd.promise;
    };

    // Finished-buffer observations are allowed only after the target chain stream is complete.
    if (!chain._completionResolved && chain._completionPromise) {
      return Promise.resolve(chain._completionPromise).then(applyObservation);
    }

    return applyObservation();
  }

  _notifyCommandOrBufferAdded(chainName) {
    const iterator = this._visitingIterators.get(chainName);
    if (iterator) {
      iterator.onCommandOrBufferAdded(this);
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

  _notifyChainFinished(chainName) {
    const iterator = this._visitingIterators.get(chainName);
    if (iterator) {
      iterator.onBufferFinished(this, chainName);
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

  isLinkedMutatedChain(chainName) {
    return this._linkedMutatedChains.has(this._resolveAliasedChainName(chainName));
  }

  // @todo - get rid of this after sorting out inheritance
  _markLinkedMutatedChain(chainName) {
    const resolvedChainName = this._resolveAliasedChainName(chainName);
    if (resolvedChainName) {
      this._linkedMutatedChains.add(resolvedChainName);
    }
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

  // @todo - get rid of this when done cleaning-up inheritance and have a clear chain linking strategy for child buffers.
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
      throw new RuntimeFatalError(
        `Cannot link chain '${resolvedChainName}' without a registered chain object`,
        this._context
      );
    }
    return resolvedChainName;
  }

}

function validateLaneNames(laneNames, label, context = null) {
  if (laneNames == null) {
    return null;
  }
  if (!Array.isArray(laneNames)) {
    throw new RuntimeFatalError(`${label} must be an array when provided`, context);
  }
  const seen = new Set();
  for (let i = 0; i < laneNames.length; i++) {
    const name = laneNames[i];
    if (typeof name !== 'string') {
      throw new RuntimeFatalError(`${label} contains a non-string chain name`, context);
    }
    if (!name) {
      throw new RuntimeFatalError(`${label} contains an empty chain name`, context);
    }
    if (seen.has(name)) {
      throw new RuntimeFatalError(`${label} contains duplicate chain '${name}'`, context);
    }
    seen.add(name);
  }
  return laneNames;
}

export { CommandBuffer };
