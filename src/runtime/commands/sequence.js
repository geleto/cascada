import {ChainMutatingResultCommand, ChainObservableCommand} from './base.js';
import {poisonIfNaN} from '../errors.js';
import {runWithResolvedArguments} from './arguments.js';

class SequenceCallCommand extends ChainMutatingResultCommand {
  constructor({ chainName, methodName, args = null, path = null, errorContext }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
    this.methodName = methodName || null;
    this.path = path || null;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, (resolvedArgs) => {
      if (!chain) return undefined;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonError = this.getPoisonFromArgs(args);
      if (poisonError) {
        this.rejectResult(poisonError);
        throw poisonError;
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
        return this.settleResult(result, {
          mapValue: value => poisonIfNaN(value, this.errorContext),
          rethrow: true
        });
      };

      const sequenceTarget = chain._ensureSequenceTargetResolved ? chain._ensureSequenceTargetResolved() : chain._sequenceTarget;
      if (sequenceTarget && typeof sequenceTarget.then === 'function') {
        return this.settleResult(Promise.resolve(sequenceTarget).then(execute), { rethrow: true });
      }
      return execute(sequenceTarget);
    });
  }
}

class SequenceGetCommand extends ChainObservableCommand {
  constructor({ chainName, path = null, errorContext }) {
    super({
      chainName,
      args: [],
      errorContext
    });
    this.path = path || null;
  }

  apply(chain) {
    if (!chain) return undefined;

    const execute = (sequenceTarget) => {
      const value = resolvePath(sequenceTarget, this.path);
      return this.settleResult(value, {
        mapValue: resolvedValue => poisonIfNaN(resolvedValue, this.errorContext)
      });
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

export {SequenceCallCommand, SequenceGetCommand};
