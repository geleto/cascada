import {isPoisonError, isRuntimeError, markPromiseHandled, RuntimeError} from './errors.js';

class RenderState {
  constructor(onError = null) {
    this.error = null;
    this.onError = onError;
    this.fatalPromise = new Promise((_resolve, reject) => {
      this._rejectFatal = reject;
    });
    markPromiseHandled(this.fatalPromise);
  }

  reportFatalError(error, errorContext) {
    if (!error) {
      throw new TypeError('reportFatalError requires an error');
    }
    if (errorContext !== undefined || typeof error === 'string') {
      error = RuntimeError.create(error, errorContext);
    } else if (!(error instanceof Error)) {
      error = new Error(String(error));
    }
    if (this.error) {
      return;
    }
    this.error = error;
    if (this.onError) {
      this.onError(error);
    }
    this._rejectFatal(error);
  }

  reportAndThrowFatalError(error, errorContext) {
    if (errorContext !== undefined || typeof error === 'string') {
      error = RuntimeError.create(error, errorContext);
    } else if (!(error instanceof Error)) {
      error = new Error(String(error));
    }
    this.reportFatalError(error);
    throw error;
  }

  isFatalErrorReported() {
    return !!this.error;
  }

  throwIfFatalErrorReported() {
    if (this.error) {
      throw this.error;
    }
  }

  raceRootResult(result) {
    if (!result || typeof result.then !== 'function') {
      if (this.error) {
        return Promise.reject(this.error);
      }
      return result;
    }
    const raced = Promise.race([result, this.fatalPromise]);
    return raced.catch((error) => {
      if (!isPoisonError(error) && !isRuntimeError(error)) {
        this.reportFatalError(error);
      }
      throw error;
    });
  }
}

function createRenderState(onError = null) {
  return new RenderState(onError);
}

export {RenderState, createRenderState};
