
import {isPoison, isPoisonError, PoisonError, createPoison} from '../errors.js';
import {ObservableCommand, MutatingResultCommand, contextualizeErrorsForChain} from './command-base.js';
import {Chain, mergePoisonErrors} from './base.js';

class SequentialPathReadCommand extends ObservableCommand {
  constructor({ chainName, pathKey, operation, repair = false, pos = null }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
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
        const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
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
        const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
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

// Like SequentialPathReadCommand but clears existing path poison before executing (used in `resume` blocks).
class RepairReadCommand extends SequentialPathReadCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

// Executes a `!`-path write/call operation in source order. Poisons the path on failure so subsequent commands on the same path are skipped. Mutating.
class SequentialPathWriteCommand extends MutatingResultCommand {
  constructor({ chainName, pathKey, operation, repair = false, pos = null }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
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
        const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
        chain._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
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
        const contextualized = contextualizeErrorsForChain(chain, this.pos, errs);
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

// Like SequentialPathWriteCommand but clears existing path poison before executing (used in `resume` blocks).
class RepairWriteCommand extends SequentialPathWriteCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

class SequentialPathChain extends Chain {

  constructor(buffer, chainName, context, chainType) {

    super(buffer, chainName, context, chainType, true, null);

    this._sequentialPathPoisonErrors = null;

    this._sequentialPathLastResult = undefined;

  }



  _getSequentialPathPoisonErrors() {

    return this._sequentialPathPoisonErrors ? this._sequentialPathPoisonErrors.slice() : null;

  }



  _applySequentialPathPoisonErrors(errors) {

    if (!Array.isArray(errors) || errors.length === 0) {

      return;

    }

    const merged = mergePoisonErrors(this._sequentialPathPoisonErrors || [], errors);

    this._sequentialPathPoisonErrors = merged;

    this._setTarget(createPoison(merged));

  }



  _clearSequentialPathPoison() {

    this._sequentialPathPoisonErrors = null;

    this._setTarget(true);

  }



  _setSequentialPathLastResult(value) {

    this._sequentialPathLastResult = value;

    if (!this._sequentialPathPoisonErrors || this._sequentialPathPoisonErrors.length === 0) {

      this._setTarget(value);

    }

  }



  _captureGuardState() {

    return {

      target: this._target,

      poisonErrors: this._sequentialPathPoisonErrors ? this._sequentialPathPoisonErrors.slice() : null,

      lastResult: this._sequentialPathLastResult

    };

  }



  _restoreGuardState(state) {

    if (state && typeof state === 'object') {

      this._sequentialPathPoisonErrors = Array.isArray(state.poisonErrors)

        ? state.poisonErrors.slice()

        : null;

      this._sequentialPathLastResult = state.lastResult;

      if (Object.prototype.hasOwnProperty.call(state, 'target')) {

        this._setTarget(state.target);

        return;

      }

    }

    this._sequentialPathPoisonErrors = null;

    this._sequentialPathLastResult = state;

    this._setTarget(state);

  }



  _applyPoisonErrors(errors) {

    this._applySequentialPathPoisonErrors(errors);

  }



  _getCurrentResult() {

    return this._sequentialPathLastResult;

  }

}

export { SequentialPathChain, SequentialPathReadCommand, RepairReadCommand, SequentialPathWriteCommand, RepairWriteCommand };
