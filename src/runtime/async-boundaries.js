
import {RuntimeError, handleError, markPromiseHandled} from './errors.js';
import {CommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames = null, isolatedContext = null) {
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const childBuffer = new CommandBuffer(
    bufferContext,
    null,
    linkedChainNames,
    parentBuffer || null,
    linkedMutatedChainNames
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
async function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, cb, asyncFn) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames);

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
 * waited chain. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, cb, asyncFn, waitedChainName) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb);
    return null;
  } finally {
    childBuffer.finish();
    await childBuffer.getChain(waitedChainName).finalSnapshot();
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
function runValueBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, asyncFn) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export { runControlFlowBoundary, runWaitedControlFlowBoundary, runRenderBoundary, runValueBoundary };
