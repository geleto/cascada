'use strict';

const { Command } = require('./commands');
const inheritanceState = require('./inheritance-state');
const { RuntimeFatalError, handleError, isRuntimeFatalError } = require('./errors');

function _contextualizeFatalError(error, errorContext, fallbackMessage = null) {
  const lineno = errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0;
  const colno = errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0;
  const errorContextString = errorContext && errorContext.errorContextString ? errorContext.errorContextString : null;
  const path = errorContext && errorContext.path ? errorContext.path : null;
  const message = fallbackMessage || (error && error.message) || 'Inherited dispatch failed';
  const contextualError = new RuntimeFatalError(message, lineno, colno, errorContextString, path);
  if (error && error.code) {
    contextualError.code = error.code;
  }
  return contextualError;
}

function _hasResolvedErrorLocation(error) {
  return !!(
    error &&
    (
      error.path ||
      error.errorContextString ||
      (typeof error.lineno === 'number' && error.lineno !== 0) ||
      (typeof error.colno === 'number' && error.colno !== 0)
    )
  );
}

function _normalizeResolutionError(error, errorContext) {
  if (isRuntimeFatalError(error)) {
    if (!_hasResolvedErrorLocation(error)) {
      return _contextualizeFatalError(error, errorContext);
    }
    return error;
  }

  return handleError(
    error,
    errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
    errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
    errorContext ? errorContext.errorContextString : null,
    errorContext ? errorContext.path : null
  );
}

function _createInheritanceFatalError(message, code, errorContext = null) {
  return inheritanceState.withInheritanceErrorCode(
    _contextualizeFatalError(
      new RuntimeFatalError(message, 0, 0, null, null),
      errorContext
    ),
    code
  );
}

function _createInheritanceMetadataInvariantError(message, errorContext = null) {
  return _contextualizeFatalError(
    new RuntimeFatalError(message, 0, 0, null, null),
    errorContext
  );
}

function _normalizeInheritedMethodInvocationError(error, methodName, errorContext) {
  if (error && error.code === inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND) {
    return _createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      errorContext
    );
  }
  return _normalizeResolutionError(error, errorContext);
}

function _addChannelNames(target, names) {
  if (!Array.isArray(names)) {
    return;
  }

  for (let i = 0; i < names.length; i++) {
    if (names[i]) {
      target.add(names[i]);
    }
  }
}

function _mergeChannelNames() {
  const merged = new Set();
  for (let i = 0; i < arguments.length; i++) {
    _addChannelNames(merged, arguments[i]);
  }
  return Array.from(merged);
}

function _filterSharedLookupChannels(sharedLookupCandidates, sharedSchema) {
  if (!Array.isArray(sharedLookupCandidates) || sharedLookupCandidates.length === 0 || !sharedSchema) {
    return [];
  }

  const filtered = [];
  for (let i = 0; i < sharedLookupCandidates.length; i++) {
    const name = sharedLookupCandidates[i];
    if (name && Object.prototype.hasOwnProperty.call(sharedSchema, name)) {
      filtered.push(name);
    }
  }
  return filtered;
}

function _resolvePendingInheritanceEntryChain(entry, normalizeError) {
  if (inheritanceState.isPendingInheritanceEntry(entry)) {
    return entry.promise.then(
      (resolvedEntry) => _resolvePendingInheritanceEntryChain(resolvedEntry, normalizeError),
      (error) => {
        throw normalizeError(error);
      }
    );
  }

  return entry;
}

