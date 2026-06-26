const DECLARATION_ROLE = Object.freeze({
  MACRO_ARGUMENT: 1,
  MACRO_CALLER: 2
});

const DECLARATION_IMPORT_KIND = Object.freeze({
  FROM: 'from',
  NAMESPACE: 'namespace'
});

function isStoredDirectly(declaration) {
  return !!(declaration && declaration.directStorage);
}

function isChainDeclaration(declaration) {
  return !!(declaration && !isStoredDirectly(declaration));
}

function isVarChainDeclaration(declaration) {
  return !!(isChainDeclaration(declaration) && declaration.type === 'var');
}

function isImmutableDeclaration(declaration) {
  return !!(declaration && (declaration.isMacro || declaration.imported));
}

function canUseDirectStorage(declaration) {
  return !!(
    declaration &&
    declaration.type === 'var' &&
    !declaration.shared &&
    // Caller bindings are internal by placement but value-like by behavior;
    // other internal vars are scheduling/runtime lanes and must remain chains.
    (!declaration.internal || declaration.role === DECLARATION_ROLE.MACRO_CALLER) &&
    !isImmutableDeclaration(declaration)
  );
}

function isStaticCallableDeclaration(declaration) {
  return !!(declaration && (declaration.isMacro || declaration.imported));
}

function isScopeVisibleCallableDeclaration(declaration) {
  return !!(declaration && (declaration.isMacro || declaration.scopeVisibleCallable));
}

function isClassifiedImportedCallableDeclaration(declaration) {
  return !!(
    declaration &&
    declaration.imported &&
    (declaration.requiredCallable || declaration.requiredCallableExports?.size > 0)
  );
}

export {
  DECLARATION_ROLE,
  DECLARATION_IMPORT_KIND,
  isStoredDirectly,
  isChainDeclaration,
  isVarChainDeclaration,
  isImmutableDeclaration,
  canUseDirectStorage,
  isStaticCallableDeclaration,
  isScopeVisibleCallableDeclaration,
  isClassifiedImportedCallableDeclaration
};
