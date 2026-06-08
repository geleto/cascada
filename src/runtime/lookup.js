
import {
  createPoison,
  isPoison,
  PoisonError,
  RuntimeError,
  poisonOrReport,
  valueWithOrigin,
} from './errors.js';

import {resolveDuo} from './resolve.js';
import {SnapshotCommand, IsErrorCommand, GetErrorCommand} from './commands/observation.js';
import {getSharedSourceName} from '../inheritance/shared-names.js';
import {formatDiagnosticValue} from './error-format.js';
import {isScalarPrimitive} from '../lib.js';
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

function formatLookupValue(value) {
  return formatDiagnosticValue(value, new Set());
}

function memberLookupScriptResolved(obj, val, errorContext) {
  if (obj === undefined || obj === null) {
    return createPoison(PoisonError.create(`Cannot read property ${formatLookupValue(val)} of ${formatLookupValue(obj)}`, errorContext, 'NullLookup'));
  }

  let value;
  try {
    value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'LookupThrew'));
  }

  if (value === undefined && isScalarPrimitive(obj)) {
    return createPoison(PoisonError.create(`Cannot read property ${formatLookupValue(val)} of ${formatLookupValue(obj)}`, errorContext, 'ScalarLookup'));
  }
  if (value && value.isMacro) {
    return value;
  }
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return valueWithOrigin(value, errorContext, 'LookupThrew');
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
    return createPoison(PoisonError.group([...obj.errors, ...val.errors]));
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  // No errors - proceed with lookup
  const result = memberLookup(obj, val);
  return valueWithOrigin(result, errorContext, 'LookupThrew');
}

async function _memberLookupAsyncComplex(obj, val, errorContext, currentBuffer = null) {
  // Resolve both inputs. Poison input values propagate as poison; a non-poison
  // failure indicates a missing source wrapper or runtime bug. Lookup itself only
  // owns errors thrown while reading the resolved value below.
  let resolvedObj;
  let resolvedVal;
  try {
    [resolvedObj, resolvedVal] = await resolveDuo(obj, val);
  } catch (err) {
    return poisonOrReport(err, errorContext);
  }

  try {
    const result = memberLookup(resolvedObj, resolvedVal);
    return valueWithOrigin(result, errorContext, 'LookupThrew');
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'LookupThrew'));
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
    return createPoison(PoisonError.group([...obj.errors, ...val.errors]));
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  return memberLookupScriptResolved(obj, val, errorContext);
}

async function _memberLookupScriptComplex(obj, val, errorContext, currentBuffer = null) {
  // Resolve both inputs. Poison input values propagate as poison; a non-poison
  // failure indicates a missing source wrapper or runtime bug. Script lookup
  // itself only owns errors thrown while reading the resolved value below.
  let resolvedObj;
  let resolvedVal;
  try {
    [resolvedObj, resolvedVal] = await resolveDuo(obj, val);
  } catch (err) {
    return poisonOrReport(err, errorContext);
  }

  return memberLookupScriptResolved(resolvedObj, resolvedVal, errorContext);
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

function observeInheritanceSharedChain(name, currentBuffer, errorContext, inheritanceStateValue = null, mode = 'snapshot', implicitVarRead = false) {
  if (!currentBuffer || !inheritanceStateValue) {
    return undefined;
  }

  const runtimeSharedSchema = inheritanceStateValue.runtimeState?.sharedSchema ?? null;
  if (runtimeSharedSchema) {
    const schemaEntry = runtimeSharedSchema[name] ?? null;
    if (!schemaEntry) {
      const sourceName = getSharedSourceName(name);
      RuntimeError.reportAndThrow(
        `unknown inherited shared chain '${sourceName}'`,
        errorContext
      );
    }
    if (implicitVarRead && schemaEntry.type && schemaEntry.type !== 'var') {
      const sourceName = getSharedSourceName(name);
      RuntimeError.reportAndThrow(
        `Shared chain 'this.${sourceName}' cannot be used as a bare symbol. Use 'this.${sourceName}.snapshot()' instead.`,
        errorContext
      );
    }
    return _addObservationCommand(currentBuffer, name, errorContext, mode);
  }

  const sourceName = getSharedSourceName(name);
  RuntimeError.reportAndThrow(
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

export { memberLookup, memberLookupAsync, memberLookupScript, observeInheritanceSharedChain, chainLookup };
