import {CHAIN_TYPES} from '../chain-types.js';
import {isChainDeclaration, isVarChainDeclaration} from './declarations.js';

const RETURN_CHAIN_NAME = '__return__';
const RETURN_IS_UNSET_FUNCTION_NAME = '__return_is_unset__';
const RESERVED_RETURN_SENTINEL_SYMBOL_NAME = '__RETURN_UNSET__';
const CALLER_CHAIN_NAME = '__caller__';
const WAITED_CHAIN_NAME = '__waited__';

const INTERNAL_DECLARATION_NAMES = [
  RETURN_CHAIN_NAME,
  RETURN_IS_UNSET_FUNCTION_NAME,
  RESERVED_RETURN_SENTINEL_SYMBOL_NAME,
  CALLER_CHAIN_NAME,
  WAITED_CHAIN_NAME
];

const RESERVED_DECLARATION_NAMES = new Set([
  ...CHAIN_TYPES,
  ...INTERNAL_DECLARATION_NAMES,
  'component',
  'this',
  '__constructor__',
  '__proto__'
]);
const RESERVED_ASYNC_DECLARATION_NAMES = new Set(['context']);
const STRICT_RESERVED_DECLARATION_NAMES = new Set([
  ...INTERNAL_DECLARATION_NAMES,
  '__constructor__',
  '__proto__',
  'context'
]);

function isReservedDeclarationName(name, { asyncMode = false } = {}) {
  return RESERVED_DECLARATION_NAMES.has(name) ||
    (asyncMode && RESERVED_ASYNC_DECLARATION_NAMES.has(name));
}

function isStrictReservedDeclarationName(name) {
  return STRICT_RESERVED_DECLARATION_NAMES.has(name);
}

function isReservedDeclaration(decl, { asyncMode = false, scriptMode = false } = {}) {
  if (!decl || decl.internal) {
    return false;
  }
  if (!isReservedDeclarationName(decl.name, { asyncMode })) {
    return false;
  }
  return isStrictReservedDeclarationName(decl.name) ||
    (isChainDeclaration(decl) && !isVarChainDeclaration(decl)) ||
    scriptMode;
}

export {
  CALLER_CHAIN_NAME,
  RETURN_CHAIN_NAME,
  RETURN_IS_UNSET_FUNCTION_NAME,
  WAITED_CHAIN_NAME,
  isReservedDeclaration,
  isReservedDeclarationName,
};
