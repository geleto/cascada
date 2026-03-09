'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  handleError,
  RuntimePromise,
  collectErrors,
} = require('./errors');
const { LOOKUP_DYNAMIC_OUTPUT_LINKING } = require('../feature-flags');

const {
  resolveDuo
} = require('./resolve');
const { getOutput } = require('./output');

/**
 * Sync member lookup for templates.
 * Returns undefined if obj is undefined or null.
 */
function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

/**
 * Sync member lookup for scripts.
 * Throws error if obj is null/undefined.
 */
function memberLookupScript(obj, val) {
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception
    throw new Error(`Cannot read property ${val} of ${obj}`);
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

/**
 * Async member lookup for templates.
 * Uses sync-first hybrid pattern.
 */
function memberLookupAsync(obj, val, errorContext) {

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupAsyncComplex(obj, val, errorContext);
  }

  // Sync path - collect ALL errors from both sources (never miss any error principle)
  const objPoison = isPoison(obj);
  const valPoison = isPoison(val);

  if (objPoison && valPoison) {
    // Both poisoned - merge errors
    return createPoison([...obj.errors, ...val.errors]);
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  // No errors - proceed with lookup
  const result = memberLookup(obj, val);
  if (result && typeof result.then === 'function') {
    return new RuntimePromise(result, errorContext);
  }
  return result;
}

async function _memberLookupAsyncComplex(obj, val, errorContext) {
  // Collect errors from both inputs (await all promises)
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve the values
  try {
    const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

    // Collect errors from BOTH resolved values (never miss any error principle)
    const objPoison = isPoison(resolvedObj);
    const valPoison = isPoison(resolvedVal);

    if (objPoison && valPoison) {
      // Both poisoned - merge errors
      return createPoison([...resolvedObj.errors, ...resolvedVal.errors]);
    } else if (objPoison) {
      // Only obj poisoned - return it directly
      return resolvedObj;
    } else if (valPoison) {
      // Only val poisoned - return it directly
      return resolvedVal;
    }

    const result = memberLookup(resolvedObj, resolvedVal);

    // Wrap promise results to preserve error context
    // This handles: 1) properties that are promises, 2) getters that return promises
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext);
    }

    return result;
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    } else {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      return createPoison(contextualError);
    }
  }
}

/**
 * Async member lookup for scripts.
 * Uses sync-first hybrid pattern.
 */
function memberLookupScriptAsync(obj, val, errorContext) {

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupScriptAsyncComplex(obj, val, errorContext);
  }

  // Sync path - collect ALL errors from both sources (never miss any error principle)
  const objPoison = isPoison(obj);
  const valPoison = isPoison(val);

  if (objPoison && valPoison) {
    // Both poisoned - merge errors
    return createPoison([...obj.errors, ...val.errors]);
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  // No errors - proceed with lookup
  // Let native error throw; it will be caught by the top-level sync try/catch.
  //return memberLookupScript(obj, val);

  // The same implementation as memberLookupScript, but returns a poison value instead of throwing an exception
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception
    return createPoison(new Error(`Cannot read property ${val} of ${obj}`));
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  if (value && typeof value.then === 'function') {
    return new RuntimePromise(value, errorContext);
  }
  return value;
}

async function _memberLookupScriptAsyncComplex(obj, val, errorContext) {
  // Collect errors from both inputs
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve the values
  try {
    const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

    // Collect errors from BOTH resolved values (never miss any error principle)
    const objPoison = isPoison(resolvedObj);
    const valPoison = isPoison(resolvedVal);

    if (objPoison && valPoison) {
      // Both poisoned - merge errors
      return createPoison([...resolvedObj.errors, ...resolvedVal.errors]);
    } else if (objPoison) {
      // Only obj poisoned - return it directly
      return resolvedObj;
    } else if (valPoison) {
      // Only val poisoned - return it directly
      return resolvedVal;
    }

    // The call to memberLookupScript can throw a native TypeError if resolvedObj is null/undefined.
    // This try/catch block will handle it and enrich the error with context.
    const result = memberLookupScript(resolvedObj, resolvedVal);

    // Wrap promise results to preserve error context
    // This handles: 1) properties that are promises, 2) getters that return promises
    if (result && typeof result.then === 'function') {
      return new RuntimePromise(result, errorContext);
    }

    return result;
  } catch (err) {
    // If the error is already a PoisonError, propagate it.
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    } else {
      // Otherwise, it's a native error. Enrich it with template context.
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      return createPoison(contextualError);
    }
  }
}

/**
 * Context or frame lookup for templates.
 * Returns undefined if variable not found.
 */
function contextOrFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

/**
 * Var-output lookup for template symbol aliases.
 * Does NOT read frame variables.
 * - If var output exists in active buffer hierarchy, return ordered snapshot.
 * - Otherwise, fall back to context lookup (globals/context vars).
 */
