'use strict';

const { RuntimeFatalError, isPoison } = require('./errors');
const { resolveDuo } = require('./resolve');

const INTERNAL_INHERITANCE_STATE = typeof Symbol === 'function'
  ? Symbol('cascadaInheritanceInternalState')
  : '__cascadaInheritanceInternalState__';
const INHERITANCE_METADATA_ERROR_KIND = '__cascadaInheritanceMetadataErrorKind';

function tagInheritanceMetadataError(error, kind, methodName = null) {
  if (error && typeof error === 'object') {
    error[INHERITANCE_METADATA_ERROR_KIND] = {
      kind,
      methodName
    };
  }
  return error;
}

function createInheritanceMetadataAggregateError(errors, context = null) {
  const keySeparator = '\0';
  const seen = new Set();
  const normalizedErrors = [];
  (Array.isArray(errors) ? errors : []).forEach((error) => {
    if (!error) {
      return;
    }
    const key = [
      error.path || '',
      typeof error.lineno === 'number' ? error.lineno : '',
      typeof error.colno === 'number' ? error.colno : '',
      error.errorContextString || '',
      error.message || String(error)
    ].join(keySeparator);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    normalizedErrors.push(error);
  });
  if (normalizedErrors.length === 0) {
    return null;
  }
  if (normalizedErrors.length === 1) {
    return normalizedErrors[0];
  }
  const message = `Multiple inheritance metadata errors occurred (${normalizedErrors.length}):\n` +
    normalizedErrors.map((error, index) => `  ${index + 1}. ${error.message || String(error)}`).join('\n');
  const aggregate = new RuntimeFatalError(
    message,
    context && typeof context.lineno === 'number' ? context.lineno : 0,
    context && typeof context.colno === 'number' ? context.colno : 0,
    context && context.errorContextString ? context.errorContextString : null,
    context && context.path ? context.path : null
  );
  aggregate.errors = normalizedErrors;
  return aggregate;
}

function collectOrThrowInheritanceMetadataError(error, errors = null) {
  if (Array.isArray(errors)) {
    errors.push(error);
    return error;
  }
  throw error;
}

function ensureInheritanceMethodsTable(state) {
  if (!state.methods || typeof state.methods !== 'object') {
    state.methods = createInheritanceMethodsTable();
  }
  return state.methods;
}

function ensureInheritanceSharedSchemaTable(state) {
  if (!state.sharedSchema || typeof state.sharedSchema !== 'object') {
    state.sharedSchema = Object.create(null);
  }
  return state.sharedSchema;
}

function ensureInheritanceInvokedMethodsTable(state) {
  if (!state.invokedMethods || typeof state.invokedMethods !== 'object') {
    state.invokedMethods = Object.create(null);
  }
  return state.invokedMethods;
}

function createInheritanceMethodsTable() {
  return Object.create(null);
}

function ensureInheritanceInternalState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }
  if (!state[INTERNAL_INHERITANCE_STATE]) {
    Object.defineProperty(state, INTERNAL_INHERITANCE_STATE, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: {
        startupPromise: null,
        metadataReadyPromise: null,
        metadataReadyResolve: null,
        metadataReadyReject: null,
        // `settled` tracks resolve or reject; `resolved` is success-only and
        // is used to make repeated successful finalization cheap.
        metadataReadySettled: false,
        metadataReadyResolved: false,
        metadataReadyWaiterCount: 0,
        metadataReadyYieldPending: false,
        compositionMode: null,
        chainPathStack: []
      }
    });
  }
  return state[INTERNAL_INHERITANCE_STATE];
}

