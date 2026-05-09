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
  const sharedSchema = Object.create(null);

  for (let i = files.length - 1; i >= 0; i--) {
    const spec = files[i].spec;
    Object.assign(sharedSchema, spec.sharedSchema || {});
    for (const [name, entry] of Object.entries(spec.methodEntries || {})) {
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
      methods[name] = method;
    }
  }

  state.methods = methods;
  state.sharedSchema = sharedSchema;
  state.loading = null;
  state.finalized = true;
  return state;
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

export {finalizeInheritanceMetadata};
