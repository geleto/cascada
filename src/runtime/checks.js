
import {RuntimeFatalError} from './errors.js';

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
function checkFinishedBuffer(buffer, channelName = null) {
  const isFinished = (channelName !== null && channelName !== undefined)
    ? buffer.isFinished(channelName)
    : buffer.finished;
  if (isFinished) {
    throw new Error(
      'Cannot add command to finished CommandBuffer. ' +
      'This indicates a timing issue where commands are being added after ' +
      'the async block has completed.'
    );
  }
}

function ensureSequentialPathChannel(currentBuffer, pathKey) {
  const channel = currentBuffer.getChannel(pathKey);

  if (!channel) {
    throw new Error(`Sequential path '${pathKey}' was not predeclared as a channel (expected compile-time declaration)`);
  }

  const channelType = channel._channelType;
  if (channelType !== 'sequential_path') {
    throw new Error(`Sequential path '${pathKey}' is declared with incompatible channel type '${channelType || 'unknown'}'`);
  }
}

function assertChannelLaneAvailable(buffer, channelName) {
  if (buffer.hasChannel && buffer.hasChannel(channelName)) {
    return;
  }
  if (buffer.arrays && channelName in buffer.arrays) {
    return;
  }

  throw new RuntimeFatalError(
    `Channel '${channelName}' is visible but this buffer has no linked lane for it`,
    0,
    0,
    null,
    buffer._context ? buffer._context.path : null
  );
}

export { assertChannelLaneAvailable, checkFrameBalance, checkFinishedBuffer, ensureSequentialPathChannel };
