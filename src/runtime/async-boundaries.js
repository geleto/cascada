
import {isPoisonError, markPromiseHandled} from './errors.js';
import {CommandBuffer} from './command-buffer.js';

function _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames = null, isolatedContext = null, bufferStackErrorContext, traceParent = null, renderState = null) {
  const bufferContext = parentBuffer && parentBuffer._context ? parentBuffer._context : isolatedContext;
  const diagnosticTraceParent = traceParent || parentBuffer || null;
  const boundaryRenderState = renderState || (parentBuffer && parentBuffer.renderState) || null;
  // Boundary buffers intentionally keep parent null for runtime visibility and
  // attach to parentBuffer only through linked chain lanes. traceParent carries
  // the diagnostic stack relationship.
  // Store the exact compact context the compiler selected for this origin.
  // Dynamic boundaries receive owned clones so later metadata updates are
  // visible to diagnostics; static boundaries may share prepared contexts.
  const childBuffer = new CommandBuffer(
    bufferContext,
    null,
    linkedChainNames,
    parentBuffer || null,
    linkedMutatedChainNames,
    bufferStackErrorContext,
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
async function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, bufferStackErrorContext) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext, null, renderState);
  const childStackErrorContext = childBuffer.bufferStackErrorContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackErrorContext, childBuffer);
  } finally {
    childBuffer.finish();
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited chain. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
async function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, asyncFn, waitedChainName, bufferStackErrorContext) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext, null, renderState);
  const childStackErrorContext = childBuffer.bufferStackErrorContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackErrorContext, childBuffer);
  } finally {
    childBuffer.finish();
    // Fatal state abandons pending waited work; renderState owns shutdown and
    // draining never-settling waited commands would deadlock cleanup.
    if (!renderState.isFatalErrorReported()) {
      await childBuffer.getChain(waitedChainName).finalSnapshot();
    }
  }
}

/**
 * Run an isolated render boundary as an async child buffer that is not linked
 * into the parent tree. The asyncFn receives (childBuffer)
 * and should synchronously emit the boundary body into that child buffer.
 */
async function runRenderBoundary(context, renderState, asyncFn, bufferStackErrorContext, traceParent = null) {
  renderState.throwIfFatalErrorReported();
  const { childBuffer } = _createChildBoundary(null, null, null, context || null, bufferStackErrorContext, traceParent, renderState);
  const childStackErrorContext = childBuffer.bufferStackErrorContext;

  try {
    const result = await asyncFn(childBuffer);
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    }
    renderState.reportAndThrowFatalError(err, childStackErrorContext, childBuffer);
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
function runValueBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, asyncFn, bufferStackErrorContext) {
  const { childBuffer } = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export { runControlFlowBoundary, runWaitedControlFlowBoundary, runRenderBoundary, runValueBoundary };
