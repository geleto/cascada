
import {
  SnapshotCommand,
  RawSnapshotCommand,
  ReturnIsUnsetCommand,
} from './channels/observation.js';

import {assertChannelLaneAvailable, checkFinishedBuffer} from './checks.js';
import {handleError, RuntimeFatalError} from './errors.js';
import {BufferIterator} from './buffer-iterator.js';
import {markCommandBuffer} from './buffer-marker.js';

class CommandBuffer {
  constructor(context, parent = null, laneNames = null) {
    markCommandBuffer(this);
    this._context = context;
    this.parent = parent;
    this.finished = false;
    this._finishedChannels = Object.create(null);
    // Local addressability map. Entries may be owned by this buffer or linked
    // from an explicit parent lane; ownership is derived from channel._buffer.
    this._channels = Object.create(null);
    // Per-lane command arrays. Static metadata creates these eagerly; remaining
    // dynamic compatibility declarations enter through _ensureLane().
    this.arrays = Object.create(null);
    this._finishedPromise = null;
    this._finishedResolver = null;

    // Iterators currently visiting this buffer keyed by channel name.
    this._visitingIterators = new Map();
    if (parent && parent._channelAliases) {
      // Propagate explicit channel-binding aliases down the buffer tree so
      // nested child buffers can continue routing formal names to the same
      // caller-owned runtime channels.
      this._inheritChannelAliases(parent._channelAliases);
    }
    this._installInitialLanes(laneNames);
  }

  _installInitialLanes(laneNames) {
    if (!laneNames) {
      return;
    }
    for (let i = 0; i < laneNames.length; i++) {
      this._ensureLane(laneNames[i]);
    }
  }

  // ANALYSIS-CHANNELS-REFACTOR: when linked/declared lane metadata is fully
  // authoritative, this should become an assertion-backed lane lookup instead
  // of the runtime path that creates compatibility lanes.
  _ensureLane(channelName) {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    if (!resolvedChannelName) {
      return null;
    }
    if (!(resolvedChannelName in this.arrays)) {
      this.arrays[resolvedChannelName] = [];
    }
    return resolvedChannelName;
  }

