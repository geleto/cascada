
import {RuntimeError, contextualizeError, markPromiseHandled} from './errors.js';
import {CommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames = null, isolatedContext = null, bufferBranchContext = null, traceParent = null) {
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const diagnosticTraceParent = traceParent || parentBuffer || null;
  // Boundary buffers intentionally keep parent null for runtime visibility and
  // attach to parentBuffer only through linked chain lanes. traceParent carries
  // the diagnostic stack relationship.
  const childBuffer = new CommandBuffer(
    bufferContext,
    null,
    linkedChainNames,
    parentBuffer || null,
    linkedMutatedChainNames,
    bufferBranchContext,
    diagnosticTraceParent
  );
  return { childBuffer };
}

function _reportBoundaryError(err, boundaryLabel, context, cb, bufferBranchContext = null) {
  void context;
  const sourceContext = bufferBranchContext && bufferBranchContext.ec;
  if (!Array.isArray(sourceContext)) {
    throw new TypeError(`${boundaryLabel} requires bufferBranchContext.ec to be a compact errorContext`);
  }
  const reportedError = err instanceof RuntimeError
    ? err
    : contextualizeError(err, sourceContext);
  cb(reportedError);
}

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 *
 * The asyncFn receives (childBuffer) and runs the branch body inside that
 * single child boundary.
 */
async function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, cb, asyncFn, bufferBranchContext = null) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferBranchContext);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb, bufferBranchContext);
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
async function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, cb, asyncFn, waitedChainName, bufferBranchContext = null) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferBranchContext);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, cb, bufferBranchContext);
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
async function runRenderBoundary(context, cb, asyncFn, bufferBranchContext = null, traceParent = null) {
  const { childBuffer } = _createChildBoundary(null, null, null, context || null, bufferBranchContext, traceParent);

  try {
    return await asyncFn(childBuffer);
  } catch (err) {
    _reportBoundaryError(err, 'RenderAsyncBlock', context, cb, bufferBranchContext);
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
function runValueBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, asyncFn, bufferBranchContext = null) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferBranchContext);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export { runControlFlowBoundary, runWaitedControlFlowBoundary, runRenderBoundary, runValueBoundary };
