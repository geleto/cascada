import {markPromiseHandled} from './errors.js';

class RenderState {
  constructor(onError = null) {
    this.error = null;
    this.onError = onError;
    this.reportError = this.reportFatalError.bind(this);
    this.fatalPromise = new Promise((_resolve, reject) => {
      this._rejectFatal = reject;
    });
    markPromiseHandled(this.fatalPromise);
  }

  reportFatalError(error) {
    if (!error) {
      throw new TypeError('reportFatalError requires an error');
    }
    if (this.error) {
      return this.error;
    }
    this.error = error;
    if (this.onError) {
      this.onError(error);
    }
    this._rejectFatal(error);
    return error;
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
      this.reportFatalError(error);
      throw error;
    });
  }
}

function createRenderState(onError = null) {
  return new RenderState(onError);
}

export {RenderState, createRenderState};
