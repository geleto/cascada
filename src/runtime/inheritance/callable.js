import {handleError} from '../errors.js';
import {resolveSingle} from '../resolve.js';

function noInheritanceParent() {
  return { parentTemplateOrScript: null, origin: null };
}

async function resolveInheritanceParent(env, isScript, target, origin, context, errorContext) {
  try {
    target = await resolveSingle(target);
  } catch (error) {
    throw runtimeError(error, context, errorContext);
  }

  if (target === null || target === undefined) {
    // Scripts use null as an explicit parentless selection; templates must
    // select a concrete parent when dynamic extends is present.
    if (!isScript) {
      throw runtimeError(
        new Error('template extends must select a parent template'),
        context,
        errorContext
      );
    }
    return noInheritanceParent();
  }

  const loadMethod = isScript ? 'getScript' : 'getTemplate';
  try {
    const parentTemplateOrScript = await env[loadMethod](target, true, context.path, false);
    return { parentTemplateOrScript, origin };
  } catch (error) {
    throw handleError(
      error,
      origin?.lineno,
      origin?.colno,
      origin?.errorContextString,
      origin?.path ?? context.path
    );
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
  const payloadContext = Object.assign({}, (blockRenderCtx || {}), compositionPayloadContext);
  // Callable arguments are local chains, not composition-context variables.
  // `blockPayload` only marks an inherited block placement call.
  if (blockPayload !== null || blockRenderCtx !== undefined || Object.keys(payloadContext).length > 0) {
    return context.forkForComposition(invocationPath, payloadContext, blockRenderCtx);
  }
  return context.forkForPath(invocationPath);
}

function runtimeError(error, context, errorContext) {
  return handleError(
    error,
    errorContext?.lineno,
    errorContext?.colno,
    errorContext?.errorContextString,
    context.path
  );
}

export {
  noInheritanceParent,
  resolveInheritanceParent,
  getInheritanceCallableOriginalArgs,
  createInheritanceCallableContext
};
