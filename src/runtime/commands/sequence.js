import {ChainMutatingResultCommand, ChainObservableCommand} from './base.js';
import {PoisonError, poisonIfNaN} from '../errors.js';
import {classifyCallTarget} from '../call.js';
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
          const error = PoisonError.create(`Cannot read property ${formatSequencePath(this.path)} of ${target}`, this.errorContext, 'NullLookup');
          this.rejectResult(error);
          throw error;
        }
        const method = this.methodName ? target[this.methodName] : target;
        const methodError = classifyCallTarget(method, this.methodName, this.errorContext);
        if (methodError) {
          this.rejectResult(methodError);
          throw methodError;
        }
        try {
          const result = method.apply(target, args);
          return this.settleResult(result, {
            mapValue: value => poisonIfNaN(value, this.errorContext),
            mapError: err => PoisonError.wrap(err, this.errorContext, 'UserCallThrew'),
            rethrow: true
          });
        } catch (err) {
          const error = PoisonError.wrap(err, this.errorContext, 'UserCallThrew');
          this.rejectResult(error);
          throw error;
        }
      };

      const sequenceTarget = chain._ensureSequenceTargetResolved ? chain._ensureSequenceTargetResolved() : chain._sequenceTarget;
      if (sequenceTarget && typeof sequenceTarget.then === 'function') {
        return this.settleResult(sequenceTarget.then(execute), { rethrow: true });
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
      return this.settleResult(sequenceTarget.then(execute), { rethrow: true });
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

function formatSequencePath(path) {
  if (!Array.isArray(path) || path.length === 0) {
    return 'undefined';
  }
  return path[path.length - 1];
}

export {SequenceCallCommand, SequenceGetCommand};
