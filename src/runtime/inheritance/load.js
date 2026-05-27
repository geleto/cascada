import {contextualizeError} from '../errors.js';

function requireInheritanceLoadErrorContext(errorContext) {
  if (Array.isArray(errorContext)) {
    return errorContext;
  }
  const received = errorContext === null ? 'null' : typeof errorContext;
  throw new TypeError(`inheritance loading requires a compact errorContext (got ${received})`);
}

function addLoadErrorContext(error, errorContext, context) {
  void context;
  return contextualizeError(error, requireInheritanceLoadErrorContext(errorContext), null);
}

function loadEntry(templateOrScript, errorContext, runtime) {
  templateOrScript.compile();
  const path = templateOrScript.path ?? null;
  if (!templateOrScript.inheritanceSpec || !templateOrScript.resolveInheritanceParent) {
    throw contextualizeError(
      new Error('expected an inheritance participant but got a plain template/script'),
      requireInheritanceLoadErrorContext(errorContext),
      null
    );
  }
  const errorContextTable = templateOrScript.getErrorContexts(runtime, path, null);
  return Object.freeze({
    templateOrScript,
    spec: templateOrScript.inheritanceSpec,
    path,
    errorContextTable,
    errorContext: errorContext ?? null
  });
}

async function resolveLoadedParent(entry, env, context, runtime, reportError) {
  try {
    return await entry.templateOrScript.resolveInheritanceParent(env, context, runtime, null, reportError);
  } catch (error) {
    throw addLoadErrorContext(error, entry.errorContext, context);
  }
}

async function loadInheritanceChain({ templateOrScript, env, context, runtime, errorContext = null, reportError }) {
  const entries = [];
  const seen = new Set();
  let currentTemplateOrScript = templateOrScript;
  let selectedByErrorContext = errorContext;

  while (currentTemplateOrScript) {
    // Path is the stable source identity; pathless synthetic objects fall back
    // to reference identity.
    const cycleIdentity = currentTemplateOrScript.path ?? currentTemplateOrScript;
    if (seen.has(cycleIdentity)) {
      throw contextualizeError(
        new Error(`inheritance cycle detected at ${currentTemplateOrScript.path ?? '<anonymous>'}`),
        requireInheritanceLoadErrorContext(selectedByErrorContext),
        null
      );
    }
    seen.add(cycleIdentity);

    let entry;
    try {
      entry = loadEntry(currentTemplateOrScript, selectedByErrorContext, runtime);
    } catch (error) {
      throw addLoadErrorContext(error, selectedByErrorContext, context);
    }
    entries.push(entry);

    const parentSelection = await resolveLoadedParent(entry, env, context, runtime, reportError);
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
