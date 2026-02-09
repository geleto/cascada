'use strict';

const { CommandBuffer } = require('./buffer');
const { RuntimeFatalError, PoisonError, isPoisonError } = require('./errors');

function flattenBuffer(output, errorContext = null) {
  if (!output || (typeof output !== 'object' && typeof output !== 'function')) {
    const context = errorContext || null;
    throw new RuntimeFatalError(
      `Invalid output object for flattening: ${output}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  let context = errorContext || output._context || null;
  const buffer = output._buffer;
  if (!buffer) {
    throw new RuntimeFatalError(
      `Output object is missing _buffer property for flattening: ${output}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  if (!(buffer instanceof CommandBuffer)) {
    throw new RuntimeFatalError(
      `Output _buffer must be a CommandBuffer, got: ${typeof buffer}`,
      context ? context.lineno : null,
      context ? context.colno : null,
      context ? context.errorContextString : null,
      context ? context.path : null
    );
  }

  // Phase 1: Chain-walk flatten using incrementally constructed chains
  // The chain has been built incrementally as commands were added via add()/fillSlot()
  // and child buffers notified parents via _childBufferChained()
  // If the chain wasn't built (e.g., in tests that bypass declareOutput), build it now
  if (!output._firstChainedCommand && buffer.arrays[output._outputName]?.length > 0) {
    buildChainOnDemand(buffer, output);
  }

  const errors = [];
  flattenChain(output, errors);

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return output.getCurrentResult();
}

function buildChainOnDemand(buffer, output) {
  // Register output in buffer's _outputs Map if not already there
  if (buffer._outputs instanceof Map && !buffer._outputs.has(output._outputName)) {
    buffer._outputs.set(output._outputName, output);
  }

  // Reset chain endpoints before building
  output._firstChainedCommand = null;
  output._lastChainedCommand = null;

  // Build the chain from the root, letting _advanceChainFrom handle child buffers recursively
  buffer._advanceChainFromWithDemandBuild(output._outputName, 0);
}

function flattenChain(output, errors) {
  let cmd = output._firstChainedCommand;

  while (cmd) {
    try {
      cmd.apply(output);
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
    cmd = cmd.next;
  }
}

module.exports = {
  flattenBuffer
};
