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

function _mergeChannelNames(...arrays) {
  const merged = new Set();
  for (let i = 0; i < arrays.length; i++) {
    _addChannelNames(merged, arrays[i]);
  }
  return Array.from(merged);
}

function _cloneErrorContext(errorContext) {
  if (!errorContext || typeof errorContext !== 'object') {
    return null;
  }
  return {
    lineno: typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
    colno: typeof errorContext.colno === 'number' ? errorContext.colno : 0,
    errorContextString: errorContext.errorContextString || null,
    path: errorContext.path || null
  };
}

function _inheritanceMetadataErrorContext(originContext, fallbackContext = null) {
  if (!originContext && !fallbackContext) {
    return null;
  }
  const origin = _cloneErrorContext(originContext);
  const fallback = _cloneErrorContext(fallbackContext);
  if (!origin) {
    return fallback;
  }
  if (origin.path || origin.errorContextString || origin.lineno || origin.colno) {
    return origin;
  }
  origin.path = (fallback && fallback.path) || origin.path;
  origin.errorContextString = (fallback && fallback.errorContextString) || origin.errorContextString;
  origin.lineno = origin.lineno || (fallback && fallback.lineno) || 0;
  origin.colno = origin.colno || (fallback && fallback.colno) || 0;
  return origin;
}

function _getInvokedMethodReferenceName(reference, fallbackName) {
  if (reference && typeof reference === 'object' && typeof reference.name === 'string') {
    return reference.name;
  }
  if (typeof reference === 'string') {
    return reference;
  }
  return fallbackName;
}

