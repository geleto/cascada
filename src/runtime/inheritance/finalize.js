import {handleError} from '../errors.js';
import {getSharedSourceName} from '../../inheritance/shared-names.js';

class InheritanceFinalizationError extends Error {
  constructor(errors) {
    super(errors.length === 1
      ? errors[0].message
      : `Multiple inheritance finalization errors (${errors.length}):\n` +
        errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n'));
    this.name = 'InheritanceFinalizationError';
    this.errors = errors;
  }
}

function addFinalizationError(errors, message, errorContext) {
  errors.push(handleError(
    new Error(message),
    errorContext ?? null,
    null
  ));
}

function assertNoFinalizationErrors(errors) {
  if (errors.length > 0) {
    throw new InheritanceFinalizationError(errors);
  }
}

function createRuntimeOwnerEntry(entry) {
  return Object.freeze({
    templateOrScript: entry.templateOrScript,
    path: entry.path,
    errorContextTable: entry.errorContextTable || null,
    errorContext: entry.errorContext,
    isStructuralTemplate: !entry.templateOrScript.scriptMode && !entry.spec.hasExtends
  });
}

function resolveOwnerErrorContext(ownerEntry, index) {
  if (index == null || !ownerEntry || !ownerEntry.errorContextTable) {
    return null;
  }
  return ownerEntry.errorContextTable[index] ?? null;
}

function resolveCompiledEntryErrorContext(ownerEntry, compiledEntry, indexField, legacyField = null) {
  // TODO(error-context-cleanup): remove legacyField fallback after inheritance
  // tests stop constructing hand-written object error-context metadata.
  return resolveOwnerErrorContext(ownerEntry, compiledEntry[indexField]) ??
    (legacyField ? compiledEntry[legacyField] : null) ??
    null;
}

function hasCompatibleOverrideSignature(childEntry, parentEntry) {
  const childArgs = childEntry.signature.argNames;
  const parentArgs = parentEntry.signature.argNames;
  const sharedArgCount = Math.min(childArgs.length, parentArgs.length);
  for (let index = 0; index < sharedArgCount; index++) {
    if (childArgs[index] !== parentArgs[index]) {
      return false;
    }
  }
  return true;
}

function mergeChainFootprintNames(...nameLists) {
  return Array.from(new Set(nameLists.flat()));
}

function createRootNoopConstructorEntry(ownerEntry) {
  return Object.freeze({
    name: '__constructor__',
    fn() {},
    signature: { argNames: [] },
    errorContext: null,
    isConstructor: true,
    ownerEntry,
    super: null,
    mergedLinkedChains: [],
    mergedMutatedChains: []
  });
}

function createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry, errors) {
  if (compiledEntry.super && !parentEntry && !compiledEntry.isConstructor) {
    addFinalizationError(
      errors,
      `super() in '${compiledEntry.name}' has no parent implementation`,
      resolveCompiledEntryErrorContext(ownerEntry, compiledEntry, 'superErrorContextIndex', 'superErrorContext') ??
        resolveCompiledEntryErrorContext(ownerEntry, compiledEntry, 'errorContextIndex', 'errorContext')
    );
  }
  if (parentEntry && !hasCompatibleOverrideSignature(compiledEntry, parentEntry)) {
    addFinalizationError(
      errors,
      `method '${compiledEntry.name}' renames an inherited argument`,
      resolveCompiledEntryErrorContext(ownerEntry, compiledEntry, 'errorContextIndex', 'errorContext')
    );
  }

  const superEntry = parentEntry || (compiledEntry.super && compiledEntry.isConstructor
    ? createRootNoopConstructorEntry(ownerEntry)
    : null);
  const mergedLinkedChains = mergeChainFootprintNames(
    compiledEntry.ownLinkedChains,
    superEntry ? superEntry.mergedLinkedChains : []
  );
  const mergedMutatedChains = mergeChainFootprintNames(
    compiledEntry.ownMutatedChains,
    superEntry ? superEntry.mergedMutatedChains : []
  );

  return {
    name: compiledEntry.name,
    fn: compiledEntry.fn,
    signature: compiledEntry.signature,
    errorContext: resolveCompiledEntryErrorContext(ownerEntry, compiledEntry, 'errorContextIndex', 'errorContext'),
    errorContextIndex: compiledEntry.errorContextIndex,
    isConstructor: !!compiledEntry.isConstructor,
    ownerEntry,
    super: superEntry,
    mergedLinkedChains,
    mergedMutatedChains
  };
}

