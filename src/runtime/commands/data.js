import {isPoison, isPoisonError, createPoison} from '../errors.js';
import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';
import {contextualizeChainError} from './errors.js';

class DataCommand extends ChainCommand {
  constructor({ chainName, operation, args = null, errorContext = null, initializeIfNotSet = false }) {
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
    return runWithResolvedArguments(this.arguments, this, chain, (resolvedArgs) => {
      if (!chain || !chain._base) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const rawPath = args.length > 0 ? args[0] : null;
      const dataPath = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (this.operation !== 'set') {
        const existing = readDataValueAtPath(chain._base.data, dataPath);
        if (isPoison(existing) || isPoisonError(existing)) {
          if (poisonErrors.length > 0) {
            setDataPoisonAtPath(chain, args, this.toPoisonValue(poisonErrors));
          }
          return;
        }
      }
      if (poisonErrors.length > 0) {
        setDataPoisonAtPath(chain, args, this.toPoisonValue(poisonErrors));
        return;
      }
      const method = this.operation ? chain._base[this.operation] : chain._base;
      if (typeof method !== 'function') {
        setDataPoisonAtPath(
          chain,
          args,
          this.toPoisonValue([
            contextualizeChainError(chain, this.errorContext, new Error(`has no method '${this.operation}'`))
          ])
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
        method.apply(chain._base, args);
        chain._setTarget(chain._base.data);
      } catch (err) {
        setDataPoisonAtPath(
          chain,
          args,
          this.toPoisonValue([
            contextualizeChainError(chain, this.errorContext, err)
          ])
        );
      }
    });
  }
}

function setDataPoisonAtPath(chain, args, poisonValue) {
  if (!chain || !chain._base) {
    return;
  }
  const rawPath = Array.isArray(args) && args.length > 0 ? args[0] : null;
  const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
  const existingValue = readDataValueAtPath(chain._base.data, path);
  const existingErrors = extractPoisonErrors(existingValue);
  const newErrors = extractPoisonErrors(poisonValue);
  const mergedPoison = (existingErrors.length > 0 || newErrors.length > 0)
    ? createPoison([...existingErrors, ...newErrors])
    : poisonValue;
  chain._base.set(path, mergedPoison);
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

function extractPoisonErrors(value) {
  if (isPoison(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  if (isPoisonError(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  return [];
}

export {DataCommand};
