'use strict';

const nodes = require('../nodes');
const {
  CHANNEL_TYPES,
  CHANNEL_TYPE_FACTS
} = require('../channel-types');

const RESERVED_DECLARATION_NAMES = new Set([...CHANNEL_TYPES, 'value', 'component', 'this', '__return__', '__RETURN_UNSET__', '__constructor__']);
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
 * Validate that write attempts from read-only scopes do not target outer variables/channels.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Frame} options.frame - Current frame
 * @param {Node} options.node - Statement node
 * @param {Node} options.target - Assignment target node (for precise position)
 * @param {string} options.name - Variable/output name
 * @param {boolean} options.mutatingOuterRef - True when assignment targets an outer-scope binding
 */
/**
 * Validate channel declaration statement constraints.
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - Channel declaration node
 */
function validateChannelDeclarationNode(compiler, node) {
  const nameNode = node && node.name;
  const channelType = node && node.channelType;
  const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
  const hasInitializer = !!(node && node.initializer);
  const isShared = !!(node && node.isShared);
  const isRootScopeOwner = compiler.analysis.isRootScopeOwner(node._analysis);

  if (!compiler.asyncMode) {
    compiler.fail('Channel declarations are only supported in async mode', node.lineno, node.colno, node);
  }
  if (!compiler.scriptMode && !isShared) {
    compiler.fail('Channel declarations are only supported in script mode', node.lineno, node.colno, node);
  }
  if (!(nameNode instanceof nodes.Symbol)) {
    compiler.fail('Channel declaration name must be a symbol', node.lineno, node.colno, node);
  }
  if (isShared && !isRootScopeOwner) {
    compiler.fail('shared declarations are only allowed at the root scope', node.lineno, node.colno, node);
  }
  if (!isShared && channelFacts && channelFacts.requiresInitializer && !hasInitializer) {
    compiler.fail(`${channelType} channels must have an initializer`, node.lineno, node.colno, node);
  }
}

/**
 * Validate observation call constraints for channel symbols.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - ChannelCommand node
 * @param {string} options.command - snapshot|isError|getError
 * @param {string} options.channelName - Channel symbol name
 * @param {string|null} options.channelType - Declared channel type
 */
function validateChannelObservationCall(compiler, { node, command, channelName, channelType }) {
  if (node.call && node.call.args && node.call.args.children && node.call.args.children.length > 0) {
    compiler.fail(
      `${command}() does not accept arguments on channel '${channelName}'.`,
      node.lineno,
      node.colno,
      node
    );
  }
}

function describePreExtendsRootStatement(node) {
  if (node instanceof nodes.Set) {
    return node.varType === 'declaration' ? 'var declaration' : 'assignment';
  }
  if (node instanceof nodes.Block) {
    return 'method declaration';
  }
  if (node instanceof nodes.Extends) {
    return 'extends statement';
  }
  if (node instanceof nodes.ChannelDeclaration) {
    return `${node.isShared ? 'shared ' : ''}${node.channelType} declaration`;
  }
  return `${node.typename || 'statement'} statement`;
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
    if (child instanceof nodes.ChannelDeclaration && child.isShared) {
      continue;
    }
    const offendingNodeDescription = describePreExtendsRootStatement(child);
    return {
      node: child,
      message: `unexpected ${offendingNodeDescription} before extends; only shared declarations are allowed before extends`
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

function validateLocalSharedMethodNameCollisions(compiler, node) {
  const sharedDeclarations = compiler._getSharedDeclarations(node);
  if (!sharedDeclarations || sharedDeclarations.length === 0) {
    return;
  }
  const sharedNames = new Map();
  sharedDeclarations.forEach((declaration) => {
    if (declaration && declaration.name && declaration.name.value) {
      sharedNames.set(declaration.name.value, declaration);
    }
  });
  if (sharedNames.size === 0) {
    return;
  }
  const methodDefinitions = compiler.scriptMode
    ? compiler._getMethodDefinitions(node)
    : node.findAll(nodes.Block);
  methodDefinitions.forEach((method) => {
    const methodName = method && method.name && method.name.value;
    if (!methodName || !sharedNames.has(methodName)) {
      return;
    }
    compiler.fail(
      `shared channel '${methodName}' conflicts with method '${methodName}' defined in this file`,
      method.name.lineno,
      method.name.colno,
      method,
      sharedNames.get(methodName)
    );
  });
}



module.exports = {
  RESERVED_DECLARATION_NAMES,
  RESERVED_ASYNC_DECLARATION_NAMES,
  validateGuardVariablesDeclared,
  validateChannelDeclarationNode,
  validateChannelObservationCall,
  getScriptExtendsSourceOrderViolation,
  validateScriptExtendsSourceOrder,
  validateLocalSharedMethodNameCollisions
};
