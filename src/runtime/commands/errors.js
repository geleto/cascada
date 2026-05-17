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

function contextualizeErrorsForChain(chain, pos, errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const lineno = pos && typeof pos.lineno === 'number' ? pos.lineno : 0;
  const colno = pos && typeof pos.colno === 'number' ? pos.colno : 0;
  const path = chain && chain._context && chain._context.path ? chain._context.path : null;
  const contextualized = [];
  for (const err of errors) {
    if (isPoisonError(err) && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const nested of err.errors) {
        contextualized.push(handleError(nested, lineno, colno, null, path));
      }
      continue;
    }
    contextualized.push(handleError(err, lineno, colno, null, path));
  }
  return contextualized;
}

function contextualizeChainError(chain, pos, err) {
  const lineno = pos && typeof pos.lineno === 'number' ? pos.lineno : 0;
  const colno = pos && typeof pos.colno === 'number' ? pos.colno : 0;
  const path = chain && chain._context && chain._context.path ? chain._context.path : null;
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    const cacheKey = `${lineno}:${colno}:${path || ''}`;
    const perError = contextualizedChainErrorCache.get(err);
    if (perError && perError.has(cacheKey)) {
      return perError.get(cacheKey);
    }
    const wrapped = handleError(err, lineno, colno, null, path);
    if (wrapped !== err) {
      const nextPerError = perError || new Map();
      nextPerError.set(cacheKey, wrapped);
      contextualizedChainErrorCache.set(err, nextPerError);
    }
    return wrapped;
  }
  return handleError(err, lineno, colno, null, path);
}

export {ErrorCommand, TargetPoisonCommand, contextualizeErrorsForChain, contextualizeChainError};