class InheritanceState {
  constructor() {
    this.methods = createInheritanceMethodsTable();
    this.sharedSchema = Object.create(null);
    this.invokedMethods = Object.create(null);
    this.sharedRootBuffer = null;
    this.compositionPayload = null;
    ensureInheritanceInternalState(this);
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

function setInheritanceStartupPromise(state, promise) {
  const internalState = ensureInheritanceInternalState(state);
  if (internalState) {
    internalState.startupPromise = promise || null;
  }
  return promise;
}

function awaitInheritanceStartup(state) {
  const internalState = ensureInheritanceInternalState(state);
  const promise = internalState ? internalState.startupPromise : null;
  return promise && typeof promise.then === 'function' ? promise : null;
}

function mergeInheritanceStartupPromise(state, promise, currentPromise = null) {
  const normalizedCurrent = currentPromise && typeof currentPromise.then === 'function'
    ? currentPromise
    : awaitInheritanceStartup(state);
  const normalizedNext = promise && typeof promise.then === 'function'
    ? promise
    : null;

  if (!normalizedNext) {
    return normalizedCurrent;
  }

  const merged = normalizedCurrent
    ? resolveDuo(normalizedCurrent, normalizedNext).then((results) => {
      if (isPoison(results)) {
        if (results.errors.length === 1) {
          throw results.errors[0];
        }
        if (results.errors.length > 1) {
          throw createInheritanceMetadataAggregateError(results.errors);
        }
      }
      return results[1];
    })
    : normalizedNext;

  setInheritanceStartupPromise(state, merged);
  return merged;
}

function beginInheritanceMetadataReadiness(state) {
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState || internalState.metadataReadySettled) {
    return null;
  }
  if (!internalState.metadataReadyPromise) {
    internalState.metadataReadyPromise = new Promise((resolve, reject) => {
      internalState.metadataReadyResolve = resolve;
      internalState.metadataReadyReject = reject;
    });
    internalState.metadataReadyPromise.catch(() => {});
  }
  return internalState.metadataReadyPromise;
}

function resolveInheritanceMetadataReadiness(state, value = state) {
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState || internalState.metadataReadySettled) {
    return value;
  }
  internalState.metadataReadySettled = true;
  internalState.metadataReadyResolved = true;
  const hadWaiters = internalState.metadataReadyWaiterCount > 0;
  if (internalState.metadataReadyResolve) {
    internalState.metadataReadyResolve(value);
  }
  internalState.metadataReadyWaiterCount = 0;
  internalState.metadataReadyYieldPending = hadWaiters;
  internalState.metadataReadyPromise = null;
  internalState.metadataReadyResolve = null;
  internalState.metadataReadyReject = null;
  return value;
}

function rejectInheritanceMetadataReadiness(state, error) {
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState || internalState.metadataReadySettled) {
    return error;
  }
  internalState.metadataReadySettled = true;
  internalState.metadataReadyResolved = false;
  if (internalState.metadataReadyReject) {
    internalState.metadataReadyReject(error);
  }
  internalState.metadataReadyWaiterCount = 0;
  internalState.metadataReadyYieldPending = false;
  internalState.metadataReadyPromise = null;
  internalState.metadataReadyResolve = null;
  internalState.metadataReadyReject = null;
  return error;
}

function awaitInheritanceMetadataReadiness(state) {
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState || internalState.metadataReadySettled) {
    return null;
  }
  if (
    internalState.metadataReadyPromise &&
    typeof internalState.metadataReadyPromise.then === 'function'
  ) {
    internalState.metadataReadyWaiterCount++;
    return internalState.metadataReadyPromise;
  }
  return null;
}

function isInheritanceMetadataReadinessResolved(state) {
  const internalState = ensureInheritanceInternalState(state);
  return !!(internalState && internalState.metadataReadyResolved);
}

function consumeInheritanceMetadataReadyYield(state) {
  // If finalization released constructor/invocation waiters, the next startup
  // step yields once so those waiters can enqueue their source-order work.
  // When nobody waited on readiness, startup can continue synchronously.
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState || !internalState.metadataReadyYieldPending) {
    return null;
  }
  internalState.metadataReadyYieldPending = false;
  return Promise.resolve();
}

function setInheritanceCompositionMode(state, mode) {
  const internalState = ensureInheritanceInternalState(state);
  if (internalState) {
    internalState.compositionMode = mode || null;
  }
  return mode;
}

function isInheritanceCompositionMode(state, mode) {
  const internalState = ensureInheritanceInternalState(state);
  return !!internalState && internalState.compositionMode === mode;
}

function enterInheritanceChainPath(state, path, errorContext = null) {
  if (!path) {
    return null;
  }
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState) {
    return null;
  }
  const normalizedPath = String(path);
  if (internalState.chainPathStack.indexOf(normalizedPath) !== -1) {
    const cycle = internalState.chainPathStack.concat([normalizedPath]).join(' -> ');
    throw new RuntimeFatalError(
      `Cyclic extends chain detected: ${cycle}`,
      0,
      0,
      null,
      errorContext && errorContext.path ? errorContext.path : normalizedPath
    );
  }
  internalState.chainPathStack.push(normalizedPath);
  return normalizedPath;
}

