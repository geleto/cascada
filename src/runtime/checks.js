'use strict';

/**
 * Check if a write counter exists for a variable.
 * Called when attempting to decrement a write counter.
 *
 * @param {string} varName - Variable name
 * @throws {RuntimeFatalError} If no write counter found
 */
function checkWriteCounterExists(varName) {
  const { RuntimeFatalError } = require('./errors');
  throw new RuntimeFatalError(`No write counter found for variable ${varName}`);
}

/**
 * Check if write counter went negative.
 * Called when decrementing a write counter results in a negative value.
 *
 * @param {string} varName - Variable name
 * @param {number} count - Current counter value
 * @throws {RuntimeFatalError} Always throws
 */
function checkWriteCounterNegative(varName, count) {
  const { RuntimeFatalError } = require('./errors');
  const message = `Variable ${varName} write counter ${count === undefined ? 'is undefined' : 'turned negative'} in _trackAsyncWrites`;
  throw new RuntimeFatalError(message);
}

/**
 * Check frame balance when popping.
 * Called when returning to parent frame to validate push/pop balance.
 *
 * @param {Frame} frame - Current frame being popped
 * @param {Frame} parent - Parent frame after pop
 * @throws {RuntimeFatalError} If frame balance is violated
 */
function checkFrameBalance(frame, parent) {
  if (!parent) {
    throw new Error('Frame pop without parent - unbalanced push/pop detected');
  }

  // Check depth consistency if depths are tracked
  if (frame._runtimeDepth !== undefined && parent._runtimeDepth !== undefined) {
    const expectedDepth = frame._runtimeDepth - 1;
    if (parent._runtimeDepth !== expectedDepth) {
      const message = `Frame depth mismatch: expected ${expectedDepth}, got ${parent._runtimeDepth}`;
      throw new Error(message);
    }
  }
}

/**
 * Check if trying to add command to finished CommandBuffer
 * This prevents race conditions where commands are added after the buffer
 * has completed its async block and patched its links.
 *
 * @param {Object} buffer - The CommandBuffer to check
 * @throws {Error} If buffer is finished
 */
function checkFinishedBuffer(buffer) {
  if (buffer && buffer.finished) {
    throw new Error(
      'Cannot add command to finished CommandBuffer. ' +
      'This indicates a timing issue where commands are being added after ' +
      'the async block has completed.'
    );
  }
}

function ensureSequentialPathOutput(frame, pathKey) {
  const { getOutput } = require('./output');
  const output = getOutput(frame, pathKey);

  if (!output) {
    throw new Error(`Sequential path '${pathKey}' was not predeclared as output (expected compile-time declaration)`);
  }

  if (output._outputType !== 'sequential_path') {
    throw new Error(`Sequential path '${pathKey}' is declared with incompatible output type '${output._outputType || 'unknown'}'`);
  }
}

module.exports = {
  checkWriteCounterExists,
  checkWriteCounterNegative,
  checkFrameBalance,
  checkFinishedBuffer,
  ensureSequentialPathOutput
};
