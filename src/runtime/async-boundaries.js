'use strict';

const errors = require('./errors');
const buffer = require('./command-buffer');

function _createChildBoundary(parentBuffer, usedChannels, f, isolatedContext = null) {
  const linkedChannels = Array.isArray(usedChannels) ? usedChannels : null;
  const childFrame = f.push(false);
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const childBuffer = buffer.createCommandBuffer(bufferContext, null, childFrame, linkedChannels, parentBuffer || null);
  return { childFrame, childBuffer };
}

function _reportBoundaryError(err, boundaryName, context, cb) {
  const reportedError = err instanceof errors.RuntimeError
    ? err
    : errors.handleError(err, 0, 0, boundaryName, context && context.path ? context.path : null);
  cb(reportedError);
}

async function _finalizeBoundary(childBuffer, waitedChannelName = null) {
  childBuffer.markFinishedAndPatchLinks();
  if (waitedChannelName) {
    await childBuffer.getChannel(waitedChannelName).finalSnapshot();
  }
}

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 *
 * The asyncFn receives (childFrame, childBuffer) and should compile
 * branch bodies synchronously inside - no inner legacy async-block wrappers needed.
 */
async function runControlFlowBoundary(parentBuffer, usedChannels, f, context, cb, asyncFn) {
  void context;
  void cb;
  const { childFrame, childBuffer } = _createChildBoundary(parentBuffer, usedChannels, f);

  try {
    return await asyncFn(childFrame, childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb);
    return null;
  } finally {
    await _finalizeBoundary(childBuffer);
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited channel. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, usedChannels, f, context, cb, asyncFn, waitedChannelName) {
  void context;
  void cb;
  const { childFrame, childBuffer } = _createChildBoundary(parentBuffer, usedChannels, f);

  try {
    return await asyncFn(childFrame, childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb);
    return null;
  } finally {
    await _finalizeBoundary(childBuffer, waitedChannelName);
  }
}

/**
 * Run an isolated render boundary as an async child buffer that is not linked
 * into the parent tree. The asyncFn receives (childFrame, childBuffer)
 * and should synchronously emit the boundary body into that child buffer.
 */
async function runRenderBoundary(f, context, cb, asyncFn) {
  const { childFrame, childBuffer } = _createChildBoundary(null, null, f, context || null);

  try {
    return await asyncFn(childFrame, childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'RenderAsyncBlock', context, cb);
    return null;
  } finally {
    await _finalizeBoundary(childBuffer);
  }
}

/**
 * Run a value-returning async boundary that may need a child buffer before
 * the eventual dispatched call decides whether it is command-emitting.
 *
 * Unlike runControlFlowBoundary(...), this helper preserves normal expression
 * rejection semantics: errors are rethrown to the awaiting caller.
 */
async function runValueBoundary(parentBuffer, usedChannels, f, asyncFn) {
  const { childFrame, childBuffer } = _createChildBoundary(parentBuffer, usedChannels, f);

  try {
    return await asyncFn(childFrame, childBuffer);
  } finally {
    await _finalizeBoundary(childBuffer);
  }
}

module.exports = {
  runControlFlowBoundary,
  runWaitedControlFlowBoundary,
  runRenderBoundary,
  runValueBoundary
};
