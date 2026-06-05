import {PoisonError, isPoison, poisonIfNaN, poisonOrReportedFatal} from '../errors.js';
import {thenValue} from '../resolve.js';
import {Chain} from './base.js';

class SequenceObjectChain extends Chain {
  constructor(buffer, chainName, context, targetObject) {
    super(buffer, chainName, context, 'sequence', undefined, null);
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

  setInitialValue(targetObject) {
    return this._setSequenceTarget(targetObject);
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
      this._sequenceTargetReadyPromise = targetValue
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
          return result.then(undefined, (err) => {
            cmd.rejectResult(poisonOrReportedFatal(err, cmd.errorContext));
          });
        }
        return result;
      }

      const sequenceTarget = this._ensureSequenceTargetResolved();
      const apply = () => cmd.apply(this);
      const result = (sequenceTarget && typeof sequenceTarget.then === 'function')
        ? sequenceTarget.then(apply)
        : apply();
      if (result && typeof result.then === 'function') {
        return result.then(undefined, (err) => {
          this._recordError(err, cmd);
        });
      }

      return result;
    } catch (err) {
      if (cmd.isObservable) {
        cmd.rejectResult(poisonOrReportedFatal(err, cmd.errorContext));
        return;
      }
      this._recordError(err, cmd);
    }
  }

  _snapshotFromSequenceTarget(sequenceTarget) {
    if (!sequenceTarget) {
      return sequenceTarget;
    }
    if (typeof sequenceTarget.snapshot === 'function') return sequenceTarget.snapshot();
    if (typeof sequenceTarget.getReturnValue === 'function') return sequenceTarget.getReturnValue();
    if (typeof sequenceTarget.finalize === 'function') return sequenceTarget.finalize();
    return sequenceTarget;
  }

  _resolveSnapshotCommandResult(errorContext) {
    const targetValue = this._ensureSequenceTargetResolved();
    if (targetValue && typeof targetValue.then === 'function') {
      return targetValue.then((resolved) => {
        const target = this._getTarget();
        if (isPoison(target)) {
          throw PoisonError.group(target.errors);
        }
        return normalizeSequenceValue(this._snapshotFromSequenceTarget(resolved), errorContext);
      });
    }
    const target = this._getTarget();
    if (isPoison(target)) {
      throw PoisonError.group(target.errors);
    }
    return normalizeSequenceValue(super._resolveSnapshotCommandResult(), errorContext);
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

    return thenValue(targetValue, capture);
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
      return restoreGuardStateAsync(targetValue, state, restore);
    }
    return restore(targetValue, state);
  }
}

function normalizeSequenceValue(value, errorContext) {
  return thenValue(value, resolved => poisonIfNaN(resolved, errorContext));
}

async function restoreGuardStateAsync(targetValue, state, restore) {
  const targetResult = observeValueSettlement(targetValue);
  const stateResult = observeValueSettlement(state);
  const results = await Promise.all([targetResult, stateResult]);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
  return restore(results[0].value, results[1].value);
}

function observeValueSettlement(value) {
  if (value && typeof value.then === 'function') {
    return value.then(
      resolved => ({ status: 'fulfilled', value: resolved }),
      reason => ({ status: 'rejected', reason })
    );
  }
  return { status: 'fulfilled', value };
}

class SequenceChain extends SequenceObjectChain {
  constructor(buffer, chainName, context, targetObject) {
    super(buffer, chainName, context, targetObject);
    this._chainType = 'sequence';
  }

  beginTransaction() {
    const targetValue = this._ensureSequenceTargetResolved();
    const begin = (sequenceTarget) => {
      if (!sequenceTarget || typeof sequenceTarget.begin !== 'function') {
        return { active: false, token: undefined };
      }
      const token = sequenceTarget.begin();
      if (token && typeof token.then === 'function') {
        return token.then((resolvedToken) => ({ active: true, token: resolvedToken }));
      }
      return { active: true, token };
    };

    return thenValue(targetValue, begin);
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
    return thenValue(targetValue, commit);
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
    return thenValue(targetValue, rollback);
  }
}

export {SequenceObjectChain, SequenceChain};
