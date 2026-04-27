'use strict';

function createCompositionPayload(rootContext, payloadContext = rootContext) {
  return {
    rootContext: rootContext || {},
    payloadContext: payloadContext || {}
  };
}

const __defaultExport = {
  createCompositionPayload
};
export { createCompositionPayload };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
