
import {POISON_KEY, RESOLVE_MARKER} from './markers.js';
import {CascadaError} from '../errors.js';
import {
  formatDiagnosticInfo,
  formatDiagnosticMessage,
  formatNumberedDiagnostic
} from './error-format.js';

class NormalizedPoisonGroupState {
  constructor(state) {
    this.state = state;
  }
}

// Internal promises are sometimes observed through an owning command/chain
// instead of by the promise object itself. Mark those promises handled so delayed
// Cascada-owned consumption does not create process-level rejection warnings.
function markPromiseHandled(promise) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  return promise;
}

function prepareErrorContexts(path, renderState, labels, specs) {
  return specs.map(([lineno, colno, label]) => [
    lineno,
    colno,
    typeof label === 'number' ? labels[label] : label,
    path ?? null,
    renderState ?? null
  ]);
}

function isBufferStackContext(context) {
  return context && !Array.isArray(context) && Array.isArray(context.ec);
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
    this.errors = PoisonError._normalizeErrors(errors);
    this[POISON_KEY] = true;
  }

  then(onFulfilled, onRejected) {
    // Optimization: if no rejection handler, propagate poison directly
    if (!onRejected) {
      return this;
    }

    const error = PoisonError.group(this.errors);

    // Call the rejection handler
    try {
      const result = onRejected(error);
      // Handler succeeded - need Promise for fulfillment
      // Use Promise.resolve to handle case where result is itself a thenable
      return Promise.resolve(result);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err);
      }
      throw err;
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

class RuntimeContextError extends CascadaError {
  static _normalizeContext(errorContext) {
    const bufferStackContext = isBufferStackContext(errorContext)
      ? errorContext
      : null;
    const ec = bufferStackContext ? bufferStackContext.ec : errorContext;

    if (!Array.isArray(ec)) {
      throw new Error('RuntimeContextError expects a compact error context');
    }
    const context = {
      lineno: ec[0] ?? null,
      colno: ec[1] ?? null,
      label: ec[2] ?? null,
      path: ec[3] ?? null,
      renderState: ec[4] ?? null
    };

    if (!bufferStackContext) {
      return context;
    }

    // The compact ec remains the authority for source position and render
    // state. Stack metadata may intentionally provide a display label override
    // such as "Iteration", but other base fields are ignored here.
    const {
      ec: _ec,
      diagnosticStack: _diagnosticStack,
      lineno,
      colno,
      path,
      renderState,
      label,
      ...bufferStackMetadata
    } = bufferStackContext;

    return {
      ...context,
      ...bufferStackMetadata,
      label: label ?? context.label
    };
  }

  constructor(name, message, errorContext, options = {}) {
    const {
      normalizedContext = null,
      storedErrorContext = errorContext,
      diagnosticName = name,
      diagnosticHeaderLines = null,
      diagnosticFullHeaderLines = diagnosticHeaderLines,
      ...errorOptions
    } = options;
    const context = normalizedContext || RuntimeContextError._normalizeContext(errorContext);
    const description = message || '';
    const compactMessage = formatDiagnosticMessage(diagnosticName, description, context, {
      headerLines: diagnosticHeaderLines
    });
    const diagnosticStack = RuntimeContextError._getDiagnosticStack(errorContext);
    const fullMessage = formatDiagnosticMessage(diagnosticName, description, context, {
      headerLines: diagnosticFullHeaderLines,
      stack: diagnosticStack
    });

    super(name, compactMessage, context, { ...errorOptions, formatContext: false });
    this.context = context;
    this._errorContext = storedErrorContext;
    this.description = description;
    this.fullMessage = fullMessage;
  }

  getInfo(options = {}) {
    return RuntimeContextError.getInfo(this, this._errorContext, options);
  }

  formatInfo(options = {}) {
    return RuntimeContextError.formatInfo(this, this._errorContext, options);
  }

