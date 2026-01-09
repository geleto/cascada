'use strict';

// Symbol for poison detection
const POISON_KEY = typeof Symbol !== 'undefined'
  ? Symbol.for('cascada.poison')
  : '__cascadaPoisonError';

// Symbol for PoisonError detection (more reliable than instanceof after transpilation)
const POISON_ERROR_KEY = typeof Symbol !== 'undefined'
  ? Symbol.for('cascada.poisonError')
  : '__cascadaPoisonErrorMarker';

/**
 * PoisonedValue: An inspectable error container that can be detected synchronously
 * and automatically rejects when awaited.
 *
 * Purpose: Enables sync-first error detection (isPoison()) while maintaining
 * compatibility with await/promises. Avoids async overhead for error propagation
 *
 * NOT FULLY PROMISE A+ COMPLIANT
 * - Rejection handlers execute synchronously (not on microtask queue)
 * - Returns `this` when no handler provided (doesn't create new promise)
 *
 * Trade-off: faster for sync-first patterns, but may break code expecting strict async behavior.
 */
class PoisonedValue {
  constructor(errors) {
    this.errors = Array.isArray(errors) ? errors : [errors];
    this[POISON_KEY] = true;
  }

  then(onFulfilled, onRejected) {
    // Optimization: if no rejection handler, propagate poison directly
    if (!onRejected) {
      return this;
    }

    const error = new PoisonError(this.errors);

    // Call the rejection handler
    try {
      const result = onRejected(error);
      // Handler succeeded - need Promise for fulfillment
      // Use Promise.resolve to handle case where result is itself a thenable
      return Promise.resolve(result);
    } catch (err) {
      // Handler threw - return new PoisonedValue (no Promise needed!)
      return createPoison(isPoisonError(err) ? err.errors : [err]);
    }
  }

  catch(onRejected) {
    return this.then(null, onRejected);
  }

  finally(onFinally) {
    if (onFinally) {
      try {
        onFinally();
      } catch (e) {
        // Ignore errors in finally, return original poison
      }
    }
    return this;
  }
}

/**
 * Error thrown when one or more operations are poisoned.
 * Contains deduplicated array of original errors.
 */
class PoisonError extends Error {
  constructor(errors, errorContext = null) {
    const normalizedErrors = normalizeErrorsWithContext(errors, errorContext);
    const deduped = deduplicateAndFlattenErrors(normalizedErrors);
    const messageSource = deduped.length > 0 ? deduped : normalizedErrors;

    const message = messageSource.length === 1
      ? messageSource[0].message
      : `Multiple errors occurred (${messageSource.length}):\n` +
      messageSource.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
    super(message);

    this.name = 'PoisonError';
    this.errors = deduped;
    this[POISON_ERROR_KEY] = true;

    // Determine the appropriate stack trace
    const stacks = deduped.map(e => e.stack).filter(Boolean);
    const allSame = stacks.length > 0 && stacks.every(s => s === stacks[0]);

    if (allSame) {
      // Use the shared stack if all are identical
      this.stack = stacks[0];
    }

    // Ensure correct prototype chain (for Babel/older environments)
    Object.setPrototypeOf?.(this, new.target.prototype);
  }

  constructMessage(errors) {

  }
}

/**
 * Runtime error with position and context information.
 */
class RuntimeError extends Error {
  constructor(message, lineno, colno, errorContextString = null, path = null) {
    let err;
    let cause;
    if (message instanceof Error) {
      err = message;
      message = err.message;
      cause = err;
    } else {
      err = new Error(message);
      cause = null;
    }

    // Build formatted message with path and position info
    let messageMetadata = '';
    if (lineno !== undefined || colno !== undefined || errorContextString !== null || path !== null) {
      messageMetadata = '(' + (path || 'unknown path') + ')';

      if (lineno && colno) {
        messageMetadata += ` [Line ${lineno}, Column ${colno}]`;
      } else if (lineno) {
        messageMetadata += ` [Line ${lineno}]`;
      }

      if (errorContextString) {
        messageMetadata += ` doing '${errorContextString}'`;
      }

      messageMetadata += ' : ';
    }

    super(messageMetadata + message);
    if (cause && cause.name) {
      this.name = `RuntimeError: ${cause.name}`;
    } else {
      this.name = 'RuntimeError';
    }
    this.lineno = lineno;
    this.colno = colno;
    this.errorContextString = errorContextString;
    this.path = path;
    this.cause = cause;

    // Capture stack trace for contextual portion
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    if (cause && cause.stack) {
      this.stack = cause.stack;
    }

    // Copy all other properties from the cause
    if (cause && typeof cause === 'object') {
      const reserved = new Set(['name', 'stack', 'message', 'cause']);
      for (const key of Object.keys(cause)) {
        if (reserved.has(key)) {
          continue;
        }
        if (this[key] === undefined) {
          this[key] = cause[key];
        }
      }
    }
  }
}

