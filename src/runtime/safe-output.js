'use strict';

var lib = require('../lib');
const errors = require('./errors');
const { CommandBuffer } = require('./command-buffer');
const { flattenBuffer } = require('./flatten-buffer');

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

function flattenTextCommandBuffer(buffer, errorContext) {
  let output = null;
  if (buffer && buffer._outputs instanceof Map) {
    output = buffer._outputs.get('text') || null;
  }

  if (!output) {
    output = {
      _frame: { _outputBuffer: buffer, parent: null },
      _buffer: buffer,
      _outputName: 'text',
      _target: [],
      _firstChainedCommand: null,
      _lastChainedCommand: null,
      getCurrentResult() {
        if (!Array.isArray(this._target) || this._target.length === 0) {
          this._target = [''];
          return '';
        }
        const result = this._target.join('');
        this._target = [result];
        return result;
      }
    };

    if (buffer && typeof buffer._registerOutput === 'function') {
      buffer._registerOutput('text', output);
    } else if (buffer && buffer._outputs instanceof Map) {
      buffer._outputs.set('text', output);
    }
  }

  return flattenBuffer(output, errorContext || null);
}

// @todo - rewrite when command chain is implemented
async function materializeTemplateTextValue(val, context, astate, waitCount = 1) {
  val = normalizeBufferValue(val);
  if (!(val instanceof CommandBuffer)) {
    return val;
  }
  if (astate && typeof astate.waitAllClosures === 'function') {
    await astate.waitAllClosures(waitCount);
  }
  return flattenTextCommandBuffer(val, context || null);
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
  val = normalizeBufferValue(val);
  // Poison check - return rejected promise synchronously
  if (errors.isPoison(val)) {
    return val;
  }

  // CommandBuffer should normally be materialized at async boundaries.
  // Keep this as a compatibility fallback.
  if (val instanceof CommandBuffer) {
    return flattenTextCommandBuffer(val, errorContext);
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
        val = await Promise.all(val);
      } catch (err) {
        if (errors.isPoisonError(err)) {
          throw err;
        } else {
          const contextualError = errors.handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
          throw new errors.PoisonError([contextualError]);
        }
      }
    }

    return suppressValue(val.join(','), autoescape);
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
  val = normalizeBufferValue(val);
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
  val = normalizeBufferValue(val);
  // Handle arrays with possible poison values
  if (Array.isArray(val)) {
    const collectedErrors = await errors.collectErrors(val);
    if (collectedErrors.length > 0) {
      throw new errors.PoisonError(collectedErrors);
    }

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
  if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof CommandBuffer)) {
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

function normalizeScriptTextArgs(args, autoescape) {
  if (!Array.isArray(args)) {
    return [suppressValueScript(args, autoescape)];
  }
  return args.map((arg) => suppressValueScript(arg, autoescape));
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
  normalizeScriptTextArgs,
  suppressValueScriptAsync,
  SafeString,
  copySafeness,
  markSafe,
  materializeTemplateTextValue,
  ensureDefined,
  ensureDefinedAsync,
  _ensureDefinedAsyncComplex
};
