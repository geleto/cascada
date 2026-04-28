// If the user is using the async API, *always* call it
// asynchronously even if the template was synchronous.
function callbackAsap(cb, err, res) {
  const schedule = typeof process !== 'undefined' && typeof process.nextTick === 'function'
    ? process.nextTick
    : queueMicrotask;
  schedule(() => {
    cb(err, res);
  });
}

export { callbackAsap };
