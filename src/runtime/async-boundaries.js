'use strict';

const errors = require('./errors');
const buffer = require('./command-buffer');

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 * This helper owns the child buffer lifecycle so waited loops can optionally
 * gate on a child-owned waited channel instead of only on async function return.
 *
 * The asyncFn receives (childFrame, childBuffer) and should compile
 * branch bodies synchronously inside - no inner astate.asyncBlock calls needed.
 */
async function runControlFlowBoundary(astate, parentBuffer, usedChannels, f, context, cb, asyncFn, waitedChannelName = null) {
  void astate;
  void context;
  void cb;
  const linkedChannels = Array.isArray(usedChannels) ? usedChannels : null;
  const childFrame = f.push(false);
  let childBuffer = null;
  if (parentBuffer) {
    const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : null;
    childBuffer = buffer.createCommandBuffer(bufferContext, null, childFrame, linkedChannels, parentBuffer);
  }

  const activeBuffer = childBuffer || parentBuffer || null;

  const finalizeChildBuffer = () => {
    if (!childBuffer || !waitedChannelName) {
      return Promise.resolve();
    }
    return childBuffer.getChannel(waitedChannelName).finalSnapshot();
  };

  const cleanup = () => {
    if (childBuffer) {
      childBuffer.markFinishedAndPatchLinks();
    }
    return finalizeChildBuffer();
  };

  try {
    return await asyncFn(childFrame, activeBuffer, parentBuffer || null);
  } catch (err) {
    const reportedError = err instanceof errors.RuntimeError
      ? err
      : errors.handleError(err, 0, 0, 'ControlFlowAsyncBlock', context && context.path ? context.path : null);
    cb(reportedError);
    return null;
  } finally {
    await cleanup();
  }
}

/**
 * Run an isolated render boundary as an async child buffer that is not linked
 * into the parent tree. The asyncFn receives (childFrame, childBuffer)
 * and should synchronously emit the boundary body into that child buffer.
 */
async function runRenderBoundary(astate, f, context, cb, asyncFn) {
  void astate;
  const childFrame = f.push(false);
  const childBuffer = buffer.createCommandBuffer(context || null, null, childFrame, null, null);

  const cleanup = () => {
    childBuffer.markFinishedAndPatchLinks();
  };

  try {
    return await asyncFn(childFrame, childBuffer);
  } catch (err) {
    const reportedError = err instanceof errors.RuntimeError
      ? err
      : errors.handleError(err, 0, 0, 'RenderAsyncBlock', context && context.path ? context.path : null);
    cb(reportedError);
    return null;
  } finally {
    cleanup();
  }
}

module.exports = {
  runControlFlowBoundary,
  runRenderBoundary
};
