const DECLARATION_ROLE = Object.freeze({
  MACRO_ARGUMENT: 1,
  MACRO_CALLER: 2
});

const DECLARATION_STORAGE = Object.freeze({
  CHAIN: 1,
  DIRECT: 2
});

const DECLARATION_IMPORT_KIND = Object.freeze({
  FROM: 'from',
  NAMESPACE: 'namespace'
});

function isStoredDirectly(declaration) {
  return !!(declaration && declaration.storage === DECLARATION_STORAGE.DIRECT);
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
  DECLARATION_STORAGE,
  DECLARATION_IMPORT_KIND,
  isStoredDirectly,
  isChainDeclaration,
  isVarChainDeclaration,
  isImmutableDeclaration,
  isStaticCallableDeclaration,
  isScopeVisibleCallableDeclaration,
  isClassifiedImportedCallableDeclaration
};
