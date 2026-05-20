import {handleError} from '../errors.js';

function addLoadErrorContext(error, errorContext, context) {
  // Fallback compact context: [lineno=0, colno=0, label=null, path, cb=null].
  return handleError(error, errorContext ?? [0, 0, null, context?.path ?? null, null], null);
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
    throw handleError(
      new Error('expected an inheritance participant but got a plain template/script'),
      entry.errorContext ?? null,
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
      throw handleError(
        new Error(`inheritance cycle detected at ${currentTemplateOrScript.path ?? '<anonymous>'}`),
        selectedByErrorContext ?? null,
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
