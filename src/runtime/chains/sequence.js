
import {ChainMutatingResultCommand, ChainObservableCommand, runWithResolvedArguments} from './command-base.js';
import {PoisonError, isPoison} from '../errors.js';
import {Chain} from './base.js';

class SequenceCallCommand extends ChainMutatingResultCommand {
  constructor({ chainName, methodName, args = null, path = null, pos = null }) {
    super({
      chainName,
      args: args || [],
      pos
    });
    this.methodName = methodName || null;
    this.path = path || null;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, chain, (resolvedArgs) => {
      if (!chain) return undefined;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        const err = new PoisonError(poisonErrors);
        this.rejectResult(err);
        throw err;
      }

      const execute = (sequenceTarget) => {
        const target = resolvePath(sequenceTarget, this.path);
        if (target === null || target === undefined) {
          return this.settleResult(undefined);
        }
        const method = this.methodName ? target[this.methodName] : target;
        if (typeof method !== 'function') {
          return this.settleResult(undefined);
        }
        const result = method.apply(target, args);
        return this.settleResult(result, { rethrow: true });
      };

      const sequenceTarget = chain._ensureSequenceTargetResolved ? chain._ensureSequenceTargetResolved() : chain._sequenceTarget;
      if (sequenceTarget && typeof sequenceTarget.then === 'function') {
        return this.settleResult(Promise.resolve(sequenceTarget).then(execute), { rethrow: true });
      }
      return execute(sequenceTarget);
    });
  }
}

// Reads a property from a sequence target in source order and resolves its result promise with the value. Observable — applied immediately without waiting for pending mutating commands.
class SequenceGetCommand extends ChainObservableCommand {
  constructor({ chainName, path = null, pos = null }) {
    super({
      chainName,
      args: [],
      pos
    });
    this.path = path || null;
  }

  apply(chain) {
    if (!chain) return undefined;

    const execute = (sequenceTarget) => {
      const value = resolvePath(sequenceTarget, this.path);
      return this.settleResult(value);
    };

    const sequenceTarget = chain._ensureSequenceTargetResolved ? chain._ensureSequenceTargetResolved() : chain._sequenceTarget;
    if (sequenceTarget && typeof sequenceTarget.then === 'function') {
      return this.settleResult(Promise.resolve(sequenceTarget).then(execute), { rethrow: true });
    }
    return execute(sequenceTarget);
  }
}

function resolvePath(target, path) {
  if (!Array.isArray(path) || path.length === 0) {
    return target;
  }
  let current = target;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

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

export { SequenceObjectChain, SequenceChain, SequenceCallCommand, SequenceGetCommand };
