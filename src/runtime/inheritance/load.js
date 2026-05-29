import {RuntimeError} from '../errors.js';

function requireInheritanceLoadErrorContext(errorContext) {
  if (Array.isArray(errorContext)) {
    return errorContext;
  }
  const received = errorContext === null ? 'null' : typeof errorContext;
  throw new TypeError(`inheritance loading requires a compact errorContext (got ${received})`);
}

function reportInheritanceLoadError(error, errorContext) {
  return RuntimeError.report(error, requireInheritanceLoadErrorContext(errorContext));
}

function loadEntry(templateOrScript, errorContext, runtime) {
  templateOrScript.compile();
  const path = templateOrScript.path ?? null;
  if (!templateOrScript.inheritanceSpec || !templateOrScript.resolveInheritanceParent) {
    RuntimeError.reportAndThrow(
      'expected an inheritance participant but got a plain template/script',
      requireInheritanceLoadErrorContext(errorContext)
    );
  }
  const errorContextTable = templateOrScript.getErrorContexts(runtime, path, null);
  return Object.freeze({
    templateOrScript,
    spec: templateOrScript.inheritanceSpec,
    path,
    errorContextTable,
    errorContext
  });
}

async function resolveLoadedParent(entry, env, context, runtime, renderState) {
  try {
    return await entry.templateOrScript.resolveInheritanceParent(env, context, runtime, entry.errorContext, renderState);
  } catch (error) {
    throw reportInheritanceLoadError(error, entry.errorContext);
  }
}

async function loadInheritanceChain({ templateOrScript, env, context, runtime, errorContext, renderState }) {
  const entries = [];
  const seen = new Set();
  let currentTemplateOrScript = templateOrScript;
  let selectedByErrorContext = errorContext;

  while (currentTemplateOrScript) {
    // Path is the stable source identity; pathless synthetic objects fall back
    // to reference identity.
    const cycleIdentity = currentTemplateOrScript.path ?? currentTemplateOrScript;
    if (seen.has(cycleIdentity)) {
      RuntimeError.reportAndThrow(
        `inheritance cycle detected at ${currentTemplateOrScript.path ?? '<anonymous>'}`,
        requireInheritanceLoadErrorContext(selectedByErrorContext)
      );
    }
    seen.add(cycleIdentity);

    let entry;
    try {
      entry = loadEntry(currentTemplateOrScript, selectedByErrorContext, runtime);
    } catch (error) {
      throw reportInheritanceLoadError(error, selectedByErrorContext);
    }
    entries.push(entry);

    renderState.throwIfFatalErrorReported();
    const parentSelection = await resolveLoadedParent(entry, env, context, runtime, renderState);
    currentTemplateOrScript = parentSelection.parentTemplateOrScript;
    selectedByErrorContext = parentSelection.errorContext;
  }

  // Freeze only loader-owned wrappers; compiled templates/scripts remain owned
  // by the environment cache.
  return Object.freeze({
    entries: Object.freeze(entries.slice())
  });
}

export {loadInheritanceChain};
