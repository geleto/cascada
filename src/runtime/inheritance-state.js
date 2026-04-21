'use strict';

const { RuntimeFatalError } = require('./errors');

const ERR_INHERITED_METHOD_NOT_FOUND = 'ERR_INHERITED_METHOD_NOT_FOUND';
const ERR_SUPER_METHOD_NOT_FOUND = 'ERR_SUPER_METHOD_NOT_FOUND';
const ERR_SHARED_CHANNEL_NOT_FOUND = 'ERR_SHARED_CHANNEL_NOT_FOUND';

function withInheritanceErrorCode(error, code) {
  if (error && code) {
    error.code = code;
  }
  return error;
}

function createPendingInheritanceEntry() {
  let settled = false;
  let settleResolve = null;
  let settleReject = null;
  let promise = new Promise((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  const entry = {
    promise,
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
    state.methods = new InheritanceMethodRegistry();
  }
  return state.methods;
}

function ensureInheritanceSharedSchemaTable(state) {
  if (!state.sharedSchema || typeof state.sharedSchema !== 'object') {
    state.sharedSchema = new InheritanceSharedRegistry();
  }
  return state.sharedSchema;
}

class InheritanceMethodRegistry {
  registerCompiled(methods) {
    registerInheritanceMethods({ methods: this }, methods);
    return this;
  }

  getChain(name) {
    const chain = [];
    let entry = this[name];
    while (entry && !isPendingInheritanceEntry(entry)) {
      chain.push(entry);
      entry = entry.super;
    }
    return chain;
  }
}

class InheritanceSharedRegistry {
  registerSchema(sharedSchema, context = null) {
    registerInheritanceSharedSchema({ sharedSchema: this }, sharedSchema, context);
    return this;
  }
}

class InheritanceResolutionState {
  constructor() {
    this._pendingCount = 0;
    this._pendingPromise = null;
    this._resolvePending = null;
  }

  begin() {
    this._pendingCount += 1;
    if (!this._pendingPromise) {
      this._pendingPromise = new Promise((resolve) => {
        this._resolvePending = resolve;
      });
    }
  }

  finish() {
    if (this._pendingCount === 0) {
      return;
    }
    this._pendingCount -= 1;
    if (this._pendingCount === 0 && this._resolvePending) {
      const resolvePending = this._resolvePending;
      this._resolvePending = null;
      const pendingPromise = this._pendingPromise;
      this._pendingPromise = null;
      resolvePending();
      return pendingPromise;
    }
    return null;
  }

  await() {
    return this._pendingPromise;
  }
}

class InheritanceState {
  constructor() {
    this.methods = new InheritanceMethodRegistry();
    this.sharedSchema = new InheritanceSharedRegistry();
    this.resolution = new InheritanceResolutionState();
    this.sharedRootBuffer = null;
    this.compositionPayload = null;
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

function cloneInheritanceMethodEntry(entry, clones = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (clones.has(entry)) {
    return clones.get(entry);
  }
  if (isPendingInheritanceEntry(entry)) {
    const pendingClone = createPendingInheritanceEntry();
    clones.set(entry, pendingClone);
    return pendingClone;
  }

  const clonedEntry = Object.assign({}, entry);
  clones.set(entry, clonedEntry);
  clonedEntry.usedChannels = Array.isArray(entry.usedChannels)
    ? entry.usedChannels.slice()
    : [];
  clonedEntry.mutatedChannels = Array.isArray(entry.mutatedChannels)
    ? entry.mutatedChannels.slice()
    : [];
  clonedEntry.contract = entry.contract && typeof entry.contract === 'object'
    ? {
      argNames: Array.isArray(entry.contract.argNames)
        ? entry.contract.argNames.slice()
        : [],
      withContext: !!entry.contract.withContext
    }
    : { argNames: [], withContext: false };
  clonedEntry.super = cloneInheritanceMethodEntry(entry.super, clones);
  delete clonedEntry._resolvedInheritanceMethodMeta;
  delete clonedEntry._resolvedInheritanceMethodMetaPromise;
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

function cloneInheritanceSharedEntry(entry, clones = new Map()) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (clones.has(entry)) {
    return clones.get(entry);
  }
  if (isPendingInheritanceEntry(entry)) {
    const pendingClone = createPendingInheritanceEntry();
    clones.set(entry, pendingClone);
    return pendingClone;
  }

  const clonedEntry = Object.assign({}, entry);
  clones.set(entry, clonedEntry);
  return clonedEntry;
}

function cloneInheritanceSharedSchema(localSharedSchema) {
  if (!localSharedSchema || typeof localSharedSchema !== 'object') {
    return localSharedSchema;
  }

  const clonedSharedSchema = Object.create(null);
  const clones = new Map();
  const names = Object.keys(localSharedSchema);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    clonedSharedSchema[name] = cloneInheritanceSharedEntry(localSharedSchema[name], clones);
  }
  return clonedSharedSchema;
}

function _formatInheritanceContract(name, contract) {
  const args = Array.isArray(contract && contract.argNames) ? contract.argNames.join(', ') : '';
  const contextSuffix = contract && contract.withContext ? ' with context' : '';
  return `${name}(${args})${contextSuffix}`;
}

function validateInheritanceContractCompatibility(name, overridingEntry, parentEntry) {
  if (name === '__constructor__') {
    return;
  }

  const overridingContract = overridingEntry && overridingEntry.contract;
  const parentContract = parentEntry && parentEntry.contract;
  if (!overridingContract || !parentContract) {
    return;
  }

  const overridingNames = Array.isArray(overridingContract.argNames) ? overridingContract.argNames : [];
  const parentNames = Array.isArray(parentContract.argNames) ? parentContract.argNames : [];
  const overridingOmittedSignature = overridingNames.length === 0 && !overridingContract.withContext;
  if (overridingOmittedSignature) {
    return;
  }
  const sameLength = overridingNames.length === parentNames.length;
  const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
  const sameContextMode = !!overridingContract.withContext === !!parentContract.withContext;
  if (sameNames && sameContextMode) {
    return;
  }

  throw new RuntimeFatalError(
    `block "${name}" signature mismatch: overriding block declares ${_formatInheritanceContract(name, overridingContract)} but parent declares ${_formatInheritanceContract(name, parentContract)}`,
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
  const isolatedLocalSharedSchema = cloneInheritanceSharedSchema(localSharedSchema);

  const names = Object.keys(isolatedLocalSharedSchema);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const localEntry = isolatedLocalSharedSchema[name];
    if (!localEntry) {
      continue;
    }

    const currentEntry = sharedSchema[name];
    if (!currentEntry) {
      sharedSchema[name] = localEntry;
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
      sharedSchema[name] = localEntry;
      continue;
    }
    if (isPendingInheritanceEntry(localEntry)) {
      continue;
    }
    if (currentEntry.type !== localEntry.type) {
      throw new RuntimeFatalError(
        `shared channel '${name}' was declared as '${currentEntry.type}' and '${localEntry.type}'`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      );
    }
  }

  return sharedSchema;
}

function finalizeInheritanceMethods(state, context = null) {
  const sharedMethods = ensureInheritanceMethodsTable(state);
  const names = Object.keys(sharedMethods);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = sharedMethods[name];
    if (isPendingInheritanceEntry(entry)) {
      if (name === '__constructor__') {
        const emptyConstructor = {
          fn() {
            return null;
          },
          usedChannels: [],
          mutatedChannels: [],
          super: null,
          ownerKey: '__synthetic__'
        };
        entry.resolve(emptyConstructor);
        sharedMethods[name] = emptyConstructor;
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
  const sharedSchema = ensureInheritanceSharedSchemaTable(state);
  const names = Object.keys(sharedSchema);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = sharedSchema[name];
    if (!isPendingInheritanceEntry(entry)) {
      continue;
    }
    entry.reject(withInheritanceErrorCode(
      new RuntimeFatalError(
        `Shared channel '${name}' was not found`,
        0,
        0,
        null,
        context && context.path ? context.path : null
      ),
      ERR_SHARED_CHANNEL_NOT_FOUND
    ));
  }
  return sharedSchema;
}

module.exports = {
  InheritanceState,
  InheritanceMethodRegistry,
  InheritanceSharedRegistry,
  InheritanceResolutionState,
  createInheritanceState,
  createPendingInheritanceEntry,
  cloneInheritanceMethodEntry,
  cloneInheritanceMethods,
  cloneInheritanceSharedEntry,
  cloneInheritanceSharedSchema,
  isPendingInheritanceEntry,
  ensureInheritanceMethodsTable,
  ensureInheritanceSharedSchemaTable,
  resolveInheritanceMethodEntry,
  registerInheritanceMethods,
  wireResolvedSuperEntry,
  registerInheritanceSharedSchema,
  finalizeInheritanceMethods,
  finalizeInheritanceSharedSchema,
  ERR_INHERITED_METHOD_NOT_FOUND,
  ERR_SUPER_METHOD_NOT_FOUND,
  ERR_SHARED_CHANNEL_NOT_FOUND,
  withInheritanceErrorCode
};
