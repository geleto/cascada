const DECLARATION_ROLE = Object.freeze({
  MACRO_ARGUMENT: 1,
  MACRO_CALLER: 2
});

const DECLARATION_STORAGE = Object.freeze({
  CHAIN: 1,
  DIRECT: 2
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

export {
  DECLARATION_ROLE,
  DECLARATION_STORAGE,
  isStoredDirectly,
  isChainDeclaration,
  isVarChainDeclaration,
  isImmutableDeclaration
};