function leaveInheritanceChainPath(state, token) {
  if (!token) {
    return;
  }
  const internalState = ensureInheritanceInternalState(state);
  if (!internalState) {
    return;
  }
  const index = internalState.chainPathStack.indexOf(token);
  if (index !== -1) {
    internalState.chainPathStack.splice(index, 1);
  }
}

function releaseInheritanceBootstrapMetadata(state) {
  if (!state || typeof state !== 'object') {
    return state;
  }
  state.invokedMethods = Object.create(null);
  const internalState = ensureInheritanceInternalState(state);
  if (internalState) {
    internalState.chainPathStack = [];
  }
  return state;
}

function cloneInheritanceMethodEntry(entry, clones = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (clones.has(entry)) {
    return clones.get(entry);
  }

  const clonedEntry = Object.assign({}, entry);
  clones.set(entry, clonedEntry);
  clonedEntry.ownUsedChannels = Array.isArray(entry.ownUsedChannels)
    ? entry.ownUsedChannels.slice()
    : [];
  clonedEntry.ownMutatedChannels = Array.isArray(entry.ownMutatedChannels)
    ? entry.ownMutatedChannels.slice()
    : [];
  clonedEntry.invokedMethods = cloneInvokedMethodsMap(entry.invokedMethods);
  clonedEntry.superOrigin = entry.superOrigin && typeof entry.superOrigin === 'object'
    ? Object.assign({}, entry.superOrigin)
    : null;
  clonedEntry.signature = entry.signature && typeof entry.signature === 'object'
    ? {
      argNames: Array.isArray(entry.signature.argNames)
        ? entry.signature.argNames.slice()
        : [],
      withContext: !!entry.signature.withContext
    }
    : { argNames: [], withContext: false };
  clonedEntry.super = cloneInheritanceMethodEntry(entry.super, clones);
  delete clonedEntry._resolvedMethodData;
  return clonedEntry;
}

function cloneInvokedMethodsMap(invokedMethods) {
  const cloned = Object.create(null);
  if (!invokedMethods || typeof invokedMethods !== 'object') {
    return cloned;
  }
  // Values are method-name strings before bootstrap and metadata references
  // after bootstrap; shallow cloning preserves the intended identity in both cases.
  const names = Object.keys(invokedMethods);
  for (let i = 0; i < names.length; i++) {
    const value = invokedMethods[names[i]];
    cloned[names[i]] = value && typeof value === 'object'
      ? Object.assign({}, value, {
        origin: value.origin && typeof value.origin === 'object'
          ? Object.assign({}, value.origin)
          : null
      })
      : value;
  }
  return cloned;
}

function cloneInheritanceMethods(localMethods) {
  if (!localMethods || typeof localMethods !== 'object') {
    return localMethods;
  }

  const clonedMethods = Object.create(null);
  const clones = new Map();
  const names = Object.keys(localMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    clonedMethods[name] = cloneInheritanceMethodEntry(localMethods[name], clones);
  }
  return clonedMethods;
}

function _formatInheritanceSignature(name, signature) {
  const args = Array.isArray(signature && signature.argNames) ? signature.argNames.join(', ') : '';
  const contextSuffix = signature && signature.withContext ? ' with context' : '';
  return `${name}(${args})${contextSuffix}`;
}

function createEmptyConstructorEntry(context = null) {
  const ownerKey = context && context.path ? String(context.path) : '__anonymous__';
  return {
    fn() {
      return null;
    },
    ownUsedChannels: [],
    ownMutatedChannels: [],
    invokedMethods: Object.create(null),
    super: null,
    signature: { argNames: [], withContext: false },
    ownerKey
  };
}