function _getInvokedMethodReferenceOrigin(reference, fallbackContext = null) {
  return _inheritanceMetadataErrorContext(
    reference && typeof reference === 'object' ? reference.origin : null,
    fallbackContext
  );
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

function _buildResolvedMethodDataBase(entry) {
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
  const resolvedData = {
    fn: entry.fn,
    ownerKey: entry.ownerKey || null,
    signature: _normalizeMethodSignature(entry.signature, null),
    ownUsedChannels,
    ownMutatedChannels,
    mergedUsedChannels: ownUsedChannels,
    mergedMutatedChannels: ownMutatedChannels,
    super: null,
    invokedMethods: Object.create(null)
  };
  return resolvedData;
}

function _finalizeResolvedMethodData(resolvedData, entry, superData = null, invokedMethods = null) {
  resolvedData.signature = _normalizeMethodSignature(entry.signature, superData ? superData.signature : null);
  resolvedData.super = superData || null;
  resolvedData.invokedMethods = invokedMethods || Object.create(null);
  resolvedData.mergedUsedChannels = _mergeChannelNames(
    resolvedData.mergedUsedChannels,
    superData ? superData.mergedUsedChannels : null
  );
  resolvedData.mergedMutatedChannels = _mergeChannelNames(
    resolvedData.ownMutatedChannels,
    superData ? superData.mergedMutatedChannels : null
  );
  return resolvedData;
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

function _hasNewMetadataErrors(localErrors, initialErrorCount) {
  return localErrors.length > initialErrorCount;
}

function _throwCollectedMetadataErrors(localErrors, errorContext) {
  const aggregateError = inheritanceState.createInheritanceMetadataAggregateError(localErrors, errorContext);
  throw aggregateError ||
    localErrors.find(Boolean) ||
    _createInheritanceMetadataInvariantError(
      'Inheritance metadata finalization reported errors but produced no concrete error values',
      errorContext
    );
}

function _createInvalidInvokedMetadataError(methodData, invokedName, errorContext = null) {
  const ownerSuffix = methodData && methodData.ownerKey
    ? ` on owner '${methodData.ownerKey}'`
    : '';
  return inheritanceState.withInheritanceErrorCode(
    _createInheritanceMetadataInvariantError(
      `Invoked method '${invokedName}'${ownerSuffix} has invalid metadata: expected fully resolved method data`,
      errorContext
    ),
    inheritanceState.ERR_INVALID_INVOKED_METHOD_METADATA
  );
}

function _createInvalidSuperMetadataError(methodData, errorContext = null) {
  const ownerSuffix = methodData && methodData.ownerKey
    ? ` on owner '${methodData.ownerKey}'`
    : '';
  return inheritanceState.withInheritanceErrorCode(
    _createInheritanceMetadataInvariantError(
      `super() metadata${ownerSuffix} is invalid: expected fully resolved method data`,
      errorContext
    ),
    inheritanceState.ERR_INVALID_SUPER_METADATA
  );
}

function _collectResolvedMethodData(state, errorContext = null) {
  const collected = [];
  const seen = new Set();
  const addMethodData = (methodData) => {
    if (!_isResolvedMethodData(methodData) || seen.has(methodData)) {
      return;
    }
    seen.add(methodData);
    collected.push(methodData);
    addMethodData(methodData.super);
    _collectInvokedMethodData(methodData, errorContext).forEach(addMethodData);
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

function _collectInvokedMethodData(methodData, errorContext = null) {
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
    throw _createInvalidInvokedMetadataError(methodData, name, errorContext);
  }
  return resolved;
}

function _createResolvedInvokedMethodsData(invokedMethods, errorContext, state = null) {
  const resolved = Object.create(null);
  if (!invokedMethods || typeof invokedMethods !== 'object') {
    return resolved;
  }
  const names = Object.keys(invokedMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    resolved[name] = _resolveInvokedMethodReference(invokedMethods[name], name, errorContext, state);
  }
  return resolved;
}

function _resolveInvokedMethodReference(reference, fallbackName, errorContext, state = null) {
  if (_isResolvedMethodData(reference)) {
    return reference;
  }

  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  const targetName = _getInvokedMethodReferenceName(reference, fallbackName);
  const originContext = _getInvokedMethodReferenceOrigin(reference, errorContext);
  if (!Object.prototype.hasOwnProperty.call(methods, targetName)) {
    throw _createInheritanceFatalError(
      `Inherited method '${targetName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      originContext
    );
  }
  const methodData = _getMethodDataFromResolvedEntry(methods[targetName], originContext, state);
  return methodData;
}

function _getMethodDataFromResolvedEntry(
  resolvedEntry,
  errorContext,
  state = null
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

  if (resolvedEntry._resolvedMethodData) {
    return resolvedEntry._resolvedMethodData;
  }

  const resolvedMethodData = _buildResolvedMethodDataBase(resolvedEntry);
  // This cached base object exists so recursive super/invoked resolution can
  // share one identity; the metadata-ready barrier prevents external callers
  // from observing it before finalization fills in the remaining graph fields.
  resolvedEntry._resolvedMethodData = resolvedMethodData;

  const superData = resolvedEntry.super
    ? _getMethodDataFromResolvedEntry(
        resolvedEntry.super,
        _inheritanceMetadataErrorContext(resolvedEntry.superOrigin, errorContext),
        state
      )
    : null;

  try {
    const invokedMethods = _createResolvedInvokedMethodsData(
      resolvedEntry.invokedMethods,
      errorContext,
      state
    );
    return _finalizeResolvedMethodData(resolvedMethodData, resolvedEntry, superData, invokedMethods);
  } catch (error) {
    delete resolvedEntry._resolvedMethodData;
    throw error;
  }
}

function getMethodData(state, methodName, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(methods, methodName)) {
    throw _createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
      errorContext
    );
  }

  return _getMethodDataFromResolvedEntry(methods[methodName], errorContext, state);
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state || {});
  if (!Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
    throw _createInheritanceFatalError(
      `Shared channel '${channelName}' was not found`,
      inheritanceState.ERR_SHARED_CHANNEL_NOT_FOUND,
      errorContext
    );
  }

  return sharedSchema[channelName];
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

function getCallableBodyLinkedChannels(methodData, errorContext = null) {
  const resolvedMethodData = _assertResolvedMethodData(methodData);
  if (resolvedMethodData.super && !_isResolvedMethodData(resolvedMethodData.super)) {
    throw _createInvalidSuperMetadataError(resolvedMethodData, errorContext);
  }
  const invokedMethods = resolvedMethodData.invokedMethods && typeof resolvedMethodData.invokedMethods === 'object'
    ? resolvedMethodData.invokedMethods
    : Object.create(null);
  const invokedNames = Object.keys(invokedMethods);

  for (let i = 0; i < invokedNames.length; i++) {
    const invokedName = invokedNames[i];
    const invokedMethodData = invokedMethods[invokedName];
    if (!invokedMethodData) {
      throw _createInheritanceFatalError(
        `Inherited method '${invokedName}' was not found`,
        inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND,
        errorContext
      );
    }
    if (!_isResolvedMethodData(invokedMethodData)) {
      throw _createInvalidInvokedMetadataError(resolvedMethodData, invokedName, errorContext);
    }
  }

  return _getMethodLinkedChannels(resolvedMethodData);
}

function _finalizeInvokedMethodCatalog(state, errorContext = null, errors) {
  const invokedMethods = inheritanceState.ensureInheritanceInvokedMethodsTable(state || {});
  const names = Object.keys(invokedMethods);
  const resolvedCatalog = Object.create(null);

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const reference = invokedMethods[name];
    const originContext = _getInvokedMethodReferenceOrigin(reference, errorContext);
    try {
      resolvedCatalog[name] = _resolveInvokedMethodReference(
        reference,
        name,
        originContext,
        state
      );
    } catch (error) {
      if (
        error &&
        (
          error.code === inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND ||
          error.code === inheritanceState.ERR_SUPER_METHOD_NOT_FOUND
        )
      ) {
        inheritanceState.collectOrThrowInheritanceMetadataError(error, errors);
        continue;
      }
      throw error;
    }
  }

  for (let i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(resolvedCatalog, names[i])) {
      invokedMethods[names[i]] = resolvedCatalog[names[i]];
    }
  }
  return invokedMethods;
}

function _finalizeChannelFootprints(state, errorContext = null) {
  const methodDataList = _collectResolvedMethodData(state, errorContext);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < methodDataList.length; i++) {
      const methodData = methodDataList[i];
      const invokedMethods = _collectInvokedMethodData(methodData, errorContext);
      // Invalid resolved metadata shapes remain fail-fast invariants. Super-chain
      // channel growth stays folded into this same fixed-point walk so we do not
      // reintroduce a second parent-to-child merge phase.
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

function finalizeResolvedMethodMetadata(state, errorContext = null, errors = null) {
  const localErrors = Array.isArray(errors) ? errors : [];
  const initialErrorCount = localErrors.length;
  const methods = inheritanceState.ensureInheritanceMethodsTable(state || {});
  const methodNames = Object.keys(methods);
  for (let i = 0; i < methodNames.length; i++) {
    const name = methodNames[i];
    try {
      // Build and cache methods[name]._resolvedMethodData before the footprint pass.
      _getMethodDataFromResolvedEntry(methods[name], errorContext, state);
    } catch (error) {
      if (
        error &&
        (
          error.code === inheritanceState.ERR_INHERITED_METHOD_NOT_FOUND ||
          error.code === inheritanceState.ERR_SUPER_METHOD_NOT_FOUND
        )
      ) {
        inheritanceState.collectOrThrowInheritanceMetadataError(error, localErrors);
        continue;
      }
      throw error;
    }
  }

  _finalizeInvokedMethodCatalog(state, errorContext, localErrors);
  if (_hasNewMetadataErrors(localErrors, initialErrorCount)) {
    if (!Array.isArray(errors)) {
      _throwCollectedMetadataErrors(localErrors, errorContext);
    }
    return state;
  }
  _finalizeChannelFootprints(state, errorContext);
  return state;
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

function hasLinkedChannelPath(rootBuffer, buffer, channelName) {
  let current = buffer;
  while (current && current.parent) {
    const parent = current.parent;
    if (
      !parent ||
      typeof parent.hasLinkedBuffer !== 'function' ||
      !parent.hasLinkedBuffer(current, channelName)
    ) {
      return false;
    }
    if (parent === rootBuffer) {
      return true;
    }
    current = parent;
  }
  return false;
}

function _markBufferFinish(buffer) {
  if (!buffer || typeof buffer.markFinishedAndPatchLinks !== 'function') {
    return;
  }
  buffer.markFinishedAndPatchLinks();
}

function _invokeResolvedMethodData(command, methodData, invocationBuffer) {
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
}

async function _finishInvocationBuffer(invocationBuffer) {
  if (!invocationBuffer) {
    return;
  }
  _markBufferFinish(invocationBuffer);
  if (typeof invocationBuffer.getFinishedPromise === 'function') {
    await invocationBuffer.getFinishedPromise();
  }
}

function createInheritanceInvocationCommand(spec) {
  const {
    name,
    label = null,
    methodData,
    fallbackToContextOriginalArgs = false,
    normalizeError,
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    invocationBuffer,
    errorContext = null
  } = spec;
  const command = new Command({ withDeferredResult: true });
  command.name = name;
  command.label = label || `Inherited method '${name}'`;
  command.methodData = _assertResolvedMethodData(methodData);
  if (!invocationBuffer) {
    throw _createInheritanceMetadataInvariantError(
      `Inherited method '${name}' reached command creation without an admitted invocation buffer`,
      errorContext
    );
  }
  command.normalizeError = typeof normalizeError === 'function'
    ? normalizeError
    : (error) => _normalizeResolutionError(error, errorContext);
  command.args = Array.isArray(args) ? args : [];
  command.context = context;
  command.inheritanceState = inheritanceStateValue;
  command.env = env;
  command.runtime = runtime;
  command.cb = cb;
  command.invocationBuffer = invocationBuffer;
  command.errorContext = errorContext;
  command.isObservable = false;
  command.fallbackToContextOriginalArgs = !!fallbackToContextOriginalArgs;
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
        const result = await _invokeResolvedMethodData(command, command.methodData, command.invocationBuffer);
        await _finishInvocationBuffer(command.invocationBuffer);
        command._resolveResult(result);
        return result;
      } catch (error) {
        const normalizedError = command.normalizeError(error);
        command._normalizedError = normalizedError;
        command._rejectResult(normalizedError);
        try {
          await _finishInvocationBuffer(command.invocationBuffer);
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

function _assertDirectMethodData(inheritanceStateValue, methodName, errorContext = null) {
  return _assertResolvedMethodData(getMethodData(inheritanceStateValue, methodName, errorContext));
}

function _assertDirectSuperMethodData(inheritanceStateValue, methodName, ownerKey, errorContext = null) {
  const methodData = _assertDirectMethodData(inheritanceStateValue, methodName, errorContext);
  const ownerMethodData = _findMethodDataForOwner(methodData, ownerKey);
  if (!ownerMethodData || !ownerMethodData.super) {
    throw _createInheritanceFatalError(
      `super() for method '${methodName}' was not found`,
      inheritanceState.ERR_SUPER_METHOD_NOT_FOUND,
      errorContext
    );
  }
  return _assertResolvedMethodData(ownerMethodData.super);
}

function _createAdmittedInvocationBuffer(runtime, context, inheritanceStateValue, currentBuffer, methodData) {
  const sharedRootBuffer =
    inheritanceStateValue && inheritanceStateValue.sharedRootBuffer
      ? inheritanceStateValue.sharedRootBuffer
      : currentBuffer;
  const linkedChannels = _getMethodLinkedChannels(methodData);
  const invocationBuffer = runtime.createCommandBuffer(
    context,
    sharedRootBuffer,
    null,
    currentBuffer
  );
  for (let i = 0; i < linkedChannels.length; i++) {
    // The caller link preserves local source order; the shared-root link lets
    // hierarchy-wide shared observations wait on method output from anywhere
    // in the composed chain.
    _registerInvocationChannelLink(currentBuffer, invocationBuffer, linkedChannels[i]);
    if (
      sharedRootBuffer &&
      sharedRootBuffer !== currentBuffer &&
      typeof sharedRootBuffer.addBuffer === 'function' &&
      !hasLinkedChannelPath(sharedRootBuffer, invocationBuffer, linkedChannels[i])
    ) {
      _registerInvocationChannelLink(sharedRootBuffer, invocationBuffer, linkedChannels[i]);
    }
  }
  return invocationBuffer;
}

function _invokeWhenMetadataReady(metadataReadyPromise, invokeFn) {
  if (!metadataReadyPromise || typeof metadataReadyPromise.then !== 'function') {
    // Once readiness has already settled, invariant failures surface as
    // synchronous throws here. If readiness is still pending, the same failure
    // is observed as a rejected promise through the `.then(...)` path below.
    return invokeFn();
  }
  return metadataReadyPromise.then(() => invokeFn());
}

function invokeInheritedMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  return _invokeWhenMetadataReady(metadataReadyPromise, () => {
    const methodData = _assertDirectMethodData(inheritanceStateValue, methodName, errorContext);
    const invocationBuffer = _createAdmittedInvocationBuffer(
      runtime,
      context,
      inheritanceStateValue,
      currentBuffer,
      methodData
    );
    const command = module.exports.createInheritanceInvocationCommand({
      name: methodName,
      label: `Inherited method '${methodName}'`,
      methodData,
      normalizeError: (error) => _normalizeInheritedMethodInvocationError(error, methodName, errorContext),
      args,
      context,
      inheritanceState: inheritanceStateValue,
      env,
      runtime,
      cb,
      invocationBuffer,
      errorContext
    });

    invocationBuffer.add(command, '__invoke__');
    command.apply();
    return command.promise;
  });
}

function invokeSuperMethod(inheritanceStateValue, methodName, ownerKey, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  return _invokeWhenMetadataReady(metadataReadyPromise, () => {
    const methodData = _assertDirectSuperMethodData(inheritanceStateValue, methodName, ownerKey, errorContext);
    const invocationBuffer = _createAdmittedInvocationBuffer(
      runtime,
      context,
      inheritanceStateValue,
      currentBuffer,
      methodData
    );
    const command = module.exports.createInheritanceInvocationCommand({
      name: methodName,
      label: `super() for method '${methodName}'`,
      methodData,
      fallbackToContextOriginalArgs: true,
      normalizeError: (error) => _normalizeResolutionError(error, errorContext),
      args,
      context,
      inheritanceState: inheritanceStateValue,
      env,
      runtime,
      cb,
      invocationBuffer,
      errorContext
    });

    invocationBuffer.add(command, '__invoke__');
    command.apply();
    return command.promise;
  });
}

module.exports = {
  createInheritanceInvocationCommand,
  getMethodData,
  finalizeResolvedMethodMetadata,
  hasLinkedChannelPath,
  getMethodLinkedChannels: _getMethodLinkedChannels,
  getCallableBodyLinkedChannels,
  resolveInheritanceSharedChannel,
  invokeInheritedMethod,
  invokeSuperMethod
};
