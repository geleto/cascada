function getOwnerErrorContextTable(ownerEntry, ownerTables, runtime, reportError) {
  if (ownerTables.has(ownerEntry)) {
    return ownerTables.get(ownerEntry);
  }

  const table = ownerEntry.templateOrScript.getErrorContexts(runtime, ownerEntry.path ?? null, reportError);
  ownerTables.set(ownerEntry, table);
  return table;
}

function bindRuntimeSharedSchemaEntry(schemaEntry, runtime, reportError, ownerTables) {
  const errorContext = getOwnerErrorContextTable(schemaEntry.ownerEntry, ownerTables, runtime, reportError)[schemaEntry.errorContextIndex];
  return Object.freeze({
    type: schemaEntry.type,
    errorContext,
    ownerEntry: schemaEntry.ownerEntry,
    defaultErrorContext: schemaEntry.hasDefault ? errorContext : null,
    hasDefault: schemaEntry.hasDefault
  });
}

// Binds finalized metadata to one render/inheritance instance by preparing
// owner error-context tables with that instance's reportError callback.
function bindInheritanceRuntimeState(runtimeState, runtime, reportError) {
  const ownerTables = new Map();
  const boundMethods = new Map();
  const pendingMethods = Object.values(runtimeState.methods);
  for (let index = 0; index < pendingMethods.length; index++) {
    const methodData = pendingMethods[index];
    if (boundMethods.has(methodData)) {
      continue;
    }
    if (methodData.super) {
      pendingMethods.push(methodData.super);
    }
    const ownerTable = getOwnerErrorContextTable(methodData.ownerEntry, ownerTables, runtime, reportError);
    const errorContext = methodData.errorContextIndex == null
      ? methodData.errorContext
      : ownerTable[methodData.errorContextIndex];
    boundMethods.set(methodData, {
      name: methodData.name,
      fn: methodData.fn,
      signature: methodData.signature,
      errorContext,
      isConstructor: methodData.isConstructor,
      ownerEntry: methodData.ownerEntry,
      mergedLinkedChains: methodData.mergedLinkedChains,
      mergedMutatedChains: methodData.mergedMutatedChains,
      errorContextTable: ownerTable,
      super: null
    });
  }

  boundMethods.forEach((boundMethod, methodData) => {
    boundMethod.super = methodData.super ? boundMethods.get(methodData.super) : null;
    Object.freeze(boundMethod);
  });

  const methods = Object.create(null);
  Object.entries(runtimeState.methods).forEach(([name, methodData]) => {
    methods[name] = boundMethods.get(methodData);
  });

  const sharedSchema = Object.create(null);
  Object.entries(runtimeState.sharedSchema).forEach(([name, schemaEntry]) => {
    sharedSchema[name] = bindRuntimeSharedSchemaEntry(schemaEntry, runtime, reportError, ownerTables);
  });

  return Object.freeze({
    methods: Object.freeze(methods),
    sharedSchema: Object.freeze(sharedSchema)
  });
}

export {bindInheritanceRuntimeState};