function createRuntimeSharedSchema(entries, errors) {
  const sharedSchema = Object.create(null);

  entries.forEach((entry) => {
    Object.entries(entry.spec.sharedSchema || {}).forEach(([name, compiledSchemaEntry]) => {
      const runtimeSchemaEntry = createRuntimeSharedSchemaEntry(compiledSchemaEntry, entry);
      const existingEntry = sharedSchema[name] || null;
      if (existingEntry && existingEntry.type !== runtimeSchemaEntry.type) {
        addFinalizationError(
          errors,
          `shared chain '${name}' has conflicting types '${existingEntry.type}' and '${runtimeSchemaEntry.type}'`,
          runtimeSchemaEntry.errorContext
        );
        return;
      }
      if (!existingEntry) {
        sharedSchema[name] = runtimeSchemaEntry;
        return;
      }
      if (!existingEntry.hasDefault && runtimeSchemaEntry.hasDefault) {
        sharedSchema[name] = Object.freeze({
          ...existingEntry,
          hasDefault: true,
          defaultErrorContext: runtimeSchemaEntry.defaultErrorContext
        });
      }
    });
  });

  return sharedSchema;
}

function createRuntimeSharedSchemaEntry(compiledSchemaEntry, entry) {
  // TODO(error-context-cleanup): remove compiledSchemaEntry.errorContext fallback
  // after inheritance tests stop constructing hand-written object error-context metadata.
  const errorContext = resolveOwnerErrorContext(entry, compiledSchemaEntry.errorContextIndex) ??
    compiledSchemaEntry.errorContext ??
    entry.errorContext ??
    null;
  return Object.freeze({
    type: compiledSchemaEntry.type,
    errorContext,
    defaultErrorContext: compiledSchemaEntry.hasDefault ? errorContext : null,
    hasDefault: !!compiledSchemaEntry.hasDefault
  });
}

function validateSharedMethodCollisions(sharedSchema, methodNames, errors) {
  Object.keys(sharedSchema).forEach((name) => {
    const methodName = getSharedSourceName(name);
    if (!methodNames.has(methodName)) {
      return;
    }
    addFinalizationError(
      errors,
      `shared chain '${methodName}' conflicts with inherited method '${methodName}'`,
      sharedSchema[name].errorContext
    );
  });
}

function validateInheritedMethodDependencies(entries, methodNames, errors) {
  entries.forEach((entry) => {
    Object.values(entry.spec.methodEntries || {}).forEach((methodEntry) => {
      const dependencies = methodEntry.inheritedMethodDependencies || {};
      Object.keys(dependencies).forEach((name) => {
        if (methodNames.has(name)) {
          return;
        }
        addFinalizationError(
          errors,
          `method '${methodEntry.name}' references missing inherited method '${name}'`,
          resolveCompiledEntryErrorContext(entry, dependencies[name], 'errorContextIndex', 'errorContext') ??
            resolveCompiledEntryErrorContext(entry, methodEntry, 'errorContextIndex', 'errorContext')
        );
      });
    });
  });
}

