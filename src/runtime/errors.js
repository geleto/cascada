
import {POISON_KEY, RESOLVE_MARKER} from './markers.js';

const BUFFER_CONTEXT_OPTIONAL_KEYS = ['boundaryName', 'loadName', 'targetIdentifier', 'loop', 'branch'];

// Internal promises are sometimes observed through an owning command/chain
// instead of by the promise object itself. Mark those promises handled so delayed
// Cascada-owned consumption does not create process-level rejection warnings.
function markPromiseHandled(promise) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  return promise;
}

function prepareErrorContexts(path, cb, labels, specs) {
  return specs.map(([lineno, colno, label]) => [
    lineno,
    colno,
    typeof label === 'number' ? labels[label] : label,
    path ?? null,
    cb ?? null
  ]);
}

function normalizeErrorContext(ec) {
  if (Array.isArray(ec)) {
    return {
      lineno: ec[0] ?? null,
      colno: ec[1] ?? null,
      label: ec[2] ?? null,
      path: ec[3] ?? null,
      cb: ec[4] ?? null
    };
  }

  if (ec && typeof ec === 'object') {
    // TODO(error-context-cleanup): remove legacy object-context support once
    // generated code passes only prepared compact __ec entries.
    return {
      lineno: ec.lineno ?? null,
      colno: ec.colno ?? null,
      label: (ec.label ?? ec.errorContextString) ?? null,
      path: ec.path ?? null,
      cb: ec.cb ?? null
    };
  }

  return {
    lineno: null,
    colno: null,
    label: null,
    path: null,
    cb: null
  };
}

// TODO(error-context-cleanup): remove this compatibility converter once runtime
// APIs no longer accept legacy object or positional error-context arguments.
function compactErrorContext(ec) {
  if (Array.isArray(ec)) {
    return ec;
  }

  const context = normalizeErrorContext(ec);
  if (
    context.lineno === null &&
    context.colno === null &&
    context.label === null &&
    context.path === null &&
    context.cb === null
  ) {
    return null;
  }

  return [
    context.lineno ?? 0,
    context.colno ?? 0,
    context.label,
    context.path,
    context.cb
  ];
}

// Keep source-origin assignment at the constructor/wrapper boundary. This
// helper is only for idempotently annotating an already-wrapped error that
// should not be replaced with a new RuntimeError.
function attachErrorContextIfMissing(error, ec) {
  const compact = compactErrorContext(ec);
  if (compact && error && typeof error === 'object' && !error.errorContext) {
    error.errorContext = compact;
  }
  return error;
}

function resolveEffectiveErrorContext(error, fallback = null) {
  if (error && typeof error === 'object' && error.errorContext) {
    return compactErrorContext(error.errorContext);
  }
  // TODO(error-context-cleanup): once helper fallbacks are always compact
  // prepared __ec entries, return fallback directly instead of converting.
  return compactErrorContext(fallback);
}

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
    if (errors instanceof PoisonError) {
      // Preserve the original error's properties, ignore new errorContext
      super(errors.message);
      this.errors = normalizeErrorsWithContext(errors.errors, errorContext);
      this.stack = errors.stack;
      return;
    }
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

    // Determine the appropriate stack trace
    const stacks = deduped.map(e => e.stack).filter(Boolean);
    const allSame = stacks.length > 0 && stacks.every(s => s === stacks[0]);

    if (allSame) {
      // Use the shared stack if all are identical
      this.stack = stacks[0];
    }

    // Ensure correct prototype chain (for Babel/older environments)
    // Object.setPrototypeOf?.(this, new.target.prototype);
  }

  constructMessage(errors) {

  }
}

/**
 * Runtime error with position and context information.
 */
