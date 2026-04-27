'use strict';

import {isPoison, isPoisonError, PoisonError, createPoison} from '../errors';
import {Command, contextualizeErrorsForOutput} from './command-base';
import {Channel, mergePoisonErrors} from './base';

class SequentialPathReadCommand extends Command {
  constructor({ channelName, pathKey, operation, repair = false, pos = null, withDeferredResult = true }) {
    super({ withDeferredResult });
    this.channelName = channelName;
    this.pathKey = pathKey || this.channelName;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
  }

  apply(output) {

    const existingPoison = output._getSequentialPathPoisonErrors();
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
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          output._clearSequentialPathPoison();
        }
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
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
class SequentialPathWriteCommand extends Command {
  constructor({ channelName, pathKey, operation, repair = false, pos = null, withDeferredResult = true }) {
    super({ withDeferredResult });
    this.channelName = channelName;
    this.pathKey = pathKey || this.channelName;
    this.operation = operation;
    this.repair = !!repair;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(output) {

    const existingPoison = output._getSequentialPathPoisonErrors();
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
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        output._applySequentialPathPoisonErrors(contextualized);
        this.rejectResult(new PoisonError(contextualized));
        return;
      }

      const resolveResultValue = (value) => {
        if (isPoison(value)) {
          const errs = Array.isArray(value.errors) ? value.errors : [value];
          const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
          output._applySequentialPathPoisonErrors(contextualized);
          this.rejectResult(new PoisonError(contextualized));
          return;
        }
        if (this.repair) {
          output._clearSequentialPathPoison();
        }
        output._setSequentialPathLastResult(value);
        this.resolveResult(value);
      };

      const rejectResultError = (err) => {
        const errs = isPoisonError(err) ? err.errors : [err];
        const contextualized = contextualizeErrorsForOutput(output, this.pos, errs);
        output._applySequentialPathPoisonErrors(contextualized);
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

class SequentialPathChannel extends Channel {

  constructor(buffer, channelName, context, channelType) {

    super(buffer, channelName, context, channelType, true, null);

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

const __defaultExport = {
  SequentialPathChannel,
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand
};
export { SequentialPathChannel, SequentialPathReadCommand, RepairReadCommand, SequentialPathWriteCommand, RepairWriteCommand };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
