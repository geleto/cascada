import {contextualizeError} from '../errors.js';

function requireLoadErrorContext(errorContext, label) {
  if (Array.isArray(errorContext)) {
    return errorContext;
  }
  const received = errorContext === null ? 'null' : typeof errorContext;
  throw new TypeError(`${label} requires a compact errorContext (got ${received})`);
}

function addLoadErrorContext(error, errorContext, context) {
  void context;
  return contextualizeError(error, requireLoadErrorContext(errorContext, 'inheritance load error'), null);
}

function loadEntry(templateOrScript, errorContext, runtime) {
  templateOrScript.compile();
  const path = templateOrScript.path ?? null;
  const errorContextTable = typeof templateOrScript.getErrorContexts === 'function'
    ? templateOrScript.getErrorContexts(runtime, path, null)
    : null;
  return Object.freeze({
    templateOrScript,
    spec: templateOrScript.inheritanceSpec,
    path,
    errorContextTable,
    errorContext: errorContext ?? null
  });
}

function assertLoadableInheritanceEntry(entry) {
  if (!entry.spec || !entry.templateOrScript.resolveInheritanceParent) {
    throw contextualizeError(
      new Error('expected an inheritance participant but got a plain template/script'),
      requireLoadErrorContext(entry.errorContext, 'inheritance participant error'),
      null
    );
  }
}

async function resolveLoadedParent(entry, env, context, runtime) {
  try {
    return await entry.templateOrScript.resolveInheritanceParent(env, context, runtime, null);
  } catch (error) {
    throw addLoadErrorContext(error, entry.errorContext, context);
  }
}

async function loadInheritanceChain({ templateOrScript, env, context, runtime, errorContext = null }) {
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
        requireLoadErrorContext(selectedByErrorContext, 'inheritance cycle error'),
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
    assertLoadableInheritanceEntry(entry);
    entries.push(entry);

    const parentSelection = await resolveLoadedParent(entry, env, context, runtime);
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