function _normalizeMethodSignature(signature, inheritedSignature = null) {
  let normalizedSignature = signature && typeof signature === 'object'
    ? {
      argNames: Array.isArray(signature.argNames) ? signature.argNames.slice() : [],
      withContext: !!signature.withContext
    }
    : { argNames: [], withContext: false };

  if (!inheritedSignature) {
    return normalizedSignature;
  }

  const localArgNames = normalizedSignature.argNames;
  const inheritedArgNames = Array.isArray(inheritedSignature.argNames)
    ? inheritedSignature.argNames
    : [];

  if (localArgNames.length === 0 && inheritedArgNames.length > 0) {
    normalizedSignature = {
      argNames: inheritedArgNames.slice(),
      withContext: !!(normalizedSignature.withContext || inheritedSignature.withContext)
    };
  } else if (!normalizedSignature.withContext && inheritedSignature.withContext) {
    normalizedSignature = {
      argNames: localArgNames.slice(),
      withContext: true
    };
  }

  return normalizedSignature;
}

function _createResolvedMethodData(entry, sharedSchema = null, superData = null, invokedMethods = null) {
  if (!entry || typeof entry !== 'object' || typeof entry.fn !== 'function') {
    throw new RuntimeFatalError(
      'Inherited dispatch resolved to an invalid method entry',
      0,
      0,
      null,
      null
    );
  }

  const ownUsedChannels = _mergeChannelNames(entry.ownUsedChannels);
  const ownMutatedChannels = _mergeChannelNames(entry.ownMutatedChannels);
  const sharedLookupChannels = _filterSharedLookupChannels(entry.sharedLookupCandidates, sharedSchema);
  const mergedUsedChannels = _mergeChannelNames(
    ownUsedChannels,
    sharedLookupChannels,
    superData ? superData.mergedUsedChannels : null
  );
  const mergedMutatedChannels = _mergeChannelNames(
    ownMutatedChannels,
    superData ? superData.mergedMutatedChannels : null
  );

  return {
    fn: entry.fn,
    ownerKey: entry.ownerKey || null,
    signature: _normalizeMethodSignature(entry.signature, superData ? superData.signature : null),
    ownUsedChannels,
    ownMutatedChannels,
    mergedUsedChannels,
    mergedMutatedChannels,
    super: superData || null,
    invokedMethods: invokedMethods || Object.create(null)
  };
}

function _isResolvedMethodData(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    typeof value.fn === 'function' &&
    Array.isArray(value.mergedUsedChannels) &&
    Array.isArray(value.mergedMutatedChannels) &&
    value.invokedMethods &&
    typeof value.invokedMethods === 'object'
  );
}

function _channelArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function _throwOrReturnOnNewMetadataErrors(localErrors, initialErrorCount, errors, errorContext) {
  if (localErrors.length <= initialErrorCount) {
    return false;
  }
  if (!Array.isArray(errors)) {
    throw inheritanceState.createInheritanceMetadataAggregateError(localErrors, errorContext);
  }
  return true;
}

function _createInvalidInvokedMetadataError(methodData, invokedName, errorContext = null) {
  const ownerSuffix = methodData && methodData.ownerKey
    ? ` on owner '${methodData.ownerKey}'`
    : '';
  return _createInheritanceMetadataInvariantError(
    `Invoked method '${invokedName}'${ownerSuffix} has invalid metadata: expected fully resolved method data`,
    errorContext
  );
}

function _collectResolvedMethodData(state, errorContext = null, errors = null) {
  const collected = [];
  const seen = new Set();
  const addMethodData = (methodData) => {
    if (!_isResolvedMethodData(methodData) || seen.has(methodData)) {
      return;
    }
    seen.add(methodData);
    collected.push(methodData);
    addMethodData(methodData.super);
    _collectInvokedMethodData(methodData, errorContext, errors).forEach(addMethodData);
  };

  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  Object.keys(methods).forEach((name) => {
    const entry = methods[name];
    if (entry && typeof entry === 'object') {
      addMethodData(entry._resolvedMethodData);
    }
  });

  const invokedMethods = inheritanceState.ensureInheritanceInvokedMethodsTable(state || {});
  Object.keys(invokedMethods).forEach((name) => addMethodData(invokedMethods[name]));

  return collected;
}

