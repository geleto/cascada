'use strict';

const { RuntimeFatalError } = require('./errors');

const ERR_INHERITED_METHOD_NOT_FOUND = 'ERR_INHERITED_METHOD_NOT_FOUND';
const ERR_SUPER_METHOD_NOT_FOUND = 'ERR_SUPER_METHOD_NOT_FOUND';
const ERR_SHARED_CHANNEL_NOT_FOUND = 'ERR_SHARED_CHANNEL_NOT_FOUND';
const ERR_INVALID_INVOKED_METHOD_METADATA = 'ERR_INVALID_INVOKED_METHOD_METADATA';
const ERR_INVALID_SUPER_METADATA = 'ERR_INVALID_SUPER_METADATA';
const INTERNAL_INHERITANCE_STATE = typeof Symbol === 'function'
  ? Symbol('cascadaInheritanceInternalState')
  : '__cascadaInheritanceInternalState__';

function withInheritanceErrorCode(error, code) {
  if (error && code) {
    error.code = code;
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
      error.code || '',
      error.path || '',
      typeof error.lineno === 'number' ? error.lineno : '',
      typeof error.colno === 'number' ? error.colno : '',
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

function createPendingInheritanceEntry(linkedChannels = null) {
  let settled = false;
  let settleResolve = null;
  let settleReject = null;
  let promise = new Promise((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  const entry = {
    promise,
    linkedChannels: Array.isArray(linkedChannels) ? linkedChannels.slice() : [],
    resolve(value) {
      if (settled) {
        return value;
      }
      settled = true;
      entry.promise = Promise.resolve(value);
      settleResolve(value);
      return value;
    },
    reject(error) {
      if (settled) {
        return error;
      }
      settled = true;
      entry.promise = Promise.reject(error);
      entry.promise.catch(() => {});
      settleReject(error);
      return error;
    }
  };

  return entry;
}

function isPendingInheritanceEntry(entry) {
  return !!(
    entry &&
    typeof entry === 'object' &&
    typeof entry.promise?.then === 'function' &&
    typeof entry.resolve === 'function' &&
    typeof entry.reject === 'function'
  );
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
        metadataReadyYieldPending: false,
        // Counts registrations only. It is reset on settlement and only drives
        // whether one post-finalization yield is needed.
        metadataReadyWaiterCount: 0,
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
    ? Promise.all([normalizedCurrent, normalizedNext]).then((results) => results[1])
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
  if (internalState.metadataReadyResolve) {
    internalState.metadataReadyResolve(value);
  }
  internalState.metadataReadyYieldPending = internalState.metadataReadyWaiterCount > 0;
  internalState.metadataReadyWaiterCount = 0;
  internalState.metadataReadyPromise = Promise.resolve(value);
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
  internalState.metadataReadyYieldPending = false;
  internalState.metadataReadyWaiterCount = 0;
  internalState.metadataReadyPromise = Promise.reject(error);
  internalState.metadataReadyPromise.catch(() => {});
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
    internalState.metadataReadyWaiterCount += 1;
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

function cloneInheritanceMethodEntry(entry, clones = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (clones.has(entry)) {
    return clones.get(entry);
  }
  if (isPendingInheritanceEntry(entry)) {
    const pendingClone = createPendingInheritanceEntry(entry.linkedChannels);
    if (entry.ownerKey) {
      pendingClone.ownerKey = entry.ownerKey;
    }
    clones.set(entry, pendingClone);
    return pendingClone;
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
  delete clonedEntry._resolvedMethodDataPromise;
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

function resolveInheritanceMethodEntry(sharedMethods, methodName, resolvedEntry) {
  const methods = sharedMethods && typeof sharedMethods === 'object'
    ? sharedMethods
    : Object.create(null);
  const current = methods[methodName];
  if (isPendingInheritanceEntry(current)) {
    current.resolve(resolvedEntry);
    methods[methodName] = resolvedEntry;
  } else if (!current) {
    methods[methodName] = resolvedEntry;
  }
  return methods[methodName];
}

function wireResolvedSuperEntry(targetEntry, parentEntry) {
  let current = targetEntry;
  while (
    current &&
    typeof current === 'object' &&
    !isPendingInheritanceEntry(current.super) &&
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
    delete current._resolvedMethodData;
    delete current._resolvedMethodDataPromise;
    return true;
  }
  if (current && isPendingInheritanceEntry(current.super)) {
    current.super.resolve(parentEntry);
    current.super = parentEntry;
    delete current._resolvedMethodData;
    delete current._resolvedMethodDataPromise;
    return true;
  }
  if (current && typeof current === 'object' && !current.super) {
    current.super = parentEntry;
    delete current._resolvedMethodData;
    delete current._resolvedMethodDataPromise;
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
    if (isPendingInheritanceEntry(localEntry) && !localEntry.ownerKey) {
      // Pending placeholders are created at reference sites, so this ownerKey is
      // an attribution hint rather than a method-definition owner.
      localEntry.ownerKey = context && context.path ? String(context.path) : null;
    }

    const currentEntry = sharedMethods[name];
    if (!currentEntry) {
      sharedMethods[name] = localEntry;
      continue;
    }
    if (currentEntry === localEntry) {
      continue;
    }
    if (isPendingInheritanceEntry(currentEntry)) {
      if (isPendingInheritanceEntry(localEntry)) {
        continue;
      }
      currentEntry.resolve(localEntry);
      sharedMethods[name] = localEntry;
      continue;
    }
    if (isPendingInheritanceEntry(localEntry)) {
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

function finalizeInheritanceMethods(state, context = null, errors = null) {
  const sharedMethods = ensureInheritanceMethodsTable(state);
  const invokedMethods = ensureInheritanceInvokedMethodsTable(state);
  const names = Object.keys(sharedMethods);
  let emptyConstructorEntry = null;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = sharedMethods[name];
    if (isPendingInheritanceEntry(entry)) {
      if (name === '__constructor__') {
        if (!emptyConstructorEntry) {
          emptyConstructorEntry = createEmptyConstructorEntry(context);
        }
        entry.resolve(emptyConstructorEntry);
        sharedMethods[name] = emptyConstructorEntry;
        continue;
      }
      const invokedReference = invokedMethods[name];
      const invokedOrigin = invokedReference && typeof invokedReference === 'object' && invokedReference.origin
        ? invokedReference.origin
        : null;
      const error = withInheritanceErrorCode(
        new RuntimeFatalError(
          `Inherited method '${name}' was not found`,
          invokedOrigin && typeof invokedOrigin.lineno === 'number' ? invokedOrigin.lineno : 0,
          invokedOrigin && typeof invokedOrigin.colno === 'number' ? invokedOrigin.colno : 0,
          invokedOrigin && invokedOrigin.errorContextString ? invokedOrigin.errorContextString : null,
          invokedOrigin && invokedOrigin.path ? invokedOrigin.path : entry.ownerKey || (context && context.path ? context.path : null)
        ),
        ERR_INHERITED_METHOD_NOT_FOUND
      );
      entry.reject(error);
      collectOrThrowInheritanceMetadataError(error, errors);
      continue;
    }
    let superOwner = entry && typeof entry === 'object' ? entry : null;
    while (
      superOwner &&
      typeof superOwner === 'object' &&
      !isPendingInheritanceEntry(superOwner.super) &&
      !isUnresolvedSuperEntry(superOwner.super) &&
      superOwner.super
    ) {
      superOwner = superOwner.super;
    }
    const superEntry = superOwner && typeof superOwner === 'object' ? superOwner.super : null;
    if (isPendingInheritanceEntry(superEntry)) {
      if (name === '__constructor__') {
        if (!emptyConstructorEntry) {
          emptyConstructorEntry = createEmptyConstructorEntry(context);
        }
        superEntry.resolve(emptyConstructorEntry);
        superOwner.super = emptyConstructorEntry;
        delete superOwner._resolvedMethodData;
        delete superOwner._resolvedMethodDataPromise;
        continue;
      }
      const superOrigin = superOwner && superOwner.superOrigin && typeof superOwner.superOrigin === 'object'
        ? superOwner.superOrigin
        : null;
      const error = withInheritanceErrorCode(
        new RuntimeFatalError(
          `super() for method '${name}' was not found`,
          superOrigin && typeof superOrigin.lineno === 'number' ? superOrigin.lineno : 0,
          superOrigin && typeof superOrigin.colno === 'number' ? superOrigin.colno : 0,
          superOrigin && superOrigin.errorContextString ? superOrigin.errorContextString : null,
          superOrigin && superOrigin.path ? superOrigin.path : superOwner.ownerKey || (context && context.path ? context.path : null)
        ),
        ERR_SUPER_METHOD_NOT_FOUND
      );
      superEntry.reject(error);
      collectOrThrowInheritanceMetadataError(error, errors);
      continue;
    } else if (isUnresolvedSuperEntry(superEntry)) {
      if (name === '__constructor__') {
        if (!emptyConstructorEntry) {
          emptyConstructorEntry = createEmptyConstructorEntry(context);
        }
        superOwner.super = emptyConstructorEntry;
        delete superOwner._resolvedMethodData;
        delete superOwner._resolvedMethodDataPromise;
        continue;
      }
      const superOrigin = superOwner && superOwner.superOrigin && typeof superOwner.superOrigin === 'object'
        ? superOwner.superOrigin
        : null;
      collectOrThrowInheritanceMetadataError(withInheritanceErrorCode(
        new RuntimeFatalError(
          `super() for method '${name}' was not found`,
          superOrigin && typeof superOrigin.lineno === 'number' ? superOrigin.lineno : 0,
          superOrigin && typeof superOrigin.colno === 'number' ? superOrigin.colno : 0,
          superOrigin && superOrigin.errorContextString ? superOrigin.errorContextString : null,
          superOrigin && superOrigin.path ? superOrigin.path : superOwner.ownerKey || (context && context.path ? context.path : null)
        ),
        ERR_SUPER_METHOD_NOT_FOUND
      ), errors);
    } else if (superOwner && superOwner.super === false) {
      superOwner.super = null;
    }
  }
  return sharedMethods;
}

function finalizeInheritanceSharedSchema(state, context = null) {
  return ensureInheritanceSharedSchemaTable(state);
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
  createPendingInheritanceEntry,
  cloneInheritanceMethodEntry,
  cloneInheritanceMethods,
  isPendingInheritanceEntry,
  isUnresolvedSuperEntry,
  ensureInheritanceMethodsTable,
  ensureInheritanceSharedSchemaTable,
  ensureInheritanceInvokedMethodsTable,
  resolveInheritanceMethodEntry,
  registerInheritanceMethods,
  wireResolvedSuperEntry,
  registerInheritanceSharedSchema,
  registerInheritanceInvokedMethods,
  finalizeInheritanceMethods,
  finalizeInheritanceSharedSchema,
  createEmptyConstructorEntry,
  createInheritanceMetadataAggregateError,
  collectOrThrowInheritanceMetadataError,
  ERR_INHERITED_METHOD_NOT_FOUND,
  ERR_SUPER_METHOD_NOT_FOUND,
  ERR_SHARED_CHANNEL_NOT_FOUND,
  ERR_INVALID_INVOKED_METHOD_METADATA,
  ERR_INVALID_SUPER_METADATA,
  withInheritanceErrorCode
};
