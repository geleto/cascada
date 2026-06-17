function getOwnerErrorContextTable(ownerEntry) {
  return ownerEntry.ownerState.errorContextTable;
}

function bindRuntimeSharedSchemaEntry(schemaEntry) {
  const errorContext = getOwnerErrorContextTable(schemaEntry.ownerEntry)[schemaEntry.errorContextIndex];
  return Object.freeze({
    type: schemaEntry.type,
    errorContext,
    ownerEntry: schemaEntry.ownerEntry,
    defaultErrorContext: schemaEntry.hasDefault ? errorContext : null,
    hasDefault: schemaEntry.hasDefault
  });
}

// Binds finalized metadata to one render/inheritance instance using the
// active owner-state error context table for each source artifact.
function bindInheritanceRuntimeState(runtimeState) {
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
    const ownerTable = getOwnerErrorContextTable(methodData.ownerEntry);
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
      mergedObservedChains: methodData.mergedObservedChains,
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
    sharedSchema[name] = bindRuntimeSharedSchemaEntry(schemaEntry);
  });

  return Object.freeze({
    methods: Object.freeze(methods),
    sharedSchema: Object.freeze(sharedSchema)
  });
}

export {bindInheritanceRuntimeState};
