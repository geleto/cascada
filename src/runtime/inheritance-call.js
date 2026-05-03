
import {Command} from './channels/command-base.js';
import * as inheritanceState from './inheritance-state.js';
import {RuntimeFatalError, handleError, isRuntimeFatalError} from './errors.js';

const INHERITANCE_METADATA_ERROR_KIND = '__cascadaInheritanceMetadataErrorKind';

function _contextualizeFatalError(error, errorContext, fallbackMessage = null) {
  const lineno = errorContext?.lineno ?? 0;
  const colno = errorContext?.colno ?? 0;
  const errorContextString = errorContext?.errorContextString ?? null;
  const path = errorContext?.path ?? null;
  const message = fallbackMessage ?? error?.message ?? 'Inherited dispatch failed';
  const contextualError = new RuntimeFatalError(message, lineno, colno, errorContextString, path);
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
    errorContext?.lineno ?? 0,
    errorContext?.colno ?? 0,
    errorContext?.errorContextString ?? null,
    errorContext?.path ?? null
  );
}

function _createInheritanceFatalError(message, errorContext = null) {
  return _contextualizeFatalError(
    new RuntimeFatalError(message, 0, 0, null, null),
    errorContext
  );
}

function _createInheritanceMetadataInvariantError(message, errorContext = null) {
  return _contextualizeFatalError(
    new RuntimeFatalError(message, 0, 0, null, null),
    errorContext
  );
}

function _tagInheritanceMetadataError(error, kind, methodName = null) {
  if (error && typeof error === 'object') {
    error[INHERITANCE_METADATA_ERROR_KIND] = {
      kind,
      methodName
    };
  }
  return error;
}

function _createMissingInheritedMethodError(methodName, errorContext = null) {
  return _tagInheritanceMetadataError(
    _createInheritanceFatalError(
      `Inherited method '${methodName}' was not found`,
      errorContext
    ),
    'missing-inherited-method',
    methodName
  );
}

function _createMissingSuperMethodError(methodName, errorContext = null) {
  return _tagInheritanceMetadataError(
    _createInheritanceFatalError(
      `super() for method '${methodName}' was not found`,
      errorContext
    ),
    'missing-super-method',
    methodName
  );
}

