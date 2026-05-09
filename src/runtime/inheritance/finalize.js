// Builds executable runtime tables from loaded inheritance specs.
// Validates shared schema, selects overrides, wires super links, resolves
// invoked callables, and merges channel footprints.

import {RuntimeFatalError} from '../errors.js';

/*
// Source location for diagnostics.
type SourceOrigin = {
  lineno: number,
  colno: number,
  errorContextString: string,
  path: string | null
}

// Compiler output for one inherited callable reference.
type InvokedMethodRef = {
  name: string,
  origin: SourceOrigin | null
}

// Compiler output for one callable body.
type CompiledMethodEntry = {
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  ownLinkedChannels: string[], // local body reads/observations
  ownMutatedChannels: string[], // local body mutations
  super: boolean, // true when the body calls super()
  superOrigin: SourceOrigin | null, // super() call site
  invokedMethodRefs: Record<string, InvokedMethodRef> // method name -> first call site, for error output when missing
}

// Runtime method entry after finalization.
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  super: RuntimeMethodEntry | null, // owner-relative parent method
  callsSuper: boolean, // true when the body calls super()
  invokedMethodRefs: Record<string, InvokedMethodRef>, // method name -> first call site
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}
*/

function finalizeInheritanceMetadata(state, context = null) {
  if (!state) {
    throw new RuntimeFatalError(
      'finalizeInheritanceMetadata requires an inheritance state',
      0,
      0,
      null,
      context?.path ?? null
    );
  }
  if (state.failure) {
    throw state.failure;
  }
  if (state.finalized) {
    return state;
  }

  const files = state.loading?.files || [];
  const methods = Object.create(null);
  const allMethods = [];
  const sharedSchema = Object.create(null);

  for (let i = files.length - 1; i >= 0; i--) {
    const spec = files[i].spec;
    registerSharedSchema(sharedSchema, methods, spec.sharedSchema || {}, files[i].context || context);
    for (const [name, entry] of Object.entries(spec.methodEntries || {})) {
      if (Object.prototype.hasOwnProperty.call(sharedSchema, name)) {
        throw new RuntimeFatalError(
          `Inherited callable "${name}" conflicts with shared channel "${name}"`,
          entry.origin?.lineno ?? 0,
          entry.origin?.colno ?? 0,
          entry.origin?.errorContextString ?? null,
          entry.origin?.path ?? context?.path ?? null
        );
      }
      const parentMethod = methods[name] || null;
      const method = createRuntimeMethodEntry(entry, name, context);
      if (parentMethod) {
        validateSignatureCompatibility(name, method, parentMethod, context);
      }
      if (entry.super && !parentMethod) {
        throw new RuntimeFatalError(
          `Inherited callable "${name}" uses super() but has no parent implementation`,
          entry.superOrigin?.lineno ?? 0,
          entry.superOrigin?.colno ?? 0,
          entry.superOrigin?.errorContextString ?? null,
          entry.superOrigin?.path ?? context?.path ?? null
        );
      }
      method.super = parentMethod;
      allMethods.push(method);
      methods[name] = method;
    }
  }

  state.methods = methods;
  state.sharedSchema = sharedSchema;
  validateInvokedMethodRefs(allMethods, methods, context);
  mergeMethodFootprints(allMethods, methods);
  state.loading = null;
  state.finalized = true;
  return state;
}

