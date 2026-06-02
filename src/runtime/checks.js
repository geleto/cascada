
import {RuntimeError} from './errors.js';

/**
 * Check frame balance when popping.
 * Called when returning to parent frame to validate push/pop balance.
 *
 * @param {Frame} frame - Current frame being popped
 * @param {Frame} parent - Parent frame after pop
 * @throws {RuntimeError} If frame balance is violated
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
function checkFinishedBuffer(buffer, chainName = null) {
  const isFinished = chainName != null
    ? buffer.isChainFinished(chainName)
    : buffer.isFinished();
  if (isFinished) {
    throw new Error(
      'Cannot add command to finished CommandBuffer. ' +
      'This indicates a timing issue where commands are being added after ' +
      'the async block has completed.'
    );
  }
}

function ensureSequentialPathChain(currentBuffer, pathKey) {
  const chain = currentBuffer.getChainIfExists(pathKey);

  if (!chain) {
    throw new Error(`Sequential path '${pathKey}' was not predeclared as a chain (expected compile-time declaration)`);
  }

  const chainType = chain._chainType;
  if (chainType !== 'sequential_path') {
    throw new Error(`Sequential path '${pathKey}' is declared with incompatible chain type '${chainType || 'unknown'}'`);
  }
}

function assertChainLaneAvailable(buffer, chainName) {
  if (buffer.arrays && chainName in buffer.arrays) {
    return;
  }

  RuntimeError.reportAndThrow(
    `Chain '${chainName}' is visible but this buffer has no linked lane for it`,
    buffer.bufferStackErrorContext
  );
}

export {
  assertChainLaneAvailable,
  checkFrameBalance,
  checkFinishedBuffer,
  ensureSequentialPathChain
};