  static getInfo(error, fallbackContext, options = {}) {
    const { stackBuffer = null } = options;
    const effectiveContext = error && error._errorContext ? error._errorContext : fallbackContext;
    if (!effectiveContext) {
      throw new Error('RuntimeContextError.getInfo requires an error with origin context or a compact fallback context');
    }
    const contextInput = error && error.bufferStackContext
      ? error.bufferStackContext
      : effectiveContext;
    const info = RuntimeContextError._normalizeContext(contextInput);
    delete info.renderState;

    if (stackBuffer) {
      info.stack = stackBuffer.getDiagnosticStack();
    } else if (isBufferStackContext(contextInput) && Array.isArray(contextInput.diagnosticStack)) {
      info.stack = contextInput.diagnosticStack;
    }

    return info;
  }

  static formatInfo(error, fallbackContext, options = {}) {
    return formatDiagnosticInfo(RuntimeContextError.getInfo(error, fallbackContext, options));
  }

  static _getDiagnosticStack(errorContext) {
    return isBufferStackContext(errorContext) && Array.isArray(errorContext.diagnosticStack)
      ? errorContext.diagnosticStack
      : null;
  }
}

function throwIfRuntimeError(error) {
  if (isRuntimeError(error)) {
    throw error;
  }
}

class PoisonError extends RuntimeContextError {
  constructor(cause, errorContext, normalizedContext = RuntimeContextError._normalizeContext(errorContext)) {
    const source = cause instanceof Error ? cause : new Error(String(cause));
    super('PoisonError', source.message, normalizedContext, {
      cause: source,
      normalizedContext,
      storedErrorContext: errorContext,
      diagnosticName: 'PoisonError'
    });
    if (new.target === PoisonError) {
      this.errors = [this];
      if (source.stack) {
        this.stack = source.stack;
      }
      const reserved = new Set(['name', 'stack', 'message', 'cause']);
      for (const key of Object.keys(source)) {
        if (!reserved.has(key) && this[key] === undefined) {
          this[key] = source[key];
        }
      }
    }
  }

  static _normalizeErrors(errors) {
    if (isPoisonError(errors)) {
      errors = errors.errors;
    } else if (!Array.isArray(errors)) {
      reportRuntimeContractError(
        'PoisonError.group expects existing poison errors',
        errors && errors._errorContext
      );
    }
    const normalized = PoisonError._deduplicateAndFlatten(errors);
    return normalized.map(err => {
      throwIfRuntimeError(err);
      if (!isPoisonError(err)) {
        reportRuntimeContractError(
          'PoisonError.group expects existing poison errors',
          err._errorContext
        );
      }
      return err;
    });
  }

  static _deduplicateAndFlatten(errors) {
    const seen = new Map();
    const result = [];
    // Deduplicate wrappers by their original cause so re-wrapping the same
    // source error preserves the old identity semantics.
    const getIdentity = (err) => {
      return err instanceof PoisonError && err.cause ? err.cause : err;
    };

    for (const err of errors) {
      if (isPoisonError(err)) {
        for (const flattenedErr of err.errors) {
          const identity = getIdentity(flattenedErr);
          if (!seen.has(identity)) {
            seen.set(identity, true);
            result.push(flattenedErr);
          }
        }
      } else {
        const identity = getIdentity(err);
        if (!seen.has(identity)) {
          seen.set(identity, true);
          result.push(err);
        }
      }
    }

    return result;
  }

  static create(message, errorContext) {
    if (typeof message !== 'string') {
      RuntimeError.reportAndThrow('PoisonError.create expects a message string', errorContext);
    }
    return new PoisonError(new Error(message), errorContext);
  }

  static wrap(error, errorContext) {
    if (isPoisonError(error)) {
      return error;
    }
    throwIfRuntimeError(error);
    return new PoisonError(error, errorContext);
  }

  static group(errors) {
    const poisonErrors = PoisonError._normalizeErrors(errors);
    const state = PoisonErrorGroup._buildStateFromNormalizedErrors(poisonErrors);
    if (state.errors.length === 1) {
      return state.errors[0];
    }
    return PoisonErrorGroup._fromState(state);
  }
}

/**
 * Error thrown when multiple operations are poisoned.
 * Extends PoisonError so instanceof PoisonError is true for both types.
 * Exposes the same interface: cause/lineno/colno/path/label come from the
 * first child error; errors[] holds all individual PoisonErrors.
 */
