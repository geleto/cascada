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
  return captureCompositionValueImpl(name, currentBuffer, () => _context.lookup(name));
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
  const currentPath = currentBuffer && currentBuffer._context ? currentBuffer._context.path : null;
  const channelPath = channel && channel._context ? channel._context.path : null;
  const isCrossTemplateSharedRead = !!(
    channelAllowsCrossTemplateRead(channel) &&
    currentPath &&
    channelPath &&
    channelPath !== currentPath
  );
  if (isBlockedCrossTemplateChannelRead(currentBuffer, channel)) {
    return undefined;
  }
  if (isCrossTemplateSharedRead) {
    return channel._buffer.addSnapshot(channel._channelName, { lineno: 0, colno: 0 });
  }
  const ownerInAncestry = isBufferInAncestry(currentBuffer, channel._buffer);
  if (ownerInAncestry &&
    isChannelLinkedThroughAncestry(currentBuffer, channel._buffer, name)) {
    // Optional dynamic mode: lazily link current read buffer into the channel lane.
    // This is intentionally flag-guarded so structural prelinking remains the default model,
    // but dynamic compositions can opt in without changing compiler wiring.
    if (LOOKUP_DYNAMIC_CHANNEL_LINKING) {
      ensureReadChannelLink(currentBuffer, channel, name);
    }
    return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
  }
  if (ownerInAncestry && !channelAllowsCrossTemplateRead(channel)) {
    throw new RuntimeFatalError(
      `Channel '${name}' is owned by an ancestor buffer but is not linked through the current buffer ancestry`
    );
  }
  // Shared-root channels may be observed from descendant buffers even when
  // some private intermediate buffers do not project that lane. In that case
  // the ordered read must happen on the shared owner channel itself.
  return channel._buffer.addSnapshot(channel._channelName, { lineno: 0, colno: 0 });
}

/**
 * Async context/frame/channel lookup for scripts.
 * Returns poison for missing names via context.lookupScript.
 */
function contextOrScriptChannelLookup(context, name, currentBuffer, errorContext = null) {
  const channelRead = channelLookup(name, currentBuffer);
  if (channelRead !== undefined) {
    return channelRead;
  }
  return context.lookupScript(name, errorContext);
}

function captureCompositionScriptValue(context, name, currentBuffer, errorContext = null) {
  return captureCompositionValueImpl(
    name,
    currentBuffer,
    () => context.lookupScript(name, errorContext)
  );
}

const COMPOSITION_CAPTURE_UNAVAILABLE = Symbol('COMPOSITION_CAPTURE_UNAVAILABLE');

// Explicit composition capture bridge for inheritance payload construction.
// This stays intentionally narrow: it snapshots the current assigned value when
// available, but does not replace ordered channel observation in general.
function captureCompositionValueImpl(name, currentBuffer, fallbackLookup) {
  const channel = currentBuffer.findChannel(name);
  if (channel) {
    const captured = getCurrentCompositionChannelValue(channel);
    if (captured !== COMPOSITION_CAPTURE_UNAVAILABLE) {
      return captured;
    }
  }
  return fallbackLookup();
}

// Composition capture reads the latest assigned value directly from the owning
// channel when the inheritance payload needs an immediate value snapshot.
// This is intentionally separate from ordered snapshot-based observation.
function getCurrentCompositionChannelValue(channel) {
  if (!channel) {
    return COMPOSITION_CAPTURE_UNAVAILABLE;
  }
  if (typeof channel.getTemporaryCompositionAssignedValue === 'function') {
    return channel.getTemporaryCompositionAssignedValue();
  }
  return COMPOSITION_CAPTURE_UNAVAILABLE;
}

// Cross-template bare-name lookup remains blocked for non-shared channels.
// Shared channels are the only lanes that may be observed across template
// boundaries without going through an explicit payload.
function isBlockedCrossTemplateChannelRead(currentBuffer, channel) {
  if (!currentBuffer || !channel || channel._buffer === currentBuffer) {
    return false;
  }
  if (channelAllowsCrossTemplateRead(channel)) {
    return false;
  }
  const currentPath = currentBuffer._context ? currentBuffer._context.path : null;
  const channelPath = channel._context ? channel._context.path : null;
  return !!(currentPath && channelPath !== currentPath);
}

function channelAllowsCrossTemplateRead(channel) {
  return !!(
    channel &&
    typeof channel.allowsCrossTemplateRead === 'function' &&
    channel.allowsCrossTemplateRead()
  );
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

function isChannelLinkedThroughAncestry(buffer, ancestor, channelName) {
  let current = buffer;
  while (current && current !== ancestor) {
    if (!(typeof current.isLinkedChannel === 'function' && current.isLinkedChannel(channelName))) {
      return false;
    }
    current = current.parent;
  }
  return current === ancestor;
}

module.exports = {
  memberLookup,
  memberLookupScriptRaw,
  memberLookupAsync,
  memberLookupScript,
  channelLookup,
  contextOrChannelLookup,
  captureCompositionValue,
  contextOrScriptChannelLookup,
  captureCompositionScriptValue,
};