function _collectInvokedMethodData(methodData, errorContext = null, errors = null) {
  const invoked = methodData && methodData.invokedMethods && typeof methodData.invokedMethods === 'object'
    ? methodData.invokedMethods
    : null;
  if (!invoked) {
    return [];
  }
  const resolved = [];
  const names = Object.keys(invoked);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = invoked[name];
    if (_isResolvedMethodData(entry)) {
      resolved.push(entry);
      continue;
    }
    inheritanceState.collectOrThrowInheritanceMetadataError(
      _createInvalidInvokedMetadataError(methodData, name, errorContext),
      errors
    );
  }
  return resolved;
}

function _createResolvedInvokedMethodsData(invokedMethods, sharedSchema, errorContext, state = null) {
  const resolved = Object.create(null);
  if (!invokedMethods || typeof invokedMethods !== 'object') {
    return resolved;
  }
  const names = Object.keys(invokedMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = invokedMethods[name];
    if (_isResolvedMethodData(entry)) {
      resolved[name] = entry;
      continue;
    }
    if (typeof entry === 'string') {
      const catalog = inheritanceState.ensureInheritanceInvokedMethodsTable(state || {});
      if (_isResolvedMethodData(catalog[entry])) {
        resolved[name] = catalog[entry];
        continue;
      }
    }
    if (!entry || typeof entry !== 'object' || inheritanceState.isPendingInheritanceEntry(entry)) {
      throw _createInheritanceFatalError(
        `Inherited method '${name}' was not found`,
        inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
        errorContext
      );
    }
    const methodData = _getMethodDataFromEntry(entry, sharedSchema, errorContext, state, false);
    if (methodData && typeof methodData.then === 'function') {
      throw _createInheritanceMetadataInvariantError(
        `Inherited method metadata for '${name}' was still pending during invoked-method resolution`,
        errorContext
      );
    }
    resolved[name] = methodData;
  }
  return resolved;
}

function _getMethodDataFromResolvedEntry(
  resolvedEntry,
  sharedSchema,
  errorContext,
  state = null,
  hasWaitedForStartup = false,
  includeInvokedMethods = true
) {
  if (resolvedEntry === true) {
    throw _createInheritanceFatalError(
      'Inherited dispatch reached unresolved super metadata',
      inheritanceState.ERR_SUPER_METHOD_NOT_FOUND,
      errorContext
    );
  }

  if (!resolvedEntry || typeof resolvedEntry !== 'object') {
    throw new RuntimeFatalError(
      'Inherited dispatch resolved to an invalid method entry',
      0,
      0,
      null,
      null
    );
  }

  if (includeInvokedMethods && resolvedEntry._resolvedMethodData) {
    return resolvedEntry._resolvedMethodData;
  }
  if (includeInvokedMethods && resolvedEntry._resolvedMethodDataPromise) {
    return resolvedEntry._resolvedMethodDataPromise;
  }

  if (resolvedEntry.super === true && !hasWaitedForStartup) {
    const startupPromise = inheritanceState.awaitInheritanceStartup(state);
    if (startupPromise && typeof startupPromise.then === 'function') {
      const startupMethodDataPromise = startupPromise.then(() => {
        delete resolvedEntry._resolvedMethodDataPromise;
        return _getMethodDataFromResolvedEntry(resolvedEntry, sharedSchema, errorContext, state, true, includeInvokedMethods);
      });
      if (includeInvokedMethods) {
        resolvedEntry._resolvedMethodDataPromise = startupMethodDataPromise;
      }
      return startupMethodDataPromise;
    }
  }

  const superData = resolvedEntry.super
    ? _getMethodDataFromEntry(resolvedEntry.super, sharedSchema, errorContext, state, includeInvokedMethods)
    : null;

  if (superData && typeof superData.then === 'function') {
    const resolvedMethodDataPromise = superData.then((resolvedSuperData) => {
      const invokedMethods = includeInvokedMethods
        ? _createResolvedInvokedMethodsData(resolvedEntry.invokedMethods, sharedSchema, errorContext, state)
        : Object.create(null);
      const resolvedData = _createResolvedMethodData(resolvedEntry, sharedSchema, resolvedSuperData, invokedMethods);
      if (includeInvokedMethods) {
        resolvedEntry._resolvedMethodData = resolvedData;
        delete resolvedEntry._resolvedMethodDataPromise;
      }
      return resolvedData;
    });
    if (includeInvokedMethods) {
      resolvedEntry._resolvedMethodDataPromise = resolvedMethodDataPromise;
    }
    return resolvedMethodDataPromise;
  }

  const invokedMethods = includeInvokedMethods
    ? _createResolvedInvokedMethodsData(resolvedEntry.invokedMethods, sharedSchema, errorContext, state)
    : Object.create(null);
  const resolvedData = _createResolvedMethodData(resolvedEntry, sharedSchema, superData, invokedMethods);
  if (includeInvokedMethods) {
    resolvedEntry._resolvedMethodData = resolvedData;
  }
  return resolvedData;
}

