
import {escape} from '../lib.js';
import {
  isPoison,
  isPoisonError,
  handleError,
  collectErrors,
  PoisonError
} from './errors.js';
import {RESOLVE_MARKER, resolveAll, resolveSingle} from './resolve.js';
import {CommandBuffer} from './command-buffer.js';

function normalizeBufferValue(val) {
  if (val && typeof val === 'object') {
    if (val instanceof CommandBuffer) {
      return val;
    }
    if (Array.isArray(val.text)) {
      return val.text;
    }
    if (Array.isArray(val.output)) {
      return val.output;
    }
  }
  return val;
}

// Snapshot-first materialization for template text values.
function materializeTemplateTextValue(val, context) {
  val = normalizeBufferValue(val);
  if (val && typeof val.finalSnapshot === 'function') {
    return val.finalSnapshot();
  }
  if (val && typeof val.snapshot === 'function') {
    return val.snapshot();
  }
  return val;
}

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
  if (val && typeof val === 'object' && val.then && typeof val.then === 'function') {
    return (async (v) => {
      return markSafe(await v);
    })(val);
  }

  let type = typeof val;

  if (type === 'string') {
    return new SafeString(val);
  } else if (type !== 'function') {
    return val;
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
    val = escape(val.toString());
  }

  return val;
}

function suppressValueAsync(val, autoescape, errorContext) {
  val = normalizeBufferValue(val);
  // Poison check - return rejected promise synchronously
  if (isPoison(val)) {
    return val;
  }

  if (val && typeof val.finalSnapshot === 'function') {
    return val.finalSnapshot();
  }

  if (val && typeof val.snapshot === 'function') {
    return val.snapshot();
  }

  // Simple literal value (not array, not promise) - return synchronously
  if (!val || (typeof val.then !== 'function' && !val[RESOLVE_MARKER] && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Arrays without promises - handle synchronously
  if (Array.isArray(val)) {
    const hasPoison = val.some(isPoison);
    const hasPromises = val.some(item => item && typeof item.then === 'function');
    const hasMarkers = val.some(item => item && item[RESOLVE_MARKER]);

    // If array has no promises and no poison, handle synchronously
    if (!hasPromises && !hasMarkers && !hasPoison) {
      return suppressValue(val.join(','), autoescape);
    }

    // Has promises or poison - delegate to async helper
    return _suppressValueAsyncComplex(val, autoescape, errorContext);
  }

  // Promise - delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape, errorContext);
}

async function _suppressValueAsyncComplex(val, autoescape, errorContext) {
  val = normalizeBufferValue(val);
  // Consume a single top-level Cascada value before text materialization.
  if (!Array.isArray(val)) {
    try {
      if (val && val[RESOLVE_MARKER]) {
        val = await resolveSingle(val);
      } else if (val && typeof val.then === 'function') {
        val = await val;
      }
    } catch (err) {
      if (isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new PoisonError([contextualError]);
      }
    }

  }

  // Handle arrays
  if (Array.isArray(val)) {
    try {
      const resolvedArray = await resolveAll(val);
      val = resolvedArray;
    } catch (err) {
      if (isPoisonError(err)) {
        throw err;
      }
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      throw new PoisonError([contextualError]);
    }

    return suppressValue(val.join(','), autoescape);
  }

  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno, context) {
  if (val === null || val === undefined) {
    const err = handleError(
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
  val = normalizeBufferValue(val);
  // Poison check - return rejected promise synchronously
  if (isPoison(val)) {
    return val;
  }

  // Simple literal value - validate and return synchronously
  if (!val || (typeof val.then !== 'function' && !val[RESOLVE_MARKER] && !Array.isArray(val))) {
    return ensureDefined(val, lineno, colno, context);
  }

  // Complex cases - delegate to async helper
  return _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext);
}

//@todo - remove lineno, colno
async function _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext) {
  val = normalizeBufferValue(val);
  // Handle arrays with possible poison values
  if (Array.isArray(val)) {
    const collectedErrors = await collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new PoisonError(collectedErrors);
    }

    return val;
  }

  // Handle promises and marker-backed values
  if (val && (typeof val.then === 'function' || val[RESOLVE_MARKER])) {
    try {
      if (val[RESOLVE_MARKER]) {
        val = await resolveSingle(val);
      } else {
        val = await val;
      }
    } catch (err) {
      if (isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new PoisonError([contextualError]);
      }
    }

  }

  return ensureDefined(val, lineno, colno, context);
}

function suppressValueScriptRaw(val, autoescape) {
  if (val && typeof val === 'object' && !Array.isArray(val) && !val instanceof CommandBuffer) {
    const hasCustomToString = val.toString && val.toString !== Object.prototype.toString;
    const isPromise = typeof val.then === 'function';
    if (!hasCustomToString && !isPromise) {
      // Call-block/filter envelopes can expose a text field.
      if (Object.prototype.hasOwnProperty.call(val, 'text')) {
        const textVal = val.text;
        if (textVal === null || textVal === undefined) {
          return '';
        }
        if (Array.isArray(textVal)) {
          return suppressValue(textVal.join(''), autoescape);
        }
        return suppressValue(textVal, autoescape);
      }
      if (Object.prototype.hasOwnProperty.call(val, 'output') && Array.isArray(val.output)) {
        return suppressValue(val.output.join(''), autoescape);
      }
      // Plain objects are ignored in script text output by design.
      return '';
    }
  }
  return suppressValue(val, autoescape);
}

function suppressValueScript(val, autoescape, errorContext) {
  if (val && (typeof val.then === 'function' || val[RESOLVE_MARKER] || Array.isArray(val))) {
    return _suppressValueScriptComplex(val, autoescape, errorContext);
  }
  return suppressValueScriptRaw(val, autoescape);
}

async function _suppressValueScriptComplex(val, autoescape, errorContext) {
  try {
    if (!Array.isArray(val)) {
      if (val && val[RESOLVE_MARKER]) {
        val = await resolveSingle(val);
      } else if (val && typeof val.then === 'function') {
        val = await val;
      }
    }
  } catch (err) {
    if (isPoisonError(err)) {
      throw err;
    } else {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      throw new PoisonError([contextualError]);
    }
  }

  if (Array.isArray(val)) {
    const resolvedArray = await resolveAll(val);
    val = resolvedArray;
  }

  return suppressValueScriptRaw(val, autoescape);
}

export { suppressValue, suppressValueAsync, _suppressValueAsyncComplex, suppressValueScriptRaw, suppressValueScript, SafeString, copySafeness, markSafe, materializeTemplateTextValue, ensureDefined, ensureDefinedAsync, _ensureDefinedAsyncComplex };