function contextOrVarLookup(_context, frame, name, currentBuffer) {
  const outputRead = varOutputLookup(frame, name, currentBuffer);
  if (outputRead !== undefined) {
    return outputRead;
  }
  return _context.lookup(name);
}

/**
 * Output-only lookup for known declared var outputs.
 * Returns undefined when no output binding is available.
 *
 * Ordering rule:
 * - If the output owner buffer is in the current buffer ancestry, snapshot from
 *   current buffer lane (ordered read).
 * - Otherwise, use finalSnapshot() directly (cross-tree / completed-owner read).
 */
function varOutputLookup(frame, name, currentBuffer) {
  let output = getOutput(frame, name);
  if (!output && currentBuffer && currentBuffer._outputs instanceof Map) {
    output = currentBuffer._outputs.get(name);
  }
  if (!output) {
    return undefined;
  }
  if (isBufferInAncestry(currentBuffer, output._buffer)) {
    if (currentBuffer && currentBuffer.parent && currentBuffer.parent.finished) {
      return output.finalSnapshot();
    }
    // Optional dynamic mode: lazily link current read buffer into the handler lane.
    // This is intentionally flag-guarded so structural prelinking remains the default model,
    // but dynamic compositions can opt in without changing compiler wiring.
    if (LOOKUP_DYNAMIC_OUTPUT_LINKING) {
      ensureReadOutputLink(currentBuffer, output, name);
    }
    return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
  }
  return output.finalSnapshot();
}

/**
 * Context/frame/output lookup for scripts.
 * Order:
 * 1) declared frame variable
 * 2) declared output snapshot in current buffer
 * 3) script-mode context lookup (throws if missing)
 */
function contextOrVarLookupScript(context, frame, name, currentBuffer) {
  let {value: val, frame: f} = frame.lookupAndLocate(name);
  if (f) {
    return val;
  }
  const outputRead = varOutputLookupScript(frame, name, currentBuffer);
  if (outputRead !== undefined) {
    return outputRead;
  }
  return context.lookupScriptMode(name);
}

/**
 * Async context/frame/output lookup for scripts.
 * Returns poison for missing names via context.lookupScriptModeAsync.
 */
function contextOrVarLookupScriptAsync(context, frame, name, currentBuffer, errorContext = null) {
  let {value: val, frame: f} = frame.lookupAndLocate(name);
  if (f) {
    return val;
  }
  const outputRead = varOutputLookupScript(frame, name, currentBuffer);
  if (outputRead !== undefined) {
    return outputRead;
  }
  return context.lookupScriptModeAsync(name, errorContext);
}

// Script-mode output lookup variant:
// for cross-tree reads, prefer producer-buffer snapshots while producer is live
// to avoid waiting on full finalization of the output stream.
function varOutputLookupScript(frame, name, currentBuffer) {
  let output = getOutput(frame, name);
  if (!output && currentBuffer && currentBuffer._outputs instanceof Map) {
    output = currentBuffer._outputs.get(name);
  }
  if (!output) {
    return undefined;
  }
  if (isBufferInAncestry(currentBuffer, output._buffer)) {
    if (currentBuffer && currentBuffer.parent && currentBuffer.parent.finished) {
      return output.finalSnapshot();
    }
    if (LOOKUP_DYNAMIC_OUTPUT_LINKING) {
      ensureReadOutputLink(currentBuffer, output, name);
    }
    return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
  }
  if (output._buffer && !output._buffer.finished) {
    return output._buffer.addSnapshot(name, { lineno: 0, colno: 0 });
  }
  return output.finalSnapshot();
}

// Dynamically links the current read buffer into the target handler lane once.
// This is used only when LOOKUP_DYNAMIC_OUTPUT_LINKING is enabled.
function ensureReadOutputLink(currentBuffer, output, outputName) {
  if (!currentBuffer || !output || output._buffer === currentBuffer) {
    return;
  }
  const parent = currentBuffer.parent;
  if (!parent || typeof parent.addBuffer !== 'function') {
    return;
  }
  currentBuffer._readOutputLinks = currentBuffer._readOutputLinks || Object.create(null);
  if (currentBuffer._readOutputLinks[outputName]) {
    return;
  }
  parent.addBuffer(currentBuffer, outputName);
  currentBuffer._readOutputLinks[outputName] = true;
}

// Returns true when `ancestor` is on the parent chain of `buffer`.
// Used to decide whether an ordered lane snapshot is valid from current buffer.
function isBufferInAncestry(buffer, ancestor) {
  let current = buffer;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

module.exports = {
  memberLookup,
  memberLookupScript,
  memberLookupAsync,
  memberLookupScriptAsync,
  contextOrFrameLookup,
  varOutputLookup,
  contextOrVarLookup,
  contextOrVarLookupScript,
  contextOrVarLookupScriptAsync,
};