function _getMethodDataFromEntry(entry, sharedSchema, errorContext, state = null, includeInvokedMethods = true) {
  const resolvedEntry = _resolvePendingInheritanceEntryChain(
    entry,
    (error) => _normalizeResolutionError(error, errorContext)
  );

  if (resolvedEntry && typeof resolvedEntry.then === 'function') {
    return resolvedEntry.then((entryValue) =>
      _getMethodDataFromResolvedEntry(entryValue, sharedSchema, errorContext, state, false, includeInvokedMethods)
    );
  }

  return _getMethodDataFromResolvedEntry(resolvedEntry, sharedSchema, errorContext, state, false, includeInvokedMethods);
}

function getMethodData(state, methodName, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(methods, methodName)) {
    throw _createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      errorContext
    );
  }

  return _getMethodDataFromEntry(methods[methodName], sharedSchema, errorContext, state);
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
    return Promise.reject(_createInheritanceFatalError(
      `Shared channel '${channelName}' was not found`,
      inheritanceState.ERR_SHARED_CHANNEL_NOT_FOUND,
      errorContext
    ));
  }

  return Promise.resolve(sharedSchema[channelName]);
}

function _findMethodDataForOwner(methodData, ownerKey) {
  let current = methodData || null;
  while (current) {
    if (current.ownerKey === ownerKey) {
      return current;
    }
    current = current.super;
  }
  return null;
}

function _getMethodLinkedChannels(methodData) {
  return _mergeChannelNames(
    methodData && methodData.mergedUsedChannels,
    methodData && methodData.mergedMutatedChannels
  );
}

function _findKnownMethodEntryForOwner(entry, ownerKey) {
  let current = entry || null;
  while (current && !inheritanceState.isPendingInheritanceEntry(current)) {
    if (inheritanceState.isUnresolvedSuperEntry(current)) {
      // Transitional Step 1 state: startup can hit super metadata before the
      // active chain load rewrites `true` to the direct parent entry.
      return null;
    }
    if (current.ownerKey === ownerKey) {
      return current;
    }
    current = current.super;
  }
  return null;
}

function _hasPendingMethodMetadata(entry, seen = new Set()) {
  if (!entry || typeof entry !== 'object') {
    return inheritanceState.isUnresolvedSuperEntry(entry);
  }
  if (inheritanceState.isPendingInheritanceEntry(entry) || inheritanceState.isUnresolvedSuperEntry(entry)) {
    return true;
  }
  if (seen.has(entry)) {
    return false;
  }
  seen.add(entry);
  return _hasPendingMethodMetadata(entry.super, seen);
}

