'use strict';

const { createCheckInfo } = require('./checks');

class AsyncState {
  constructor(parent = null) {
    this.activeClosures = 0;
    this.waitClosuresCount = 0;
    this.parent = parent;
    this.completionPromise = null;
    this.completionResolver = null;
    this.asyncBlockFrame = null;//@todo - remove
  }

  _enterAsyncBlock(asyncBlockFrame) {
    const newState = new AsyncState(this);
    newState.asyncBlockFrame = asyncBlockFrame || null;
    newState._incrementClosures();

    // Create a new completion promise for this specific closure chain
    /*this.waitAllClosures().then(() => {
      asyncBlockFrame.dispose();// - todo - why does it succeed and then fail?
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

    if (this.activeClosures === 0 && this.checkInfo && this.asyncBlockFrame) {
      const { checkPendingWrites } = require('./checks');
      checkPendingWrites(this.asyncBlockFrame, this.checkInfo);
    }

    if (this.parent) {
      return this.parent._leaveAsyncBlock();
    }

    return this.parent;
  }

  asyncBlock(func, runtime, f, readVars, writeCounts, usedOutputs, parentBuffer, createOutputBuffer, cb, lineno, colno, context, errorContextString = null, isExpression = false, sequentialAsyncBlock = false, hasConcurrencyLimit = false) {
    const childFrame = f.pushAsyncBlock(readVars, writeCounts, sequentialAsyncBlock, usedOutputs);
    // Runtime async-block creation site for CommandBuffer.
    // This avoids compiler-side duplicate creation for async block execution.
    let newBuffer = null;
    if (createOutputBuffer) {
      newBuffer = runtime.createCommandBuffer(context, null, childFrame, hasConcurrencyLimit);
      if (parentBuffer && Array.isArray(usedOutputs)) {
        for (const outputName of usedOutputs) {
          parentBuffer.addBuffer(newBuffer, outputName);
        }
      }
    }

    const checkInfo = createCheckInfo(cb, runtime, lineno, colno, errorContextString, context);
    const childState = this._enterAsyncBlock(childFrame);
    childState.checkInfo = checkInfo;
    if (checkInfo) {
      childFrame.checkInfo = checkInfo;
    }

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
      // Ensure per-block finalization always runs (decrementing counters, releasing locks, etc.)
      if (sequentialAsyncBlock) {
        // This is the best place to do it rather than when the counter reaches 0
        // because by this time some promises may have already been resolved
        // and we will write the final values to the parent frame rather than the promises
        childFrame._commitSequentialWrites();
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
