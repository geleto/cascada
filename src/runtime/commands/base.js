import {
  isPoison,
  PoisonError,
  RuntimeError,
  createPoison,
  isPoisonError,
  markPromiseHandled,
  markValuePromiseHandled,
  poisonOrReportedFatal
} from '../errors.js';

class Command {
  constructor() {
    // Commands that can report/apply runtime errors must set this.errorContext
    // with requireCommandErrorContext(...) in their own constructor.
    this.resolved = false;
    this.promise = null;
    this.resolve = null;
    this.reject = null;
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

  _runPhase(chain, handleError) {
    const apply = () => this.apply(chain);
    try {
      this.resolved = true;
      const ready = chain && typeof chain._beforeApplyCommand === 'function'
        ? chain._beforeApplyCommand(this)
        : undefined;
      const result = ready && typeof ready.then === 'function'
        ? ready.then(apply)
        : apply();
      if (result && typeof result.then === 'function') {
        return result.then(undefined, handleError);
      }
      return result;
    } catch (err) {
      return handleError(err);
    }
  }
}

class MutatingCommand extends Command {
  mutate(chain) {
    const handleError = (err) => {
      // Mutations change chain state, so their failures are fatal to the lane.
      // Result-bearing mutations still reject their public result promise.
      const normalizedError = isPoisonError(err)
        ? err
        : RuntimeError.create(err, this.errorContext);
      this.rejectResult(normalizedError);
      if (chain && typeof chain._recordError === 'function') {
        chain._recordError(normalizedError, this);
        return undefined;
      }
      throw normalizedError;
    };
    return this._runPhase(chain, handleError);
  }
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
  }

  observe(chain) {
    const handleError = (err) => {
      // Observations produce values and do not mutate chain state. Poison
      // failures reject the result; raw failures are reported as fatal.
      this.rejectResult(poisonOrReportedFatal(err, this.errorContext));
      return undefined;
    };
    return this._runPhase(chain, handleError);
  }
}

class UniversalObservationCommand extends ObservableCommand {
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

function isObservableCommand(command) {
  // Stage 0+ command capability is method-shaped. Universal observations
  // remain class-shaped because they have extra cross-chain semantics.
  return !!(command && command.observe);
}

function isUniversalObservationCommand(command) {
  return command instanceof UniversalObservationCommand;
}

export {
  Command,
  MutatingCommand,
  MutatingResultCommand,
  ObservableCommand,
  UniversalObservationCommand,
  ChainCommand,
  ChainMutatingResultCommand,
  ChainObservableCommand,
  isObservableCommand,
  isUniversalObservationCommand,
  requireCommandErrorContext
};