function prewarmMethodDataCache(state, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  const names = Object.keys(methods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = methods[name];
    if (!entry || _hasPendingMethodMetadata(entry)) {
      continue;
    }
    const methodData = getMethodData(state, name, errorContext);
    if (methodData && typeof methodData.then === 'function') {
      throw _createInheritanceMetadataInvariantError(
        `Inherited method metadata for '${name}' was still pending during cache prewarm`,
        errorContext
      );
    }
  }
  return state;
}

function resolveAndWireInvokedMethodCatalog(state, errorContext = null) {
  const invokedMethods = inheritanceState.ensureInheritanceInvokedMethodsTable(state || {});
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  const names = Object.keys(invokedMethods);
  const resolvedCatalog = Object.create(null);

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (_isResolvedMethodData(invokedMethods[name])) {
      resolvedCatalog[name] = invokedMethods[name];
      continue;
    }
    const methodData = _getMethodDataFromEntry(invokedMethods[name], sharedSchema, errorContext, state, false);
    if (methodData && typeof methodData.then === 'function') {
      throw _createInheritanceMetadataInvariantError(
        `Inherited method metadata for invoked method '${name}' was still pending during finalization`,
        errorContext
      );
    }
    resolvedCatalog[name] = methodData;
  }

  for (let i = 0; i < names.length; i++) {
    invokedMethods[names[i]] = resolvedCatalog[names[i]];
  }

  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  const methodNames = Object.keys(methods);
  for (let i = 0; i < methodNames.length; i++) {
    const entry = methods[methodNames[i]];
    if (!entry || typeof entry !== 'object' || inheritanceState.isPendingInheritanceEntry(entry)) {
      continue;
    }
    const localInvoked = entry.invokedMethods && typeof entry.invokedMethods === 'object'
      ? entry.invokedMethods
      : Object.create(null);
    const localNames = Object.keys(localInvoked);
    const resolvedLocalInvoked = Object.create(null);
    for (let j = 0; j < localNames.length; j++) {
      const localName = localNames[j];
      const methodName = typeof localInvoked[localName] === 'string'
        ? localInvoked[localName]
        : localName;
      if (!Object.prototype.hasOwnProperty.call(invokedMethods, methodName)) {
        throw _createInheritanceFatalError(
          `Inherited method '${methodName}' was not found`,
          inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
          errorContext
        );
      }
      resolvedLocalInvoked[localName] = invokedMethods[methodName];
    }
    entry.invokedMethods = resolvedLocalInvoked;
    if (Object.prototype.hasOwnProperty.call(invokedMethods, methodNames[i])) {
      entry._resolvedMethodData = invokedMethods[methodNames[i]];
      entry._resolvedMethodData.invokedMethods = resolvedLocalInvoked;
      delete entry._resolvedMethodDataPromise;
    } else {
      delete entry._resolvedMethodData;
      delete entry._resolvedMethodDataPromise;
    }
  }

  return invokedMethods;
}

function finalizeMethodChannelFootprints(state, errorContext = null, errors = null) {
  const localErrors = Array.isArray(errors) ? errors : [];
  const initialErrorCount = localErrors.length;
  const methodDataList = _collectResolvedMethodData(state, errorContext, localErrors);
  if (_throwOrReturnOnNewMetadataErrors(localErrors, initialErrorCount, errors, errorContext)) {
    return state;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < methodDataList.length; i++) {
      const methodData = methodDataList[i];
      const invokedMethods = _collectInvokedMethodData(methodData, errorContext, localErrors);
      // Invalid resolved metadata shapes are impossible for normal compiled
      // input; Step 6 will consolidate these invariant errors into the final
      // metadata-construction path.
      if (_throwOrReturnOnNewMetadataErrors(localErrors, initialErrorCount, errors, errorContext)) {
        return state;
      }
      const nextUsedChannels = _mergeChannelNames(
        methodData.mergedUsedChannels,
        methodData.super ? methodData.super.mergedUsedChannels : null,
        ...invokedMethods.map((entry) => entry.mergedUsedChannels)
      );
      const nextMutatedChannels = _mergeChannelNames(
        methodData.mergedMutatedChannels,
        methodData.super ? methodData.super.mergedMutatedChannels : null,
        ...invokedMethods.map((entry) => entry.mergedMutatedChannels)
      );
      if (!_channelArraysEqual(methodData.mergedUsedChannels, nextUsedChannels)) {
        methodData.mergedUsedChannels = nextUsedChannels;
        changed = true;
      }
      if (!_channelArraysEqual(methodData.mergedMutatedChannels, nextMutatedChannels)) {
        methodData.mergedMutatedChannels = nextMutatedChannels;
        changed = true;
      }
    }
  }
  return state;
}

