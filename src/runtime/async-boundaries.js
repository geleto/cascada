
import {isPoisonError, isRuntimeError, markPromiseHandled, RuntimeError} from './errors.js';
import {resolveThen, thenValue} from './resolve.js';
import {CommandBuffer} from './command-buffer.js';
import {ErrorCommand} from './commands/errors.js';

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
  return childBuffer;
}

/**
 * Run a control-flow boundary (if/switch body) as a single child buffer.
 *
 * The boundary function receives (childBuffer) and runs the branch body inside
 * that single child boundary. Synchronous bodies complete without a microtask.
 */
function runControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, boundaryFn, bufferStackErrorContext) {
  renderState.throwIfFatalErrorReported();
  const childBuffer = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext, null, renderState);
  return markPromiseHandled(_runWithChildBuffer(childBuffer, renderState, boundaryFn));
}

function normalizeStructuralBoundaryError(err, renderState, childBuffer) {
  if (isPoisonError(err)) {
    return err;
  }
  let normalizedErr;
  try {
    renderState.reportAndThrowFatalError(err, childBuffer.bufferStackErrorContext, childBuffer);
  } catch (reportedErr) {
    normalizedErr = reportedErr;
  }
  return normalizedErr;
}

function finishChildBuffer(childBuffer, renderState, waitedChainName) {
  childBuffer.finish();
  // Fatal state abandons pending waited work; renderState owns shutdown and
  // draining never-settling waited commands would deadlock cleanup.
  if (waitedChainName && !renderState.isFatalErrorReported()) {
    const waitedResult = childBuffer.getChain(waitedChainName).finalSnapshot();
    if (waitedResult && typeof waitedResult.then === 'function') {
      return waitedResult;
    }
  }
  return null;
}

function finishChildBufferWithResult(childBuffer, renderState, waitedChainName, result) {
  const waitedResult = finishChildBuffer(childBuffer, renderState, waitedChainName);
  return waitedResult ? waitedResult.then(() => result) : result;
}

function finishChildBufferWithError(childBuffer, renderState, waitedChainName, err) {
  const waitedResult = finishChildBuffer(childBuffer, renderState, waitedChainName);
  if (waitedResult) {
    return waitedResult.then(() => {
      throw err;
    });
  }
  throw err;
}

function handleRunWithChildBufferError(err, childBuffer, renderState, waitedChainName) {
  const handledErr = normalizeStructuralBoundaryError(err, renderState, childBuffer);
  return finishChildBufferWithError(childBuffer, renderState, waitedChainName, handledErr);
}

// Fatal structural errors are delivered through render state; wrappers mark
// these promises handled to suppress duplicate boundary-promise rejection.
function _runWithChildBuffer(childBuffer, renderState, boundaryFn, waitedChainName = null) {
  let result;
  try {
    result = boundaryFn(childBuffer);
  } catch (err) {
    return handleRunWithChildBufferError(err, childBuffer, renderState, waitedChainName);
  }

  if (result && typeof result.then === 'function') {
    return _runWithChildBufferAsync(childBuffer, renderState, result, waitedChainName);
  }

  try {
    renderState.throwIfFatalErrorReported();
    return finishChildBufferWithResult(childBuffer, renderState, waitedChainName, result);
  } catch (err) {
    return handleRunWithChildBufferError(err, childBuffer, renderState, waitedChainName);
  }
}

async function _runWithChildBufferAsync(childBuffer, renderState, resultPromise, waitedChainName = null) {
  try {
    const result = await resultPromise;
    // A sibling/root path may have reported fatal while this boundary awaited.
    renderState.throwIfFatalErrorReported();
    return result;
  } catch (err) {
    throw normalizeStructuralBoundaryError(err, renderState, childBuffer);
  } finally {
    const waitedResult = finishChildBuffer(childBuffer, renderState, waitedChainName);
    if (waitedResult) {
      await waitedResult;
    }
  }
}

/**
 * Run a control-flow boundary whose completion is gated by a child-owned
 * waited chain. This is loop-specific structural behavior and stays out of
 * the generic control-flow helper.
 */
function runWaitedControlFlowBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, context, renderState, boundaryFn, waitedChainName, bufferStackErrorContext) {
  renderState.throwIfFatalErrorReported();
  const childBuffer = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext, null, renderState);
  return markPromiseHandled(_runWithChildBuffer(childBuffer, renderState, boundaryFn, waitedChainName));
}

function poisonControlFlowTargets(buffer, poisonTargetChains, err, errorContext) {
  if (isRuntimeError(err)) {
    throw err;
  }
  if (!isPoisonError(err)) {
    RuntimeError.reportAndThrow(err, errorContext);
  }
  if (!poisonTargetChains) {
    return;
  }
  for (const chainName of poisonTargetChains) {
    buffer.addCommand(new ErrorCommand(err, errorContext), chainName);
  }
}

function consumeControlFlowValue(value, buffer, poisonTargetChains, errorContext, onValue, onPoison = null) {
  return resolveThen(value, onValue, (err) => {
    poisonControlFlowTargets(buffer, poisonTargetChains, err, errorContext);
    return onPoison ? onPoison(err) : undefined;
  });
}

function finishBufferAndWait(buffer, waitedChainName) {
  buffer.finish();
  return buffer.getChain(waitedChainName).finalSnapshot();
}

function finishBufferAndContinue(buffer, waitedChainName) {
  return thenValue(finishBufferAndWait(buffer, waitedChainName), () => true);
}

/**
 * Run an isolated render boundary as a child buffer that is not linked into
 * the parent tree. The boundary function receives (childBuffer) and should
 * synchronously emit the boundary body into that child buffer when possible.
 */
function runRenderBoundary(context, renderState, boundaryFn, bufferStackErrorContext, traceParent = null) {
  renderState.throwIfFatalErrorReported();
  const childBuffer = _createChildBoundary(null, null, null, context || null, bufferStackErrorContext, traceParent, renderState);
  return markPromiseHandled(_runWithChildBuffer(childBuffer, renderState, boundaryFn));
}

/**
 * Run a value-returning async boundary that may need a child buffer before
 * the eventual dispatched call decides whether it is command-emitting.
 *
 * Unlike runControlFlowBoundary(...), this helper preserves normal expression
 * rejection semantics: errors are rethrown to the awaiting caller.
 */
function runValueBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, asyncFn, bufferStackErrorContext) {
  const childBuffer = _createChildBoundary(parentBuffer, linkedChainNames, linkedMutatedChainNames, null, bufferStackErrorContext);
  const promise = Promise.resolve()
    .then(() => asyncFn(childBuffer))
    .finally(() => {
      childBuffer.finish();
    });
  markPromiseHandled(promise);
  return promise;
}

export {
  runControlFlowBoundary,
  runWaitedControlFlowBoundary,
  consumeControlFlowValue,
  finishBufferAndContinue,
  finishBufferAndWait,
  runRenderBoundary,
  runValueBoundary
};
