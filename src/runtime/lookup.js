
import {
  createPoison,
  isPoison,
  isPoisonError,
  contextualizeError,
  RuntimeFatalError,
  RuntimePromise,
  collectErrors,
} from './errors.js';

import {resolveDuo} from './resolve.js';
import {SnapshotCommand, IsErrorCommand, GetErrorCommand} from './commands/observation.js';
import {getSharedSourceName} from '../inheritance/shared-names.js';
/**
 * Sync member lookup for templates.
 * Returns undefined if obj is undefined or null.
 */
function memberLookupImpl(obj, val) {
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
function memberLookupAsync(obj, val, errorContext, currentBuffer = null) {

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupAsyncComplex(obj, val, errorContext, currentBuffer);
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

async function _memberLookupAsyncComplex(obj, val, errorContext, currentBuffer = null) {
  // Collect errors from both inputs (await all promises)
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors, errorContext);
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
      const contextualError = contextualizeError(err, errorContext);
      return createPoison(contextualError);
    }
  }
}

/**
 * Async member lookup for scripts.
 * Uses sync-first hybrid pattern.
 */
function memberLookupScript(obj, val, errorContext, currentBuffer = null) {

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupScriptComplex(obj, val, errorContext, currentBuffer);
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
    return createPoison(new Error(`Cannot read property ${val} of ${obj}`), errorContext);
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

async function _memberLookupScriptComplex(obj, val, errorContext, currentBuffer = null) {
  // Collect errors from both inputs
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors, errorContext);
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
      const contextualError = contextualizeError(err, errorContext);
      return createPoison(contextualError);
    }
  }
}

function _addObservationCommand(targetBuffer, chainName, errorContext, mode) {
  if (mode === 'snapshot') {
    return targetBuffer.addCommand(new SnapshotCommand({ chainName, errorContext }), chainName);
  }
  if (mode === 'isError') {
    return targetBuffer.addCommand(new IsErrorCommand({ chainName, errorContext }), chainName);
  }
  if (mode === 'getError') {
    return targetBuffer.addCommand(new GetErrorCommand({ chainName, errorContext }), chainName);
  }

  throw new Error(`Unsupported shared-chain observation mode '${mode}'`);
}

function observeInheritanceSharedChain(name, currentBuffer, errorContext = null, inheritanceStateValue = null, mode = 'snapshot', implicitVarRead = false) {
  if (!currentBuffer || !inheritanceStateValue) {
    return undefined;
  }

  const runtimeSharedSchema = inheritanceStateValue.runtimeState?.sharedSchema ?? null;
  if (runtimeSharedSchema) {
    const schemaEntry = runtimeSharedSchema[name] ?? null;
    if (!schemaEntry) {
      const sourceName = getSharedSourceName(name);
      throw new RuntimeFatalError(
        `unknown inherited shared chain '${sourceName}'`,
        errorContext
      );
    }
    if (implicitVarRead && schemaEntry.type && schemaEntry.type !== 'var') {
      const sourceName = getSharedSourceName(name);
      throw new RuntimeFatalError(
        `Shared chain 'this.${sourceName}' cannot be used as a bare symbol. Use 'this.${sourceName}.snapshot()' instead.`,
        errorContext
      );
    }
    return _addObservationCommand(currentBuffer, name, errorContext, mode);
  }

  const sourceName = getSharedSourceName(name);
  throw new RuntimeFatalError(
    `unknown inherited shared chain '${sourceName}'`,
    errorContext
  );
}

/**
 * Chain-only lookup for known declared var chains.
 * Returns undefined when no chain binding is available.
 *
 * Ordinary lookup never skips to the producer/owner buffer. It issues an
 * ordered snapshot on the current buffer only. CommandBuffer.add owns the
 * local lane assertion so lookup cannot silently create invisible lanes.
 */
function chainLookup(name, currentBuffer, errorContext) {
  const chain = currentBuffer.getChainIfExists(name);
  if (!chain) {
    return undefined;
  }
  return currentBuffer.addCommand(new SnapshotCommand({
    chainName: name,
    errorContext
  }), name);
}

const memberLookup = memberLookupImpl;

export { memberLookup, memberLookupScriptRaw, memberLookupAsync, memberLookupScript, observeInheritanceSharedChain, chainLookup };
