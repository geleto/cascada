'use strict';

function createCompositionPayload(rootContext, payloadContext = rootContext) {
  return {
    rootContext: rootContext || {},
    payloadContext: payloadContext || {}
  };
}

module.exports = {
  createCompositionPayload
};
