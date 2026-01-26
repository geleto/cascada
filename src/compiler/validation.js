'use strict';

// Enable bidirectional validation to ensure write counter registration and decrementing are mutual.
// Set to true during development to catch compiler bugs early at compile-time.
// Can be set to false in production if needed for performance (runtime checks still active).
const ENABLE_RESOLVEUP_VALIDATION = true;

// Enable frame balance validation at compile-time.
// Set to true during development to catch frame push/pop bugs early.
// Can be set to false in production if needed for performance.
const ENABLE_FRAME_BALANCE_VALIDATION = true;

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

module.exports = {
  ENABLE_RESOLVEUP_VALIDATION,
  ENABLE_FRAME_BALANCE_VALIDATION,
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
};
