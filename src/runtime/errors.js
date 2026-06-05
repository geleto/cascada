
import {POISON_KEY, RESOLVE_MARKER} from './markers.js';
import {CascadaError} from '../errors.js';
import {
  formatDiagnosticInfo,
  formatDiagnosticMessage,
  formatPoisonErrorGroupMessages
} from './error-format.js';
import {
  getAddedContext,
  getRenderState,
  isCompactErrorContext,
  validateAddedContext
} from './error-context.js';

// Last-resort fatal runtime context only. Ordinary runtime and poison errors
// must carry compact origin context.
const CONTEXTLESS_FATAL_RUNTIME_CONTEXT = {
  lineno: null,
  colno: null,
  label: null,
  path: null,
  renderState: null
};
const POISON_GROUP_ERROR_LIMIT = 10;
// Internal promises are sometimes observed through an owning command/chain
// instead of by the promise object itself. Mark those promises handled so delayed
// Cascada-owned consumption does not create process-level rejection warnings.
function markPromiseHandled(promise) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  return promise;
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
    this.errors = PoisonError._normalizePoisonErrors(errors);
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
  static _resolveContext(errorContext) {
    return errorContext === undefined || errorContext === null
      ? CONTEXTLESS_FATAL_RUNTIME_CONTEXT
      : RuntimeContextError._normalizeContext(errorContext);
  }

  static _normalizeContext(errorContext) {
    if (!isCompactErrorContext(errorContext)) {
      throw new Error('RuntimeContextError expects a compact error context');
    }
    const addedContext = getAddedContext(errorContext);
    validateAddedContext(addedContext);

    return {
      lineno: errorContext[0] ?? null,
      colno: errorContext[1] ?? null,
      label: errorContext[2] ?? null,
      path: errorContext[3] ?? null,
      renderState: errorContext[5] ?? null,
      ...(addedContext || {})
    };
  }

  constructor(name, message, errorContext, options = {}) {
    const {
      headerLines = null,
      diagnosticStack = null,
      ...errorOptions
    } = options;
    const context = RuntimeContextError._resolveContext(errorContext);
    const description = message || '';
    const compactMessage = formatDiagnosticMessage(name, description, context, {
      headerLines
    });
    const normalizedDiagnosticStack = RuntimeContextError._normalizeDiagnosticStack(diagnosticStack);
    const fullMessage = formatDiagnosticMessage(name, description, context, {
      headerLines,
      stack: normalizedDiagnosticStack
    });

    super(name, compactMessage, context, { ...errorOptions, formatContext: false });
    this.context = context;
    this._errorContext = errorContext || null;
    this._diagnosticStack = diagnosticStack;
    this.description = description;
    this.fullMessage = fullMessage;
  }

  getInfo(diagnosticStack = null) {
    return RuntimeContextError.getInfo(this, this._errorContext || this.context, diagnosticStack);
  }

  formatInfo(diagnosticStack = null) {
    return RuntimeContextError.formatInfo(this, this._errorContext || this.context, diagnosticStack);
  }

  static getInfo(error, fallbackContext, diagnosticStack = null) {
    const effectiveContext = error && error._errorContext ? error._errorContext : fallbackContext;
    if (!effectiveContext) {
      throw new Error('RuntimeContextError.getInfo requires an error with origin context or a compact fallback context');
    }
    let info;
    if (isCompactErrorContext(effectiveContext)) {
      info = RuntimeContextError._normalizeContext(effectiveContext);
    } else if (error && effectiveContext === error.context && effectiveContext && typeof effectiveContext === 'object') {
      info = { ...effectiveContext };
    } else {
      throw new Error('RuntimeContextError.getInfo requires an error with origin context or a compact fallback context');
    }
    delete info.renderState;

    let stack = null;
    if (diagnosticStack) {
      stack = diagnosticStack;
    } else if (error && error._diagnosticStack) {
      stack = error._diagnosticStack;
    }
    const normalizedStack = RuntimeContextError._normalizeDiagnosticStack(stack);
    if (normalizedStack) {
      info.stack = normalizedStack.map((frame) => {
        const printableFrame = { ...frame };
        delete printableFrame.renderState;
        return printableFrame;
      });
    }

    return info;
  }

  static formatInfo(error, fallbackContext, diagnosticStack = null) {
    return formatDiagnosticInfo(RuntimeContextError.getInfo(error, fallbackContext, diagnosticStack));
  }

  static _normalizeDiagnosticStack(stack) {
    if (!Array.isArray(stack)) {
      return null;
    }
    return stack.map(frame => RuntimeContextError._normalizeContext(frame));
  }
}

function throwIfRuntimeError(error) {
  if (isRuntimeError(error)) {
    throw error;
  }
}

