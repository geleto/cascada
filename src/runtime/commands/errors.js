import {PoisonError, createPoison, isPoisonError, handleError} from '../errors.js';
import {MutatingCommand} from './base.js';

const contextualizedChainErrorCache = new WeakMap();

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

class TargetPoisonCommand extends MutatingCommand {
  constructor({ chainName, errors = null, errorContext = null }) {
    super();
    this.chainName = chainName;
    this.errorContext = errorContext || null;
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(chain) {
    if (!chain) {
      return;
    }
    const contextualizedErrors = contextualizeErrorsForChain(chain, this.errorContext, this.errors);
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

function contextualizeErrorsForChain(chain, errorContext, errors) {
  void chain;
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const contextualized = [];
  for (const err of errors) {
    if (isPoisonError(err) && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const nested of err.errors) {
        contextualized.push(contextualizeChainError(chain, errorContext, nested));
      }
      continue;
    }
    contextualized.push(contextualizeChainError(chain, errorContext, err));
  }
  return contextualized;
}

function contextualizeChainError(chain, errorContext, err) {
  void chain;
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    const cacheKey = errorContext || 'none';
    const perError = contextualizedChainErrorCache.get(err);
    if (perError && perError.has(cacheKey)) {
      return perError.get(cacheKey);
    }
    const wrapped = handleError(err, errorContext);
    if (wrapped !== err) {
      const nextPerError = perError || new Map();
      nextPerError.set(cacheKey, wrapped);
      contextualizedChainErrorCache.set(err, nextPerError);
    }
    return wrapped;
  }
  return handleError(err, errorContext);
}

export {ErrorCommand, TargetPoisonCommand, contextualizeErrorsForChain, contextualizeChainError};
