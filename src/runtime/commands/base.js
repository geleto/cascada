import {isPoison, PoisonError, createPoison} from '../errors.js';
import {markDeferredThenablesHandled} from './arguments.js';

class Command {
  constructor() {
    this.resolved = false;
    this.promise = null;
    this.resolve = null;
    this.reject = null;
    this.isObservable = false;
  }

  _createResultPromise() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    markDeferredThenablesHandled(this.promise);
  }

  resolveResult(value) {
    if (!this.resolve) {
      return;
    }
    this.resolve(value);
    this.resolve = null;
    this.reject = null;
  }

  rejectResult(err) {
    if (!this.reject) {
      return;
    }
    this.reject(err);
    this.resolve = null;
    this.reject = null;
  }

  settleResult(result, { mapValue = null, mapError = null, rethrow = false } = {}) {
    const resolve = (value) => {
      const resolvedValue = mapValue ? mapValue(value) : value;
      this.resolveResult(resolvedValue);
      return resolvedValue;
    };
    const reject = (err) => {
      const rejectedValue = mapError ? mapError(err) : err;
      this.rejectResult(rejectedValue);
      if (rethrow) {
        throw rejectedValue;
      }
      return undefined;
    };
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(resolve, reject);
    }
    return resolve(result);
  }

  settleResultFrom(fn) {
    try {
      return this.settleResult(fn());
    } catch (err) {
      this.rejectResult(err);
      throw err;
    }
  }

  getError() {
    return null;
  }

  apply(ctx) {
    void ctx;
    throw new Error('Command.apply() must be overridden');
  }
}

class MutatingCommand extends Command {
}

class MutatingResultCommand extends MutatingCommand {
  constructor() {
    super();
    this._createResultPromise();
  }
}

class ObservableCommand extends Command {
  constructor() {
    super();
    this._createResultPromise();
    this.isObservable = true;
  }
}

class ChainCommand extends MutatingCommand {
  constructor({ chainName, args = null, pos = null }) {
    super();
    this.chainName = chainName;
    this.arguments = args || [];
    if (this.arguments.length > 0) {
      markDeferredThenablesHandled(this.arguments);
    }
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  extractPoisonFromArgs(args = this.arguments) {
    if (isPoison(args) && Array.isArray(args.errors) && args.errors.length > 0) {
      return args.errors.slice();
    }
    if (!Array.isArray(args)) return [];
    const errors = [];
    for (const arg of args) {
      if (isPoison(arg) && Array.isArray(arg.errors) && arg.errors.length > 0) {
        errors.push(...arg.errors);
      }
    }
    return errors;
  }

  toPoisonValue(errors) {
    return createPoison(errors);
  }

  getError() {
    const errors = this.extractPoisonFromArgs();
    return errors.length > 0 ? new PoisonError(errors) : null;
  }

  apply(ctx) {
    void ctx;
  }
}

class ChainMutatingResultCommand extends ChainCommand {
  constructor(spec) {
    super(spec);
    this._createResultPromise();
  }
}

class ChainObservableCommand extends ObservableCommand {
  constructor(spec) {
    super();
    this.chainName = spec.chainName;
    this.arguments = spec.args || [];
    if (this.arguments.length > 0) {
      markDeferredThenablesHandled(this.arguments);
    }
    this.pos = spec.pos || { lineno: 0, colno: 0 };
  }
}

export {
  Command,
  MutatingCommand,
  MutatingResultCommand,
  ObservableCommand,
  ChainCommand,
  ChainMutatingResultCommand,
  ChainObservableCommand
};
