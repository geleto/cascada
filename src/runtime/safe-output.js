'use strict';

var lib = require('../lib');
const errors = require('./errors');
const resolve = require('./resolve');

// A SafeString object indicates that the string should not be
// autoescaped. This happens magically because autoescaping only
// occurs on primitive string objects.
function SafeString(val) {
  if (typeof val !== 'string') {
    return val;
  }

  this.val = val;
  this.length = val.length;
}

function newSafeStringAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return new SafeString(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return new SafeString(await v, lineno, colno);
    })(val);
  }
  return new SafeString(val, lineno, colno);
}

SafeString.prototype = Object.create(String.prototype, {
  length: {
    writable: true,
    configurable: true,
    value: 0
  }
});
SafeString.prototype.valueOf = function valueOf() {
  return this.val;
};
SafeString.prototype.toString = function toString() {
  return this.val;
};

function copySafeness(dest, target) {
  if (dest instanceof SafeString) {
    return new SafeString(target);
  }
  return target.toString();
}

function markSafe(val) {
  var type = typeof val;

  if (type === 'string') {
    return new SafeString(val);
  } else if (type !== 'function') {
    return val;
  } else if (type === 'object' && val.then && typeof val.then === 'function') {
    return (async (v) => {
      return markSafe(await v);
    })(val);
  }
  else {
    return function wrapSafe(args) {
      var ret = val.apply(this, arguments);

      if (typeof ret === 'string') {
        return new SafeString(ret);
      }

      return ret;
    };
  }
}

function suppressValue(val, autoescape) {
  val = (val !== undefined && val !== null) ? val : '';

  if (autoescape && !(val instanceof SafeString)) {
    val = lib.escape(val.toString());
  }

  return val;
}

function suppressValueAsync(val, autoescape, errorContext) {
  // Poison check - return rejected promise synchronously
  if (errors.isPoison(val)) {
    return val;
  }

  // Simple literal value (not array, not promise) - return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Arrays without promises - handle synchronously
  if (Array.isArray(val)) {
    const hasPoison = val.some(errors.isPoison);
    const hasPromises = val.some(item => item && typeof item.then === 'function');

    // If array has no promises and no poison, handle synchronously
    if (!hasPromises && !hasPoison) {
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }

    // Has promises or poison - delegate to async helper
    return _suppressValueAsyncComplex(val, autoescape, errorContext);
  }

  // Promise - delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape, errorContext);
}

async function _suppressValueAsyncComplex(val, autoescape, errorContext) {
  // Handle promise values
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      if (errors.isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new errors.PoisonError([contextualError]);
      }
    }

    // Check if resolved to poison
    if (errors.isPoison(val)) {
      throw new errors.PoisonError(val.errors);
    }
  }

  // Handle arrays
  if (Array.isArray(val)) {
    // Collect errors from all items (deterministic)
    const collectedErrors = await errors.collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new errors.PoisonError(collectedErrors);
    }

    const hasPromises = val.some(item => item && typeof item.then === 'function');

    if (hasPromises) {
      try {
        let resolvedArray = await resolve.deepResolveArray(val);

        if (resolvedArray.length > 0) {
          resolvedArray = [resolvedArray.join(',')];
        }
        if (autoescape) {
          resolvedArray.push((value) => suppressValue(value, true));
        }
        return resolvedArray;
      } catch (err) {
        if (errors.isPoisonError(err)) {
          throw err;
        } else {
          const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
          throw new errors.PoisonError([contextualError]);
        }
      }
    } else {
      // No promises in array
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }
  }

  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno, context) {
  if (val === null || val === undefined) {
    const err = errors.handleError(
      new Error('attempted to output null or undefined value'),
      lineno + 1,
      colno + 1,
      null,
      context ? context.path : null
    );
    throw err;
  }
  return val;
}

//@todo - remove lineno, colno
function ensureDefinedAsync(val, lineno, colno, context, errorContext) {
  // Poison check - return rejected promise synchronously
  if (errors.isPoison(val)) {
    return val;
  }

  // Simple literal value - validate and return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return ensureDefined(val, lineno, colno, context);
  }

  // Complex cases - delegate to async helper
  return _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext);
}

//@todo - remove lineno, colno
async function _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext) {
  // Handle arrays with possible poison values
  if (Array.isArray(val)) {
    const collectedErrors = await errors.collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new errors.PoisonError(collectedErrors);
    }

    // Append validation function
    val.push((v) => ensureDefined(v, lineno, colno, context));
    return val;
  }

  // Handle promises
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      if (errors.isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new errors.PoisonError([contextualError]);
      }
    }

    if (errors.isPoison(val)) {
      throw new errors.PoisonError(val.errors);
    }
  }

  return ensureDefined(val, lineno, colno, context);
}

function suppressValueScript(val, autoescape) {
  // Pass through any objects in script mode so they can be handled by the buffer processor
  // (flattenBuffer -> processItem). This avoids stringifying objects like { value: ... }
  // to "[object Object]".
  if (val && typeof val === 'object' && !val.handler && !val.method && !Array.isArray(val)) {
    const hasCustomToString = val.toString && val.toString !== Object.prototype.toString;
    const isPromise = typeof val.then === 'function';
    // If it's a plain object (no custom toString, not specific class), pass it through.
    // SafeString has custom toString, so it falls through to suppressValue.
    if (!hasCustomToString && !isPromise) {
      return val;
    }
  }
  return suppressValue(val, autoescape);
}





function suppressValueScriptAsync(val, autoescape, errorContext) {
  // Handle Promises
  if (val && typeof val.then === 'function') {
    return _suppressValueScriptAsyncComplex(val, autoescape, errorContext);
  }
  return suppressValueScript(val, autoescape);
}

async function _suppressValueScriptAsyncComplex(val, autoescape, errorContext) {
  try {
    val = await val;
  } catch (err) {
    if (errors.isPoisonError(err)) {
      throw err;
    } else {
      const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      throw new errors.PoisonError([contextualError]);
    }
  }

  if (errors.isPoison(val)) {
    throw new errors.PoisonError(val.errors);
  }

  return suppressValueScript(val, autoescape);
}

module.exports = {
  suppressValue,
  suppressValueAsync,
  _suppressValueAsyncComplex,
  suppressValueScript,
  suppressValueScriptAsync,
  SafeString,
  newSafeStringAsync,
  copySafeness,
  markSafe,
  ensureDefined,
  ensureDefinedAsync,
  _ensureDefinedAsyncComplex
};
