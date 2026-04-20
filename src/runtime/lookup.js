'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  handleError,
  RuntimeFatalError,
  RuntimePromise,
  collectErrors,
} = require('./errors');
const { LOOKUP_DYNAMIC_CHANNEL_LINKING } = require('../feature-flags');
const inheritanceCall = require('./inheritance-call');
const inheritanceState = require('./inheritance-state');

const {
  resolveDuo
} = require('./resolve');
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
function memberLookupScriptRaw(obj, val) {
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

  // No errors - proceed with lookup
  // Let native error throw; it will be caught by the top-level sync try/catch.
  //return memberLookupScriptRaw(obj, val);

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

/**
 * Async template symbol lookup through declared channels first, then context.
 */
function contextOrChannelLookup(_context, name, currentBuffer) {
  const channelRead = channelLookup(name, currentBuffer);
  if (channelRead !== undefined) {
    return channelRead;
  }
  return _context.lookup(name);
}

/**
 * Capture the current template symbol value for an explicit composition
 * boundary such as `extends ... with ...`.
 *
 * Unlike channelLookup(), this does not perform an ordered snapshot read.
 * It captures the value that exists at the current source position so the
 * caller can pass that plain value (or promise) through an explicit
 * composition payload.
 */
function captureCompositionValue(_context, name, currentBuffer) {
  const channelRead = channelLookup(name, currentBuffer);
  if (channelRead !== undefined) {
    return channelRead;
  }
  return _context.lookup(name);
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

function _resolveSharedObservationTarget(currentBuffer, name) {
  const channel = currentBuffer && typeof currentBuffer.findChannel === 'function'
    ? currentBuffer.findChannel(name)
    : null;

  if (!channel) {
    return {
      buffer: currentBuffer,
      channelName: name
    };
  }

  if (isBufferInAncestry(currentBuffer, channel._buffer)) {
    return {
      buffer: currentBuffer,
      channelName: name
    };
  }

  return {
    buffer: channel._buffer,
    channelName: channel._channelName
  };
}

function observeInheritanceSharedChannel(name, currentBuffer, errorContext = null, inheritanceStateValue = null, mode = 'snapshot', implicitVarRead = false) {
  if (!currentBuffer || !inheritanceStateValue) {
    return undefined;
  }

  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(inheritanceStateValue);
  if (!Object.prototype.hasOwnProperty.call(sharedSchema, name)) {
    return undefined;
  }

  const pos = _getObservationPosition(errorContext);

  return inheritanceCall.resolveInheritanceSharedChannel(inheritanceStateValue, name, errorContext).then((channelMeta) => {
    if (implicitVarRead && channelMeta && channelMeta.type && channelMeta.type !== 'var') {
      throw new RuntimeFatalError(
        `Shared channel '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
        pos.lineno,
        pos.colno,
        errorContext ? errorContext.errorContextString : null,
        errorContext ? errorContext.path : null
      );
    }

    const target = _resolveSharedObservationTarget(currentBuffer, name);
    return _addObservationCommand(target.buffer, target.channelName, pos, mode);
  });
}

/**
 * Channel-only lookup for known declared var channels.
 * Returns undefined when no channel binding is available.
 *
 * Ordering rule:
 * - If the channel owner buffer is in the current buffer ancestry, snapshot from
 *   current buffer lane (ordered read).
 * - Otherwise, snapshot from the producer buffer lane.
 *
 * Ordinary symbol reads are not terminal consumers and must not use
 * finalSnapshot(); only explicit finalization sites may do that.
 */
function channelLookup(name, currentBuffer) {
  const channel = currentBuffer.findChannel(name);
  if (!channel) {
    return undefined;
  }
  if (isBlockedInheritanceBoundaryChannelRead(currentBuffer, channel)) {
    return undefined;
  }
  if (isBufferInAncestry(currentBuffer, channel._buffer)) {
    // Optional dynamic mode: lazily link current read buffer into the channel lane.
    // This is intentionally flag-guarded so structural prelinking remains the default model,
    // but dynamic compositions can opt in without changing compiler wiring.
    if (LOOKUP_DYNAMIC_CHANNEL_LINKING) {
      ensureReadChannelLink(currentBuffer, channel, name);
    }
    return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
  }
  return channel._buffer.addSnapshot(channel._channelName, { lineno: 0, colno: 0 });
}

/**
 * Async context/frame/channel lookup for scripts.
 * Returns poison for missing names via context.lookupScript.
 */
function contextOrScriptChannelLookup(context, name, currentBuffer, errorContext = null) {
  const channel = currentBuffer && typeof currentBuffer.findChannel === 'function'
    ? currentBuffer.findChannel(name)
    : null;
  if (channel && isBlockedInheritanceBoundaryChannelRead(currentBuffer, channel)) {
    return undefined;
  }
  const channelRead = channelLookup(name, currentBuffer);
  if (channelRead !== undefined) {
    return channelRead;
  }
  return context.lookupScript(name, errorContext);
}

function captureCompositionScriptValue(context, name, currentBuffer, errorContext = null) {
  const channelRead = channelLookup(name, currentBuffer);
  if (channelRead !== undefined) {
    return channelRead;
  }
  return context.lookupScript(name, errorContext);
}

// Temporary Step C fence until later payload work removes the need for linked
// buffers to act as a source of ordinary bare-name lookup across templates.
function isBlockedInheritanceBoundaryChannelRead(currentBuffer, channel) {
  if (!currentBuffer || !channel || channel._buffer === currentBuffer) {
    return false;
  }
  if (channel._allowsInheritanceBoundaryRead) {
    return false;
  }
  const currentPath = currentBuffer._context ? currentBuffer._context.path : null;
  const channelPath = channel._context ? channel._context.path : null;
  return !!(currentPath && channelPath !== currentPath);
}

// Dynamically links the current read buffer into the target channel lane once.
// This is used only when LOOKUP_DYNAMIC_CHANNEL_LINKING is enabled.
function ensureReadChannelLink(currentBuffer, channel, channelName) {
  if (channel._buffer === currentBuffer) {
    return;
  }
  const parent = currentBuffer.parent;
  currentBuffer._readChannelLinks = currentBuffer._readChannelLinks || Object.create(null);
  if (currentBuffer._readChannelLinks[channelName]) {
    return;
  }
  parent.addBuffer(currentBuffer, channelName);
  currentBuffer._readChannelLinks[channelName] = true;
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
  memberLookupScriptRaw,
  memberLookupAsync,
  memberLookupScript,
  observeInheritanceSharedChannel,
  channelLookup,
  contextOrChannelLookup,
  captureCompositionValue,
  contextOrScriptChannelLookup,
  captureCompositionScriptValue,
};