class PoisonErrorGroup extends PoisonError {
  constructor(input) {
    const state = input instanceof NormalizedPoisonGroupState
      ? input.state
      : PoisonErrorGroup._buildStateFromNormalizedErrors(
        PoisonError._normalizeErrors(input),
        input instanceof PoisonErrorGroup ? input.stack : null
      );
    const firstError = state.errors[0];
    super(firstError.cause, firstError._errorContext, state.context);

    this.name = 'PoisonErrorGroup';
    this.description = state.description;
    this.message = formatDiagnosticMessage('PoisonErrorGroup', state.description, state.context, {
      headerLines: state.messageLines
    });
    this.fullMessage = formatDiagnosticMessage('PoisonErrorGroup', state.description, state.context, {
      headerLines: state.fullMessageLines,
      stack: RuntimeContextError._getDiagnosticStack(firstError._errorContext)
    });
    this.errors = state.errors;
    if (state.stack) {
      this.stack = state.stack;
    }
  }

  static _fromState(state) {
    return new PoisonErrorGroup(new NormalizedPoisonGroupState(state));
  }

  static _buildStateFromNormalizedErrors(normalizedErrors, sourceStack = null) {
    const deduped = normalizedErrors;
    if (deduped.length === 0) {
      throw new Error('PoisonErrorGroup requires at least one poison error');
    }
    const errorLabel = deduped.length === 1 ? 'error' : 'errors';
    const description = `Multiple errors occurred (${deduped.length})`;
    const messageLines = [
      `PoisonErrorGroup (${deduped.length} ${errorLabel}):`,
      ...deduped.map((error, index) => formatNumberedDiagnostic(index, error.message))
    ];
    const fullMessageLines = [
      `PoisonErrorGroup (${deduped.length} ${errorLabel}):`,
      ...deduped.map((error, index) => formatNumberedDiagnostic(index, error.fullMessage))
    ];
    const stacks = deduped.map(e => e.stack).filter(Boolean);
    const allSame = stacks.length > 0 && stacks.every(s => s === stacks[0]);
    if (!deduped[0]._errorContext) {
      throw new Error('PoisonErrorGroup requires origin context');
    }

    return {
      description,
      messageLines,
      fullMessageLines,
      errors: deduped,
      errorContext: deduped[0]._errorContext,
      context: RuntimeContextError._normalizeContext(deduped[0]._errorContext),
      stack: sourceStack || (allSame ? stacks[0] : null)
    };
  }
}

function resolveRuntimeErrorContext(cause, context) {
  const bufferStackContext = isBufferStackContext(context)
    ? context
    : null;
  const errorContext = cause && cause._errorContext
    ? cause._errorContext
    : cause && cause.errorContext
      ? cause.errorContext
    : (bufferStackContext ? bufferStackContext.ec : context);
  return {
    errorContext,
    bufferStackContext: cause && cause.bufferStackContext
      ? cause.bufferStackContext
      : bufferStackContext
  };
}

class RuntimeError extends RuntimeContextError {
  static create(message, context) {
    if (message instanceof RuntimeError) {
      return message;
    }
    if (!context && !(message && (message._errorContext || message.errorContext))) {
      throw new Error('RuntimeError.create requires an error context');
    }
    return new RuntimeError(message, context);
  }

  static report(message, context) {
    const error = RuntimeError.create(message, context);
    const renderState = error.context.renderState;
    if (renderState) {
      renderState.reportFatalError(error);
    }
    return error;
  }

  static reportAndThrow(message, context) {
    throw RuntimeError.report(message, context);
  }

