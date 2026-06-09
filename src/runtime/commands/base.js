import {isPoison, PoisonError, createPoison, markPromiseHandled, markValuePromiseHandled} from '../errors.js';

class Command {
  constructor() {
    // Commands that can report/apply runtime errors must set this.errorContext
    // with requireCommandErrorContext(...) in their own constructor.
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
    markPromiseHandled(this.promise);
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

  settleResult(result, mapValue = null, mapError = null, rethrow = false) {
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
      return markPromiseHandled(result.then(resolve, reject));
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
  constructor({ chainName, args = null, errorContext }) {
    super();
    this.chainName = chainName;
    this.arguments = args || [];
    if (this.arguments.length > 0) {
      markValuePromiseHandled(this.arguments);
    }
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  getPoisonFromArgs(args = this.arguments) {
    if (isPoison(args)) {
      return PoisonError.group(args.errors);
    }
    if (!Array.isArray(args)) return null;
    const errors = [];
    for (const arg of args) {
      if (isPoison(arg)) {
        errors.push(...arg.errors);
      }
    }
    return errors.length > 0 ? PoisonError.group(errors) : null;
  }

  toPoisonValue(poisonError) {
    return createPoison(poisonError);
  }

  getError() {
    return this.getPoisonFromArgs();
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
      markValuePromiseHandled(this.arguments);
    }
    this.errorContext = requireCommandErrorContext(spec.errorContext, this.constructor.name);
  }
}

function requireCommandErrorContext(errorContext, commandName) {
  if (Array.isArray(errorContext)) {
    return errorContext;
  }
  const received = errorContext === null ? 'null' : typeof errorContext;
  throw new TypeError(`${commandName} requires a compact errorContext (got ${received})`);
}

export {
  Command,
  MutatingCommand,
  MutatingResultCommand,
  ObservableCommand,
  ChainCommand,
  ChainMutatingResultCommand,
  ChainObservableCommand,
  requireCommandErrorContext
};
