'use strict';

const nodes = require('../nodes');

// Canonical lexical-scope boundaries used by compiler and transformer.
// Any non-listed fields are implicitly non-scope and are traversed in-place.
const SCOPE_BOUNDARY_FIELDS_BY_NODE = Object.freeze({
  If: Object.freeze(['body', 'else_']),
  IfAsync: Object.freeze(['body', 'else_']),
  Switch: Object.freeze(['cases', 'default']),
  Case: Object.freeze(['body']),
  For: Object.freeze(['body', 'else_']),
  AsyncEach: Object.freeze(['body', 'else_']),
  AsyncAll: Object.freeze(['body', 'else_']),
  While: Object.freeze(['body']),
  Guard: Object.freeze(['body', 'recoveryBody']),
  Macro: Object.freeze(['body']),
  Caller: Object.freeze(['body']),
  Capture: Object.freeze(['body']),
  Block: Object.freeze(['body']),
  MethodDefinition: Object.freeze(['body']),
  // Set/CallAssign capture bodies are not regular node.fields but are lexical scopes.
  Set: Object.freeze(['body']),
  CallAssign: Object.freeze(['body'])
});
// Convenience export for tests/consumers that need the canonical boundary list
// without duplicating node names in assertions.
const SCOPE_BOUNDARY_NODE_NAMES = Object.freeze(Object.keys(SCOPE_BOUNDARY_FIELDS_BY_NODE));

function getScopeBoundaryFields(node) {
  if (!node || !node.typename) {
    return [];
  }
  return SCOPE_BOUNDARY_FIELDS_BY_NODE[node.typename] || [];
}

function _isSetLikeDeclaration(node) {
  return !!(node && node.varType === 'declaration');
}

function isDeclarationSite(node, ctx = {}) {
  if (!node || !node.typename) {
    return false;
  }

  if (node instanceof nodes.Set || node instanceof nodes.CallAssign) {
    return _isSetLikeDeclaration(node);
  }

  if (node instanceof nodes.ChannelDeclaration) {
    return true;
  }

  if (node instanceof nodes.Import) {
    // Import/FromImport declaration intent is field-context dependent.
    // The node itself is not always treated as a declaration site.
    return !!ctx.inImportTarget;
  }

  if (node instanceof nodes.FromImport) {
    return !!ctx.inFromImportTarget;
  }

  return false;
}

function extractDeclaredSymbols(node, ctx = {}) {
  if (!node) {
    return [];
  }

  if ((node instanceof nodes.Set || node instanceof nodes.CallAssign) && _isSetLikeDeclaration(node)) {
    // Declaration-form set/call_assign may declare multiple symbols at once.
    return (node.targets || []).filter((target) => target instanceof nodes.Symbol);
  }

  if (node instanceof nodes.ChannelDeclaration) {
    return node.name instanceof nodes.Symbol ? [node.name] : [];
  }

  if (node instanceof nodes.Import && ctx.inImportTarget) {
    return node.target instanceof nodes.Symbol ? [node.target] : [];
  }

  if (node instanceof nodes.FromImport && ctx.inFromImportTarget) {
    if (!node.names || !node.names.children) {
      return [];
    }
    const names = [];
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        names.push(nameNode.value);
      } else if (nameNode instanceof nodes.Symbol) {
        names.push(nameNode);
      }
    });
    return names;
  }

  return [];
}

module.exports = {
  SCOPE_BOUNDARY_FIELDS_BY_NODE,
  SCOPE_BOUNDARY_NODE_NAMES,
  getScopeBoundaryFields,
  isDeclarationSite,
  extractDeclaredSymbols
};
