import {PoisonError, createPoison} from '../errors.js';
import {MutatingCommand, requireCommandErrorContext} from './base.js';

class ErrorCommand extends MutatingCommand {
  constructor(error, errorContext) {
    super();
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.error = PoisonError.group(error);
  }

  getError() {
    return this.error;
  }

  apply(ctx) {
    void ctx;
    throw this.getError();
  }
}

class TargetPoisonCommand extends MutatingCommand {
  constructor({ chainName, error, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.error = PoisonError.group(error);
  }

  getError() {
    return this.error;
  }

  apply(chain) {
    if (!chain) {
      return;
    }
    const chainType = chain._chainType;
    if (chainType === 'text') {
      if (!Array.isArray(chain._target)) {
        chain._setTarget([]);
      }
      chain._target.push(createPoison(this.error));
      chain._markStateChanged();
      return;
    }
    chain._applyPoisonError(this.error);
  }
}

export {ErrorCommand, TargetPoisonCommand};