function _collectKnownEntryChannels(entry) {
  if (!entry || inheritanceState.isPendingInheritanceEntry(entry)) {
    return [];
  }

  return _mergeChannelNames(
    entry.ownUsedChannels,
    entry.ownMutatedChannels,
    _collectKnownEntryChannels(entry.super)
  );
}

function _getInitialInvocationChannels(entry) {
  if (inheritanceState.isPendingInheritanceEntry(entry)) {
    if (Array.isArray(entry.linkedChannels) && entry.linkedChannels.length > 0) {
      return entry.linkedChannels.slice();
    }
    return ['__return__'];
  }

  if (!entry) {
    return ['__return__'];
  }

  return _collectKnownEntryChannels(entry);
}

function _assertResolvedMethodData(methodData) {
  if (!methodData || typeof methodData !== 'object' || typeof methodData.fn !== 'function') {
    throw new RuntimeFatalError(
      'Inherited dispatch resolved to an invalid method entry',
      0,
      0,
      null,
      null
    );
  }
  return methodData;
}

function _createMethodPayload(methodData, args, errorContext, label, context = null, fallbackToContextOriginalArgs = false) {
  const signature = methodData && methodData.signature ? methodData.signature : { argNames: [], withContext: false };
  const argNames = Array.isArray(signature.argNames) ? signature.argNames : [];
  let values = Array.isArray(args) ? args : [];

  if (
    fallbackToContextOriginalArgs &&
    values.length === 0 &&
    argNames.length > 0 &&
    context &&
    typeof context.getCompositionContextVariables === 'function'
  ) {
    const originalArgs = context.getCompositionContextVariables() || {};
    values = argNames.map((name) => originalArgs[name]);
  }

  if (values.length > argNames.length) {
    throw new RuntimeFatalError(
      `${label} received too many arguments`,
      errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
      errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
      errorContext ? errorContext.errorContextString : null,
      errorContext ? errorContext.path : null
    );
  }

  const originalArgs = {};
  for (let i = 0; i < values.length; i++) {
    originalArgs[argNames[i]] = values[i];
  }

  return {
    originalArgs
  };
}

function _registerInvocationChannelLink(currentBuffer, invocationBuffer, channelName) {
  if (!channelName || !currentBuffer || !invocationBuffer || currentBuffer === invocationBuffer) {
    if (invocationBuffer && channelName) {
      invocationBuffer._registerLinkedChannel(channelName);
    }
    return;
  }
  if (
    typeof currentBuffer.hasLinkedBuffer === 'function' &&
    currentBuffer.hasLinkedBuffer(invocationBuffer, channelName)
  ) {
    return;
  }
  if (
    typeof currentBuffer.isFinished === 'function' &&
    (currentBuffer.isFinished(channelName) || currentBuffer.finished)
  ) {
    invocationBuffer._registerLinkedChannel(channelName);
    return;
  }
  currentBuffer.addBuffer(invocationBuffer, channelName);
}

function _markBufferFinish(buffer) {
  if (!buffer || typeof buffer.markFinishedAndPatchLinks !== 'function') {
    return;
  }
  buffer.markFinishedAndPatchLinks();
}