function _addChannelNames(target, names) {
  for (const name of names ?? []) {
    if (name) {
      target.add(name);
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
  if (!errorContext) {
    return null;
  }
  return { ...errorContext };
}

function _inheritanceMetadataErrorContext(originContext, fallbackContext = null) {
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
    reference?.origin ?? null,
    fallbackContext
  );
}

function _normalizeMethodSignature(signature, inheritedSignature = null) {
  let normalizedSignature = signature
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

function _getMethodIdentity(entry, methodName = null) {
  const ownerKey = entry?.ownerKey ? ` in ${entry.ownerKey}` : '';
  return `${methodName || 'unknown'}${ownerKey}`;
}

function _buildResolvedMethodDataBase(entry, methodName = null, errorContext = null) {
  if (!entry || typeof entry.fn !== 'function') {
    throw new RuntimeFatalError(
      `Inherited dispatch for method '${methodName || 'unknown'}' resolved to an invalid method entry`,
      errorContext?.lineno ?? 0,
      errorContext?.colno ?? 0,
      errorContext?.errorContextString ?? null,
      errorContext?.path ?? null
    );
  }

  if (!Array.isArray(entry.ownLinkedChannels)) {
    throw new RuntimeFatalError(
      `Inherited method '${_getMethodIdentity(entry, methodName)}' metadata is missing ownLinkedChannels`,
      errorContext?.lineno ?? 0,
      errorContext?.colno ?? 0,
      errorContext?.errorContextString ?? null,
      errorContext?.path ?? null
    );
  }
  if (!Array.isArray(entry.ownMutatedChannels)) {
    throw new RuntimeFatalError(
      `Inherited method '${_getMethodIdentity(entry, methodName)}' metadata is missing ownMutatedChannels`,
      errorContext?.lineno ?? 0,
      errorContext?.colno ?? 0,
      errorContext?.errorContextString ?? null,
      errorContext?.path ?? null
    );
  }
  // Mutated channels are not used for admission today. They are kept as a
  // transitive footprint for a finer read/write scheduler where read-only calls
  // on a channel do not block later reads of that channel.
  const ownMutatedChannels = _mergeChannelNames(entry.ownMutatedChannels);
  const ownLinkedChannels = _mergeChannelNames(entry.ownLinkedChannels);
  const resolvedData = {
    fn: entry.fn,
    ownerKey: entry.ownerKey ?? null,
    signature: _normalizeMethodSignature(entry.signature, null),
    mergedMutatedChannels: ownMutatedChannels,
    mergedLinkedChannels: ownLinkedChannels,
    super: null,
    invokedMethods: Object.create(null)
  };
  return resolvedData;
}

function _finalizeResolvedMethodData(resolvedData, entry, superData = null, invokedMethods = null) {
  resolvedData.signature = _normalizeMethodSignature(entry.signature, superData?.signature ?? null);
  resolvedData.super = superData ?? null;
  resolvedData.invokedMethods = invokedMethods ?? Object.create(null);
  resolvedData.mergedMutatedChannels = _mergeChannelNames(
    resolvedData.mergedMutatedChannels,
    superData?.mergedMutatedChannels
  );
  resolvedData.mergedLinkedChannels = _mergeChannelNames(
    resolvedData.mergedLinkedChannels,
    superData?.mergedLinkedChannels
  );
  return resolvedData;
}

function _isResolvedMethodData(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    typeof value.fn === 'function' &&
    Array.isArray(value.mergedMutatedChannels) &&
    Array.isArray(value.mergedLinkedChannels)
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
  const ownerSuffix = methodData?.ownerKey
    ? ` on owner '${methodData.ownerKey}'`
    : '';
  return _createInheritanceMetadataInvariantError(
    `Invoked method '${invokedName}'${ownerSuffix} has invalid metadata: expected fully resolved method data`,
    errorContext
  );
}

function _createInvalidSuperMetadataError(methodData, errorContext = null) {
  const ownerSuffix = methodData?.ownerKey
    ? ` on owner '${methodData.ownerKey}'`
    : '';
  return _createInheritanceMetadataInvariantError(
    `super() metadata${ownerSuffix} is invalid: expected fully resolved method data`,
    errorContext
  );
}

function _isCollectableInheritanceMetadataError(error) {
  const metadata = error && error[INHERITANCE_METADATA_ERROR_KIND];
  return !!(
    metadata &&
    (
      metadata.kind === 'missing-inherited-method' ||
      metadata.kind === 'missing-super-method'
    )
  );
}

function _hasCollectedMissingSuperError(errors, methodName) {
  return errors.some((error) => {
    const metadata = error && error[INHERITANCE_METADATA_ERROR_KIND];
    return !!(
      metadata &&
      metadata.kind === 'missing-super-method' &&
      metadata.methodName === methodName
    );
  });
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

  const methods = inheritanceState.ensureInheritanceMethodsTable(state);
  Object.keys(methods).forEach((name) => {
    const entry = methods[name];
    // Before the execution table is published, raw entries expose their
    // in-progress resolved graph through this private finalization cache.
    addMethodData(_isResolvedMethodData(entry) ? entry : entry._resolvedMethodData);
  });

  const invokedMethods = inheritanceState.ensureInheritanceInvokedMethodsTable(state);
  Object.keys(invokedMethods).forEach((name) => addMethodData(invokedMethods[name]));

  return collected;
}

function _collectInvokedMethodData(methodData, errorContext = null) {
  const invoked = methodData.invokedMethods ?? {};
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
  const names = Object.keys(invokedMethods ?? {});
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

  const methods = inheritanceState.ensureInheritanceMethodsTable(state);
  const targetName = _getInvokedMethodReferenceName(reference, fallbackName);
  const originContext = _getInvokedMethodReferenceOrigin(reference, errorContext);
  if (!methods[targetName]) {
    throw _createMissingInheritedMethodError(targetName, originContext);
  }
  const methodData = _getMethodDataFromResolvedEntry(methods[targetName], originContext, state, targetName);
  return methodData;
}

function _getMethodDataFromResolvedEntry(
  resolvedEntry,
  errorContext,
  state = null,
  methodName = null
) {
  if (_isResolvedMethodData(resolvedEntry)) {
    return resolvedEntry;
  }

  if (resolvedEntry === true) {
    const name = methodName || 'unknown';
    throw _createMissingSuperMethodError(name, errorContext);
  }

  if (!resolvedEntry) {
    throw new RuntimeFatalError(
      'Inherited dispatch resolved to an invalid method entry',
      0,
      0,
      null,
      null
    );
  }

  if (resolvedEntry._resolvedMethodData) {
    // Bootstrap/finalization-only cache: after publication, state.methods holds
    // execution method data directly and returns through the resolved-data path.
    return resolvedEntry._resolvedMethodData;
  }

  const resolvedMethodData = _buildResolvedMethodDataBase(resolvedEntry, methodName, errorContext);
  // This cached base object exists so recursive super/invoked resolution can
  // share one identity; the metadata-ready barrier prevents external callers
  // from observing it before finalization fills in the remaining graph fields.
  resolvedEntry._resolvedMethodData = resolvedMethodData;

  const superData = resolvedEntry.super
    ? _getMethodDataFromResolvedEntry(
      resolvedEntry.super,
      _inheritanceMetadataErrorContext(resolvedEntry.superOrigin, errorContext),
      state,
      methodName
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
  const methods = inheritanceState.ensureInheritanceMethodsTable(state);
  if (!methods[methodName]) {
    throw _createMissingInheritedMethodError(methodName, errorContext);
  }

  return _getMethodDataFromResolvedEntry(methods[methodName], errorContext, state, methodName);
}

function _pruneExecutionMethodData(methodData, seen) {
  if (!methodData || seen.has(methodData)) {
    return;
  }
  seen.add(methodData);
  _pruneExecutionMethodData(methodData.super, seen);
  delete methodData.ownMutatedChannels;
  delete methodData.ownLinkedChannels;
  delete methodData.invokedMethods;
}

function _publishExecutionMethodTable(state, errorContext = null) {
  const methods = inheritanceState.ensureInheritanceMethodsTable(state);
  const names = Object.keys(methods);
  const executionMethods = Object.create(null);
  const seen = new Set();

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const methodData = _getMethodDataFromResolvedEntry(methods[name], errorContext, state, name);
    _pruneExecutionMethodData(methodData, seen);
    executionMethods[name] = methodData;
  }

  state.methods = executionMethods;
  return executionMethods;
}

function resolveInheritanceSharedChannel(state, channelName, errorContext = null) {
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(state);
  if (!sharedSchema[channelName]) {
    throw _createInheritanceFatalError(
      `Shared channel '${channelName}' was not found`,
      errorContext
    );
  }

  return sharedSchema[channelName];
}

function _findMethodDataForOwner(methodData, ownerKey) {
  let current = methodData;
  while (current) {
    if (current.ownerKey === ownerKey) {
      return current;
    }
    current = current.super;
  }
  return null;
}

function _getMethodLinkedChannels(methodData) {
  return _assertResolvedMethodData(methodData).mergedLinkedChannels;
}

function _getMethodMutatedChannels(methodData) {
  return _assertResolvedMethodData(methodData).mergedMutatedChannels;
}

function getCallableBodyLinkedChannelsImpl(methodData, errorContext = null) {
  const resolvedMethodData = _assertResolvedMethodData(methodData);
  if (resolvedMethodData.super && !_isResolvedMethodData(resolvedMethodData.super)) {
    throw _createInvalidSuperMetadataError(resolvedMethodData, errorContext);
  }

  return _getMethodLinkedChannels(resolvedMethodData);
}

function getCallableBodyMutatedChannelsImpl(methodData, errorContext = null) {
  const resolvedMethodData = _assertResolvedMethodData(methodData);
  if (resolvedMethodData.super && !_isResolvedMethodData(resolvedMethodData.super)) {
    throw _createInvalidSuperMetadataError(resolvedMethodData, errorContext);
  }

  return _getMethodMutatedChannels(resolvedMethodData);
}

function _finalizeInvokedMethodCatalog(state, errorContext = null, errors) {
  const invokedMethods = inheritanceState.ensureInheritanceInvokedMethodsTable(state);
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
      if (_isCollectableInheritanceMetadataError(error)) {
        inheritanceState.collectOrThrowInheritanceMetadataError(error, errors);
        continue;
      }
      throw error;
    }
  }

  for (let i = 0; i < names.length; i++) {
    if (resolvedCatalog[names[i]]) {
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
      // `mergedMutatedChannels` intentionally follows the same hierarchy and
      // invoked-method closure as links, but remains separate for future
      // read/write scheduling.
      const nextMutatedChannels = _mergeChannelNames(
        methodData.mergedMutatedChannels,
        methodData.super?.mergedMutatedChannels,
        ...invokedMethods.map((entry) => entry.mergedMutatedChannels)
      );
      const nextLinkedChannels = _mergeChannelNames(
        methodData.mergedLinkedChannels,
        methodData.super?.mergedLinkedChannels,
        ...invokedMethods.map((entry) => entry.mergedLinkedChannels)
      );
      if (!_channelArraysEqual(methodData.mergedMutatedChannels, nextMutatedChannels)) {
        methodData.mergedMutatedChannels = nextMutatedChannels;
        changed = true;
      }
      if (!_channelArraysEqual(methodData.mergedLinkedChannels, nextLinkedChannels)) {
        methodData.mergedLinkedChannels = nextLinkedChannels;
        changed = true;
      }
    }
  }
  return state;
}

