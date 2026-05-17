
import {createPoison, isPoison, isPoisonError} from '../errors.js';
import {ChainCommand, runWithResolvedArguments, contextualizeChainError} from './command-base.js';
import {DataChainTarget} from './data-target.js';
import {Chain, cloneSnapshotValue, mergePoisonErrors} from './base.js';

class DataCommand extends ChainCommand {
  constructor({ chainName, operation, args = null, pos = null, initializeIfNotSet = false }) {
    super({
      chainName,
      args: args || [],
      pos
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
            contextualizeChainError(chain, this.pos, new Error(`has no method '${this.operation}'`))
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
            contextualizeChainError(chain, this.pos, err)
          ])
        );
      }
    });
  }
}

class DataChain extends Chain {

  constructor(buffer, chainName, context, chainType) {

    const env = context && context.env ? context.env : null;

    const base = new DataChainTarget(context && context.getVariables ? context.getVariables() : {}, env);

    super(

      buffer,

      chainName,

      context,

      chainType,

      base.data,

      base

    );

    this._snapshotShared = false;

    this._installCommandMethods();

  }



  _getCurrentResult() {

    return this._target;

  }



  _installCommandMethods() {

    const methods = this._base && this._base.methods ? this._base.methods : null;

    if (!methods) {

      return;

    }

    Object.keys(methods).forEach((methodName) => {

      if (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError') {

        return;

      }

      if (Object.prototype.hasOwnProperty.call(this, methodName) || typeof this[methodName] !== 'undefined') {

        return;

      }

      Object.defineProperty(this, methodName, {

        configurable: true,

        enumerable: false,

        writable: true,

        value: (...args) => {

          if (!this._buffer) return;

          this._buffer.addCommand(new DataCommand({

            chainName: this._chainName,
            operation: methodName,

            args,

            pos: { lineno: 0, colno: 0 }

          }), this._chainName);

        }

      });

    });

  }



  _resolveSnapshotCommandResult() {

    const value = super._resolveSnapshotCommandResult();

    if (value && typeof value === 'object') {

      this._snapshotShared = true;

    }

    return value;

  }



  _beforeApplyCommand(cmd) {

    if (!cmd || cmd.isObservable || !this._snapshotShared || !this._base) {

      return;

    }

    const cloned = cloneSnapshotValue(this._target);

    this._setTarget(cloned);

    this._base.data = cloned;

    this._snapshotShared = false;

  }



  _captureGuardState() {

    return {

      target: cloneSnapshotValue(this._target)

    };

  }



  _restoreGuardState(state) {

    const nextTarget = state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'target')

      ? state.target

      : state;

    this._setTarget(nextTarget);

    if (this._base) {

      this._base.data = nextTarget;

    }

    this._snapshotShared = false;

  }



  _applyPoisonErrors(errors, cmd = null) {

    if (!Array.isArray(errors) || errors.length === 0) {

      return;

    }

    const mergedRootErrors = mergePoisonErrors(extractPoisonErrors(this._getTarget()), errors);

    const poison = createPoison(mergedRootErrors);

    const rawPath = cmd && Array.isArray(cmd.arguments) && cmd.arguments.length > 0 ? cmd.arguments[0] : null;

    const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;

    if (this._base) {

      try {

        this._base.set(path, poison);

        this._setTarget(this._base.data);

        return;

      } catch (err) {

        void err;

      }

    }

    this._setTarget(poison);

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

export { DataChain, DataCommand };