const invocationInternals = {
  ensureInvocationBuffer(command, methodData) {
    const linkedChannels = _getMethodLinkedChannels(methodData);
    const sharedRootBuffer =
      command.inheritanceState && command.inheritanceState.sharedRootBuffer
        ? command.inheritanceState.sharedRootBuffer
        : command.currentBuffer;

    if (!command.invocationBuffer) {
      command.invocationBuffer = command.runtime.createCommandBuffer(
        command.context,
        sharedRootBuffer,
        null,
        command.currentBuffer
      );
    }
    for (let i = 0; i < linkedChannels.length; i++) {
      _registerInvocationChannelLink(command.currentBuffer, command.invocationBuffer, linkedChannels[i]);
    }
    return command.invocationBuffer;
  },

  invokeResolvedMethodData(command, methodData, invocationBuffer) {
    if (command.name === '__constructor__') {
      return methodData.fn(
        command.env,
        command.context,
        command.runtime,
        command.cb,
        invocationBuffer,
        command.inheritanceState
      );
    }

    const payload = _createMethodPayload(
      methodData,
      command.args,
      command.errorContext,
      command.label,
      command.context,
      command.fallbackToContextOriginalArgs
    );
    const renderCtx = methodData.signature && methodData.signature.withContext &&
      command.context && typeof command.context.getRenderContextVariables === 'function'
      ? command.context.getRenderContextVariables()
      : undefined;

    return methodData.fn(
      command.env,
      command.context,
      command.runtime,
      command.cb,
      invocationBuffer,
      payload,
      renderCtx,
      command.inheritanceState,
      methodData
    );
  },

  async finishInvocationBuffer(invocationBuffer) {
    if (!invocationBuffer) {
      return;
    }
    _markBufferFinish(invocationBuffer);
    if (typeof invocationBuffer.getFinishedPromise === 'function') {
      await invocationBuffer.getFinishedPromise();
    }
  }
};

function createInheritanceInvocationCommand(spec) {
  const {
    name,
    label = null,
    getMethodData,
    normalizeError,
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    currentBuffer,
    invocationBuffer,
    errorContext = null
  } = spec;
  const command = new Command({ withDeferredResult: true });
  command.name = name;
  command.label = label || `Inherited method '${name}'`;
  command.getMethodData = getMethodData;
  command.normalizeError = typeof normalizeError === 'function'
    ? normalizeError
    : (error) => _normalizeResolutionError(error, errorContext);
  command.args = Array.isArray(args) ? args : [];
  command.context = context;
  command.inheritanceState = inheritanceStateValue;
  command.env = env;
  command.runtime = runtime;
  command.cb = cb;
  command.currentBuffer = currentBuffer;
  command.invocationBuffer = invocationBuffer || null;
  command.errorContext = errorContext;
  command.isObservable = false;
  command.fallbackToContextOriginalArgs = false;
  command._normalizedError = null;
  command._startPromise = null;
  command._resultSettled = false;

  command.getError = function() {
    return command._normalizedError;
  };

  command._resolveResult = function(value) {
    if (command._resultSettled) {
      return;
    }
    command._resultSettled = true;
    command.resolveResult(value);
  };

  command._rejectResult = function(error) {
    if (command._resultSettled) {
      return;
    }
    command._resultSettled = true;
    command.rejectResult(error);
  };

  command.apply = function() {
    if (command._startPromise) {
      return command._startPromise;
    }

    command._startPromise = (async () => {
      try {
        const methodData = _assertResolvedMethodData(await command.getMethodData());
        const ensuredInvocationBuffer = invocationInternals.ensureInvocationBuffer(command, methodData);
        const result = await invocationInternals.invokeResolvedMethodData(command, methodData, ensuredInvocationBuffer);
        await invocationInternals.finishInvocationBuffer(ensuredInvocationBuffer);
        command._resolveResult(result);
        return result;
      } catch (error) {
        const normalizedError = command.normalizeError(error);
        command._normalizedError = normalizedError;
        command._rejectResult(normalizedError);
        try {
          await invocationInternals.finishInvocationBuffer(command.invocationBuffer);
        } catch (finishError) {
          void finishError;
        }
        throw normalizedError;
      }
    })();

    return command._startPromise;
  };

  return command;
}

