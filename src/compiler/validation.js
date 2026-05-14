
import * as nodes from '../language/nodes.js';
import {CHANNEL_TYPES, CHANNEL_TYPE_FACTS} from '../channel-types.js';

import {
  RETURN_CHANNEL_NAME,
  RETURN_IS_UNSET_FUNCTION_NAME,
  RESERVED_RETURN_SENTINEL_SYMBOL_NAME,
} from './return.js';

const RESERVED_DECLARATION_NAMES = new Set([
  ...CHANNEL_TYPES,
  'value',
  'component',
  'this',
  RETURN_CHANNEL_NAME,
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
 * Validate that write attempts from read-only scopes do not target outer variables/channels.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Frame} options.frame - Current frame
 * @param {Node} options.node - Statement node
 * @param {Node} options.target - Assignment target node (for precise position)
 * @param {string} options.name - Variable/channel name
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
  if (!compiler.scriptMode) {
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

function isAllowedBeforeScriptExtendsNode(node) {
  if (nodes.isWhitespaceOutputNode(node)) {
    return true;
  }
  return node instanceof nodes.ChannelDeclaration && node.isShared;
}

function isAllowedBeforeTemplateExtendsNode(node) {
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
    if (isAllowedBeforeScriptExtendsNode(child)) {
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

function isRootLevelNode(rootNode, childNode) {
  return !!(rootNode && Array.isArray(rootNode.children) && rootNode.children.includes(childNode));
}

function validateTemplateExtendsExpression(compiler, rootNode, extendsNode) {
  if (!extendsNode || !extendsNode.template) {
    return;
  }
  const usedChannels = extendsNode.template._analysis?.usedChannels;
  if (!usedChannels) {
    return;
  }
  const inferredSharedNames = new Set();
  const sharedDeclarations = compiler.inheritance.getSharedDeclarations(rootNode);
  sharedDeclarations.forEach((declaration) => {
    if (declaration.implicitTemplateShared) {
      inferredSharedNames.add(declaration.name);
    }
  });
  usedChannels.forEach((name) => {
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

  const allExtendsNodes = rootNode.findAll(nodes.Extends);
  const directExtendsNodes = allExtendsNodes.filter((extendsNode) =>
    isRootLevelNode(rootNode, extendsNode)
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
      if (isAllowedBeforeTemplateExtendsNode(child)) {
        continue;
      }
      compiler.fail(
        'template extends must appear before template code',
        child.lineno,
        child.colno,
        child
      );
    }
    validateTemplateExtendsExpression(compiler, rootNode, directExtendsNode);
  }

  const nestedExtends = allExtendsNodes.find((extendsNode) =>
    !isRootLevelNode(rootNode, extendsNode)
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

function validateLocalSharedMethodNameCollisions(compiler, node) {
  const sharedDeclarations = compiler.inheritance.getSharedDeclarations(node);
  if (sharedDeclarations.length === 0) {
    return;
  }
  const sharedNames = new Map();
  sharedDeclarations.forEach((declaration) => {
    sharedNames.set(declaration.name, declaration);
  });
  const methodDefinitions = compiler.scriptMode
    ? compiler.inheritance.getMethodDefinitions(node)
    : node.findAll(nodes.Block);
  methodDefinitions.forEach((method) => {
    const methodName = method.name.value;
    if (!sharedNames.has(methodName)) {
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



export { RESERVED_DECLARATION_NAMES, RESERVED_ASYNC_DECLARATION_NAMES, validateGuardVariablesDeclared, validateChannelDeclarationNode, validateChannelObservationCall, getScriptExtendsSourceOrderViolation, validateScriptExtendsSourceOrder, validateTemplateExtendsExpression, validateTemplateInheritanceSurface, validateLocalSharedMethodNameCollisions };
