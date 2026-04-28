'use strict';

function createCompositionPayload(rootContext, payloadContext = rootContext) {
  return {
    rootContext: rootContext || {},
    payloadContext: payloadContext || {}
  };
}

export default {
  createCompositionPayload
};
export { createCompositionPayload };
