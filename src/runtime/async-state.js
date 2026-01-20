'use strict';

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

    if (this.parent) {
      return this.parent._leaveAsyncBlock();
    }

    return this.parent;
  }

  asyncBlock(func, runtime, f, readVars, writeCounts, cb, lineno, colno, context, errorContextString = null, isExpression = false, sequentialAsyncBlock = false) {
    const childFrame = f.pushAsyncBlock(readVars, writeCounts, sequentialAsyncBlock);
    const childState = this._enterAsyncBlock(childFrame);

    try {
      // 1. Invoke the async function to get the promise.
      const promise = func(childState, childFrame);

      // Check for fatal errors to report them immediately to the render which will reject the promise
      promise.catch(err => {
        if (err instanceof runtime.RuntimeFatalError) {
          cb(err);
        }
      });

      // Add error handler to fulfill writeCounts contract even on failure
      const handled = (isExpression && writeCounts)//asyncBlockValue
        ? promise.catch(err => {
          // Poison all variables that this block was supposed to write and decrement counters
          // This happens with expressions with sequential operators because their locks are regular variables
          if (writeCounts) {
            childFrame.poisonBranchWrites(err, writeCounts);
          }

          // Re-throw to maintain error propagation to root handler
          throw err;
        })
        : promise;

      // The finally must run for all nodes.
      const wrappedPromise = handled.finally(() => {
        // Ensure per-block finalization always runs (decrementing counters, releasing locks, etc.)
        if (sequentialAsyncBlock) {
          // This is the best place to do it rather than when the counter reaches 0
          // because by this time some promises may have already been resolved
          // and we will write the final values to the parent frame
          childFrame.commitSequentialWrites();
        }
        childState._leaveAsyncBlock();
      });

      return wrappedPromise;
    } catch (syncError) {
      // This catches synchronous errors that might happen before the promise is even created.
      // This can happen mostly due to compiler error, may remove it in the future

      cb(new runtime.RuntimeFatalError(syncError, lineno, colno, errorContextString, context ? context.path : null));

      // Poison variables and decrement counters on sync failure too
      /*if (writeCounts) {
        childFrame.poisonBranchWrites(syncError, writeCounts);
      }

      const handledError = runtime.handleError(syncError, lineno, colno, errorContextString, context ? context.path : null);
      cb(handledError);
      ////////
      if (sequential) {
        //childFrame.commitSequentialWrites();
      }
      ////////
      childState._leaveAsyncBlock();// Ensure cleanup even on sync failure.
      */
    }
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
