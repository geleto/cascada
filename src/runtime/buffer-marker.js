
const COMMAND_BUFFER_MARKER = Symbol.for('cascada.runtime.CommandBuffer');

function markCommandBuffer(buffer) {
  Object.defineProperty(buffer, COMMAND_BUFFER_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });
}

function isCommandBuffer(value) {
  return !!(value && value[COMMAND_BUFFER_MARKER]);
}

export {COMMAND_BUFFER_MARKER, markCommandBuffer, isCommandBuffer};