class PoisonError extends RuntimeContextError {
  constructor(cause, errorContext, options = {}) {
    if (!isCompactErrorContext(errorContext)) {
      throw new TypeError('PoisonError requires compact origin context');
    }
    const source = cause instanceof Error ? cause : new Error(String(cause));
    super('PoisonError', source.message, errorContext, {
      cause: source,
      diagnosticStack: options.diagnosticStack || null
    });
    if (new.target === PoisonError) {
      this.errors = [this];
      this.kind = requirePoisonKind(options.kind, errorContext, 'PoisonError requires kind');
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

  static _normalizePoisonErrors(errors) {
    if (isPoisonError(errors)) {
      errors = errors.errors;
    } else if (!Array.isArray(errors)) {
      reportRuntimeContractError(
        'Expected existing poison errors',
        errors && errors._errorContext
      );
    }

    const seen = new Map();
    const result = [];
    for (const err of errors) {
      throwIfRuntimeError(err);
      if (!isPoisonError(err)) {
        reportRuntimeContractError(
          'Expected existing poison errors',
          err && err._errorContext
        );
      }
      PoisonError._pushDedupedErrors(result, seen, err.errors);
    }
    return result;
  }

  static _deduplicateCollectedErrors(errors) {
    const seen = new Map();
    const result = [];
    for (const err of errors) {
      if (isPoisonError(err)) {
        PoisonError._pushDedupedErrors(result, seen, err.errors);
      } else {
        PoisonError._pushDedupedErrors(result, seen, [err]);
      }
    }

    return result;
  }

  static _pushDedupedErrors(result, seen, errors) {
    for (const err of errors) {
      const identity = PoisonError._dedupeIdentity(err);
      if (!seen.has(identity)) {
        seen.set(identity, true);
        result.push(err);
      }
    }
  }

  // Deduplicate wrappers by their original cause so re-wrapping the same
  // source error preserves the old identity semantics.
  static _dedupeIdentity(err) {
    return err instanceof PoisonError && err.cause ? err.cause : err;
  }

  static create(message, errorContext, kind) {
    if (typeof message !== 'string') {
      RuntimeError.reportAndThrow('PoisonError.create expects a message string', errorContext);
    }
    requirePoisonKind(kind, errorContext, 'PoisonError.create requires kind');
    return new PoisonError(new Error(message), errorContext, { kind });
  }

  static wrap(error, errorContext, kind) {
    if (isPoisonError(error)) {
      // Existing poison keeps its original source context; consumers must not
      // replace it with the current operation's context.
      return error;
    }
    throwIfRuntimeError(error);
    requirePoisonKind(kind, errorContext, 'PoisonError.wrap requires kind');
    return new PoisonError(error, errorContext, { kind });
  }

  /**
   * Aggregate existing poison errors. Returns the original PoisonError when
   * there is only one normalized child, or PoisonErrorGroup for multiple.
   */
  static group(errors) {
    const poisonErrors = PoisonError._normalizePoisonErrors(errors);
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
  constructor(input, alreadyNormalized = false) {
    if (!alreadyNormalized && input instanceof PoisonErrorGroup) {
      reportRuntimeContractError(
        'PoisonErrorGroup constructor expects individual poison errors; use PoisonError.group(...) to normalize existing groups',
        input._errorContext
      );
    }
    const state = alreadyNormalized
      ? input
      : PoisonErrorGroup._buildStateFromNormalizedErrors(PoisonError._normalizePoisonErrors(input));
    const firstError = state.errors[0];
    super(firstError.cause, firstError._errorContext, {
      diagnosticStack: firstError._diagnosticStack || null
    });

    this.name = 'PoisonErrorGroup';
    this.description = state.description;
    this.message = formatDiagnosticMessage('PoisonErrorGroup', state.description, this.context, {
      headerLines: state.messageLines
    });
    this.fullMessage = formatDiagnosticMessage('PoisonErrorGroup', state.description, this.context, {
      headerLines: state.fullMessageLines,
      stack: RuntimeContextError._normalizeDiagnosticStack(firstError._diagnosticStack)
    });
    this.errors = state.errors;
    this.kind = state.kind;
    this.totalErrorCount = state.totalErrorCount;
    this.kinds = state.kinds;
    if (state.stack) {
      this.stack = state.stack;
    }
  }

  static _fromState(state) {
    return new PoisonErrorGroup(state, true);
  }

  static _buildStateFromNormalizedErrors(normalizedErrors) {
    if (normalizedErrors.length === 0) {
      throw new Error('PoisonErrorGroup requires at least one poison error');
    }
    const sortedErrors = PoisonErrorGroup._sortErrorsBySource(normalizedErrors);
    const totalErrorCount = sortedErrors.length;
    const kinds = PoisonErrorGroup._collectKinds(sortedErrors);
    const description = `Multiple errors occurred (${totalErrorCount})`;
    const { messageLines, fullMessageLines } = formatPoisonErrorGroupMessages(
      sortedErrors,
      kinds,
      POISON_GROUP_ERROR_LIMIT
    );
    const stacks = sortedErrors.map(e => e.stack).filter(Boolean);
    const allSame = stacks.length > 0 && stacks.every(s => s === stacks[0]);
    if (!sortedErrors[0]._errorContext) {
      throw new Error('PoisonErrorGroup requires origin context');
    }

    return {
      description,
      messageLines,
      fullMessageLines,
      errors: sortedErrors,
      totalErrorCount,
      kinds,
      kind: kinds.length === 1 ? kinds[0] : 'Multiple',
      stack: allSame ? stacks[0] : null
    };
  }

  static _collectKinds(errors) {
    return [...new Set(errors.map(error =>
      requirePoisonKind(error.kind, error._errorContext, 'Grouped PoisonError requires kind')
    ))].sort();
  }

  static _sortErrorsBySource(errors) {
    return errors
      .map((error, index) => ({ error, index }))
      .sort((left, right) => {
        const leftContext = left.error.context || {};
        const rightContext = right.error.context || {};
        return compareNullable(leftContext.path, rightContext.path) ||
          compareNullable(leftContext.lineno, rightContext.lineno) ||
          compareNullable(leftContext.colno, rightContext.colno) ||
          compareNullable(
            requirePoisonKind(left.error.kind, left.error._errorContext, 'Grouped PoisonError requires kind'),
            requirePoisonKind(right.error.kind, right.error._errorContext, 'Grouped PoisonError requires kind')
          ) ||
          left.index - right.index;
      })
      .map(entry => entry.error);
  }
}

function requirePoisonKind(kind, errorContext, message) {
  if (typeof kind !== 'string' || kind.length === 0) {
    reportRuntimeContractError(message, errorContext);
  }
  return kind;
}

function compareNullable(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  return left < right ? -1 : 1;
}

class RuntimeError extends RuntimeContextError {
  static create(message, context, stackBuffer = null) {
    if (message instanceof RuntimeError) {
      if (context !== undefined && context !== null) {
        reportRuntimeContractError('RuntimeError.create received context for an existing RuntimeError', context);
      }
      return message;
    }
    if (!context && !(message && message._errorContext)) {
      return new RuntimeError(message);
    }
    return new RuntimeError(message, context, stackBuffer);
  }

  static report(message, context, stackBuffer = null) {
    // Existing RuntimeError keeps its origin. A supplied context is used only
    // to find the active renderState to report into, not to re-contextualize it.
    const error = message instanceof RuntimeError
      ? message
      : RuntimeError.create(message, context, stackBuffer);
    const renderState = context
      ? getRenderState(context)
      : error.context.renderState;
    if (renderState) {
      renderState.reportFatalError(error);
    }
    return error;
  }

  static reportAndThrow(message, context, stackBuffer = null) {
    throw RuntimeError.report(message, context, stackBuffer);
  }

  constructor(message, inputContext, stackBuffer = null) {
    const cause = message instanceof Error ? message : null;
    const errorContext = cause && cause._errorContext
      ? cause._errorContext
      : inputContext;
    const runtimeMessage = cause ? cause.message : message;

    super('RuntimeError', runtimeMessage, errorContext, {
      cause,
      diagnosticStack: stackBuffer ? stackBuffer.getDiagnosticStack() : null
    });

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
  throw new RuntimeError(message);
}

function isLoadFailureFatal(env, kind) {
  requireLoadFailureKind(kind);
  const policy = env && env.opts && env.opts.loadFailFatal;
  if (policy instanceof Set) {
    return policy.has(kind);
  }
  // Default fatal for older/custom environment objects that do not normalize opts.
  return true;
}

function handleLoadFailure(error, errorContext, kind, env) {
  requireLoadFailureKind(kind);
  if (isRuntimeError(error) || isPoisonError(error)) {
    throw error;
  }
  if (isLoadFailureFatal(env, kind)) {
    RuntimeError.reportAndThrow(error, errorContext);
  }
  throw PoisonError.wrap(error, errorContext, 'LoadFailed');
}

function requireLoadFailureKind(kind) {
  if (kind !== 'import' && kind !== 'component' && kind !== 'include') {
    reportRuntimeContractError(`Invalid load failure kind '${kind}'`, CONTEXTLESS_FATAL_RUNTIME_CONTEXT);
  }
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
  constructor(promise, errorContext, kind) {
    this.promise = Promise.resolve(promise).then(value => poisonIfNaN(value, errorContext));
    // RuntimePromise instances are often passed around as values and awaited
    // only later during output application. Mark the wrapped promise as handled
    // immediately so delayed consumption does not trigger
    // PromiseRejectionHandledWarning for internal async flows.
    markPromiseHandled(this.promise);
    this.errorContext = errorContext;
    this.kind = requirePoisonKind(kind, errorContext, 'RuntimePromise requires kind');
  }

  then(onFulfilled, onRejected) {
    const wrappedOnRejected = onRejected && (err =>
      onRejected(RuntimePromise._wrapRejection(err, this.errorContext, this.kind))
    );

    const p = this.promise.then(onFulfilled, wrappedOnRejected);
    return new RuntimePromise(p, this.errorContext, this.kind);
  }

  catch(onRejected) {
    const p = this.promise.catch(err =>
      onRejected(RuntimePromise._wrapRejection(err, this.errorContext, this.kind))
    );
    return new RuntimePromise(p, this.errorContext, this.kind);
  }

  finally(onFinally) {
    const p = this.promise.finally(onFinally);
    return new RuntimePromise(p, this.errorContext, this.kind);
  }

  get [Symbol.toStringTag]() { return 'Promise'; }

  toPromise() { return this.promise; }

  static resolve(value, ctx, kind) {
    return new RuntimePromise(Promise.resolve(value), ctx, kind);
  }

  static reject(reason, ctx, kind) {
    return new RuntimePromise(Promise.reject(reason), ctx, kind);
  }

  static _wrapRejection(err, errorContext, kind) {
    if (isPoisonError(err) || isRuntimeError(err)) {
      return err;
    }
    if (isPoison(err)) {
      // Safety net for code that incorrectly throws/rejects with PoisonedValue
      // instead of throwing a PoisonError.
      return PoisonError.group(err.errors);
    }
    requirePoisonKind(kind, errorContext, 'RuntimePromise rejection requires kind');
    return PoisonError.wrap(err, errorContext, kind);
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

function poisonIfNaN(value, errorContext) {
  if (typeof value === 'number' && Number.isNaN(value)) {
    if (!errorContext) {
      reportRuntimeContractError('poisonIfNaN requires a compact errorContext for NaNResult', CONTEXTLESS_FATAL_RUNTIME_CONTEXT);
    }
    return createPoison(PoisonError.create('value is NaN', errorContext, 'NaNResult'));
  }
  return value;
}

// Sync-first consumers: return poison as a value, report raw failures as fatal.
function poisonOrReport(err, errorContext) {
  if (isPoisonError(err)) {
    return createPoison(err);
  }
  RuntimeError.reportAndThrow(err, errorContext);
}

// Async consumers: keep poison as a rejection, report raw failures as fatal.
function rethrowPoisonOrReport(err, errorContext) {
  if (isPoisonError(err)) {
    throw err;
  }
  RuntimeError.reportAndThrow(err, errorContext);
}

// Observable command results: preserve poison, report raw failures as fatal.
function poisonOrReportedFatal(err, errorContext) {
  return isPoisonError(err) ? err : RuntimeError.report(err, errorContext);
}

// Context-free consumers (resolve.js): return poison as a value, bare-rethrow raw
// failures (and RuntimeErrors, unchanged) by design. No errorContext here, so the
// owning boundary — call/structural, or raceRootResult — reports it as fatal with
// proper context. Context belongs to the origin/owner, not the consumer.
function poisonOrRethrow(err) {
  if (isPoisonError(err)) {
    return createPoison(err);
  }
  throw err;
}

function observeDiscardedExpression(value, errorContext) {
  if (!value || isPoison(value) || typeof value.then !== 'function') {
    return;
  }

  markPromiseHandled(Promise.resolve(value).catch((err) => {
    if (!isPoisonError(err)) {
      RuntimeError.report(err, errorContext);
    }
  }));
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

  return PoisonError._deduplicateCollectedErrors(errors);
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
function createSyncRuntimeError(error, lineno = null, colno = null, syncLabel = null, path = null) {
  if (error instanceof RuntimeError) {
    return error;
  }
  const errorContext = [lineno ?? 0, colno ?? 0, syncLabel, path, null, null];
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

export { PoisonedValue, PoisonError, PoisonErrorGroup, RuntimeError, RuntimeContextError, RuntimePromise, createPoison, poisonIfNaN, poisonOrReport, rethrowPoisonOrReport, poisonOrReportedFatal, poisonOrRethrow, observeDiscardedExpression, isPoison, isPoisonError, isRuntimeError, isError, collectErrors, createSyncRuntimeError, peekError, markPromiseHandled, isLoadFailureFatal, handleLoadFailure };
