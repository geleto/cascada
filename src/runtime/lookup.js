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

function contextOrExternLookup(_context, name) {
  const externContext = _context && typeof _context.getExternContextVariables === 'function'
    ? _context.getExternContextVariables()
    : null;
  if (externContext && Object.prototype.hasOwnProperty.call(externContext, name)) {
    return externContext[name];
  }
  return _context.lookup(name);
}

function _assertChannelReadableFromCurrentBuffer(currentBuffer, channel, requestedName) {
  if (!currentBuffer || !channel || channel._buffer === currentBuffer) {
    return;
  }

  if (isBufferInAncestry(currentBuffer, channel._buffer)) {
    if (!hasLinkedChannelPathToOwner(currentBuffer, channel._buffer, requestedName)) {
      throw new RuntimeFatalError(
        `Channel '${requestedName}' is visible but not linked to the current buffer`,
        0,
        0,
        null,
        currentBuffer && currentBuffer._context ? currentBuffer._context.path : null
      );
    }
  }
}

function captureCompositionValue(_context, name, currentBuffer) {
  const channelRead = currentBuffer && typeof currentBuffer.findChannel === 'function'
    ? channelLookup(name, currentBuffer)
    : undefined;
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
  if (
    targetBuffer &&
    typeof targetBuffer.isFinished === 'function' &&
    targetBuffer.isFinished(channelName) &&
    typeof targetBuffer.findChannel === 'function'
  ) {
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

function _resolveSharedObservationTarget(currentBuffer, name) {
  const channel = currentBuffer && typeof currentBuffer.findChannel === 'function'
    ? currentBuffer.findChannel(name)
    : null;
  if (channel) {
    _assertChannelReadableFromCurrentBuffer(currentBuffer, channel, name);
  }
  return {
    buffer: currentBuffer,
    channelName: name
  };
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

  const target = _resolveSharedObservationTarget(currentBuffer, name);
  return _addObservationCommand(target.buffer, target.channelName, pos, mode);
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
 * ordered snapshot on the current buffer only, and throws if the owning lane
 * is visible but not structurally linked to that current buffer.
 */
function channelLookup(name, currentBuffer) {
  const channel = currentBuffer.findChannel(name);
  if (!channel) {
    return undefined;
  }
  if (isBlockedInheritanceBoundaryChannelRead(currentBuffer, channel)) {
    return undefined;
  }
  _assertChannelReadableFromCurrentBuffer(currentBuffer, channel, name);
  return currentBuffer.addSnapshot(name, { lineno: 0, colno: 0 });
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

// Ordinary var-channel lookup must not turn mere ancestry into ambient
// cross-template visibility. Shared channels use explicit observation helpers.
function isBlockedInheritanceBoundaryChannelRead(currentBuffer, channel) {
  if (!currentBuffer || !channel || channel._buffer === currentBuffer) {
    return false;
  }
  const currentPath = currentBuffer._context ? currentBuffer._context.path : null;
  const channelPath = channel._context ? channel._context.path : null;
  if (!currentPath || channelPath === currentPath) {
    return false;
  }
  // A fully linked ancestor lane is already the structural guarantee we need
  // for an ordered read; do not block it just because the owning template path
  // differs from the current invocation path.
  if (
    isBufferInAncestry(currentBuffer, channel._buffer) &&
    hasLinkedChannelPathToOwner(currentBuffer, channel._buffer, channel._channelName)
  ) {
    return false;
  }
  return true;
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

function hasLinkedChannelPathToOwner(buffer, ownerBuffer, channelName) {
  // A descendant buffer can only observe an ancestor-owned channel through its
  // own lane if every parent/child edge on the way back to the owner is linked
  // for that channel name. Constructor-boundary/template dispatch failures in
  // Phase 9 showed that mere ancestry is not enough.
  let current = buffer;
  while (current && current !== ownerBuffer) {
    const parent = current.parent;
    if (!parent || typeof parent.hasLinkedBuffer !== 'function') {
      return false;
    }
    if (parent.hasLinkedBuffer(current, channelName)) {
      current = parent;
      continue;
    }
    // Late child buffers can be created after an ancestor shared lane has
    // already finished. In that case the parent cannot accept a new buffer
    // edge, so the runtime records the link on the child buffer instead.
    if (
      typeof current.isLinkedChannel === 'function' &&
      current.isLinkedChannel(channelName) &&
      (
        (typeof parent.isFinished === 'function' && parent.isFinished(channelName)) ||
        parent.finished === true
      )
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return current === ownerBuffer;
}

module.exports = {
  memberLookup,
  memberLookupScriptRaw,
  memberLookupAsync,
  memberLookupScript,
  observeInheritanceSharedChannel,
  channelLookup,
  contextOrExternLookup,
  captureCompositionValue,
  contextOrScriptChannelLookup,
};
