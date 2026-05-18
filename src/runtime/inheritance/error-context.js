
// TODO(error-context-cleanup): remove this Phase 2 bridge once inheritance
// buffers receive final { ec: __ec[index], ...fields } objects directly.
// This helper is only packaging buffer diagnostic metadata during migration.
function createBufferErrorContext(ec, boundaryName) {
  if (!ec && !boundaryName) {
    return null;
  }
  return { ec, boundaryName };
}

export {createBufferErrorContext};
