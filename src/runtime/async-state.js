'use strict';

class AsyncState {
  _enterAsyncBlock() {
    return new AsyncState();
  }

  _leaveAsyncBlock() {
    return null;
  }

  asyncBlock(
    func,
    runtime,
    f,
    asyncMeta,
    parentBuffer,
    createOutputBuffer,
    cb
  ) {
    const usedChannels = asyncMeta && Array.isArray(asyncMeta.usedChannels)
      ? asyncMeta.usedChannels
      : null;
    const childFrame = f.push(false);
    // Runtime async-block creation site for CommandBuffer.
    // This avoids compiler-side duplicate creation for async block execution.
    let newBuffer = null;
    if (createOutputBuffer) {
      const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : null;
      newBuffer = runtime.createCommandBuffer(bufferContext, null, childFrame, usedChannels, parentBuffer);
    }

    const childState = this.new();

    const activeBuffer = newBuffer || parentBuffer || null;
    const cleanup = () => {
      // Always finalize the child buffer so parent iteration/output ordering can proceed,
      // even if the block failed. Waited-loop completion itself comes from the block's
      // returned promise, not from cleanup timing.
      if (newBuffer) {
        newBuffer.markFinishedAndPatchLinks();
      }
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
  new() {
    return new AsyncState();
  }
}

module.exports = {
  AsyncState
};
