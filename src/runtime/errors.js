
import {POISON_KEY, RESOLVE_MARKER} from './markers.js';

// Command-buffer execution metadata copied into getErrorInfo output. Keep this
// list narrow: `boundaryName` is the compiler/runtime boundary label, while
// source-operation identity still comes from the compact `ec` label.
const BUFFER_CONTEXT_OPTIONAL_KEYS = ['boundaryName', 'loadName', 'targetIdentifier', 'loop', 'branch'];
// TODO(error-context-cleanup): remove with normalizeOptionalErrorContext(...)
// once async paths no longer tolerate missing errorContext values.
const EMPTY_ERROR_CONTEXT_INFO = Object.freeze({
  lineno: null,
  colno: null,
  label: null,
  path: null,
  cb: null
});

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
  if (!Array.isArray(ec)) {
    throw new TypeError('normalizeErrorContext expects a compact error context');
  }
  return {
    lineno: ec[0] ?? null,
    colno: ec[1] ?? null,
    label: ec[2] ?? null,
    path: ec[3] ?? null,
    cb: ec[4] ?? null
  };
}

function normalizeOptionalErrorContext(ec) {
  return Array.isArray(ec) ? normalizeErrorContext(ec) : EMPTY_ERROR_CONTEXT_INFO;
}

function getErrorContextCallback(ec) {
  if (Array.isArray(ec)) {
    return ec[4] ?? null;
  }
  if (ec && typeof ec === 'object') {
    // TODO(error-context-cleanup): remove legacy object-context callback support
    // once inheritance origin metadata is compact-only.
    return ec.cb ?? null;
  }
  return null;
}

// Sync compatibility only. The async compiler/runtime passes compact prepared
// contexts directly; frozen sync/Nunjucks paths still enter handleError with
// positional fields.
function compactSyncErrorContext(lineno = null, colno = null, label = null, path = null) {
  if (lineno === null && colno === null && label === null && path === null) {
    return null;
  }

  return [
    lineno ?? 0,
    colno ?? 0,
    label,
    path,
    null
  ];
}

// Keep source-origin assignment at the constructor/wrapper boundary. This
// helper is only for idempotently annotating an already-wrapped error that
// should not be replaced with a new RuntimeError.
function attachErrorContextIfMissing(error, ec) {
  if (Array.isArray(ec) && error && typeof error === 'object' && !error.errorContext) {
    error.errorContext = ec;
  }
  return error;
}

function resolveEffectiveErrorContext(error, fallback = null) {
  if (error && typeof error === 'object' && error.errorContext) {
    if (Array.isArray(error.errorContext)) {
      return error.errorContext;
    }
    // Non-array errorContext is from a pre-Phase-A path; async diagnostics use
    // only compact prepared contexts and fall back to the explicit context.
  }
  return Array.isArray(fallback) ? fallback : null;
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
      // Apply new context to contained errors that lack one; preserve errors
      // that already carry their originating context.
      super(errors.message);
      this.errors = errorContext
        ? normalizeErrorsWithContext(errors.errors, errorContext)
        : errors.errors;
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
  constructor(message, ec = null) {
    const cause = message instanceof Error ? message : null;
    const errorContext = resolveEffectiveErrorContext(cause, ec);
    const context = normalizeOptionalErrorContext(errorContext);
    const lineno = context.lineno;
    const colno = context.colno;

    let err;
    if (message instanceof Error) {
      err = message;
      message = err.message;
    } else {
      err = new Error(message);
    }

    // Build formatted message with path and position info
    let messageMetadata = '';
    if (lineno != null || colno != null || context.label !== null || context.path !== null) {
      messageMetadata = '(' + (context.path || 'unknown path') + ')';

      if (lineno && colno) {
        messageMetadata += ` [Line ${lineno}, Column ${colno}]`;
      } else if (lineno) {
        messageMetadata += ` [Line ${lineno}]`;
      }

      if (context.label) {
        messageMetadata += ` doing '${context.label}'`;
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
    this.label = context.label;
    this.path = context.path;
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
 */
class RuntimeFatalError extends RuntimeError {
  constructor(message, ec = null) {
    super(message, ec);
    this.name = 'RuntimeFatalError';
  }
}


/**
 * Wraps a Promise to add contextual error information the *first time* it rejects.
 * - Does NOT attach a catch in the constructor, so global unhandled rejections still fire.
 * - Adds context only when a rejection handler is actually invoked (then/catch/await).
 * - Each chaining method returns a new RuntimePromise, preserving behavior through chains.
 * - Requires contextualizeError() to be idempotent so context is added only once per error.
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
      onRejected(contextualizeError(err, this.errorContext))
    );

    const p = this.promise.then(onFulfilled, wrappedOnRejected);
    return new RuntimePromise(p, this.errorContext);
  }

  catch(onRejected) {
    const p = this.promise.catch(err =>
      onRejected(contextualizeError(err, this.errorContext))
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
 * Normalizes createPoison inputs to an error array and attaches compact context
 * only where an error does not already carry one.
 *
 * errors can be either:
 * - a string
 * - an Error
 * - a PoisonError that may have many errors in it
 * - an array of Errors or strings
 */
function normalizeErrorsWithContext(errors, errorContext = null) {
  const context = normalizeOptionalErrorContext(errorContext);
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
          e = contextualizeError(e, errorContext);
        }
        if (didIterate) {
          e.didIterate = didIterate;
        }
        return e;
      });
    }

    if (!err.errorContext && err.lineno == null) {
      err = contextualizeError(err, errorContext);
    }

    if (didIterate) {
      err.didIterate = didIterate;
    }

    return err;
  }).flat();
}