/**
 * Wraps a Promise to add contextual error information the *first time* it rejects.
 * - Does NOT attach a catch in the constructor, so global unhandled rejections still fire.
 * - Adds context only when a rejection handler is actually invoked (then/catch/await).
 * - Each chaining method returns a new RuntimePromise, preserving behavior through chains.
 * - Requires handleError() to be idempotent so context is added only once per error.
 */
class RuntimePromise {
  constructor(promise, errorContext) {
    this.promise = Promise.resolve(promise);
    this.errorContext = errorContext;
  }

  then(onFulfilled, onRejected) {
    const wrappedOnRejected = onRejected && (err =>
      onRejected(handleError(
        err,
        this.errorContext.lineno,
        this.errorContext.colno,
        this.errorContext.errorContextString,
        this.errorContext.path
      ))
    );

    const p = this.promise.then(onFulfilled, wrappedOnRejected);
    return new RuntimePromise(p, this.errorContext);
  }

  catch(onRejected) {
    const p = this.promise.catch(err =>
      onRejected(handleError(
        err,
        this.errorContext.lineno,
        this.errorContext.colno,
        this.errorContext.errorContextString,
        this.errorContext.path
      ))
    );
    return new RuntimePromise(p, this.errorContext);
  }

  finally(onFinally) {
    const p = this.promise.finally(onFinally);
    return new RuntimePromise(p, this.errorContext);
  }

  get [Symbol.toStringTag]() { return 'Promise'; }

  toPromise() { return this.promise; }

  static resolve(value, ctx) {
    return new RuntimePromise(Promise.resolve(value), ctx);
  }

  static reject(reason, ctx) {
    return new RuntimePromise(Promise.reject(reason), ctx);
  }
}

/**
 * Execution context for error reporting.
 */
class ErrorContext {
  constructor(lineno, colno, path, errorContextString) {
    this.lineno = lineno;
    this.colno = colno;
    this.path = path;
    this.errorContextString = errorContextString;
  }
}

/**
 * Deduplicate errors by message and flatten any PoisonError objects.
 */
function deduplicateAndFlattenErrors(errors) {
  const seen = new Map();
  const result = [];

  for (const err of errors) {
    // If it's a PoisonError, flatten its underlying errors
    if (isPoisonError(err)) {
      for (const flattenedErr of err.errors) {
        const key = flattenedErr;//(flattenedErr instanceof RuntimeError && flattenedErr.cause) ? flattenedErr.cause : flattenedErr;
        if (!seen.has(key)) {
          seen.set(key, true);
          result.push(flattenedErr);
        }
      }
    } else {
      const key = err;//(err instanceof RuntimeError && err.cause) ? err.cause : err;
      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(err);
      }
    }
  }

  return result;
}

/**
 * Create a poison value from one or more errors, optionally adding position and path info.
 * If any of the errors contain position info, it will be preserved.
 * Preserves existing position info in errors - never overwrites lineno, colno, or path.
 * Only adds position/path to errors that don't already have it.
 *
 * @param {Error|Error[]} errors - Single error or array of errors
 * @param {number|ErrorContext} lineno - Line number where error occurred (optional) or ErrorContext object
 * @param {number} colno - Column number where error occurred (optional)
 * @param {string} errorContextString - Context string for error message (optional)
 * @param {string} path - Template path (optional)
 * @returns {PoisonedValue} Poison value containing the error(s)
 */
function resolveErrorContextArgs(lineno = null, colno = null, errorContextString = null, path = null) {
  if (lineno && typeof lineno === 'object' && !Array.isArray(lineno)) {
    const ctx = lineno;
    return {
      lineno: ctx.lineno ?? null,
      colno: ctx.colno ?? null,
      errorContextString: ctx.errorContextString ?? null,
      path: (ctx.path ?? ctx.errorContextString) ?? null
    };
  }

  return { lineno, colno, errorContextString, path };
}

function normalizeErrorsWithContext(errors, lineno = null, colno = null, errorContextString = null, path = null) {
  const context = resolveErrorContextArgs(lineno, colno, errorContextString, path);
  let normalized = errors;

  if (!Array.isArray(normalized)) {
    normalized = isPoisonError(normalized) ? normalized.errors : [normalized];
  }

  const hasContext = context.lineno !== null ||
    context.colno !== null ||
    context.errorContextString !== null ||
    context.path !== null;

  if (!hasContext) {
    return normalized;
  }

  return normalized.map(err => {
    const didIterate = err && err.didIterate;

    if (isPoisonError(err)) {
      return err.errors.map(e => {
        if (!e.lineno) {
          e = handleError(e, context.lineno || 0, context.colno || 0, context.errorContextString, context.path);
        }
        if (didIterate) {
          e.didIterate = didIterate;
        }
        return e;
      });
    }

    if (!err.lineno) {
      err = handleError(err, context.lineno || 0, context.colno || 0, context.errorContextString, context.path);
    }

    if (didIterate) {
      err.didIterate = didIterate;
    }

    return err;
  }).flat();
}