function _enqueueInvocationCommand(command, invocationBuffer) {
  invocationBuffer.add(command, '__invoke__');
  command.apply();
  return command.promise;
}

function invokeInheritedMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const initialEntry =
    inheritanceStateValue &&
    inheritanceStateValue.methods &&
    Object.prototype.hasOwnProperty.call(inheritanceStateValue.methods, methodName)
      ? inheritanceStateValue.methods[methodName]
      : null;
  const initialChannels = _getInitialInvocationChannels(initialEntry);
  const sharedRootBuffer =
    inheritanceStateValue && inheritanceStateValue.sharedRootBuffer
      ? inheritanceStateValue.sharedRootBuffer
      : currentBuffer;
  const invocationBuffer = runtime.createCommandBuffer(
    context,
    sharedRootBuffer,
    initialChannels,
    currentBuffer
  );
  const command = module.exports.createInheritanceInvocationCommand({
    name: methodName,
    label: `Inherited method '${methodName}'`,
    getMethodData: () => getMethodData(inheritanceStateValue, methodName, errorContext),
    normalizeError: (error) => _normalizeInheritedMethodInvocationError(error, methodName, errorContext),
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    currentBuffer,
    invocationBuffer,
    errorContext
  });

  return _enqueueInvocationCommand(command, invocationBuffer);
}

function invokeSuperMethod(inheritanceStateValue, methodName, ownerKey, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const rootEntry =
    inheritanceStateValue &&
    inheritanceStateValue.methods &&
    Object.prototype.hasOwnProperty.call(inheritanceStateValue.methods, methodName)
      ? inheritanceStateValue.methods[methodName]
      : null;
  const ownerEntry = _findKnownMethodEntryForOwner(rootEntry, ownerKey);
  const superEntry = ownerEntry && ownerEntry.super ? ownerEntry.super : null;
  const initialChannels = _getInitialInvocationChannels(superEntry);
  const sharedRootBuffer =
    inheritanceStateValue && inheritanceStateValue.sharedRootBuffer
      ? inheritanceStateValue.sharedRootBuffer
      : currentBuffer;
  const invocationBuffer = runtime.createCommandBuffer(
    context,
    sharedRootBuffer,
    initialChannels,
    currentBuffer
  );
  const command = module.exports.createInheritanceInvocationCommand({
    name: methodName,
    label: `super() for method '${methodName}'`,
    getMethodData: async () => {
      const methodData = await getMethodData(inheritanceStateValue, methodName, errorContext);
      const ownerMethodData = _findMethodDataForOwner(methodData, ownerKey);
      if (!ownerMethodData || !ownerMethodData.super) {
        throw _createInheritanceFatalError(
          `super() for method '${methodName}' was not found`,
          inheritanceState.ERR_SUPER_METHOD_NOT_FOUND,
          errorContext
        );
      }
      return ownerMethodData.super;
    },
    normalizeError: (error) => _normalizeResolutionError(error, errorContext),
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    currentBuffer,
    invocationBuffer,
    errorContext
  });
  command.fallbackToContextOriginalArgs = true;

  return _enqueueInvocationCommand(command, invocationBuffer);
}

module.exports = {
  createInheritanceInvocationCommand,
  invocationInternals,
  getMethodData,
  prewarmMethodDataCache,
  resolveAndWireInvokedMethodCatalog,
  finalizeMethodChannelFootprints,
  getMethodLinkedChannels: _getMethodLinkedChannels,
  resolveInheritanceSharedChannel,
  invokeInheritedMethod,
  invokeSuperMethod
};