function expandAllMethodDependencyFootprints(runtimeEntries, runtimeMethodsByName, dependencyNamesByEntry) {
  const dependencyEntriesByEntry = new Map();
  runtimeEntries.forEach((entry) => {
    const dependencyEntries = (dependencyNamesByEntry.get(entry) || [])
      .map((name) => runtimeMethodsByName[name]);
    dependencyEntriesByEntry.set(entry, dependencyEntries);
  });

  let changed = true;
  let remainingPasses = runtimeEntries.length;
  while (changed && remainingPasses > 0) {
    changed = false;
    remainingPasses--;
    runtimeEntries.forEach((entry) => {
      if (expandMethodDependencyFootprint(entry, dependencyEntriesByEntry, new Set())) {
        changed = true;
      }
    });
  }

  runtimeEntries.forEach((entry) => {
    entry.mergedLinkedChains = Object.freeze(entry.mergedLinkedChains.slice());
    entry.mergedMutatedChains = Object.freeze(entry.mergedMutatedChains.slice());
    Object.freeze(entry);
  });
}

function expandMethodDependencyFootprint(entry, dependencyEntriesByEntry, visiting) {
  if (visiting.has(entry)) {
    return false;
  }
  visiting.add(entry);

  const dependencyEntries = dependencyEntriesByEntry.get(entry) || [];
  let changed = false;
  dependencyEntries.forEach((dependency) => {
    if (expandMethodDependencyFootprint(dependency, dependencyEntriesByEntry, visiting)) {
      changed = true;
    }
  });

  if (dependencyEntries.length > 0) {
    const nextLinkedChains = mergeChainFootprintNames(
      entry.mergedLinkedChains,
      ...dependencyEntries.map((dependency) => dependency.mergedLinkedChains)
    );
    const nextMutatedChains = mergeChainFootprintNames(
      entry.mergedMutatedChains,
      ...dependencyEntries.map((dependency) => dependency.mergedMutatedChains)
    );
    if (
      nextLinkedChains.length !== entry.mergedLinkedChains.length ||
      nextMutatedChains.length !== entry.mergedMutatedChains.length
    ) {
      entry.mergedLinkedChains = nextLinkedChains;
      entry.mergedMutatedChains = nextMutatedChains;
      changed = true;
    }
  }

  visiting.delete(entry);
  return changed;
}

function finalizeInheritanceChain(chain, context = null) {
  const errors = [];
  const entries = chain.entries;
  const ownerEntries = entries.map(createRuntimeOwnerEntry);
  const methodNames = new Set();
  const runtimeMethodsByName = Object.create(null);
  const parentRuntimeEntriesByName = Object.create(null);
  const runtimeEntries = [];
  const dependencyNamesByEntry = new Map();

  entries.forEach((entry) => {
    Object.keys(entry.spec.methodEntries || {}).forEach((name) => methodNames.add(name));
  });

  const sharedSchema = createRuntimeSharedSchema(entries, errors);
  validateSharedMethodCollisions(sharedSchema, methodNames, errors);

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const ownerEntry = ownerEntries[index];
    Object.entries(entry.spec.methodEntries || {}).forEach(([name, compiledEntry]) => {
      const parentEntry = parentRuntimeEntriesByName[name] || null;
      const runtimeEntry = createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry, errors);
      parentRuntimeEntriesByName[name] = runtimeEntry;
      runtimeMethodsByName[name] = runtimeEntry;
      runtimeEntries.push(runtimeEntry);
      dependencyNamesByEntry.set(
        runtimeEntry,
        Object.keys(compiledEntry.inheritedMethodDependencies || {})
      );
    });
  }

  validateInheritedMethodDependencies(entries, methodNames, errors);
  assertNoFinalizationErrors(errors);
  expandAllMethodDependencyFootprints(runtimeEntries, runtimeMethodsByName, dependencyNamesByEntry);

  return Object.freeze({
    methods: Object.freeze(runtimeMethodsByName),
    sharedSchema: Object.freeze(sharedSchema)
  });
}

export {InheritanceFinalizationError, finalizeInheritanceChain};
