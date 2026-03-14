'use strict';

const RESERVED_DECLARATION_NAMES = new Set(['var', 'value', 'data', 'text', 'sink', 'sequence']);

/**
 * Track the depth of a frame at compile-time for balance validation.
 * @param {Frame} newFrame - The new frame being pushed
 * @param {Frame} parentFrame - The parent frame
 */
function trackCompileTimeFrameDepth(newFrame, parentFrame) {
  newFrame._compilerDepth = (parentFrame._compilerDepth || 0) + 1;
}

/**
 * Validate that the current frame is balanced with its parent before popping.
 * @param {Frame} frame - The current frame to be popped
 * @param {Compiler} compiler - The compiler instance (for error reporting)
 * @param {Node} positionNode - The AST node for error positioning
 */
function validateCompileTimeFrameBalance(frame, compiler, positionNode) {
  if (!frame.parent) {
    compiler.fail('Compiler error: Frame pop without parent - unbalanced push/pop detected', positionNode.lineno, positionNode.colno, positionNode);
  }

  const expectedDepth = (frame._compilerDepth || 0) - 1;
  if (frame.parent._compilerDepth !== undefined && frame.parent._compilerDepth !== expectedDepth) {
    compiler.fail(`Compiler error: Frame depth mismatch - expected ${expectedDepth}, got ${frame.parent._compilerDepth}`, positionNode.lineno, positionNode.colno, positionNode);
  }
}

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
 * Validate that a variable declaration is attached to a scoping frame.
 * @param {Frame} frame - The frame where the declaration is being registered
 * @param {string} name - The variable name
 * @param {Compiler} compiler - The compiler instance (for error reporting)
 * @param {Node|null} node - The AST node for error positioning (optional)
 */
function validateDeclarationScope(frame, name, compiler, node) {
  if (frame && frame.createScope === false) {
    const lineno = node && node.lineno;
    const colno = node && node.colno;
    compiler.fail(
      `Cannot declare variable '${name}' in a non-scoping frame.`,
      lineno,
      colno,
      node || undefined
    );
  }
}

/**
 * Validate that write attempts from read-only scopes do not target outer variables/outputs.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Frame} options.frame - Current frame
 * @param {Node} options.node - Statement node
 * @param {Node} options.target - Assignment target node (for precise position)
 * @param {string} options.name - Variable/output name
 * @param {boolean} options.mutatingOuterRef - True when assignment targets an outer-scope binding
 */
/**
 * Validate output declaration statement constraints.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - Output declaration node
 * @param {Node} options.nameNode - Name node
 * @param {string} options.outputType - data|text|var|sink|sequence
 * @param {boolean} options.hasInitializer - Whether initializer exists
 * @param {boolean} options.asyncMode - Compiler async mode
 * @param {boolean} options.scriptMode - Compiler script mode
 * @param {boolean} options.isNameSymbol - Whether nameNode is a Symbol
 */
function validateOutputDeclarationNode(compiler, {
  node,
  nameNode,
  outputType,
  hasInitializer,
  asyncMode,
  scriptMode,
  isNameSymbol
}) {
  if (!asyncMode) {
    compiler.fail('Output declarations are only supported in async mode', node.lineno, node.colno, node);
  }
  if (!scriptMode) {
    compiler.fail('Output declarations are only supported in script mode', node.lineno, node.colno, node);
  }
  if (!isNameSymbol) {
    compiler.fail('Output declaration name must be a symbol', node.lineno, node.colno, node);
  }
  if ((outputType === 'data' || outputType === 'text') && hasInitializer) {
    compiler.fail(`${outputType} outputs cannot have initializers`, node.lineno, node.colno, node);
  }
  if ((outputType === 'sink' || outputType === 'sequence') && !hasInitializer) {
    compiler.fail(`${outputType} outputs must have an initializer`, node.lineno, node.colno, node);
  }
}

/**
 * Validate sink snapshot guard restrictions.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - Position node
 * @param {string} options.command - snapshot|isError|getError
 * @param {string|null} options.outputType - Output type
 */
function validateSinkSnapshotInGuard(compiler, { node, command, outputType }) {
  if (command === 'snapshot' && outputType === 'sink' && compiler.guardDepth > 0) {
    compiler.fail('sink snapshot() is not allowed inside guard blocks', node.lineno, node.colno, node);
  }
}

/**
 * Validate observation call constraints for output symbols.
 * @param {Compiler} compiler - The compiler instance
 * @param {object} options
 * @param {Node} options.node - OutputCommand node
 * @param {string} options.command - snapshot|isError|getError
 * @param {string} options.handler - Output symbol name
 * @param {string|null} options.outputType - Declared output type
 */
function validateOutputObservationCall(compiler, { node, command, handler, outputType }) {
  if (node.call && node.call.args && node.call.args.children && node.call.args.children.length > 0) {
    compiler.fail(
      `${command}() does not accept arguments on output '${handler}'.`,
      node.lineno,
      node.colno,
      node
    );
  }
  validateSinkSnapshotInGuard(compiler, { node, command, outputType });
}



module.exports = {
  RESERVED_DECLARATION_NAMES,
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance,
  validateGuardVariablesDeclared,
  validateDeclarationScope,
  validateOutputDeclarationNode,
  validateSinkSnapshotInGuard,
  validateOutputObservationCall
};
