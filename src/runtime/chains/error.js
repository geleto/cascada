
import {PoisonError, createPoison} from '../errors.js';
import {MutatingCommand, contextualizeErrorsForChain} from './command-base.js';

class ErrorCommand extends MutatingCommand {
  constructor(errors) {
    super();
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(ctx) {
    void ctx;
    throw this.getError();
  }
}

// Writes poison directly into a chain target: pushes a PoisonedValue onto a text buffer, or replaces a data/var/sequence target with one.
class TargetPoisonCommand extends MutatingCommand {
  constructor({ chainName, errors = null, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(chain) {
    if (!chain) {
      return;
    }
    const contextualizedErrors = contextualizeErrorsForChain(chain, this.pos, this.errors);
    const chainType = chain._chainType;
    if (chainType === 'text') {
      if (!Array.isArray(chain._target)) {
        chain._setTarget([]);
      }
      chain._target.push(createPoison(contextualizedErrors));
      chain._markStateChanged();
      return;
    }
    chain._applyPoisonErrors(contextualizedErrors);
  }
}

export { ErrorCommand, TargetPoisonCommand };