function validateInheritanceContractCompatibility(name, overridingEntry, parentEntry) {
  if (name === '__constructor__') {
    return;
  }

  const overridingSignature = overridingEntry && overridingEntry.signature;
  const parentSignature = parentEntry && parentEntry.signature;
  if (!overridingSignature || !parentSignature) {
    return;
  }

  const overridingNames = Array.isArray(overridingSignature.argNames) ? overridingSignature.argNames : [];
  const parentNames = Array.isArray(parentSignature.argNames) ? parentSignature.argNames : [];
  const overridingOmittedSignature = overridingNames.length === 0 && !overridingSignature.withContext;
  if (overridingOmittedSignature) {
    return;
  }
  const sameLength = overridingNames.length === parentNames.length;
  const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
  const sameContextMode = !!overridingSignature.withContext === !!parentSignature.withContext;
  if (sameNames && sameContextMode) {
    return;
  }

  throw new RuntimeFatalError(
    `block "${name}" signature mismatch: overriding block declares ${_formatInheritanceSignature(name, overridingSignature)} but parent declares ${_formatInheritanceSignature(name, parentSignature)}`,
    0,
    0,
    null,
    null
  );
}

// Raw callable entries use `super` as a small lifecycle field:
// `true` means "this callable uses super() and parent metadata is not wired",
// `false` means "no super() call", an object is the resolved parent entry, and
// `null` is the normalized no-parent state after finalization.
function isUnresolvedSuperEntry(entry) {
  return entry === true;
}

function wireResolvedSuperEntry(targetEntry, parentEntry) {
  let current = targetEntry;
  while (
    current &&
    typeof current === 'object' &&
    !isUnresolvedSuperEntry(current.super) &&
    current.super
  ) {
    current = current.super;
  }
  if (current === parentEntry) {
    return false;
  }
  if (current && typeof current === 'object' && isUnresolvedSuperEntry(current.super)) {
    current.super = parentEntry;
    // Only raw pre-finalization entries carry this cache; publishing replaces
    // state.methods with direct execution entries that do not need invalidation.
    delete current._resolvedMethodData;
    return true;
  }
  if (current && typeof current === 'object' && !current.super) {
    current.super = parentEntry;
    // Only raw pre-finalization entries carry this cache; publishing replaces
    // state.methods with direct execution entries that do not need invalidation.
    delete current._resolvedMethodData;
    return true;
  }
  return false;
}

function registerInheritanceMethods(state, localMethods, context = null) {
  const sharedMethods = ensureInheritanceMethodsTable(state);
  if (!localMethods || typeof localMethods !== 'object') {
    return sharedMethods;
  }
  const isolatedLocalMethods = cloneInheritanceMethods(localMethods);

  const names = Object.keys(isolatedLocalMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const localEntry = isolatedLocalMethods[name];
    if (!localEntry) {
      continue;
    }

    const currentEntry = sharedMethods[name];
    if (!currentEntry) {
      sharedMethods[name] = localEntry;
      continue;
    }
    if (currentEntry === localEntry) {
      continue;
    }
    if (
      currentEntry.ownerKey &&
      localEntry.ownerKey &&
      currentEntry.ownerKey === localEntry.ownerKey
    ) {
      continue;
    }

    validateInheritanceContractCompatibility(name, currentEntry, localEntry);
    wireResolvedSuperEntry(currentEntry, localEntry);
  }

  return sharedMethods;
}

function registerInheritanceSharedSchema(state, localSharedSchema, context = null) {
  const sharedSchema = ensureInheritanceSharedSchemaTable(state);
  if (!localSharedSchema || typeof localSharedSchema !== 'object') {
    return sharedSchema;
  }
  const names = Object.keys(localSharedSchema);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const localEntry = localSharedSchema[name];
    const currentEntry = sharedSchema[name];
    if (!currentEntry) {
      sharedSchema[name] = localEntry;
      continue;
    }
    if (currentEntry === localEntry) {
      continue;
    }
    throw new RuntimeFatalError(
      `shared channel '${name}' was declared as '${currentEntry}' and '${localEntry}'`,
      0,
      0,
      null,
      context && context.path ? context.path : null
    );
  }

  return sharedSchema;
}

function registerInheritanceInvokedMethods(state, localInvokedMethods, context = null) {
  const invokedMethods = ensureInheritanceInvokedMethodsTable(state);
  if (!localInvokedMethods || typeof localInvokedMethods !== 'object') {
    return invokedMethods;
  }
  const names = Object.keys(localInvokedMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name) {
      continue;
    }
    const localEntry = localInvokedMethods[name];
    if (localEntry && typeof localEntry === 'object') {
      invokedMethods[name] = Object.assign({}, localEntry, {
        origin: localEntry.origin && typeof localEntry.origin === 'object'
          ? Object.assign({}, localEntry.origin)
          : null
      });
      continue;
    }
    invokedMethods[name] = {
      name: typeof localEntry === 'string' ? localEntry : name,
      origin: {
        path: context && context.path ? context.path : null
      }
    };
  }
  return invokedMethods;
}

