'use strict';

import asap from 'asap';

// If the user is using the async API, *always* call it
// asynchronously even if the template was synchronous.
function callbackAsap(cb, err, res) {
  asap(() => {
    cb(err, res);
  });
}

export { callbackAsap };