function createPoison(errors/* or 1 error */, lineno = null, colno = null, errorContextString = null, path = null) {
  const normalizedErrors = normalizeErrorsWithContext(errors, lineno, colno, errorContextString, path);
  return new PoisonedValue(normalizedErrors);
}

/**
 * Check if a VALUE is a PoisonedValue (before await)
 * This does not handle regular rejected promises and is not
 * the same as `is error` which awaits any promises
 * thus it shall be used only as a shortcut for faster non-async processing
 */
function isPoison(value) {
  return value != null/*and undefined*/ && value[POISON_KEY] === true;
}

/**
 * Check if an error is a PoisonError.
 * More reliable than instanceof after transpilation.
 */
function isPoisonError(error) {
  return error != null/*and undefined*/ && error[POISON_ERROR_KEY] === true;
}

/**
 * Check if a value is an error or a promise that rejects with an error.
 * Awaits promises and checks if they resolve to poison or reject.
 */
async function isError(value) {
  if (isPoison(value)) {
    return true;
  }

  if (value && typeof value.then === 'function') {
    try {
      const result = await value;
      return isPoison(result);
    } catch (err) {
      return true;
    }
  }

  return false;
}

/**
 * Collect errors from an array of values.
 * Awaits all promises (even after finding errors), catches rejections,
 * extracts poison errors. Returns deduplicated error array.
 */
async function collectErrors(values) {
  const errors = [];

  for (const value of values) {
    if (isPoison(value)) {
      errors.push(...value.errors);
    } else if (value && typeof value.then === 'function') {
      try {
        const resolved = await value;
        // Check if resolved to a poison
        if (isPoison(resolved)) {
          errors.push(...resolved.errors);
        }
      } catch (err) {
        // If the error is a PoisonError (from unwrapping a poison),
        // extract its underlying errors
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
      }
    }
  }

  return deduplicateAndFlattenErrors(errors);
}

/**
 * Handle errors by adding template position information and path context.
 * Preserves PoisonError with multiple errors, adding path to each contained error.
 *
 * @param {Error} error - The error to handle
 * @param {number} lineno - Line number where error occurred
 * @param {number} colno - Column number where error occurred
 * @param {string} errorContextString - Context string for error message
 * @param {string} path - Template path (e.g., 'template.njk')
 * @returns {Error} Processed error with position and path information
 * @todo - merge TemplateError and PoisonError
 */
function handleError(error, lineno, colno, errorContextString = null, path = null) {
  // Special handling for PoisonError - preserve multiple errors
  if (isPoisonError(error)) {
    // Add path information to each contained error
    if (lineno || path) {
      // @todo - we probably shall not do this if there are multiple errors
      error.errors = error.errors.map(err => {
        return handleError(err, lineno, colno, errorContextString, path);
      });
    }
    return error; // Return PoisonError with updated errors
  }

  // Regular error handling
  if ('lineno' in error && error.lineno !== undefined) {
    // Already wrapped with position info
    /*if (path && !error.path && typeof error.Update === 'function') {
      //does this happen?
      error.Update(path);
    }*/
    return error;
  } else {
    // Wrap in RuntimeError
    const wrappedError = new RuntimeError(error, lineno, colno, errorContextString, path);
    return wrappedError;
  }
}

/**
 * Peeks inside a value (which might be a promise or a PoisonedValue)
 * and returns the underlying PoisonError object if it is an error.
 * If the value is healthy, returns a PoisonedValue (invalid peek).
 *
 * @param {any} value - The value to peek at
 * @returns {Promise<PoisonError|PoisonedValue>|PoisonError|PoisonedValue}
 */
function peekError(value) {
  // Sync check
  if (isPoison(value)) {
    return new PoisonError(value.errors);
  }

  // Promise check
  if (value && typeof value.then === 'function') {
    return value.then((result) => {
      if (isPoison(result)) {
        return new PoisonError(result.errors);
      }
      return createPoison(new Error('Peeking at a non-poisoned, healthy value.'));
    }, (err) => {
      if (isPoisonError(err)) {
        return err;
      }
      return new PoisonError([err]);
    });
  }

  // Healthy value - return poison
  return createPoison(new Error('Peeking at a non-poisoned, healthy value.'));
}

module.exports = {
  PoisonedValue,
  PoisonError,
  RuntimeError,
  RuntimePromise,
  ErrorContext,
  createPoison,
  isPoison,
  isPoisonError,
  isError,
  collectErrors,
  handleError,
  peekError
};
