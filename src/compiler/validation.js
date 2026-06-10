
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPES, CHAIN_TYPE_FACTS} from '../chain-types.js';

import {
  RETURN_CHAIN_NAME,
  RETURN_IS_UNSET_FUNCTION_NAME,
  RESERVED_RETURN_SENTINEL_SYMBOL_NAME,
} from './return.js';

const RESERVED_DECLARATION_NAMES = new Set([
  ...CHAIN_TYPES,
  'value',
  'component',
  'this',
  RETURN_CHAIN_NAME,
  RETURN_IS_UNSET_FUNCTION_NAME,
  RESERVED_RETURN_SENTINEL_SYMBOL_NAME,
  '__constructor__',
  '__proto__'
]);
const RESERVED_ASYNC_DECLARATION_NAMES = new Set(['context']);

/**
 * Validate that guard variables are declared in the scope.
 * This remains a compile-time syntax/semantic check even though
 * async var rollback machinery has been removed.
 */
function validateGuardVariablesDeclared(variableTargets, compiler, node) {
  if (variableTargets && variableTargets !== '*') {
    for (const varName of variableTargets) {
      const decl = compiler.analysis.findDeclaration(node._analysis, varName);
      if (!(decl && decl.type === 'var')) {
        compiler.fail(`guard variable "${varName}" is not declared`, node.lineno, node.colno, node);
      }
    }
  }
}

/**
 * Validate that write attempts from read-only scopes do not target outer variables/chains.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Frame} options.frame - Current frame
 * @param {Node} options.node - Statement node
 * @param {Node} options.target - Assignment target node (for precise position)
 * @param {string} options.name - Variable/chain name
 * @param {boolean} options.mutatingOuterRef - True when assignment targets an outer-scope binding
 */
/**
 * Validate chain declaration statement constraints.
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - Chain declaration node
 */
function validateChainDeclarationNode(compiler, node) {
  const nameNode = node && node.name;
  const chainType = node && node.chainType;
  const chainFacts = CHAIN_TYPE_FACTS[chainType] || null;
  const hasInitializer = !!(node && node.initializer);
  const isShared = !!(node && node.isShared);
  const isRootScopeOwner = compiler.analysis.isRootScopeOwner(node._analysis);

  if (!compiler.asyncMode) {
    compiler.fail('Chain declarations are only supported in async mode', node.lineno, node.colno, node);
  }
  if (!compiler.scriptMode) {
    compiler.fail('Chain declarations are only supported in script mode', node.lineno, node.colno, node);
  }
  if (!(nameNode instanceof nodes.Symbol)) {
    compiler.fail('Chain declaration name must be a symbol', node.lineno, node.colno, node);
  }
  if (isShared && !isRootScopeOwner) {
    compiler.fail('shared declarations are only allowed at the root scope', node.lineno, node.colno, node);
  }
  if (!isShared && chainFacts && chainFacts.requiresInitializer && !hasInitializer) {
    compiler.fail(`${chainType} chains must have an initializer`, node.lineno, node.colno, node);
  }
}

/**
 * Validate observation call constraints for chain symbols.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - ChainCommand node
 * @param {string} options.command - snapshot|isError|getError
 * @param {string} options.chainName - Chain symbol name
 * @param {string|null} options.chainType - Declared chain type
 */
function validateChainObservationCall(compiler, { node, command, chainName, chainType }) {
  if (node.call && node.call.args && node.call.args.children && node.call.args.children.length > 0) {
    compiler.fail(
      `${command}() does not accept arguments on chain '${chainName}'.`,
      node.lineno,
      node.colno,
      node
    );
  }
}

function _isAllowedBeforeScriptExtendsNode(node) {
  if (nodes.isWhitespaceOutputNode(node)) {
    return true;
  }
  return node instanceof nodes.ChainDeclaration && node.isShared;
}

function _isAllowedBeforeTemplateExtendsNode(node) {
  return nodes.isWhitespaceOutputNode(node);
}

function getScriptExtendsSourceOrderViolation(node) {
  if (!node || !Array.isArray(node.children)) {
    return null;
  }
  const directExtendsNodes = node.children.filter((child) => child instanceof nodes.Extends);
  if (directExtendsNodes.length > 1) {
    const extraExtendsNode = directExtendsNodes[1];
    return {
      node: extraExtendsNode,
      message: 'script roots support at most one top-level extends declaration'
    };
  }

  const firstDirectExtendsIndex = directExtendsNodes.length > 0
    ? node.children.indexOf(directExtendsNodes[0])
    : -1;
  if (firstDirectExtendsIndex === -1) {
    return null;
  }

  for (let i = 0; i < firstDirectExtendsIndex; i++) {
    const child = node.children[i];
    if (_isAllowedBeforeScriptExtendsNode(child)) {
      continue;
    }
    return {
      node: child,
      message: 'only shared declarations may appear before script extends'
    };
  }

  return null;
}

