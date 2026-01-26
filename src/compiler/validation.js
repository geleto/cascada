'use strict';

// Enable bidirectional validation to ensure write counter registration and decrementing are mutual.
// Set to true during development to catch compiler bugs early at compile-time.
// Can be set to false in production if needed for performance (runtime checks still active).
const ENABLE_RESOLVEUP_VALIDATION = true;

// Enable frame balance validation at compile-time.
// Set to true during development to catch frame push/pop bugs early.
// Can be set to false in production if needed for performance.
const ENABLE_FRAME_BALANCE_VALIDATION = true;

// Enable declaration scope validation at compile-time.
// This ensures variables are only declared on frames that explicitly create a scope.
// Set to true during development to catch incorrect frame selection early.
const ENABLE_SCOPE_VALIDATION = true;

/**
 * Track the depth of a frame at compile-time for balance validation.
 * @param {Frame} newFrame - The new frame being pushed
 * @param {Frame} parentFrame - The parent frame
 */
function trackCompileTimeFrameDepth(newFrame, parentFrame) {
  if (ENABLE_FRAME_BALANCE_VALIDATION) {
    newFrame._compilerDepth = (parentFrame._compilerDepth || 0) + 1;
  }
}

/**
 * Validate that the current frame is balanced with its parent before popping.
 * @param {Frame} frame - The current frame to be popped
 * @param {Compiler} compiler - The compiler instance (for error reporting)
 * @param {Node} positionNode - The AST node for error positioning
 */
function validateCompileTimeFrameBalance(frame, compiler, positionNode) {
  if (ENABLE_FRAME_BALANCE_VALIDATION) {
    if (!frame.parent) {
      compiler.fail('Compiler error: Frame pop without parent - unbalanced push/pop detected', positionNode.lineno, positionNode.colno, positionNode);
    }

    const expectedDepth = (frame._compilerDepth || 0) - 1;
    if (frame.parent._compilerDepth !== undefined && frame.parent._compilerDepth !== expectedDepth) {
      compiler.fail(`Compiler error: Frame depth mismatch - expected ${expectedDepth}, got ${frame.parent._compilerDepth}`, positionNode.lineno, positionNode.colno, positionNode);
    }
  }
}

/**
 * Validate compiler-runtime metadata mismatch for resolveUp operations.
 * @param {Frame} frame - The current frame
 * @param {string} name - Variable name
 * @param {boolean} hasResolveUpMetadata - Whether compiler metadata says variable needs resolveUp
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - The AST node for error reporting
 */
function validateResolveUp(frame, name, hasResolveUpMetadata, compiler, node) {
  if (ENABLE_RESOLVEUP_VALIDATION) {
    const hasWriteCounter = !!(frame.writeCounts && (name in frame.writeCounts));
    if (hasResolveUpMetadata !== hasWriteCounter) {
      compiler.fail(
        `Compiler-runtime mismatch for variable '${name}': metadata says resolveUp=${hasResolveUpMetadata} but writeCounts exists=${hasWriteCounter}`,
        node.lineno, node.colno, node
      );
    }
  }
}

/**
 * Validate that guard variables are declared in the scope.
 * @param {Array<string>} variableTargets - List of variable names to check
 * @param {Frame} frame - The current frame
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - The AST node for error reporting
 */
function validateGuardVariablesDeclared(variableTargets, frame, compiler, node) {
  if (variableTargets && variableTargets !== '*') {
    for (const varName of variableTargets) {
      // Assuming _isDeclared is available on compiler instance
      if (!compiler._isDeclared(frame, varName)) {
        compiler.fail(`guard variable "${varName}" is not declared`, node.lineno, node.colno, node);
      }
    }
  }
}

/**
 * Validate that guard variables are modified inside the guard block.
 * @param {Array<string>} variableTargets - List of variable names to check
 * @param {Frame} frame - The current frame (after body compilation)
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - The AST node for error reporting
 */
function validateGuardVariablesModified(variableTargets, frame, compiler, node) {
  if (variableTargets && variableTargets.length > 0) {
    for (const varName of variableTargets) {
      if (!frame.writeCounts || !frame.writeCounts[varName]) {
        compiler.fail(`guard variable "${varName}" must be modified inside guard`, node.lineno, node.colno, node);
      }
    }
  }
}

/**
 * Validate variable declaration/assignment rules for 'set', 'var', and 'extern' statements.
 * @param {Compiler} compiler - The compiler instance
 * @param {Node} node - The Set node
 * @param {Node} target - The specific target node being processed
 * @param {string} name - The variable name
 * @param {boolean} isDeclared - Whether the variable is already declared in the frame
 */
function validateSetTarget(compiler, node, target, name, isDeclared) {
  if (compiler.scriptMode) {
    // Script mode: Enforce strict var/set/extern rules.
    switch (node.varType) {
      case 'declaration': // from 'var'
        if (isDeclared) {
          compiler.fail(`Identifier '${name}' has already been declared.`, target.lineno, target.colno, node, target);
        }
        break;
      case 'assignment': // from '='
        if (!isDeclared) {
          compiler.fail(`Cannot assign to undeclared variable '${name}'. Use 'var' to declare a new variable.`, target.lineno, target.colno, node, target);
        }
        break;
      case 'extern': // from 'extern'
        if (isDeclared) {
          compiler.fail(`Identifier '${name}' has already been declared.`, target.lineno, target.colno, node, target);
        }
        if (node.value) {
          compiler.fail('extern variables cannot be initialized at declaration.', node.lineno, node.colno, node);
        }
        break;
      default:
        compiler.fail(`Unknown varType '${node.varType}' for set/var statement.`, node.lineno, node.colno, node);
    }
  } else {
    // TEMPLATE MODE: Replicates the original behavior.
    if (node.varType !== 'assignment') { // 'set' is the only valid type
      compiler.fail(`'${node.varType}' is not allowed in template mode. Use 'set'.`, node.lineno, node.colno, node);
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
  if (!ENABLE_SCOPE_VALIDATION) {
    return;
  }

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



module.exports = {
  ENABLE_RESOLVEUP_VALIDATION,
  ENABLE_FRAME_BALANCE_VALIDATION,
  ENABLE_SCOPE_VALIDATION,
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance,
  validateResolveUp,
  validateGuardVariablesDeclared,
  validateGuardVariablesModified,
  validateSetTarget,
  validateDeclarationScope
};
