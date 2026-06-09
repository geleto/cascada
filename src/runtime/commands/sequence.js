import {ChainMutatingResultCommand, ChainObservableCommand} from './base.js';
import {isPoisonError, PoisonError, poisonIfNaN} from '../errors.js';
import {classifyCallTarget} from '../call.js';
import {runCommandWithResolvedArguments} from './arguments.js';

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
    return runCommandWithResolvedArguments(this.arguments, this, (resolvedArgs) => {
      if (!chain) return undefined;
      throwIfSequenceChainPoisoned(this, chain);
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonError = this.getPoisonFromArgs(args);
      if (poisonError) {
        this.rejectResult(poisonError);
        throw poisonError;
      }

      const execute = (sequencedObject) => {
        const target = resolvePath(sequencedObject, this.path);
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
          return this.settleResult(
            result,
            value => poisonIfNaN(value, this.errorContext),
            err => (isPoisonError(err) ? err : PoisonError.wrap(err, this.errorContext, 'UserCallThrew')),
            true
          );
        } catch (err) {
          const error = isPoisonError(err) ? err : PoisonError.wrap(err, this.errorContext, 'UserCallThrew');
          this.rejectResult(error);
          throw error;
        }
      };

      return runWithSequencedObject(this, chain, execute);
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
    throwIfSequenceChainPoisoned(this, chain);

    const execute = (sequencedObject) => {
      const value = resolvePath(sequencedObject, this.path);
      return this.settleResult(value, resolvedValue => poisonIfNaN(resolvedValue, this.errorContext));
    };

    return runWithSequencedObject(this, chain, execute);
  }
}

function runWithSequencedObject(command, chain, execute) {
  const sequencedObject = chain._ensureSequencedObjectResolved();
  if (sequencedObject && typeof sequencedObject.then === 'function') {
    return command.settleResult(sequencedObject.then(execute), null, null, true);
  }
  return execute(sequencedObject);
}

function throwIfSequenceChainPoisoned(command, chain) {
  const error = chain._getSequencePoisonError ? chain._getSequencePoisonError() : null;
  if (!error) {
    return;
  }
  command.rejectResult(error);
  throw error;
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
