'use strict';

import {ChannelCommand, runWithResolvedArguments} from './command-base.js';
import {PoisonError, isPoison} from '../errors.js';
import {Channel} from './base.js';

class SequenceCallCommand extends ChannelCommand {
  constructor({ channelName, command, args = null, subpath = null, pos = null, withDeferredResult = false }) {
    super({
      channelName,
      command: command || null,
      args: args || [],
      subpath: subpath || null,
      pos,
      withDeferredResult
    });
  }

  apply(channel) {
    super.apply(channel);
    return runWithResolvedArguments(this.arguments, this, channel, (resolvedArgs) => {
      if (!channel) return undefined;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        const err = new PoisonError(poisonErrors);
        this.rejectResult(err);
        throw err;
      }

      const execute = (sequenceTarget) => {
        const target = resolveSubpath(sequenceTarget, this.subpath);
        if (target === null || target === undefined) {
          this.resolveResult(undefined);
          return undefined;
        }
        const method = this.command ? target[this.command] : target;
        if (typeof method !== 'function') {
          this.resolveResult(undefined);
          return undefined;
        }
        const result = method.apply(target, args);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).then(
            (value) => {
              this.resolveResult(value);
              return value;
            },
            (err) => {
              this.rejectResult(err);
              throw err;
            }
          );
        }
        this.resolveResult(result);
        return result;
      };

      const sequenceTarget = channel._ensureSequenceTargetResolved ? channel._ensureSequenceTargetResolved() : channel._sequenceTarget;
      if (sequenceTarget && typeof sequenceTarget.then === 'function') {
        return Promise.resolve(sequenceTarget).then(execute);
      }
      return execute(sequenceTarget);
    });
  }
}

// Reads a property from a sequence target in source order and resolves the deferred result promise with the value. Observable — applied immediately without waiting for pending mutating commands.
class SequenceGetCommand extends ChannelCommand {
  constructor({ channelName, command, subpath = null, pos = null, withDeferredResult = false }) {
    super({
      channelName,
      command: command || null,
      args: [],
      subpath: subpath || null,
      pos,
      withDeferredResult
    });
    this.isObservable = true;
  }

  apply(channel) {
    if (!channel) return undefined;

    const execute = (sequenceTarget) => {
      const target = resolveSubpath(sequenceTarget, this.subpath);
      const value = (target === null || target === undefined || !this.command) ? undefined : target[this.command];
      this.resolveResult(value);
      return value;
    };

    const sequenceTarget = channel._ensureSequenceTargetResolved ? channel._ensureSequenceTargetResolved() : channel._sequenceTarget;
    if (sequenceTarget && typeof sequenceTarget.then === 'function') {
      return Promise.resolve(sequenceTarget).then(execute, (err) => {
        this.rejectResult(err);
        throw err;
      });
    }
    return execute(sequenceTarget);
  }
}

