'use strict';

import {
  createPoison,
  isPoison,
  isPoisonError,
  handleError,
  RuntimeFatalError,
  RuntimePromise,
  collectErrors,
} from './errors.js';

import inheritanceCall from './inheritance-call.js';
import inheritanceState from './inheritance-state.js';
import {resolveDuo} from './resolve.js';
/**
 * Sync member lookup for templates.
 * Returns undefined if obj is undefined or null.
 */
function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (value && value.isMacro) {
    return value;
  }
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

/**
 * Sync member lookup for scripts.
 * Throws error if obj is null/undefined.
 */
function memberLookupScriptRaw(obj, val) {
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception
    throw new Error(`Cannot read property ${val} of ${obj}`);
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (value && value.isMacro) {
    return value;
  }
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
function memberLookupScript(obj, val, errorContext) {

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupScriptComplex(obj, val, errorContext);
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

  if (obj === undefined || obj === null) {
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

async function _memberLookupScriptComplex(obj, val, errorContext) {
  // Collect errors from both inputs
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve the values
  try {
    const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

    // The call to memberLookupScript can throw a native TypeError if resolvedObj is null/undefined.
    // This try/catch block will handle it and enrich the error with context.
    const result = memberLookupScriptRaw(resolvedObj, resolvedVal);

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

function _getObservationPosition(errorContext) {
  return errorContext && typeof errorContext === 'object'
    ? {
      lineno: typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
      colno: typeof errorContext.colno === 'number' ? errorContext.colno : 0
    }
    : { lineno: 0, colno: 0 };
}

function _addObservationCommand(targetBuffer, channelName, pos, mode) {
  if (targetBuffer.isFinished(channelName)) {
    const channel = targetBuffer.findChannel(channelName);
    if (channel) {
      if (mode === 'snapshot') {
        return channel._getResultOrThrow();
      }
      if (mode === 'isError') {
        return channel._isErrorNow();
      }
      if (mode === 'getError') {
        return channel._getErrorNow();
      }
    }
  }

  if (mode === 'snapshot') {
    return targetBuffer.addSnapshot(channelName, pos);
  }
  if (mode === 'isError') {
    return targetBuffer.addIsError(channelName, pos);
  }
  if (mode === 'getError') {
    return targetBuffer.addGetError(channelName, pos);
  }

  throw new Error(`Unsupported shared-channel observation mode '${mode}'`);
}

function _observeResolvedInheritanceSharedChannel(name, currentBuffer, channelType, pos, errorContext, mode, implicitVarRead) {
  if (implicitVarRead && channelType && channelType !== 'var') {
    throw new RuntimeFatalError(
      `Shared channel '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
      pos.lineno,
      pos.colno,
      errorContext ? errorContext.errorContextString : null,
      errorContext ? errorContext.path : null
    );
  }

  return _addObservationCommand(currentBuffer, name, pos, mode);
}

function observeInheritanceSharedChannel(name, currentBuffer, errorContext = null, inheritanceStateValue = null, mode = 'snapshot', implicitVarRead = false) {
  if (!currentBuffer || !inheritanceStateValue) {
    return undefined;
  }

  const pos = _getObservationPosition(errorContext);
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(inheritanceStateValue || {});
  if (Object.prototype.hasOwnProperty.call(sharedSchema, name)) {
    // The metadata-ready barrier guarantees normal inherited dispatch observes
    // a finalized shared schema before method/block execution starts. Keep the
    // structural link assertion on the same turn so temporary buffer-entry
    // cleanup cannot erase a valid linked path before we enqueue the ordered
    // snapshot command on the current buffer.
    return _observeResolvedInheritanceSharedChannel(
      name,
      currentBuffer,
      sharedSchema[name],
      pos,
      errorContext,
      mode,
      implicitVarRead
    );
  }

  const channelType = inheritanceCall.resolveInheritanceSharedChannel(
    inheritanceStateValue,
    name,
    errorContext
  );
  return _observeResolvedInheritanceSharedChannel(
    name,
    currentBuffer,
    channelType,
    pos,
    errorContext,
    mode,
    implicitVarRead
  );
}

/**
 * Channel-only lookup for known declared var channels.
 * Returns undefined when no channel binding is available.
 *
 * Ordinary lookup never skips to the producer/owner buffer. It issues an
 * ordered snapshot on the current buffer only. CommandBuffer.add owns the
 * local lane assertion so lookup cannot silently create invisible lanes.
 */
function channelLookup(name, currentBuffer) {
  const channel = currentBuffer.findChannel(name);
  if (!channel) {
    return undefined;
  }
  return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
}

export default {
  memberLookup,
  memberLookupScriptRaw,
  memberLookupAsync,
  memberLookupScript,
  observeInheritanceSharedChannel,
  channelLookup,
};
export { memberLookup, memberLookupScriptRaw, memberLookupAsync, memberLookupScript, observeInheritanceSharedChannel, channelLookup };
