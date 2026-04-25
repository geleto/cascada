'use strict';

const COMMAND_BUFFER_MARKER = Symbol.for('cascada.runtime.CommandBuffer');

function markCommandBuffer(buffer) {
  Object.defineProperty(buffer, COMMAND_BUFFER_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true
  });
  return buffer;
}

function isCommandBuffer(value) {
  return !!(value && typeof value === 'object' && value[COMMAND_BUFFER_MARKER] === true);
}

module.exports = {
  COMMAND_BUFFER_MARKER,
  markCommandBuffer,
  isCommandBuffer
};