function validateScriptExtendsSourceOrder(compiler, node) {
  if (!compiler.scriptMode) {
    return;
  }

  const violation = getScriptExtendsSourceOrderViolation(node);
  if (!violation) {
    return;
  }

  compiler.fail(
    violation.message,
    violation.node.lineno,
    violation.node.colno,
    violation.node
  );
}

function _hasThisLookup(node) {
  if (!node) {
    return false;
  }
  if (node instanceof nodes.LookupVal) {
    let target = node;
    while (target instanceof nodes.LookupVal) {
      target = target.target;
    }
    return target instanceof nodes.Symbol && target.value === 'this';
  }
  return node.findAll(nodes.LookupVal).some((lookupNode) => _hasThisLookup(lookupNode));
}

function _validateExtendsTargetDoesNotUseThis(compiler, extendsNode) {
  if (_hasThisLookup(extendsNode.template)) {
    compiler.fail(
      'dynamic extends target cannot read this.<shared> state',
      extendsNode.template.lineno,
      extendsNode.template.colno,
      extendsNode
    );
  }
}

function validateScriptExtendsExpression(compiler, rootNode) {
  if (!compiler.scriptMode) {
    return;
  }
  const extendsNode = rootNode.children.find((child) => child instanceof nodes.Extends) || null;
  if (!extendsNode || !extendsNode.template || extendsNode.noParentLiteral) {
    return;
  }
  _validateExtendsTargetDoesNotUseThis(compiler, extendsNode);
}

function _isRootLevelNode(rootNode, childNode) {
  return childNode._analysis?.parent === rootNode._analysis;
}

function _validateTemplateExtendsExpression(compiler, rootNode, extendsNode) {
  if (!extendsNode || !extendsNode.template) {
    return;
  }
  _validateExtendsTargetDoesNotUseThis(compiler, extendsNode);
  const usedChains = compiler.analysis.getChainsUsedFromParent(extendsNode.template);
  if (usedChains.length === 0) {
    return;
  }
  const inferredSharedNames = new Set();
  const sharedDeclarations = rootNode._analysis.inheritanceSharedDeclarations ?? [];
  sharedDeclarations.forEach((declaration) => {
    if (declaration.implicitTemplateShared) {
      inferredSharedNames.add(declaration.name);
    }
  });
  usedChains.forEach((name) => {
    if (!inferredSharedNames.has(name)) {
      return;
    }
    compiler.fail(
      `template extends target cannot read inferred shared var 'this.${name}'`,
      extendsNode.template.lineno,
      extendsNode.template.colno,
      extendsNode
    );
  });
}

function validateTemplateInheritanceSurface(compiler, rootNode) {
  if (compiler.scriptMode) {
    return;
  }

  const allExtendsNodes = rootNode._analysis.inheritanceExtendsNodes ?? [];
  const directExtendsNodes = allExtendsNodes.filter((extendsNode) =>
    _isRootLevelNode(rootNode, extendsNode)
  );
  if (directExtendsNodes.length > 1) {
    const extraExtendsNode = directExtendsNodes[1];
    compiler.fail(
      'template roots support at most one top-level extends declaration',
      extraExtendsNode.lineno,
      extraExtendsNode.colno,
      extraExtendsNode
    );
  }

  const directExtendsNode = directExtendsNodes[0] || null;
  if (directExtendsNode) {
    const extendsIndex = rootNode.children.indexOf(directExtendsNode);
    for (let i = 0; i < extendsIndex; i++) {
      const child = rootNode.children[i];
      if (_isAllowedBeforeTemplateExtendsNode(child)) {
        continue;
      }
      compiler.fail(
        'template extends must appear before template code',
        child.lineno,
        child.colno,
        child
      );
    }
    _validateTemplateExtendsExpression(compiler, rootNode, directExtendsNode);
  }

  const nestedExtends = allExtendsNodes.find((extendsNode) =>
    !_isRootLevelNode(rootNode, extendsNode)
  );
  if (nestedExtends) {
    compiler.fail(
      'template extends must be a top-level declaration',
      nestedExtends.lineno,
      nestedExtends.colno,
      nestedExtends
    );
  }
}



export { RESERVED_DECLARATION_NAMES, RESERVED_ASYNC_DECLARATION_NAMES, validateGuardVariablesDeclared, validateChainDeclarationNode, validateChainObservationCall, getScriptExtendsSourceOrderViolation, validateScriptExtendsSourceOrder, validateScriptExtendsExpression, validateTemplateInheritanceSurface };
