
import {RuntimeError, contextualizeError, markPromiseHandled} from './errors.js';
import {CommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames = null, isolatedContext = null, bufferBranchContext = null, traceParent = null, renderState = null) {
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const diagnosticTraceParent = traceParent || parentBuffer || null;
  const boundaryRenderState = renderState || (parentBuffer && parentBuffer.renderState) || null;
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
    diagnosticTraceParent,
    boundaryRenderState
  );
  return { childBuffer };
}

function _reportBoundaryError(err, boundaryLabel, context, renderState, bufferBranchContext = null) {
  void context;
  const sourceContext = bufferBranchContext && bufferBranchContext.ec;
  if (!Array.isArray(sourceContext)) {
    throw new TypeError(`${boundaryLabel} requires bufferBranchContext.ec to be a compact errorContext`);
  }
  const reportedError = err instanceof RuntimeError
    ? err
    : contextualizeError(err, sourceContext);
  renderState.reportFatalError(reportedError);
}

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 *
 * The asyncFn receives (childBuffer) and runs the branch body inside that
 * single child boundary.
 */
async function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, bufferBranchContext = null) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferBranchContext, null, renderState);

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, renderState, bufferBranchContext);
  } finally {
    childBuffer.finish();
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited chain. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, waitedChainName, bufferBranchContext = null) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferBranchContext, null, renderState);

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    _reportBoundaryError(err, 'ControlFlowAsyncBlock', context, renderState, bufferBranchContext);
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
async function runRenderBoundary(context, renderState, asyncFn, bufferBranchContext = null, traceParent = null) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(null, null, null, context || null, bufferBranchContext, traceParent, renderState);

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    _reportBoundaryError(err, 'RenderAsyncBlock', context, renderState, bufferBranchContext);
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
