function executeSync(fn, ...args) {
  if (typeof fn === 'function') {
    fn(...args);
  }
}

function executeAsync(fn) {
  setTimeout(fn, 0);
}

function makeIterator(tasks) {
  function makeCallback(index) {
    const fn = function(...args) {
      if (tasks.length) {
        tasks[index](...args);
      }
      return fn.next();
    };
    fn.next = function() {
      return index < tasks.length - 1 ? makeCallback(index + 1) : null;
    };
    return fn;
  }
  return makeCallback(0);
}

export default function waterfall(tasks, callback = function() {}, forceAsync = false) {
  const nextTick = forceAsync ? executeAsync : executeSync;
  if (!Array.isArray(tasks)) {
    callback(new Error('First argument to waterfall must be an array of functions'));
    return;
  }
  if (!tasks.length) {
    callback();
    return;
  }

  function wrapIterator(iterator) {
    return function(err, ...values) {
      if (err) {
        callback(err, ...values);
        callback = function() {};
        return;
      }

      const next = iterator.next();
      values.push(next ? wrapIterator(next) : callback);
      nextTick(() => iterator(...values));
    };
  }

  wrapIterator(makeIterator(tasks))();
}
