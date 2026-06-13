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

function loadEntry(templateOrScript, errorContext, ownerState) {
  templateOrScript.compile();
  const path = templateOrScript.path ?? null;
  if (!templateOrScript.inheritanceSpec || !templateOrScript.resolveInheritanceParent) {
    RuntimeError.reportAndThrow(
      'expected an inheritance participant but got a plain template/script',
      requireInheritanceLoadErrorContext(errorContext)
    );
  }
  const errorContextTable = templateOrScript.getErrorContexts(ownerState.runtime, path, null);
  const entryOwnerState = Object.freeze({
    env: ownerState.env,
    runtime: ownerState.runtime,
    renderState: ownerState.renderState,
    templateOrScript,
    path,
    scriptMode: !!templateOrScript.scriptMode,
    errorContextTable: templateOrScript.getErrorContexts(ownerState.runtime, path, ownerState.renderState)
  });
  return Object.freeze({
    templateOrScript,
    spec: templateOrScript.inheritanceSpec,
    path,
    errorContextTable,
    ownerState: entryOwnerState,
    errorContext
  });
}

async function resolveLoadedParent(entry, context) {
  try {
    return await entry.templateOrScript.resolveInheritanceParent(entry.ownerState, context, entry.errorContext);
  } catch (error) {
    throw reportInheritanceLoadError(error, entry.errorContext);
  }
}

async function loadInheritanceChain({ templateOrScript, ownerState, context, errorContext }) {
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
      entry = loadEntry(currentTemplateOrScript, selectedByErrorContext, ownerState);
    } catch (error) {
      throw reportInheritanceLoadError(error, selectedByErrorContext);
    }
    entries.push(entry);

    ownerState.renderState.throwIfFatalErrorReported();
    const parentSelection = await resolveLoadedParent(entry, context);
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