  _registerChannel(channelName, channel) {
    // Channel declarations also honor explicit alias bindings so a formal name
    // can attach to a caller-owned runtime channel name when a feature such as
    // macro by-reference uses this buffer-level mechanism.
    const resolvedChannelName = this._ensureLane(channelName);
    this._channels[resolvedChannelName] = channel;

    const iterator = ensureChannelIterator(channel);
    if (iterator) {
      iterator.bindToCurrentBuffer();
    }
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

  //@todo - rename this, maybe to finishBufferAndLetIteratorsExit
  markFinishedAndPatchLinks() {
    if (this.finished) {
      return;
    }
    const channelNames = Object.keys(this.arrays);
    for (let i = 0; i < channelNames.length; i++) {
      this._markChannelFinished(channelNames[i]);
    }
    this._completeFinishIfAllLanesFinished();
  }

  //@todo - rename this, maybe to finishChannelAndLetIteratorExit
  requestChannelFinish(channelName) {
    // Finishing an individual lane only wakes channel iterators. Aggregate
    // buffer completion is still gated by markFinishedAndPatchLinks().
    if (this.finished) {
      return;
    }
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    if (!resolvedChannelName) {
      return;
    }
    this._markChannelFinished(resolvedChannelName);
  }

  isFinished(channelName = null) {
    if (channelName == null) {
      return this.finished;
    }
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    return this._finishedChannels[resolvedChannelName] === true;
  }

  onEnterBuffer(iterator, channelName) {
    if (!iterator || !channelName) {
      return;
    }
    const resolvedChannelName = this._ensureLane(channelName);
    this._visitingIterators.set(resolvedChannelName, iterator);
  }

  onLeaveBuffer(iterator, channelName) {
    if (!iterator || !channelName) {
      return;
    }
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    const current = this._visitingIterators.get(resolvedChannelName);
    if (current === iterator) {
      this._visitingIterators.delete(resolvedChannelName);
    }
  }

  _add(value, channelName) {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    checkFinishedBuffer(this, resolvedChannelName);
    this._ensureLane(resolvedChannelName);
    // ANALYSIS-CHANNELS-REFACTOR: once _ensureLane(...) is removed from this
    // ingress path, this assertion becomes the hard lane-existence guard.
    assertChannelLaneAvailable(this, resolvedChannelName);
    // Normalize command channel/path keys at ingress so all downstream runtime
    // lookups operate on the resolved runtime channel name. This is why the
    // alias layer lives in CommandBuffer: once a command enters the buffer tree,
    // the rest of the runtime should not need to care whether it came from a
    // formal alias such as a by-reference macro parameter.
    if (!(value instanceof CommandBuffer) && value && typeof value === 'object') {
      if (Object.hasOwn(value, 'channelName')) {
        value.channelName = resolvedChannelName;
      }
      if (Object.hasOwn(value, 'pathKey')) {
        value.pathKey = resolvedChannelName;
      }
    }
    if (value instanceof CommandBuffer) {
      const channel = this.getChannelIfExists(resolvedChannelName);
      value._assertCanInstallLinkedChannel(resolvedChannelName, channel);
      value.parent = this;
      if (this._channelAliases) {
        // Nested child buffers must preserve the same explicit alias bindings,
        // otherwise async control-flow inside a macro could stop routing formal
        // names to the caller-owned runtime channels they were bound to.
        value._inheritChannelAliases(this._channelAliases);
      }
      value._installLinkedChannelResolved(resolvedChannelName, channel);
    }

    const target = this.arrays[resolvedChannelName];
    target.push(value);
    const slot = target.length - 1;
    this._notifyCommandOrBufferAdded(resolvedChannelName);
    return slot;
  }

  addCommand(cmd, channelName = null) {
    return this._addCommand(cmd, channelName || (cmd && cmd.channelName));
  }

  addBuffer(buffer, channelName) {
    return this._add(buffer, channelName);
  }

  _addCommand(cmd, channelName) {
    if (!this.isFinished(channelName)) {
      this._add(cmd, channelName);
      return cmd.promise;
    }

    if (isFinishedBufferObservationCommand(cmd)) {
      const resolvedChannelName = this._resolveAliasedChannelName(channelName);
      const output = this.getChannelIfExists(resolvedChannelName);
      const path = this._context?.path || null;
      if (!output) {
        throw new RuntimeFatalError(
          `Channel '${resolvedChannelName}' is unavailable on finished CommandBuffer`,
          cmd.pos?.lineno ?? 0,
          cmd.pos?.colno ?? 0,
          null,
          path
        );
      }
      if (!output._buffer.isFinished(resolvedChannelName)) {
        throw new RuntimeFatalError(
          `${cmd.constructor.name} on finished buffer is allowed only if the target channel stream is finished`,
          cmd.pos?.lineno ?? 0,
          cmd.pos?.colno ?? 0,
          null,
          path
        );
      }
      return this._runFinishedSnapshotCommand(cmd, resolvedChannelName);
    }

    const path = this._context?.path || null;
    throw new RuntimeFatalError(
      `Adding command '${cmd?.constructor ? cmd.constructor.name : 'unknown'}' is not allowed on a finished CommandBuffer`,
      cmd?.pos ? cmd.pos.lineno : 0,
      cmd?.pos ? cmd.pos.colno : 0,
      null,
      path
    );
  }

  _runFinishedSnapshotCommand(cmd, channelName) {
    const channel = this.getChannelIfExists(channelName);
    const path = this._context?.path || null;
    if (!channel) {
      throw new RuntimeFatalError(
        `Channel '${channelName}' is unavailable on finished CommandBuffer`,
        cmd.pos?.lineno ?? 0,
        cmd.pos?.colno ?? 0,
        null,
        path
      );
    }

    const applySnapshot = () => {
      try {
        cmd.apply(channel);
      } catch (err) {
        const channelPath = channel && channel._context && channel._context.path ? channel._context.path : path;
        cmd.rejectResult(handleError(err, cmd.pos.lineno, cmd.pos.colno, null, channelPath));
      }
      return cmd.promise;
    };

    // Snapshot-on-finished-buffer is allowed only after the target channel stream is complete.
    if (!channel._completionResolved && channel._completionPromise) {
      return Promise.resolve(channel._completionPromise).then(applySnapshot);
    }

    return applySnapshot();
  }

  _notifyCommandOrBufferAdded(channelName) {
    const iterator = this._visitingIterators.get(channelName);
    if (iterator) {
      iterator.onCommandOrBufferAdded(this);
    }
  }

  _completeFinishIfAllLanesFinished() {
    if (this.finished) {
      return;
    }
    const channelNames = Object.keys(this.arrays);
    for (let i = 0; i < channelNames.length; i++) {
      if (!this._finishedChannels[channelNames[i]]) {
        return;
      }
    }
    this.finished = true;
    if (this._finishedResolver) {
      this._finishedResolver();
      this._finishedResolver = null;
      this._finishedPromise = null;
    }
  }

  _notifyChannelFinished(channelName) {
    const iterator = this._visitingIterators.get(channelName);
    if (iterator) {
      iterator.onBufferFinished(this, channelName);
    }
  }

  getChannel(channelName = 'text') {
    const output = this.getChannelIfExists(channelName);
    if (!output) {
      const resolvedChannelName = this._resolveAliasedChannelName(channelName);
      throw new Error(`CommandBuffer channel '${resolvedChannelName}' is unavailable`);
    }
    return output;
  }

  getOwnChannel(channelName = 'text') {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    const channel = this._channels[resolvedChannelName];
    return channel && channel._buffer === this ? channel : undefined;
  }

  hasChannel(channelName = 'text') {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    return !!this._channels[resolvedChannelName];
  }

  // Optional local-only channel probe for runtime paths where absence is a
  // valid branch. Use getChannel(...) when missing channels are invariant bugs.
  getChannelIfExists(channelName = 'text') {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    return this._channels[resolvedChannelName];
  }

  _setChannelAliases(map) {
    if (!map) {
      return;
    }
    // Narrow runtime substrate for explicit channel binding, such as future
    // macro by-reference aliases. This must not be treated as a generic
    // ambient composition-visibility mechanism.
    this._channelAliases = Object.assign(Object.create(null), map);
  }

  _inheritChannelAliases(parentMap) {
    if (!parentMap) {
      return;
    }
    if (!this._channelAliases) {
      // Fast path: reuse parent alias object until this buffer gets its own
      // explicit alias projection.
      this._channelAliases = parentMap;
      return;
    }
    this._channelAliases = Object.assign(Object.create(null), parentMap, this._channelAliases);
  }

  _resolveAliasedChannelName(name) {
    if (typeof name !== 'string') {
      return name;
    }
    if (/#\d+$/.test(name)) {
      // Already a resolved runtime channel name (e.g. someVar#7). Do not
      // remap canonical runtime names through the alias table again.
      return name;
    }
    // Alias resolution is intentionally narrow: only explicit channel bindings
    // installed on this buffer may remap the name. Unknown names stay unknown.
    const mapped = this._channelAliases && this._channelAliases[name];
    return mapped || name;
  }

  _markChannelFinished(channelName) {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    if (!resolvedChannelName || this._finishedChannels[resolvedChannelName]) {
      return;
    }
    assertChannelLaneAvailable(this, resolvedChannelName);
    this._finishedChannels[resolvedChannelName] = true;
    this._notifyChannelFinished(resolvedChannelName);
  }

  _installLinkedChannel(channelName, channel = null) {
    if (!channelName) {
      return;
    }
    const resolvedChannelName = this._assertCanInstallLinkedChannel(channelName, channel);
    this._installLinkedChannelResolved(resolvedChannelName, channel);
  }

  _installLinkedChannelResolved(resolvedChannelName, channel) {
    this._channels[resolvedChannelName] = channel;
    this._ensureLane(resolvedChannelName);
  }

  _assertCanInstallLinkedChannel(channelName, channel) {
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    if (!channel) {
      const path = this._context?.path || null;
      throw new RuntimeFatalError(
        `Cannot link channel '${resolvedChannelName}' without a registered channel object`,
        0,
        0,
        null,
        path
      );
    }
    return resolvedChannelName;
  }

  hasLinkedBuffer(buffer, channelName) {
    // ANALYSIS-CHANNELS-REFACTOR: this is a runtime structural-link probe.
    // Prefer analysis-provided linked-channel decisions over asking the buffer
    // tree whether a link already exists. Keep the finished-parent regression
    // covered before replacing this helper.
    if (!buffer || !channelName) {
      return false;
    }
    const resolvedChannelName = this._resolveAliasedChannelName(channelName);
    const channel = this.getChannelIfExists(resolvedChannelName);
    return (
      buffer.parent === this &&
      channel &&
      buffer.getChannelIfExists(resolvedChannelName) === channel
    );
  }
}

function isFinishedBufferObservationCommand(cmd) {
  return (
    cmd instanceof SnapshotCommand ||
    cmd instanceof RawSnapshotCommand ||
    cmd instanceof ReturnIsUnsetCommand
  );
}

function ensureChannelIterator(channel) {
  if (!channel._iterator) {
    channel._iterator = new BufferIterator(channel);
  }

  return channel._iterator;
}

function createCommandBuffer(context, parent = null, linkedChannels = null, linkedParent = null, declaredChannels = null) {
  const linkedLaneNames = uniqueLaneNames(linkedChannels);
  const declaredLaneNames = uniqueLaneNames(declaredChannels);
  const laneNames = mergeLaneNames(linkedLaneNames, declaredLaneNames);
  const buffer = new CommandBuffer(context, parent, laneNames);
  const linkTarget = linkedParent || parent;
  if (linkTarget && linkedLaneNames) {
    for (let i = 0; i < linkedLaneNames.length; i++) {
      linkTarget.addBuffer(buffer, linkedLaneNames[i]);
    }
  }
  return buffer;
}

// ANALYSIS-CHANNELS-REFACTOR: Once analysis-owned linked/declared lane metadata
// is the source of truth, duplicate lane names should become an assertion rather
// than runtime normalization.
function uniqueLaneNames(laneNames) {
  if (!Array.isArray(laneNames)) {
    return null;
  }
  return Array.from(new Set(laneNames));
}

function mergeLaneNames(linkedChannels, declaredChannels) {
  if (!linkedChannels) {
    return declaredChannels;
  }
  if (!declaredChannels) {
    return linkedChannels;
  }
  return Array.from(new Set([
    ...linkedChannels,
    ...declaredChannels
  ]));
}

export { CommandBuffer, createCommandBuffer };
