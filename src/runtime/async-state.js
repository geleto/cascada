'use strict';

class AsyncState {
  constructor(parent = null) {
    this.activeClosures = 0;
    this.waitClosuresCount = 0;
    this.parent = parent;
    this.completionPromise = null;
    this.completionResolver = null;
  }

  _enterAsyncBlock() {
    const newState = new AsyncState(this);
    newState._incrementClosures();

    // Create a new completion promise for this specific closure chain
    /*this.waitAllClosures().then(() => {
      // async frame cleanup hook placeholder.
    });*/

    return newState;
  }

  _leaveAsyncBlock() {
    this.activeClosures--;

    if (this.activeClosures === this.waitClosuresCount) {
      if (this.completionResolver) {
        this.completionResolver();
        // Reset both promise and resolver
        this.completionPromise = null;
        this.completionResolver = null;
      }
    } else if (this.activeClosures < 0) {
      throw new Error('Negative activeClosures count detected');
    }

    if (this.parent) {
      return this.parent._leaveAsyncBlock();
    }

    return this.parent;
  }

  asyncBlock(
    func,
    runtime,
    f,
    asyncMeta,
    parentBuffer,
    createOutputBuffer,
    cb,
    hasConcurrencyLimit = false
  ) {
    const usedOutputs = asyncMeta && Array.isArray(asyncMeta.usedOutputs) ? asyncMeta.usedOutputs : null;
    const childFrame = f.pushAsyncBlock();
    // Runtime async-block creation site for CommandBuffer.
    // This avoids compiler-side duplicate creation for async block execution.
    let newBuffer = null;
    if (createOutputBuffer) {
      const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : null;
      newBuffer = runtime.createCommandBuffer(bufferContext, null, childFrame, hasConcurrencyLimit);
      if (parentBuffer && Array.isArray(usedOutputs)) {
        for (const outputName of usedOutputs) {
          parentBuffer.addBuffer(newBuffer, outputName);
        }
      }
    }

    const childState = this._enterAsyncBlock();

    const activeBuffer = newBuffer || parentBuffer || null;
    const cleanup = () => {
      let waitAppliedPromise = null;
      // Finalize this block's buffer on both success and failure so parent
      // chaining can progress in error paths as well.
      if (newBuffer) {
        newBuffer.markFinishedAndPatchLinks();
        // Limited-loop iterations must not complete until all mutable applies in
        // this iteration buffer segment are drained.
        if (hasConcurrencyLimit) {
          waitAppliedPromise = newBuffer.waitApplied();
        }
      }
      childState._leaveAsyncBlock();
      return waitAppliedPromise;
    };

    const result = func(childState, childFrame, activeBuffer, parentBuffer || null);

    if (!result || typeof result.then !== 'function') {
      const cleanupResult = cleanup();
      if (cleanupResult && typeof cleanupResult.then === 'function') {
        return cleanupResult.then(() => result);
      }
      return result;
    }

    return result
      .catch((err) => {
        if (err instanceof runtime.RuntimeFatalError) {
          cb(err);
        }
        throw err;
      })
      .finally(cleanup);
  }

  _incrementClosures() {
    this.activeClosures++;
    if (this.parent) {
      this.parent._incrementClosures();
    }
  }

  // can use only one closureCount value at a time
  async waitAllClosures(closureCount = 0) {
    this.waitClosuresCount = closureCount;
    if (this.activeClosures === closureCount) {
      return Promise.resolve();
    }

    // Reuse existing promise if it exists
    if (this.completionPromise) {
      return this.completionPromise;
    }

    // Create new promise and store it
    this.completionPromise = new Promise(resolvePromise => {
      this.completionResolver = resolvePromise;
    });

    return this.completionPromise;
  }

  new() {
    return new AsyncState();
  }
}

module.exports = {
  AsyncState
};
