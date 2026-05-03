
import {RuntimeError, handleError, markPromiseHandled} from './errors.js';
import {createCommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames = null, isolatedContext = null) {
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const childBuffer = createCommandBuffer(
    bufferContext,
    null,
    linkedChannelNames,
    parentBuffer || null,
    linkedMutatedChannelNames
  );
  return { childBuffer };
}

function _reportBoundaryError(err, boundaryName, context, cb) {
  const reportedError = err instanceof RuntimeError
    ? err
    : handleError(err, 0, 0, boundaryName, context && context.path ? context.path : null);
  cb(reportedError);
}

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 *
 * The asyncFn receives (childBuffer) and runs the branch body inside that
 * single child boundary.
 */
async function runControlFlowBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames, context, cb, asyncFn) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb);
    return null;
  } finally {
    childBuffer.finish();
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited channel. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames, context, cb, asyncFn, waitedChannelName) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb);
    return null;
  } finally {
    childBuffer.finish();
    await childBuffer.getChannel(waitedChannelName).finalSnapshot();
  }
}

/**
 * Run an isolated render boundary as an async child buffer that is not linked
 * into the parent tree. The asyncFn receives (childBuffer)
 * and should synchronously emit the boundary body into that child buffer.
 */
async function runRenderBoundary(context, cb, asyncFn) {
  const { childBuffer } = _createChildBoundary(null, null, null, context || null);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'RenderAsyncBlock', context, cb);
    return null;
  } finally {
    childBuffer.finish();
  }
}

/**
 * Run a value-returning async boundary that may need a child buffer before
 * the eventual dispatched call decides whether it is command-emitting.
 *
 * Unlike runControlFlowBoundary(...), this helper preserves normal expression
 * rejection semantics: errors are rethrown to the awaiting caller.
 */
function runValueBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames, asyncFn) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChannelNames, linkedMutatedChannelNames);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export { runControlFlowBoundary, runWaitedControlFlowBoundary, runRenderBoundary, runValueBoundary };