class RuntimeError extends Error {
  // TODO(error-context-cleanup): collapse this constructor to
  // RuntimeError(message, ec) and remove positional/errorContextString support.
  constructor(message, ecOrLineno, currentBufferOrColno, errorContextString = null, path = null) {
    const fallbackContext = Array.isArray(ecOrLineno) || (ecOrLineno && typeof ecOrLineno === 'object')
      ? compactErrorContext(ecOrLineno)
      : compactErrorContext({ lineno: ecOrLineno, colno: currentBufferOrColno, label: errorContextString, path });
    const cause = message instanceof Error ? message : null;
    const errorContext = resolveEffectiveErrorContext(cause, fallbackContext);
    const context = normalizeErrorContext(errorContext);
    const lineno = context.lineno;
    const colno = context.colno;
    errorContextString = context.label;
    path = context.path;

    let err;
    if (message instanceof Error) {
      err = message;
      message = err.message;
    } else {
      err = new Error(message);
    }

    // Build formatted message with path and position info
    let messageMetadata = '';
    if (lineno != null || colno != null || errorContextString !== null || path !== null) {
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
    // TODO(error-context-cleanup): remove errorContextString after all callers
    // and tests use label/errorContext instead.
    this.errorContextString = errorContextString;
    this.label = errorContextString;
    this.path = path;
    this.errorContext = errorContext;
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
 * Fatal runtime error that should be reported to the callback even for async blocks.
 * Used for critical failures like broken sequential loop contracts.
 * TODO(error-context-cleanup): collapse to RuntimeFatalError(message, ec,
 * currentBuffer) after legacy positional call sites are migrated.
 */
class RuntimeFatalError extends RuntimeError {
  /**
   * @param {string|Error} message
   * @param {number|Array|ErrorContext|object} ecOrLineno - Line number, compact context, or legacy context object.
   * @param {number|object|null} currentBufferOrColno - Current buffer for compact context calls, or column number for legacy calls.
   * @param {string|null} errorContextString
   * @param {string|null} path
   */
  constructor(message, ecOrLineno = 0, currentBufferOrColno = 0, errorContextString = null, path = null) {
    super(message, ecOrLineno, currentBufferOrColno, errorContextString, path);
    this.name = 'RuntimeFatalError';
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
    // RuntimePromise instances are often passed around as values and awaited
    // only later during output application. Mark the wrapped promise as handled
    // immediately so delayed consumption does not trigger
    // PromiseRejectionHandledWarning for internal async flows.
    markPromiseHandled(this.promise);
    this.errorContext = errorContext;
  }

  then(onFulfilled, onRejected) {
    const wrappedOnRejected = onRejected && (err =>
      onRejected(handleError(err, this.errorContext))
    );

    const p = this.promise.then(onFulfilled, wrappedOnRejected);
    return new RuntimePromise(p, this.errorContext);
  }

  catch(onRejected) {
    const p = this.promise.catch(err =>
      onRejected(handleError(err, this.errorContext))
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
// TODO(error-context-cleanup): delete this legacy object wrapper once compact
// prepared __ec entries are the only runtime context shape.
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
 * @param {Array|number|object|null} ecOrLineno - Compact context, legacy context object, or line number
 * @param {object|number|null} currentBufferOrColno - Current buffer for compact context calls, or column number for legacy calls
 * @param {string} errorContextString - Context string for error message (optional)
 * @param {string} path - Template path (optional)
 * @returns {PoisonedValue} Poison value containing the error(s)
 */
// TODO(error-context-cleanup): remove this legacy positional/object adapter once
// createPoison/handleError callers pass compact prepared __ec entries.
function resolveErrorContextArgs(lineno = null, colno = null, errorContextString = null, path = null) {
  if (Array.isArray(lineno) || (lineno && typeof lineno === 'object')) {
    return compactErrorContext(lineno);
  }

  return compactErrorContext({ lineno, colno, label: errorContextString, path });
}

/**
 * erros can be either:
 * - a string
 * - an Error
 * - a PoisonError that may have many errors in it
 * - an array of Errors or strings
 */
// TODO(error-context-cleanup): collapse this to normalize only the error list
// after createPoison(...) no longer accepts legacy positional/object contexts.
function normalizeErrorsWithContext(errors, ecOrLineno = null, currentBufferOrColno = null, errorContextString = null, path = null) {
  const errorContext = resolveErrorContextArgs(ecOrLineno, currentBufferOrColno, errorContextString, path);
  const context = normalizeErrorContext(errorContext);
  let normalized = errors;

  if (!Array.isArray(normalized)) {
    if (typeof normalized === 'string') {
      normalized = [new RuntimeError(normalized, errorContext)];
    }
    normalized = isPoisonError(normalized) ? normalized.errors : [normalized];
  } else {
    //convert any strings to RuntimeError
    normalized = normalized.map(err => {
      if (typeof err === 'string') {
        return new RuntimeError(err, errorContext);
      }
      return err;
    });
  }

  const hasContext = context.lineno !== null ||
    context.colno !== null ||
    context.label !== null ||
    context.path !== null;

  if (!hasContext) {
    return normalized;
  }

  return normalized.map(err => {
    const didIterate = err && err.didIterate;

    if (isPoisonError(err)) {
      return err.errors.map(e => {
        if (!e.errorContext && e.lineno == null) {
          e = handleError(e, errorContext);
        }
        if (didIterate) {
          e.didIterate = didIterate;
        }
        return e;
      });
    }

    if (!err.errorContext && err.lineno == null) {
      err = handleError(err, errorContext);
    }

    if (didIterate) {
      err.didIterate = didIterate;
    }

    return err;
  }).flat();
}

// TODO(error-context-cleanup): change this public signature to
// createPoison(errors, ec, currentBuffer) after legacy overloads are gone.
function createPoison(errors/* or 1 error */, ecOrLineno = null, currentBufferOrColno = null, errorContextString = null, path = null) {
  const normalizedErrors = normalizeErrorsWithContext(errors, ecOrLineno, currentBufferOrColno, errorContextString, path);
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
 */
function isPoisonError(error) {
  return error instanceof PoisonError;
}

function isRuntimeFatalError(error) {
  return error instanceof RuntimeFatalError;
}

/**
 * Check if a value is an error or a promise that rejects with an error.
 * Awaits promises and checks if they resolve to poison or reject.
 */
async function isError(value) {
  if (isPoison(value)) {
    return true;//quick path
  }

  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return false;
  }

  const errors = await collectErrors([value]);
  return errors.length > 0;
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
        if (isPoison(resolved)) {
          errors.push(...resolved.errors);
        } else if (resolved && resolved[RESOLVE_MARKER]) {
          try {
            await resolved[RESOLVE_MARKER];
          } catch (err) {
            if (isPoisonError(err)) {
              errors.push(...err.errors);
            } else {
              errors.push(err);
            }
          }
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
    } else if (value && value[RESOLVE_MARKER]) {
      try {
        await value[RESOLVE_MARKER];
      } catch (err) {
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
 * @param {Array|number|object|null} ecOrLineno - Compact context, legacy context object, or line number
 * @param {object|number|null} currentBufferOrColno - Current buffer for compact context calls, or column number for legacy calls
 * @param {string} errorContextString - Context string for error message
 * @param {string} path - Template path (e.g., 'template.njk')
 * @returns {Error} Processed error with position and path information
 * @todo - merge TemplateError and PoisonError
 * TODO(error-context-cleanup): remove positional arguments after compiler and
 * runtime call sites pass compact prepared __ec entries.
 */
function handleError(error, ecOrLineno, currentBufferOrColno = null, errorContextString = null, path = null) {
  const fallbackContext = Array.isArray(ecOrLineno) || (ecOrLineno && typeof ecOrLineno === 'object')
    ? compactErrorContext(ecOrLineno)
    : compactErrorContext({ lineno: ecOrLineno, colno: currentBufferOrColno, label: errorContextString, path });

  // Special handling for PoisonError - preserve multiple errors
  if (isPoisonError(error)) {
    error.errors = error.errors.map(err => {
      const errorContext = resolveEffectiveErrorContext(err, fallbackContext);
      return errorContext ? handleError(err, errorContext) : err;
    });
    return error; // Return PoisonError with updated errors
  }

  const errorContext = resolveEffectiveErrorContext(error, fallbackContext);
  const context = normalizeErrorContext(errorContext);

  // Regular error handling
  if (error && typeof error === 'object' && 'lineno' in error && error.lineno !== undefined) {
    // Already wrapped with position info, just add path and errorContextString if missing
    if (!error.path && context.path) {
      error.path = context.path;
    }
    if (!error.errorContextString && context.label) {
      error.errorContextString = context.label;
      error.label = context.label;
    }
    attachErrorContextIfMissing(error, errorContext);
    return error;
  } else {
    // Wrap in RuntimeError
    const wrappedError = new RuntimeError(error, errorContext);
    return wrappedError;
  }
}

function handleFatal(error, ec, currentBuffer = null) {
  const wrapped = handleError(error, ec, currentBuffer);
  const context = normalizeErrorContext(resolveEffectiveErrorContext(wrapped, ec));

  if (context.cb) {
    context.cb(wrapped);
    return wrapped;
  }

  throw wrapped;
}

function getBufferErrorInfo(buffer) {
  if (!buffer || !buffer.errorContext) {
    return null;
  }

  const bufferContext = buffer.errorContext;
  const context = normalizeErrorContext(bufferContext.ec || bufferContext);
  const info = {
    lineno: context.lineno,
    colno: context.colno,
    path: context.path,
    label: context.label,
    // TODO(error-context-cleanup): remove this alias when diagnostics consume
    // label directly everywhere.
    errorContextString: context.label
  };

  for (const key of BUFFER_CONTEXT_OPTIONAL_KEYS) {
    if (bufferContext[key] !== undefined) {
      info[key] = bufferContext[key];
    }
  }

  return info;
}

function getBufferErrorStack(currentBuffer) {
  const stack = [];
  const seen = new Set();
  let buffer = currentBuffer || null;

  while (buffer && !seen.has(buffer)) {
    seen.add(buffer);
    const info = getBufferErrorInfo(buffer);
    if (info) {
      stack.push(info);
    }
    // Buffers without errorContext are omitted from output, but they do not
    // stop the walk; earlier migration phases may leave intentional gaps.
    buffer = buffer.traceParent || buffer.parent || null;
  }

  return stack;
}

function getErrorInfo(error, ec = null, currentBuffer = null, includeStack = false) {
  const context = normalizeErrorContext(resolveEffectiveErrorContext(error, ec));
  const info = {
    lineno: context.lineno,
    colno: context.colno,
    path: context.path,
    label: context.label,
    errorContextString: context.label,
    cb: context.cb
  };

  const bufferInfo = getBufferErrorInfo(currentBuffer);
  if (bufferInfo) {
    info.buffer = bufferInfo;
  }

  if (includeStack) {
    info.stack = getBufferErrorStack(currentBuffer);
  }

  return info;
}

/**
 * Peeks inside a value (which might be a promise or a PoisonedValue)
 * and returns the underlying PoisonError object if it is an error.
 * If the value is healthy, returns null (none).
 *
 * @param {any} value - The value to peek at
 * @returns {Promise<PoisonError|PoisonedValue>|PoisonError|PoisonedValue}
 */
function peekError(value) {
  // Sync check
  if (isPoison(value)) {
    return new PoisonError(value.errors);
  }

  // Async/lazy check
  if (value && (typeof value.then === 'function' || value[RESOLVE_MARKER])) {
    return collectErrors([value]).then((errors) => {
      return errors.length > 0 ? new PoisonError(errors) : null;
    });
  }

  // Healthy value
  return null;
}

export { PoisonedValue, PoisonError, RuntimeError, RuntimeFatalError, RuntimePromise, ErrorContext, prepareErrorContexts, normalizeErrorContext, getErrorInfo, createPoison, isPoison, isPoisonError, isRuntimeFatalError, isError, collectErrors, handleError, handleFatal, peekError, markPromiseHandled };
