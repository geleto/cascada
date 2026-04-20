'use strict';

const nodes = require('../nodes');

const RESERVED_DECLARATION_NAMES = new Set(['var', 'value', 'data', 'text', 'sink', 'sequence', 'component', 'this', '__return__', '__constructor__']);
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
 * @param {object} options
 * @param {Node} options.node - Channel declaration node
 * @param {Node} options.nameNode - Name node
 * @param {string} options.channelType - data|text|var|sink|sequence
 * @param {boolean} options.hasInitializer - Whether initializer exists
 * @param {boolean} options.asyncMode - Compiler async mode
 * @param {boolean} options.scriptMode - Compiler script mode
 * @param {boolean} options.isNameSymbol - Whether nameNode is a Symbol
 * @param {boolean} options.isShared - Whether declaration uses the shared keyword
 * @param {boolean} options.isRootScopeOwner - Whether declaration is in the root scope owner
 */
function validateChannelDeclarationNode(compiler, {
  node,
  nameNode,
  channelType,
  hasInitializer,
  asyncMode,
  scriptMode,
  isNameSymbol,
  isShared,
  isRootScopeOwner
}) {
  if (!asyncMode) {
    compiler.fail('Channel declarations are only supported in async mode', node.lineno, node.colno, node);
  }
  if (!scriptMode && !isShared) {
    compiler.fail('Channel declarations are only supported in script mode', node.lineno, node.colno, node);
  }
  if (!isNameSymbol) {
    compiler.fail('Channel declaration name must be a symbol', node.lineno, node.colno, node);
  }
  if (isShared && !isRootScopeOwner) {
    compiler.fail('shared declarations are only allowed at the root scope', node.lineno, node.colno, node);
  }
  if (isShared && channelType === 'sink') {
    // The parser already rejects `shared sink`, but keep the compiler-side
    // guard so manually constructed ASTs fail the same feature gate.
    compiler.fail('shared sink declarations are not supported', node.lineno, node.colno, node);
  }
  if (!isShared && (channelType === 'sink' || channelType === 'sequence') && !hasInitializer) {
    compiler.fail(`${channelType} channels must have an initializer`, node.lineno, node.colno, node);
  }
}

/**
 * Validate sink snapshot guard restrictions.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - Position node
 * @param {string} options.command - snapshot|isError|getError
 * @param {string|null} options.channelType - Channel type
 */
function validateSinkSnapshotInGuard(compiler, { node, command, channelType }) {
  if (command === 'snapshot' && channelType === 'sink' && compiler.guardDepth > 0) {
    compiler.fail('sink snapshot() is not allowed inside guard blocks', node.lineno, node.colno, node);
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
  validateSinkSnapshotInGuard(compiler, { node, command, channelType });
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



module.exports = {
  RESERVED_DECLARATION_NAMES,
  RESERVED_ASYNC_DECLARATION_NAMES,
  validateGuardVariablesDeclared,
  validateChannelDeclarationNode,
  validateSinkSnapshotInGuard,
  validateChannelObservationCall,
  getScriptExtendsSourceOrderViolation,
  validateScriptExtendsSourceOrder
};