function resolveSubpath(target, subpath) {
  if (!Array.isArray(subpath) || subpath.length === 0) {
    return target;
  }
  let current = target;
  for (const segment of subpath) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

class SequenceObjectChannel extends Channel {
  constructor(buffer, channelName, context, targetObject) {
    super(buffer, channelName, context, 'sequence', undefined, null);
    this._sequenceTarget = targetObject;
    this._sequenceTargetReady = false;
    this._sequenceTargetReadyPromise = null;
  }

  _resolveSequenceTarget() {
    return this._sequenceTarget;
  }

  _setSequenceTarget(targetObject) {
    this._sequenceTarget = targetObject;
    this._sequenceTargetReady = false;
    this._sequenceTargetReadyPromise = null;
    this._setTarget(undefined);
    return this._sequenceTarget;
  }

  _ensureSequenceTargetResolved() {
    if (this._sequenceTargetReady) {
      return this._sequenceTarget;
    }
    if (!this._sequenceTargetReadyPromise) {
      const targetValue = this._resolveSequenceTarget();
      if (!targetValue || typeof targetValue.then !== 'function') {
        this._sequenceTarget = targetValue;
        this._sequenceTargetReady = true;
        return this._sequenceTarget;
      }
      this._sequenceTargetReadyPromise = Promise.resolve(targetValue)
        .then((resolvedTarget) => {
          this._sequenceTarget = resolvedTarget;
          this._sequenceTargetReady = true;
          this._sequenceTargetReadyPromise = null;
          return resolvedTarget;
        });
    }
    return this._sequenceTargetReadyPromise;
  }


  _applyCommand(cmd) {

    if (!cmd) return;

    try {

      cmd.resolved = true;

      if (cmd.isObservable) {

        const result = cmd.apply(this);

        if (result && typeof result.then === 'function') {

          return Promise.resolve(result).catch((err) => {

            this._recordError(err, cmd);

          });

        }

        return result;

      }

      const sequenceTarget = this._ensureSequenceTargetResolved();
      const apply = () => cmd.apply(this);
      const result = (sequenceTarget && typeof sequenceTarget.then === 'function')
        ? Promise.resolve(sequenceTarget).then(apply)
        : apply();
      if (result && typeof result.then === 'function') {

        return Promise.resolve(result).catch((err) => {

          this._recordError(err, cmd);

        });

      }

      return result;

    } catch (err) {

      this._recordError(err, cmd);

    }

  }



  _snapshotFromSequenceTarget(sequenceTarget) {
    if (!sequenceTarget) return sequenceTarget;
    if (typeof sequenceTarget.snapshot === 'function') return sequenceTarget.snapshot();
    if (typeof sequenceTarget.getReturnValue === 'function') return sequenceTarget.getReturnValue();
    if (typeof sequenceTarget.finalize === 'function') return sequenceTarget.finalize();
    return sequenceTarget;
  }

  _resolveSnapshotCommandResult() {
    const targetValue = this._ensureSequenceTargetResolved();
    if (targetValue && typeof targetValue.then === 'function') {
      return targetValue.then((resolved) => {
        const target = this._getTarget();
        if (isPoison(target)) {
          throw new PoisonError(target.errors.slice());
        }
        return this._snapshotFromSequenceTarget(resolved);
      });
    }
    const target = this._getTarget();

    if (isPoison(target)) {

      throw new PoisonError(target.errors.slice());

    }

    return super._resolveSnapshotCommandResult();

  }

  _getCurrentResult() {
    return this._snapshotFromSequenceTarget(this._sequenceTarget);
  }

  _captureGuardState() {
    const targetValue = this._ensureSequenceTargetResolved();
    const capture = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.snapshot !== 'function') {
        return undefined;
      }
      return sequenceTarget.snapshot();
    };
    const normalizeCapture = (captured) => {

      if (captured && typeof captured.then === 'function') {

        return Promise.resolve(captured);

      }

      return captured;

    };

    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then((sequenceTarget) => normalizeCapture(capture(sequenceTarget)));
    }
    return normalizeCapture(capture(targetValue));
  }

  _restoreGuardState(state) {
    const targetValue = this._ensureSequenceTargetResolved();
    const restore = (sequenceTarget, recoveredState) => {
      this._setTarget(undefined);
      if (!sequenceTarget || typeof sequenceTarget.recover !== 'function') {
        return undefined;
      }
      return sequenceTarget.recover(recoveredState);
    };

    const targetIsPromise = !!(targetValue && typeof targetValue.then === 'function');
    const stateIsPromise = !!(state && typeof state.then === 'function');
    if (targetIsPromise || stateIsPromise) {
      return Promise.all([Promise.resolve(targetValue), Promise.resolve(state)])
        .then(([sequenceTarget, recoveredState]) => restore(sequenceTarget, recoveredState));
    }
    return restore(targetValue, state);
  }
}

class SequenceChannel extends SequenceObjectChannel {
  constructor(buffer, channelName, context, targetObject) {
    super(buffer, channelName, context, targetObject);
    this._channelType = 'sequence';
  }

  beginTransaction() {
    const targetValue = this._ensureSequenceTargetResolved();
    const begin = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.begin !== 'function') {
        return { active: false, token: undefined };
      }
      const token = sequenceTarget.begin();
      if (token && typeof token.then === 'function') {

        return Promise.resolve(token).then((resolvedToken) => ({ active: true, token: resolvedToken }));

      }

      return { active: true, token };

    };

    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(begin);
    }
    return begin(targetValue);
  }


  commitTransaction(tx) {

    if (!tx || !tx.active) {

      return undefined;

    }

    const targetValue = this._ensureSequenceTargetResolved();
    const commit = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.commit !== 'function') {
        return undefined;
      }
      return sequenceTarget.commit(tx.token);
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(commit);
    }
    return commit(targetValue);
  }


  rollbackTransaction(tx) {

    if (!tx || !tx.active) {

      return undefined;

    }

    const targetValue = this._ensureSequenceTargetResolved();
    const rollback = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.rollback !== 'function') {
        return undefined;
      }
      return sequenceTarget.rollback(tx.token);
    };
    if (targetValue && typeof targetValue.then === 'function') {
      return Promise.resolve(targetValue).then(rollback);
    }
    return rollback(targetValue);
  }
}

export { SequenceObjectChannel, SequenceChannel, SequenceCallCommand, SequenceGetCommand };
