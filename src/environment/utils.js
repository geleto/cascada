'use strict';

import asap from 'asap';

// If the user is using the async API, *always* call it
// asynchronously even if the template was synchronous.
function callbackAsap(cb, err, res) {
  asap(() => {
    cb(err, res);
  });
}

const __defaultExport = {
  callbackAsap
};
export { callbackAsap };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
