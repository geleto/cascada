import {RuntimeError} from '../errors.js';
import {resolveSingle} from '../resolve.js';

function noInheritanceParent() {
  return { parentTemplateOrScript: null, errorContext: null };
}

async function resolveInheritanceParent(ownerState, target, inheritedErrorContext, context, errorContext) {
  try {
    target = await resolveSingle(target);
  } catch (error) {
    RuntimeError.reportAndThrow(error, errorContext);
  }

  if (target === null || target === undefined) {
    // Scripts use null as an explicit parentless selection; templates must
    // select a concrete parent when dynamic extends is present.
    if (!ownerState.scriptMode) {
      RuntimeError.reportAndThrow('template extends must select a parent template', errorContext);
    }
    return noInheritanceParent();
  }

  const loadMethod = ownerState.scriptMode ? 'getScript' : 'getTemplate';
  try {
    const parentTemplateOrScript = await ownerState.env[loadMethod](target, true, context.path, false);
    return { parentTemplateOrScript, errorContext: inheritedErrorContext };
  } catch (error) {
    RuntimeError.reportAndThrow(error, inheritedErrorContext);
  }
}

function getInheritanceCallableOriginalArgs(blockPayload) {
  return blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};
}

function createInheritanceCallableContext(context, isScriptMethod, invocationPath, blockPayload, blockRenderCtx) {
  if (isScriptMethod) {
    return context.forkForPath(invocationPath);
  }

  const compositionPayloadContext = context.getCompositionPayloadVariables() || {};
  const payloadContext = { ...(blockRenderCtx || {}), ...compositionPayloadContext };
  // Callable arguments are local chains, not composition-context variables.
  // `blockPayload` only marks an inherited block placement call.
  if (blockPayload !== null || blockRenderCtx !== undefined || Object.keys(payloadContext).length > 0) {
    return context.forkForComposition(invocationPath, payloadContext, blockRenderCtx);
  }
  return context.forkForPath(invocationPath);
}

export {
  noInheritanceParent,
  resolveInheritanceParent,
  getInheritanceCallableOriginalArgs,
  createInheritanceCallableContext
};
