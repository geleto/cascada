import {
  isPoison,
  isPoisonError,
  createPoison,
  PoisonError,
  RuntimeError,
  markPromiseHandled,
  poisonIfNaN
} from '../errors.js';
import {classifyCallTarget} from '../call.js';
import {isAsyncDataMethodResult} from '../chains/data-target.js';
import {ChainCommand} from './base.js';
import {runCommandWithResolvedArguments} from './arguments.js';

// Current data-chain contract:
// - data command arguments are resolved before the data method runs;
// - data methods are sync-only, so DataChain._target is fully settled after
//   apply() readiness completes;
// - stored errors are PoisonedValue leaves, not raw PoisonError objects.
//
// Future async data-chain work should allow promises at unresolved branches and
// branch-level copy-on-write marks so later data writes do not mutate immutable
// snapshots or partially materialized subtrees.

class DataCommand extends ChainCommand {
  constructor({ chainName, operation, args = null, errorContext, initializeIfNotSet = false }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
    this.operation = operation || null;
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(chain) {
    super.apply(chain);
    return runCommandWithResolvedArguments(this.arguments, this, (resolvedArgs) => {
      if (!chain || !chain._base) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const rawPath = args.length > 0 ? args[0] : null;
      const dataPath = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
      const poisonError = this.getPoisonFromArgs(args);
      if (this.operation !== 'set') {
        const existing = readDataValueAtPath(chain._base.data, dataPath);
        if (isPoison(existing)) {
          if (poisonError) {
            setDataPoisonAtPath(chain, args, poisonError);
          }
          return;
        }
      }
      if (poisonError) {
        setDataPoisonAtPath(chain, args, poisonError);
        return;
      }
      const method = this.operation ? chain._base[this.operation] : chain._base;
      const methodError = classifyCallTarget(method, this.operation, this.errorContext);
      if (methodError) {
        setDataPoisonAtPath(
          chain,
          args,
          methodError
        );
        return;
      }
      try {
        if (
          this.initializeIfNotSet &&
          this.operation === 'set' &&
          chain._getTarget() &&
          typeof chain._getTarget() === 'object' &&
          Object.keys(chain._getTarget()).length > 0
        ) {
          return;
        }
        const result = method.apply(chain._base, args);
        if (isAsyncDataMethodResult(result)) {
          markPromiseHandled(result);
          throw new AsyncDataMethodResultError();
        }
        finalizeDataMethodResult(chain, args, result, this.errorContext);
      } catch (err) {
        if (err instanceof AsyncDataMethodResultError) {
          RuntimeError.reportAndThrow(err, this.errorContext);
        }
        poisonDataMethodFailure(chain, args, err, this.errorContext);
      }
    });
  }
}

class AsyncDataMethodResultError extends Error {
  constructor() {
    super('Data chain methods must return synchronously resolved values.');
    this.name = 'AsyncDataMethodResultError';
  }
}

function finalizeDataMethodResult(chain, args, result, errorContext) {
  const poisonedResult = poisonIfNaN(result, errorContext);
  if (isPoison(poisonedResult)) {
    setDataPoisonAtPath(chain, args, PoisonError.group(poisonedResult.errors));
    return;
  }
  chain._setTarget(chain._base.data);
}

function poisonDataMethodFailure(chain, args, err, errorContext) {
  const methodPoisonError = isPoisonError(err) ? err : PoisonError.wrap(err, errorContext, 'UserCallThrew');
  try {
    setDataPoisonAtPath(
      chain,
      args,
      methodPoisonError
    );
  } catch {
    throw methodPoisonError;
  }
}

function setDataPoisonAtPath(chain, args, poisonError) {
  if (!chain || !chain._base) {
    return;
  }
  const rawPath = Array.isArray(args) && args.length > 0 ? args[0] : null;
  const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
  const existingValue = readDataValueAtPath(chain._base.data, path);
  const existingPoison = getPoisonError(existingValue);
  chain._base.set(path, createPoison(
    existingPoison ? PoisonError.group([existingPoison, poisonError]) : poisonError
  ));
  chain._setTarget(chain._base.data);
}

function readDataValueAtPath(root, path) {
  if (!Array.isArray(path) || path.length === 0 || (path.length === 1 && path[0] === null)) {
    return root;
  }
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (segment === '[]') {
      if (!Array.isArray(current) || current.length === 0) {
        return undefined;
      }
      current = current[current.length - 1];
      continue;
    }
    current = current[segment];
  }
  return current;
}

function getPoisonError(value) {
  if (isPoison(value)) {
    return PoisonError.group(value.errors);
  }
  return null;
}

export {DataCommand};
