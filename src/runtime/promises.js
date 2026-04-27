'use strict';

// Internal promises are sometimes observed through an owning command/channel
// instead of by the promise object itself. Mark those promises handled so delayed
// Cascada-owned consumption does not create process-level rejection warnings.
function markPromiseHandled(promise) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  return promise;
}

module.exports = {
  markPromiseHandled
};
