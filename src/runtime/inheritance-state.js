'use strict';

const { RuntimeFatalError } = require('./errors');

const ERR_INHERITED_METHOD_NOT_FOUND = 'ERR_INHERITED_METHOD_NOT_FOUND';
const ERR_SUPER_METHOD_NOT_FOUND = 'ERR_SUPER_METHOD_NOT_FOUND';
const ERR_SHARED_CHANNEL_NOT_FOUND = 'ERR_SHARED_CHANNEL_NOT_FOUND';
const INTERNAL_INHERITANCE_STATE = typeof Symbol === 'function'
  ? Symbol('cascadaInheritanceInternalState')
  : '__cascadaInheritanceInternalState__';

function withInheritanceErrorCode(error, code) {
  if (error && code) {
    error.code = code;
  }
  return error;
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
        constructorBoundaryPromise: null,
        compositionMode: null
      }
    });
  }
  return state[INTERNAL_INHERITANCE_STATE];
}

class InheritanceState {
  constructor() {
    this.methods = createInheritanceMethodsTable();
    this.sharedSchema = Object.create(null);
    this.sharedRootBuffer = null;
    this.compositionPayload = null;
    ensureInheritanceInternalState(this);
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

function setInheritanceConstructorBoundaryPromise(state, promise) {
  const internalState = ensureInheritanceInternalState(state);
  if (internalState) {
    internalState.constructorBoundaryPromise = promise || null;
  }
  return promise;
}

function awaitInheritanceConstructorBoundary(state) {
  const internalState = ensureInheritanceInternalState(state);
  const promise = internalState ? internalState.constructorBoundaryPromise : null;
  return promise && typeof promise.then === 'function' ? promise : null;
}

function mergeInheritanceConstructorBoundaryPromise(state, promise, currentPromise = null) {
  const normalizedCurrent = currentPromise && typeof currentPromise.then === 'function'
    ? currentPromise
    : awaitInheritanceConstructorBoundary(state);
  const normalizedNext = promise && typeof promise.then === 'function'
    ? promise
    : null;

  if (!normalizedNext) {
    return normalizedCurrent;
  }

  const merged = normalizedCurrent
    ? Promise.all([normalizedCurrent, normalizedNext]).then((results) => results[1])
    : normalizedNext;

  setInheritanceConstructorBoundaryPromise(state, merged);
  return merged;
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

function cloneInheritanceMethodEntry(entry, clones = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (clones.has(entry)) {
    return clones.get(entry);
  }
  if (isPendingInheritanceEntry(entry)) {
    const pendingClone = createPendingInheritanceEntry(entry.linkedChannels);
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
  clonedEntry.sharedLookupCandidates = Array.isArray(entry.sharedLookupCandidates)
    ? entry.sharedLookupCandidates.slice()
    : [];
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
    sharedLookupCandidates: [],
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
  while (current && !isPendingInheritanceEntry(current.super) && current.super) {
    current = current.super;
  }
  if (current === parentEntry) {
    return false;
  }
  if (current && isPendingInheritanceEntry(current.super)) {
    current.super.resolve(parentEntry);
    current.super = parentEntry;
    return true;
  }
  if (current && !current.super) {
    current.super = parentEntry;
    return true;
  }
  return false;
}

function registerInheritanceMethods(state, localMethods) {
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

function finalizeInheritanceMethods(state, context = null) {
  const sharedMethods = ensureInheritanceMethodsTable(state);
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
      entry.reject(withInheritanceErrorCode(
        new RuntimeFatalError(
          `Inherited method '${name}' was not found`,
          0,
          0,
          null,
          context && context.path ? context.path : null
        ),
        ERR_INHERITED_METHOD_NOT_FOUND
      ));
      continue;
    }
    let superEntry = entry && entry.super;
    while (superEntry && !isPendingInheritanceEntry(superEntry) && superEntry.super) {
      superEntry = superEntry.super;
    }
    if (isPendingInheritanceEntry(superEntry)) {
      if (name === '__constructor__') {
        if (!emptyConstructorEntry) {
          emptyConstructorEntry = createEmptyConstructorEntry(context);
        }
        superEntry.resolve(emptyConstructorEntry);
        continue;
      }
      superEntry.reject(withInheritanceErrorCode(
        new RuntimeFatalError(
          `super() for method '${name}' was not found`,
          0,
          0,
          null,
          context && context.path ? context.path : null
        ),
        ERR_SUPER_METHOD_NOT_FOUND
      ));
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
  setInheritanceConstructorBoundaryPromise,
  awaitInheritanceConstructorBoundary,
  mergeInheritanceConstructorBoundaryPromise,
  setInheritanceCompositionMode,
  isInheritanceCompositionMode,
  createPendingInheritanceEntry,
  cloneInheritanceMethodEntry,
  cloneInheritanceMethods,
  isPendingInheritanceEntry,
  ensureInheritanceMethodsTable,
  ensureInheritanceSharedSchemaTable,
  resolveInheritanceMethodEntry,
  registerInheritanceMethods,
  wireResolvedSuperEntry,
  registerInheritanceSharedSchema,
  finalizeInheritanceMethods,
  finalizeInheritanceSharedSchema,
  createEmptyConstructorEntry,
  ERR_INHERITED_METHOD_NOT_FOUND,
  ERR_SUPER_METHOD_NOT_FOUND,
  ERR_SHARED_CHANNEL_NOT_FOUND,
  withInheritanceErrorCode
};
