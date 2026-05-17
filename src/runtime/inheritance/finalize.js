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

function addFinalizationError(errors, message, origin, context) {
  errors.push(handleError(
    new Error(message),
    origin?.lineno,
    origin?.colno,
    origin?.errorContextString,
    origin?.path ?? context?.path ?? null
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
    origin: entry.origin,
    isStructuralTemplate: !entry.templateOrScript.scriptMode && !entry.spec.hasExtends
  });
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

function mergeChannelFootprintNames(...nameLists) {
  return Array.from(new Set(nameLists.flat()));
}

function createRootNoopConstructorEntry(ownerEntry) {
  return Object.freeze({
    name: '__constructor__',
    fn() {},
    signature: { argNames: [] },
    origin: null,
    isConstructor: true,
    ownerEntry,
    super: null,
    mergedLinkedChannels: [],
    mergedMutatedChannels: []
  });
}

function createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry, errors, context) {
  if (compiledEntry.super && !parentEntry && !compiledEntry.isConstructor) {
    addFinalizationError(
      errors,
      `super() in '${compiledEntry.name}' has no parent implementation`,
      compiledEntry.superOrigin ?? compiledEntry.origin,
      context
    );
  }
  if (parentEntry && !hasCompatibleOverrideSignature(compiledEntry, parentEntry)) {
    addFinalizationError(
      errors,
      `method '${compiledEntry.name}' renames an inherited argument`,
      compiledEntry.origin,
      context
    );
  }

  const superEntry = parentEntry || (compiledEntry.super && compiledEntry.isConstructor
    ? createRootNoopConstructorEntry(ownerEntry)
    : null);
  const mergedLinkedChannels = mergeChannelFootprintNames(
    compiledEntry.ownLinkedChannels,
    superEntry ? superEntry.mergedLinkedChannels : []
  );
  const mergedMutatedChannels = mergeChannelFootprintNames(
    compiledEntry.ownMutatedChannels,
    superEntry ? superEntry.mergedMutatedChannels : []
  );

  return {
    name: compiledEntry.name,
    fn: compiledEntry.fn,
    signature: compiledEntry.signature,
    origin: compiledEntry.origin,
    isConstructor: !!compiledEntry.isConstructor,
    ownerEntry,
    super: superEntry,
    mergedLinkedChannels,
    mergedMutatedChannels
  };
}

function createRuntimeSharedSchema(entries, errors, context) {
  const sharedSchema = Object.create(null);

  entries.forEach((entry) => {
    Object.entries(entry.spec.sharedSchema || {}).forEach(([name, compiledSchemaEntry]) => {
      const runtimeSchemaEntry = createRuntimeSharedSchemaEntry(compiledSchemaEntry, entry.origin);
      const existingEntry = sharedSchema[name] || null;
      if (existingEntry && existingEntry.type !== runtimeSchemaEntry.type) {
        addFinalizationError(
          errors,
          `shared channel '${name}' has conflicting types '${existingEntry.type}' and '${runtimeSchemaEntry.type}'`,
          runtimeSchemaEntry.origin,
          context
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
          defaultOrigin: runtimeSchemaEntry.defaultOrigin
        });
      }
    });
  });

  return sharedSchema;
}

function createRuntimeSharedSchemaEntry(compiledSchemaEntry, fallbackOrigin) {
  const origin = compiledSchemaEntry.origin ?? fallbackOrigin ?? null;
  return Object.freeze({
    type: compiledSchemaEntry.type,
    origin,
    defaultOrigin: compiledSchemaEntry.hasDefault ? origin : null,
    hasDefault: !!compiledSchemaEntry.hasDefault
  });
}

function validateSharedMethodCollisions(sharedSchema, methodNames, errors, context) {
  Object.keys(sharedSchema).forEach((name) => {
    const methodName = getSharedSourceName(name);
    if (!methodNames.has(methodName)) {
      return;
    }
    addFinalizationError(
      errors,
      `shared channel '${methodName}' conflicts with inherited method '${methodName}'`,
      sharedSchema[name].origin,
      context
    );
  });
}

function validateInheritedMethodDependencies(entries, methodNames, errors, context) {
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
          dependencies[name].origin ?? methodEntry.origin,
          context
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
    entry.mergedLinkedChannels = Object.freeze(entry.mergedLinkedChannels.slice());
    entry.mergedMutatedChannels = Object.freeze(entry.mergedMutatedChannels.slice());
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
    const nextLinkedChannels = mergeChannelFootprintNames(
      entry.mergedLinkedChannels,
      ...dependencyEntries.map((dependency) => dependency.mergedLinkedChannels)
    );
    const nextMutatedChannels = mergeChannelFootprintNames(
      entry.mergedMutatedChannels,
      ...dependencyEntries.map((dependency) => dependency.mergedMutatedChannels)
    );
    if (
      nextLinkedChannels.length !== entry.mergedLinkedChannels.length ||
      nextMutatedChannels.length !== entry.mergedMutatedChannels.length
    ) {
      entry.mergedLinkedChannels = nextLinkedChannels;
      entry.mergedMutatedChannels = nextMutatedChannels;
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

  const sharedSchema = createRuntimeSharedSchema(entries, errors, context);
  validateSharedMethodCollisions(sharedSchema, methodNames, errors, context);

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const ownerEntry = ownerEntries[index];
    Object.entries(entry.spec.methodEntries || {}).forEach(([name, compiledEntry]) => {
      const parentEntry = parentRuntimeEntriesByName[name] || null;
      const runtimeEntry = createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry, errors, context);
      parentRuntimeEntriesByName[name] = runtimeEntry;
      runtimeMethodsByName[name] = runtimeEntry;
      runtimeEntries.push(runtimeEntry);
      dependencyNamesByEntry.set(
        runtimeEntry,
        Object.keys(compiledEntry.inheritedMethodDependencies || {})
      );
    });
  }

  validateInheritedMethodDependencies(entries, methodNames, errors, context);
  assertNoFinalizationErrors(errors);
  expandAllMethodDependencyFootprints(runtimeEntries, runtimeMethodsByName, dependencyNamesByEntry);

  return Object.freeze({
    methods: Object.freeze(runtimeMethodsByName),
    sharedSchema: Object.freeze(sharedSchema)
  });
}

export {InheritanceFinalizationError, finalizeInheritanceChain};