function registerSharedSchema(sharedSchema, methods, nextSchema, context) {
  for (const [name, channelType] of Object.entries(nextSchema)) {
    // Shared entries are processed before this file's methods, so this catches
    // shared names colliding with methods from already-processed ancestors.
    if (Object.prototype.hasOwnProperty.call(methods, name)) {
      throw new RuntimeFatalError(
        `Shared channel "${name}" conflicts with inherited callable "${name}"`,
        0,
        0,
        null,
        context?.path ?? null
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(sharedSchema, name) &&
      sharedSchema[name] !== channelType
    ) {
      throw new RuntimeFatalError(
        `Shared channel "${name}" was declared as "${sharedSchema[name]}" and "${channelType}"`,
        0,
        0,
        null,
        context?.path ?? null
      );
    }
    sharedSchema[name] = channelType;
  }
}

function createRuntimeMethodEntry(entry, name, context) {
  if (typeof entry.fn !== 'function') {
    throw new RuntimeFatalError(
      `Inherited callable "${name}" is missing a compiled function`,
      0,
      0,
      null,
      context?.path ?? null
    );
  }

  return {
    name,
    fn: entry.fn,
    signature: normalizeSignature(entry.signature),
    ownerKey: entry.ownerKey,
    origin: entry.origin ?? null,
    super: null,
    callsSuper: entry.super === true,
    invokedMethodRefs: normalizeInvokedMethodRefs(entry.invokedMethodRefs),
    mergedLinkedChannels: normalizeStringArray(entry.ownLinkedChannels),
    mergedMutatedChannels: normalizeStringArray(entry.ownMutatedChannels)
  };
}

function normalizeSignature(signature) {
  return {
    argNames: Array.isArray(signature?.argNames) ? signature.argNames.slice() : []
  };
}

function validateSignatureCompatibility(name, method, parentMethod, context) {
  if (method.signature.argNames.length === parentMethod.signature.argNames.length) {
    return;
  }
  const origin = method.origin;
  throw new RuntimeFatalError(
    `Inherited callable "${name}" signature is not compatible with its parent`,
    origin?.lineno ?? 0,
    origin?.colno ?? 0,
    origin?.errorContextString ?? null,
    origin?.path ?? context?.path ?? null
  );
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((item) => typeof item === 'string')));
}

function normalizeInvokedMethodRefs(value) {
  if (!value || typeof value !== 'object') {
    return Object.create(null);
  }
  const refs = Object.create(null);
  for (const [name, ref] of Object.entries(value)) {
    if (typeof name === 'string' && name) {
      refs[name] = ref && typeof ref === 'object'
        ? ref
        : { name, origin: null };
    }
  }
  return refs;
}

function validateInvokedMethodRefs(allMethodEntries, dispatchMethods, context) {
  for (const method of allMethodEntries) {
    for (const [name, ref] of Object.entries(method.invokedMethodRefs)) {
      if (dispatchMethods[name]) {
        continue;
      }
      const origin = ref?.origin;
      throw new RuntimeFatalError(
        `Missing inherited callable "${name}"`,
        origin?.lineno ?? 0,
        origin?.colno ?? 0,
        origin?.errorContextString ?? null,
        origin?.path ?? context?.path ?? null
      );
    }
  }
}

function mergeMethodFootprints(allMethodEntries, dispatchMethods) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of allMethodEntries) {
      const linked = new Set(method.mergedLinkedChannels);
      const mutated = new Set(method.mergedMutatedChannels);
      if (method.callsSuper) {
        addFootprintChannels(method.super, linked, mutated);
      }
      for (const name of Object.keys(method.invokedMethodRefs)) {
        addFootprintChannels(dispatchMethods[name], linked, mutated);
      }
      if (replaceIfChanged(method, 'mergedLinkedChannels', linked)) {
        changed = true;
      }
      if (replaceIfChanged(method, 'mergedMutatedChannels', mutated)) {
        changed = true;
      }
    }
  }
}

function addFootprintChannels(method, linked, mutated) {
  if (!method) {
    return;
  }
  for (const channel of method.mergedLinkedChannels) {
    linked.add(channel);
  }
  for (const channel of method.mergedMutatedChannels) {
    mutated.add(channel);
  }
}

function replaceIfChanged(method, fieldName, nextSet) {
  const current = method[fieldName];
  if (current.length === nextSet.size && current.every((name) => nextSet.has(name))) {
    return false;
  }
  method[fieldName] = Array.from(nextSet);
  return true;
}

export {finalizeInheritanceMetadata};
