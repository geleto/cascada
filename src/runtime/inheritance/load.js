import {handleError} from '../errors.js';

function addLoadErrorContext(error, origin, context) {
  return handleError(
    error,
    origin?.lineno,
    origin?.colno,
    origin?.errorContextString,
    origin?.path ?? context.path
  );
}

function loadEntry(templateOrScript, origin) {
  templateOrScript.compile();
  return Object.freeze({
    templateOrScript,
    spec: templateOrScript.inheritanceSpec,
    path: templateOrScript.path ?? null,
    origin: origin ?? null
  });
}

function assertLoadableInheritanceEntry(entry, context) {
  if (!entry.spec || !entry.templateOrScript.resolveInheritanceParent) {
    throw handleError(
      new Error('expected an inheritance participant but got a plain template/script'),
      entry.origin?.lineno,
      entry.origin?.colno,
      entry.origin?.errorContextString,
      entry.origin?.path ?? context.path
    );
  }
}

async function resolveLoadedParent(entry, env, context, runtime) {
  try {
    return await entry.templateOrScript.resolveInheritanceParent(env, context, runtime, null);
  } catch (error) {
    throw addLoadErrorContext(error, entry.origin, context);
  }
}

async function loadInheritanceChain({ templateOrScript, env, context, runtime, origin = null }) {
  const entries = [];
  const seen = new Set();
  let currentTemplateOrScript = templateOrScript;
  let currentOrigin = origin;

  while (currentTemplateOrScript) {
    // Path is the stable source identity; pathless synthetic objects fall back
    // to reference identity.
    const cycleIdentity = currentTemplateOrScript.path ?? currentTemplateOrScript;
    if (seen.has(cycleIdentity)) {
      throw handleError(
        new Error(`inheritance cycle detected at ${currentTemplateOrScript.path ?? '<anonymous>'}`),
        currentOrigin?.lineno,
        currentOrigin?.colno,
        currentOrigin?.errorContextString,
        currentOrigin?.path ?? context.path
      );
    }
    seen.add(cycleIdentity);

    let entry;
    try {
      entry = loadEntry(currentTemplateOrScript, currentOrigin);
    } catch (error) {
      throw addLoadErrorContext(error, currentOrigin, context);
    }
    assertLoadableInheritanceEntry(entry, context);
    entries.push(entry);

    const parentSelection = await resolveLoadedParent(entry, env, context, runtime);
    currentTemplateOrScript = parentSelection.parentTemplateOrScript;
    currentOrigin = parentSelection.origin;
  }

  // Freeze only loader-owned wrappers; compiled templates/scripts remain owned
  // by the environment cache.
  return Object.freeze({
    entries: Object.freeze(entries.slice())
  });
}

export {loadInheritanceChain};