function finalizeResolvedMethodMetadata(state, errorContext = null, errors = null) {
  const localErrors = Array.isArray(errors) ? errors : [];
  const initialErrorCount = localErrors.length;
  const methods = inheritanceState.ensureInheritanceMethodsTable(state);
  const methodNames = Object.keys(methods);
  for (let i = 0; i < methodNames.length; i++) {
    const name = methodNames[i];
    try {
      // Build and cache raw methods before the footprint pass. On a repeated
      // finalization call, already-published execution entries pass through.
      _getMethodDataFromResolvedEntry(methods[name], errorContext, state, name);
    } catch (error) {
      if (_isCollectableInheritanceMetadataError(error)) {
        if (_hasCollectedMissingSuperError(localErrors, name)) {
          continue;
        }
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
  _publishExecutionMethodTable(state, errorContext);
  return state;
}

function _assertResolvedMethodData(methodData) {
  // Give incomplete resolved metadata specific errors; the generic check below
  // still covers null, missing fn, and entries with both channel arrays absent.
  if (
    methodData &&
    typeof methodData === 'object' &&
    typeof methodData.fn === 'function' &&
    !Array.isArray(methodData.mergedMutatedChannels) &&
    Array.isArray(methodData.mergedLinkedChannels)
  ) {
    throw new RuntimeFatalError(
      `Inherited method '${_getMethodIdentity(methodData)}' resolved metadata is missing mergedMutatedChannels`,
      0,
      0,
      null,
      null
    );
  }
  if (
    methodData &&
    typeof methodData === 'object' &&
    typeof methodData.fn === 'function' &&
    Array.isArray(methodData.mergedMutatedChannels) &&
    !Array.isArray(methodData.mergedLinkedChannels)
  ) {
    throw new RuntimeFatalError(
      `Inherited method '${_getMethodIdentity(methodData)}' resolved metadata is missing mergedLinkedChannels`,
      0,
      0,
      null,
      null
    );
  }
  // Catches null, missing fn, and both arrays absent; the specific checks
  // above only fire when one channel array is present.
  if (!_isResolvedMethodData(methodData)) {
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
  const signature = methodData.signature ?? { argNames: [], withContext: false };
  const argNames = signature.argNames ?? [];
  let values = args ?? [];

  if (
    fallbackToContextOriginalArgs &&
    values.length === 0 &&
    argNames.length > 0 &&
    context.getCompositionContextVariables
  ) {
    const originalArgs = context.getCompositionContextVariables() ?? {};
    values = argNames.map((name) => originalArgs[name]);
  }

  if (values.length > argNames.length) {
    throw new RuntimeFatalError(
      `${label} received too many arguments`,
      errorContext?.lineno ?? 0,
      errorContext?.colno ?? 0,
      errorContext?.errorContextString ?? null,
      errorContext?.path ?? null
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

function _installInvocationChannelLink(parentBuffer, invocationBuffer, channelName, isLinkedMutation = false) {
  const channel = parentBuffer.getChannelIfExists(channelName);
  if (!channel) {
    throw _createMissingInvocationChannelError(channelName, invocationBuffer?._context ?? parentBuffer?._context ?? null);
  }
  if (parentBuffer === invocationBuffer) {
    invocationBuffer._installLinkedChannel(channelName, channel);
    if (isLinkedMutation) {
      invocationBuffer._markLinkedMutatedChannel(channelName);
    }
    return true;
  }
  if (parentBuffer.isChannelFinished(channelName) || parentBuffer.isFinished()) {
    invocationBuffer._installLinkedChannel(channelName, channel);
    if (isLinkedMutation) {
      invocationBuffer._markLinkedMutatedChannel(channelName);
    }
    return true;
  }
  parentBuffer.addBuffer(invocationBuffer, channelName);
  if (isLinkedMutation) {
    invocationBuffer._markLinkedMutatedChannel(channelName);
  }
  return true;
}

function _markBufferFinish(buffer) {
  buffer.finish();
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
  _markBufferFinish(invocationBuffer);
  await invocationBuffer.getFinishedPromise();
}

function createInheritanceInvocationCommandImpl(spec) {
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
  command.normalizeError = typeof normalizeError === 'function'
    ? normalizeError
    : (error) => _normalizeResolutionError(error, errorContext);
  command.args = args ?? [];
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
  return getMethodData(inheritanceStateValue, methodName, errorContext);
}

function _assertDirectSuperMethodData(inheritanceStateValue, methodName, ownerKey, errorContext = null) {
  const methodData = _assertDirectMethodData(inheritanceStateValue, methodName, errorContext);
  const ownerMethodData = _findMethodDataForOwner(methodData, ownerKey);
  if (!ownerMethodData || !ownerMethodData.super) {
    throw _createMissingSuperMethodError(methodName, errorContext);
  }
  return _assertResolvedMethodData(ownerMethodData.super);
}

function _createAdmittedInvocationBuffer(runtime, context, inheritanceStateValue, currentBuffer, methodData) {
  const sharedRootBuffer = inheritanceStateValue.sharedRootBuffer ?? currentBuffer;
  const linkedChannels = _getMethodLinkedChannels(methodData);
  const mutatedChannelSet = new Set(_getMethodMutatedChannels(methodData));
  const sharedSchema = inheritanceState.ensureInheritanceSharedSchemaTable(inheritanceStateValue);
  const invocationBuffer = runtime.createCommandBuffer(
    context,
    sharedRootBuffer,
    null,
    currentBuffer
  );
  for (let i = 0; i < linkedChannels.length; i++) {
    const channelName = linkedChannels[i];
    const isSharedChannel = Object.prototype.hasOwnProperty.call(sharedSchema, channelName);
    const callerChannel = currentBuffer.getChannelIfExists(channelName);
    const callerHasChannel = !!callerChannel;
    if (!callerHasChannel && !isSharedChannel) {
      throw _createMissingInvocationChannelError(channelName, context);
    }
    if (callerHasChannel) {
      _installInvocationChannelLink(currentBuffer, invocationBuffer, channelName, mutatedChannelSet.has(channelName));
    }
    if (isSharedChannel && sharedRootBuffer !== currentBuffer) {
      const sharedRootChannel = sharedRootBuffer
        ? sharedRootBuffer.getChannelIfExists(channelName)
        : null;
      if (!sharedRootChannel) {
        throw _createMissingSharedChannelError(channelName, context);
      }
      if (callerChannel === sharedRootChannel) {
        // The caller path already addresses the shared-root channel object, so
        // installing the same invocation buffer through the shared root would
        // duplicate the method body in that lane.
        continue;
      }
      _installInvocationChannelLink(sharedRootBuffer, invocationBuffer, channelName, mutatedChannelSet.has(channelName));
    } else if (isSharedChannel && !callerHasChannel) {
      throw _createMissingSharedChannelError(channelName, context);
    }
  }
  return invocationBuffer;
}

function _createMissingInvocationChannelError(channelName, context = null) {
  return new RuntimeFatalError(
    `method channel '${channelName}' was registered for linking but no runtime channel is available in the linking parent`,
    context?.lineno ?? 0,
    context?.colno ?? 0,
    context?.errorContextString ?? null,
    context?.path ?? null
  );
}

function _createMissingSharedChannelError(channelName, context = null) {
  return new RuntimeFatalError(
    `shared channel '${channelName}' was registered but no runtime channel is available for linking`,
    context?.lineno ?? 0,
    context?.colno ?? 0,
    context?.errorContextString ?? null,
    context?.path ?? null
  );
}

function _invokeWhenMetadataReady(metadataReadyPromise, invokeFn) {
  if (!metadataReadyPromise) {
    // Once readiness has already settled, invariant failures surface as
    // synchronous throws here. If readiness is still pending, the same failure
    // is observed as a rejected promise through the `.then(...)` path below.
    return invokeFn();
  }
  return metadataReadyPromise.then(() => invokeFn());
}

function _admitResolvedMethodInvocation({
  name,
  label,
  methodData,
  normalizeError,
  fallbackToContextOriginalArgs = false,
  args,
  context,
  inheritanceState: inheritanceStateValue,
  env,
  runtime,
  cb,
  currentBuffer,
  errorContext = null
}) {
  const invocationBuffer = _createAdmittedInvocationBuffer(
    runtime,
    context,
    inheritanceStateValue,
    currentBuffer,
    methodData
  );
  const command = inheritanceCallApi.createInheritanceInvocationCommand({
    name,
    label,
    methodData,
    fallbackToContextOriginalArgs,
    normalizeError,
    args,
    context,
    inheritanceState: inheritanceStateValue,
    env,
    runtime,
    cb,
    invocationBuffer,
    errorContext
  });

  invocationBuffer.addCommand(command, '__invoke__');
  command.apply();
  return command.promise;
}

function invokeInheritedMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  return _invokeWhenMetadataReady(metadataReadyPromise, () => {
    const methodData = _assertDirectMethodData(inheritanceStateValue, methodName, errorContext);
    return _admitResolvedMethodInvocation({
      name: methodName,
      label: `Inherited method '${methodName}'`,
      methodData,
      normalizeError: (error) => _normalizeResolutionError(error, errorContext),
      args,
      context,
      inheritanceState: inheritanceStateValue,
      env,
      runtime,
      cb,
      currentBuffer,
      errorContext
    });
  });
}

function invokeSuperMethod(inheritanceStateValue, methodName, ownerKey, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  return _invokeWhenMetadataReady(metadataReadyPromise, () => {
    const methodData = _assertDirectSuperMethodData(inheritanceStateValue, methodName, ownerKey, errorContext);
    return _admitResolvedMethodInvocation({
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
      currentBuffer,
      errorContext
    });
  });
}

function invokeComponentMethod(inheritanceStateValue, methodName, args, context, env, runtime, cb, currentBuffer, errorContext = null) {
  const metadataReadyPromise = inheritanceState.awaitInheritanceMetadataReadiness(inheritanceStateValue);
  return _invokeWhenMetadataReady(metadataReadyPromise, () => {
    const methodData = _assertDirectMethodData(inheritanceStateValue, methodName, errorContext);
    return _admitResolvedMethodInvocation({
      name: methodName,
      label: `Component method '${methodName}'`,
      methodData,
      normalizeError: (error) => _normalizeResolutionError(error, errorContext),
      args,
      context,
      inheritanceState: inheritanceStateValue,
      env,
      runtime,
      cb,
      currentBuffer,
      errorContext
    });
  });
}

let createInheritanceInvocationCommandHook = createInheritanceInvocationCommandImpl;
let getCallableBodyLinkedChannelsHook = getCallableBodyLinkedChannelsImpl;
let getCallableBodyMutatedChannelsHook = getCallableBodyMutatedChannelsImpl;

const inheritanceCallApi = {};
Object.defineProperties(inheritanceCallApi, {
  createInheritanceInvocationCommand: {
    get: () => createInheritanceInvocationCommandHook,
    set: (value) => { createInheritanceInvocationCommandHook = value; }
  },
  getCallableBodyLinkedChannels: {
    get: () => getCallableBodyLinkedChannelsHook,
    set: (value) => { getCallableBodyLinkedChannelsHook = value; }
  },
  getCallableBodyMutatedChannels: {
    get: () => getCallableBodyMutatedChannelsHook,
    set: (value) => { getCallableBodyMutatedChannelsHook = value; }
  },
  getMethodData: { value: getMethodData },
  finalizeResolvedMethodMetadata: { value: finalizeResolvedMethodMetadata },
  resolveInheritanceSharedChannel: { value: resolveInheritanceSharedChannel },
  invokeInheritedMethod: { value: invokeInheritedMethod },
  invokeSuperMethod: { value: invokeSuperMethod },
  invokeComponentMethod: { value: invokeComponentMethod }
});
Object.freeze(inheritanceCallApi);

function createInheritanceInvocationCommand(spec) {
  return createInheritanceInvocationCommandHook.apply(this, arguments);
}

function getCallableBodyLinkedChannels(methodData, errorContext = null) {
  return getCallableBodyLinkedChannelsHook.apply(this, arguments);
}

function getCallableBodyMutatedChannels(methodData, errorContext = null) {
  return getCallableBodyMutatedChannelsHook.apply(this, arguments);
}

export { inheritanceCallApi, createInheritanceInvocationCommand, getMethodData, finalizeResolvedMethodMetadata, getCallableBodyLinkedChannels, getCallableBodyMutatedChannels, resolveInheritanceSharedChannel, invokeInheritedMethod, invokeSuperMethod, invokeComponentMethod };