  constructor(message, inputContext) {
    const cause = message instanceof Error ? message : null;
    const {errorContext, bufferStackContext} = resolveRuntimeErrorContext(cause, inputContext);
    const contextInput = bufferStackContext && bufferStackContext.ec === errorContext
      ? bufferStackContext
      : errorContext;
    const context = RuntimeContextError._normalizeContext(contextInput);
    const runtimeName = cause && cause.name ? `RuntimeError: ${cause.name}` : 'RuntimeError';
    const runtimeMessage = cause ? cause.message : message;

    super(runtimeName, runtimeMessage, contextInput, {
      cause,
      normalizedContext: context,
      storedErrorContext: errorContext,
      diagnosticName: 'RuntimeError'
    });
    if (bufferStackContext) {
      this.bufferStackContext = bufferStackContext;
    }

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

function reportRuntimeContractError(message, errorContext) {
  if (errorContext) {
    RuntimeError.reportAndThrow(message, errorContext);
  }
  throw new Error(message);
}

/**
 * Wraps a Promise to add contextual error information the *first time* it rejects.
 * - Does NOT attach a catch in the constructor, so global unhandled rejections still fire.
 * - Adds context only when a rejection handler is actually invoked (then/catch/await).
 * - Each chaining method returns a new RuntimePromise, preserving behavior through chains.
 * - Converts rejections through idempotent error factories so context is added
 *   only once per error.
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
      onRejected(RuntimePromise._wrapRejection(err, this.errorContext))
    );

    const p = this.promise.then(onFulfilled, wrappedOnRejected);
    return new RuntimePromise(p, this.errorContext);
  }

  catch(onRejected) {
    const p = this.promise.catch(err =>
      onRejected(RuntimePromise._wrapRejection(err, this.errorContext))
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

  static _wrapRejection(err, errorContext) {
    if (isPoisonError(err) || isRuntimeError(err)) {
      return err;
    }
    if (isPoison(err)) {
      return PoisonError.group(err.errors);
    }
    return PoisonError.wrap(err, errorContext);
  }
}

function createPoison(poisonError) {
  if (!isPoisonError(poisonError)) {
    reportRuntimeContractError(
      'createPoison expects PoisonError.wrap(...) or PoisonError.group(...)',
      poisonError && poisonError._errorContext
    );
  }
  return new PoisonedValue(poisonError.errors);
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

function isRuntimeError(error) {
  return error instanceof RuntimeError;
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
            collectThrownError(errors, err);
          }
        }
      } catch (err) {
        // If the error is a PoisonError (from unwrapping a poison),
        // extract its underlying errors
        collectThrownError(errors, err);
      }
    } else if (value && value[RESOLVE_MARKER]) {
      try {
        await value[RESOLVE_MARKER];
      } catch (err) {
        collectThrownError(errors, err);
      }
    }
  }

  return PoisonError._deduplicateAndFlatten(errors);
}

function collectThrownError(errors, err) {
  if (isPoisonError(err)) {
    errors.push(...err.errors);
    return;
  }
  throw err;
}

// Sync compatibility only. New async/runtime code should use
// RuntimeError.report(...) or RuntimeError.reportAndThrow(...).
function handleError(error, lineno = null, colno = null, syncLabel = null, path = null) {
  const errorContext = [lineno ?? 0, colno ?? 0, syncLabel, path, null];
  return RuntimeError.create(error, errorContext);
}

/**
 * Peeks inside a value (which might be a promise or a PoisonedValue)
 * and returns the underlying poison error if it is an error.
 * If the value is healthy, returns null (none).
 *
 * @param {any} value - The value to peek at
 * @returns {Promise<PoisonError|PoisonErrorGroup|null>|PoisonError|PoisonErrorGroup|null}
 */
function peekError(value) {
  // Sync check
  if (isPoison(value)) {
    return PoisonError.group(value.errors);
  }

  // Async/lazy check
  if (value && (typeof value.then === 'function' || value[RESOLVE_MARKER])) {
    return collectErrors([value]).then((errors) => {
      if (errors.length === 0) {
        return null;
      }
      return PoisonError.group(errors);
    });
  }

  // Healthy value
  return null;
}

export { PoisonedValue, PoisonError, PoisonErrorGroup, RuntimeError, RuntimeContextError, RuntimePromise, prepareErrorContexts, createPoison, isPoison, isPoisonError, isRuntimeError, isError, collectErrors, handleError, peekError, markPromiseHandled };
