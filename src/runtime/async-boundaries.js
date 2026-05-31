
import {isPoisonError, markPromiseHandled} from './errors.js';
import {CommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames = null, isolatedContext = null, bufferStackContext, traceParent = null, renderState = null) {
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
    bufferStackContext,
    diagnosticTraceParent,
    boundaryRenderState
  );
  return { childBuffer };
}

/**
 * Run a control-flow boundary (if/switch body) as a single async child buffer.
 *
 * The asyncFn receives (childBuffer) and runs the branch body inside that
 * single child boundary.
 */
async function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, bufferStackContext) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackContext, null, renderState);
  const childStackContext = childBuffer.bufferStackContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackContext);
  } finally {
    childBuffer.finish();
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited chain. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, waitedChainName, bufferStackContext) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackContext, null, renderState);
  const childStackContext = childBuffer.bufferStackContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackContext);
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
async function runRenderBoundary(context, renderState, asyncFn, bufferStackContext, traceParent = null) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(null, null, null, context || null, bufferStackContext, traceParent, renderState);
  const childStackContext = childBuffer.bufferStackContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackContext);
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
function runValueBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, asyncFn, bufferStackContext) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackContext);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export { runControlFlowBoundary, runWaitedControlFlowBoundary, runRenderBoundary, runValueBoundary };
