import {RuntimeError} from '../errors.js';
import {getSharedSourceName} from '../../inheritance/shared-names.js';

function failFinalization(message, errorContext) {
  throw RuntimeError.create(message, errorContext);
}

function createRuntimeOwnerEntry(entry) {
  return Object.freeze({
    path: entry.path,
    // Finalization-only table. It is prepared with reportError = null by the
    // loader so validation errors can point at source locations without making
    // finalization render-specific.
    errorContextTable: entry.errorContextTable,
    errorContext: entry.errorContext,
    ownerState: entry.ownerState,
    directMacroBindings: entry.directMacroBindings || null,
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
    mergedObservedChains: [],
    mergedMutatedChains: []
  });
}

function createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry) {
  if (compiledEntry.super && !parentEntry && !compiledEntry.isConstructor) {
    failFinalization(
      `super() in '${compiledEntry.name}' has no parent implementation`,
      ownerEntry.errorContextTable[compiledEntry.superErrorContextIndex]
    );
  }
  if (parentEntry && !hasCompatibleOverrideSignature(compiledEntry, parentEntry)) {
    failFinalization(
      `method '${compiledEntry.name}' renames an inherited argument`,
      ownerEntry.errorContextTable[compiledEntry.errorContextIndex]
    );
  }

  const superEntry = parentEntry || (compiledEntry.super && compiledEntry.isConstructor
    ? createRootNoopConstructorEntry(ownerEntry)
    : null);
  const mergedLinkedChains = mergeChainFootprintNames(compiledEntry.ownLinkedChains);
  const mergedObservedChains = mergeChainFootprintNames(compiledEntry.ownObservedChains);
  const mergedMutatedChains = mergeChainFootprintNames(compiledEntry.ownMutatedChains);

  return {
    name: compiledEntry.name,
    fn: compiledEntry.fn,
    signature: compiledEntry.signature,
    errorContext: ownerEntry.errorContextTable[compiledEntry.errorContextIndex],
    errorContextIndex: compiledEntry.errorContextIndex,
    isConstructor: !!compiledEntry.isConstructor,
    ownerEntry,
    super: superEntry,
    mergedLinkedChains,
    mergedObservedChains,
    mergedMutatedChains
  };
}

function createRuntimeSharedSchema(entries, ownerEntries) {
  const sharedSchema = Object.create(null);

  entries.forEach((entry, index) => {
    const ownerEntry = ownerEntries[index];
    Object.entries(entry.spec.sharedSchema).forEach(([name, compiledSchemaEntry]) => {
      const runtimeSchemaEntry = createRuntimeSharedSchemaEntry(compiledSchemaEntry, ownerEntry);
      const existingEntry = sharedSchema[name];
      if (existingEntry && existingEntry.type !== runtimeSchemaEntry.type) {
        failFinalization(
          `shared chain '${name}' has conflicting types '${existingEntry.type}' and '${runtimeSchemaEntry.type}'`,
          runtimeSchemaEntry.errorContext
        );
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
  const errorContext = entry.errorContextTable[compiledSchemaEntry.errorContextIndex];
  return Object.freeze({
    type: compiledSchemaEntry.type,
    errorContext,
    errorContextIndex: compiledSchemaEntry.errorContextIndex,
    ownerEntry: entry,
    defaultErrorContext: compiledSchemaEntry.hasDefault ? errorContext : null,
    hasDefault: !!compiledSchemaEntry.hasDefault
  });
}

function validateSharedMethodCollisions(sharedSchema, methodNames) {
  Object.keys(sharedSchema).forEach((name) => {
    const methodName = getSharedSourceName(name);
    if (!methodNames.has(methodName)) {
      return;
    }
    failFinalization(
      `shared chain '${methodName}' conflicts with inherited method '${methodName}'`,
      sharedSchema[name].errorContext
    );
  });
}

function validateInheritedMethodDependencies(entries, methodNames) {
  entries.forEach((entry) => {
    Object.values(entry.spec.methodEntries).forEach((methodEntry) => {
      const dependencies = methodEntry.inheritedMethodDependencies;
      Object.keys(dependencies).forEach((name) => {
        if (methodNames.has(name)) {
          return;
        }
        failFinalization(
          `method '${methodEntry.name}' references missing inherited method '${name}'`,
          entry.errorContextTable[dependencies[name].errorContextIndex]
        );
      });
    });
  });
}

function expandAllMethodDependencyFootprints(runtimeEntries, runtimeMethodsByName, dependencyNamesByEntry) {
  const dependencyEntriesByEntry = new Map();
  runtimeEntries.forEach((entry) => {
    const dependencyEntries = dependencyNamesByEntry.get(entry).map((name) => runtimeMethodsByName[name]);
    if (entry.super) {
      dependencyEntries.push(entry.super);
    }
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
    entry.mergedObservedChains = Object.freeze(entry.mergedObservedChains.slice());
    entry.mergedMutatedChains = Object.freeze(entry.mergedMutatedChains.slice());
    Object.freeze(entry);
  });
}

// Propagate chain footprints through inherited callable dependencies. Direct
// calls recorded as `this.method(...)` become dependency edges, and each method's
// `super` entry is a dependency edge to the parent implementation.
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
    const nextObservedChains = mergeChainFootprintNames(
      entry.mergedObservedChains,
      ...dependencyEntries.map((dependency) => dependency.mergedObservedChains)
    );
    if (
      nextLinkedChains.length !== entry.mergedLinkedChains.length ||
      nextObservedChains.length !== entry.mergedObservedChains.length ||
      nextMutatedChains.length !== entry.mergedMutatedChains.length
    ) {
      entry.mergedLinkedChains = nextLinkedChains;
      entry.mergedObservedChains = nextObservedChains;
      entry.mergedMutatedChains = nextMutatedChains;
      changed = true;
    }
  }

  visiting.delete(entry);
  return changed;
}

// Converts a loaded child-to-parent inheritance chain into immutable runtime
// method and shared-schema metadata.
function finalizeInheritanceChain(chain, context = null) {
  void context;
  const entries = chain.entries;
  const ownerEntries = entries.map(createRuntimeOwnerEntry);
  const methodNames = new Set();
  const runtimeMethodsByName = Object.create(null);
  const parentRuntimeEntriesByName = Object.create(null);
  const runtimeEntries = [];
  const dependencyNamesByEntry = new Map();

  entries.forEach((entry) => {
    Object.keys(entry.spec.methodEntries).forEach((name) => methodNames.add(name));
  });

  const sharedSchema = createRuntimeSharedSchema(entries, ownerEntries);
  validateSharedMethodCollisions(sharedSchema, methodNames);

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const ownerEntry = ownerEntries[index];
    Object.entries(entry.spec.methodEntries).forEach(([name, compiledEntry]) => {
      const parentEntry = parentRuntimeEntriesByName[name];
      const runtimeEntry = createRuntimeMethodEntry(compiledEntry, ownerEntry, parentEntry);
      parentRuntimeEntriesByName[name] = runtimeEntry;
      runtimeMethodsByName[name] = runtimeEntry;
      runtimeEntries.push(runtimeEntry);
      dependencyNamesByEntry.set(
        runtimeEntry,
        Object.keys(compiledEntry.inheritedMethodDependencies)
      );
    });
  }

  validateInheritedMethodDependencies(entries, methodNames);
  expandAllMethodDependencyFootprints(runtimeEntries, runtimeMethodsByName, dependencyNamesByEntry);

  return Object.freeze({
    methods: Object.freeze(runtimeMethodsByName),
    sharedSchema: Object.freeze(sharedSchema)
  });
}

export {finalizeInheritanceChain};