function createPoison(errors/* or 1 error */, errorContext = null, currentBuffer = null) {
  void currentBuffer;
  const normalizedErrors = normalizeErrorsWithContext(errors, errorContext);
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
 * Add compact source context to runtime errors.
 * Preserves PoisonError with multiple errors, adding path to each contained error.
 * Frozen sync/Nunjucks code should use handleError(...), which adapts its
 * positional fields to this compact-only runtime path.
 *
 * @param {Error} error - The error to handle
 * @param {Array|null} errorContext - Compact context
 * @param {object|null} currentBuffer - Accepted for the canonical async call shape; stack enrichment is handled by getErrorInfo.
 * @returns {Error} Processed error with position and path information
 * @todo - merge TemplateError and PoisonError
 */
function contextualizeError(error, errorContext = null, currentBuffer = null) {
  void currentBuffer;
  const fallbackContext = Array.isArray(errorContext) ? errorContext : null;

  // Special handling for PoisonError - preserve multiple errors
  if (isPoisonError(error)) {
    error.errors = error.errors.map(err => {
      const containedContext = resolveEffectiveErrorContext(err, fallbackContext);
      return containedContext ? contextualizeError(err, containedContext) : err;
    });
    return error; // Return PoisonError with updated errors
  }

  const effectiveContext = resolveEffectiveErrorContext(error, fallbackContext);
  const context = normalizeOptionalErrorContext(effectiveContext);

  // Regular error handling
  if (error && typeof error === 'object' && 'lineno' in error && error.lineno !== undefined) {
    // Already wrapped with position info, just add path and label if missing.
    if (!error.path && context.path) {
      error.path = context.path;
    }
    if (!error.label && context.label) {
      error.label = context.label;
    }
    attachErrorContextIfMissing(error, effectiveContext);
    return error;
  } else {
    // Wrap in RuntimeError
    const wrappedError = new RuntimeError(error, effectiveContext);
    return wrappedError;
  }
}

// Sync compatibility only. New async/runtime code must use contextualizeError().
function handleError(error, lineno = null, colno = null, syncLabel = null, path = null) {
  return contextualizeError(error, compactSyncErrorContext(lineno, colno, syncLabel, path));
}

function handleFatal(error, ec, currentBuffer = null) {
  const wrapped = contextualizeError(error, ec, currentBuffer);
  const context = normalizeOptionalErrorContext(resolveEffectiveErrorContext(wrapped, ec));

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
    label: context.label
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
  const context = normalizeOptionalErrorContext(resolveEffectiveErrorContext(error, ec));
  const info = {
    lineno: context.lineno,
    colno: context.colno,
    path: context.path,
    label: context.label,
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

export { PoisonedValue, PoisonError, RuntimeError, RuntimeFatalError, RuntimePromise, prepareErrorContexts, normalizeErrorContext, getErrorContextCallback, getErrorInfo, createPoison, isPoison, isPoisonError, isRuntimeFatalError, isError, collectErrors, contextualizeError, handleError, handleFatal, peekError, markPromiseHandled };