function validateInheritanceSharedMethodNameCollisions(state, context = null, errors = null) {
  const methods = ensureInheritanceMethodsTable(state);
  const sharedSchema = ensureInheritanceSharedSchemaTable(state);
  const names = Object.keys(sharedSchema);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!Object.prototype.hasOwnProperty.call(methods, name)) {
      continue;
    }
    const methodEntry = methods[name];
    const path = methodEntry && methodEntry.ownerKey
      ? methodEntry.ownerKey
      : context && context.path
        ? context.path
        : null;
    const error = new RuntimeFatalError(
      `shared channel '${name}' conflicts with inherited method '${name}'`,
      0,
      0,
      null,
      path
    );
    collectOrThrowInheritanceMetadataError(error, errors);
  }
  return state;
}

function finalizeInheritanceMethods(state, context = null, errors = null) {
  const sharedMethods = ensureInheritanceMethodsTable(state);
  const names = Object.keys(sharedMethods);
  let emptyConstructorEntry = null;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = sharedMethods[name];
    let superOwner = entry && typeof entry === 'object' ? entry : null;
    while (
      superOwner &&
      typeof superOwner === 'object' &&
      !isUnresolvedSuperEntry(superOwner.super) &&
      superOwner.super
    ) {
      superOwner = superOwner.super;
    }
    const superEntry = superOwner && typeof superOwner === 'object' ? superOwner.super : null;
    if (isUnresolvedSuperEntry(superEntry)) {
      if (name === '__constructor__') {
        if (!emptyConstructorEntry) {
          emptyConstructorEntry = createEmptyConstructorEntry(context);
        }
        superOwner.super = emptyConstructorEntry;
        delete superOwner._resolvedMethodData;
        continue;
      }
      const superOrigin = superOwner && superOwner.superOrigin && typeof superOwner.superOrigin === 'object'
        ? superOwner.superOrigin
        : null;
      collectOrThrowInheritanceMetadataError(
        tagInheritanceMetadataError(
          new RuntimeFatalError(
            `super() for method '${name}' was not found`,
            superOrigin && typeof superOrigin.lineno === 'number' ? superOrigin.lineno : 0,
            superOrigin && typeof superOrigin.colno === 'number' ? superOrigin.colno : 0,
            superOrigin && superOrigin.errorContextString ? superOrigin.errorContextString : null,
            superOrigin && superOrigin.path ? superOrigin.path : superOwner.ownerKey || (context && context.path ? context.path : null)
          ),
          'missing-super-method',
          name
        ),
        errors
      );
    } else if (superOwner && superOwner.super === false) {
      superOwner.super = null;
    }
  }
  return sharedMethods;
}

module.exports = {
  InheritanceState,
  createInheritanceState,
  setInheritanceStartupPromise,
  awaitInheritanceStartup,
  mergeInheritanceStartupPromise,
  beginInheritanceMetadataReadiness,
  resolveInheritanceMetadataReadiness,
  rejectInheritanceMetadataReadiness,
  awaitInheritanceMetadataReadiness,
  isInheritanceMetadataReadinessResolved,
  consumeInheritanceMetadataReadyYield,
  setInheritanceCompositionMode,
  isInheritanceCompositionMode,
  enterInheritanceChainPath,
  leaveInheritanceChainPath,
  cloneInheritanceMethodEntry,
  cloneInheritanceMethods,
  ensureInheritanceMethodsTable,
  ensureInheritanceSharedSchemaTable,
  ensureInheritanceInvokedMethodsTable,
  registerInheritanceMethods,
  wireResolvedSuperEntry,
  registerInheritanceSharedSchema,
  registerInheritanceInvokedMethods,
  validateInheritanceSharedMethodNameCollisions,
  finalizeInheritanceMethods,
  releaseInheritanceBootstrapMetadata,
  createEmptyConstructorEntry,
  createInheritanceMetadataAggregateError,
  collectOrThrowInheritanceMetadataError,
};
