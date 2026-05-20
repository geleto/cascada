import {isPoison, isPoisonError, PoisonError} from '../errors.js';
import {ObservableCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';
import {contextualizeErrorsForChain} from './errors.js';

class SequentialPathReadCommand extends ObservableCommand {
  constructor({ chainName, pathKey, operation, repair = false, errorContext }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const existingPoison = chain._getSequentialPathPoisonErrors();
    if (!this.repair && Array.isArray(existingPoison) && existingPoison.length > 0) {
      this.rejectResult(new PoisonError(existingPoison.slice()));
      return;
    }

    const run = () => {
      let result;
      try {
        result = this.operation();
      } catch (err) {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          chain._clearSequentialPathPoison();
        }
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
        this.rejectResult(new PoisonError(contextualized));
      };

      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(resolveResultValue, rejectResultError);
      }

      resolveResultValue(result);
      return result;
    };

    return run();
  }
}

class RepairReadCommand extends SequentialPathReadCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

class SequentialPathWriteCommand extends MutatingResultCommand {
  constructor({ chainName, pathKey, operation, repair = false, errorContext }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const existingPoison = chain._getSequentialPathPoisonErrors();
    if (!this.repair && Array.isArray(existingPoison) && existingPoison.length > 0) {
      this.rejectResult(new PoisonError(existingPoison.slice()));
      return;
    }

    const run = () => {
      let result;
      try {
        result = this.operation();
      } catch (err) {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
        chain._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
          chain._applySequentialPathPoisonErrors(contextualized);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          chain._clearSequentialPathPoison();
        }
        chain._setSequentialPathLastResult(value);
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForChain(chain, this.errorContext, errs);
        chain._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
      };

      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(resolveResultValue, rejectResultError);
      }

      resolveResultValue(result);
      return result;
    };

    return run();
  }
}

class RepairWriteCommand extends SequentialPathWriteCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

export {SequentialPathReadCommand, RepairReadCommand, SequentialPathWriteCommand, RepairWriteCommand};
