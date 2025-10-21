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
  constructor(errors) {
    errors = Array.isArray(errors) ? errors : [errors];
    const deduped = deduplicateAndFlattenErrors(errors);

    const message = errors.length === 1
      ? errors[0].message
      : `Multiple errors occurred (${errors.length}):\n` +
      errors.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
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
    this.name = 'RuntimeError';
    this.lineno = lineno;
    this.colno = colno;
    this.errorContextString = errorContextString;
    this.path = path;
    this.cause = cause;

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
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
        const key = flattenedErr;
        if (!seen.has(key)) {
          seen.set(key, true);
          result.push(flattenedErr);
        }
      }
    } else {
      const key = err;//err.message || String(err);
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
 * Preserves existing position info in errors - never overwrites lineno, colno, or path.
 * Only adds position/path to errors that don't already have it.
 *
 * @param {Error|Error[]} errorOrErrors - Single error or array of errors
 * @param {number} lineno - Line number where error occurred (optional)
 * @param {number} colno - Column number where error occurred (optional)
 * @param {string} errorContextString - Context string for error message (optional)
 * @param {string} path - Template path (optional)
 * @returns {PoisonedValue} Poison value containing the error(s)
 */
function createPoison(errorOrErrors, lineno = null, colno = null, errorContextString = null, path = null) {
  let errors = Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors];

  // If position or path info provided, add it to errors that don't already have it
  if (lineno !== null || colno !== null || errorContextString !== null || path !== null) {
    errors = errors.map(err => {
      // If it's a PoisonError, extract its errors and process each one
      if (isPoisonError(err)) {
        return err.errors.map(e => {
          // If error already has position info, preserve it completely (don't update lineno, colno, or path)
          if (e.lineno) {
            return e;
          }
          // Error lacks position info - add it via handleError
          return handleError(e, lineno || 0, colno || 0, errorContextString, path);
        });
      }
      // If error already has position info, preserve it completely
      if (err.lineno) {
        return err;
      }
      // Error lacks position info - add it via handleError
      return handleError(err, lineno || 0, colno || 0, errorContextString, path);
    }).flat();
  }

  return new PoisonedValue(errors);
}

/**
 * Check if a value is poisoned.
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

module.exports = {
  PoisonedValue,
  PoisonError,
  RuntimeError,
  createPoison,
  isPoison,
  isPoisonError,
  collectErrors,
  handleError,
};
