'use strict';

// Enable write counter validation at runtime.
// Set to true during development to catch async tracking bugs.
// Can be set to false in production if needed for performance.
const ENABLE_WRITECOUNTER_CHECK = true;

// Enable checkInfo object creation for detailed error reporting.
// When true, creates checkInfo with source location for better debugging.
// When false, skips checkInfo creation (slightly better performance).
const ENABLE_CHECKINFO = true;

/**
 * Check if async block finished with pending writes.
 * Called when leaving an async block to validate all write counters reached zero.
 *
 * @param {Object} asyncBlockFrame - The frame for the async block
 * @param {Object} checkInfo - Optional checkInfo object with {cb, runtime, lineno, colno, errorContextString, context}
 */
function checkPendingWrites(asyncBlockFrame, checkInfo) {
  if (!asyncBlockFrame || !asyncBlockFrame.writeCounters) {
    return;
  }

  const pendingWrites = Object.entries(asyncBlockFrame.writeCounters).filter(([_, count]) => count > 0);

  if (pendingWrites.length > 0) {
    const writeCountersObj = Object.fromEntries(pendingWrites);
    const message = 'Async block finished with pending writes: ' + JSON.stringify(writeCountersObj);

    if (checkInfo && checkInfo.cb) {
      checkInfo.cb(new checkInfo.runtime.RuntimeFatalError(
        message,
        checkInfo.lineno,
        checkInfo.colno,
        checkInfo.errorContextString,
        checkInfo.context ? checkInfo.context.path : null
      ));
    } else {
      throw new Error(message);
    }
  }
}

/**
 * Check if a write counter exists for a variable.
 * Called when attempting to decrement a write counter.
 *
 * @param {string} varName - Variable name
 * @param {Object} checkInfo - Optional checkInfo object with {cb, runtime, lineno, colno, errorContextString, context}
 * @throws {RuntimeFatalError} If no write counter found
 */
function checkWriteCounterExists(varName, checkInfo) {
  const { RuntimeFatalError } = require('./errors');
  const err = new RuntimeFatalError(`No write counter found for variable ${varName}`);

  if (checkInfo && checkInfo.cb) {
    checkInfo.cb(err);
    return false;
  } else {
    throw err;
  }
}

/**
 * Check if write counter went negative.
 * Called when decrementing a write counter results in a negative value.
 *
 * @param {string} varName - Variable name
 * @param {number} count - Current counter value
 * @param {Object} checkInfo - Optional checkInfo object
 * @throws {RuntimeFatalError} Always throws
 */
function checkWriteCounterNegative(varName, count, checkInfo) {
  const { RuntimeFatalError } = require('./errors');
  const message = `Variable ${varName} write counter ${count === undefined ? 'is undefined' : 'turned negative'} in _trackAsyncWrites`;

  if (checkInfo && checkInfo.cb) {
    const fatal = new RuntimeFatalError(
      message,
      checkInfo.lineno,
      checkInfo.colno,
      checkInfo.errorContextString,
      checkInfo.context ? checkInfo.context.path : null
    );
    checkInfo.cb(fatal);
    throw fatal;
  }

  throw new RuntimeFatalError(message);
}

/**
 * Create checkInfo object if enabled.
 *
 * @param {Function} cb - Callback for error reporting
 * @param {Object} runtime - Runtime object
 * @param {number} lineno - Line number
 * @param {number} colno - Column number
 * @param {string} errorContextString - Error context string
 * @param {Object} context - Context object
 * @returns {Object|null} checkInfo object or null if disabled
 */
function createCheckInfo(cb, runtime, lineno, colno, errorContextString, context) {
  if (!ENABLE_CHECKINFO) {
    return null;
  }

  return { cb, runtime, lineno, colno, errorContextString, context };
}

module.exports = {
  ENABLE_WRITECOUNTER_CHECK,
  ENABLE_CHECKINFO,
  checkPendingWrites,
  checkWriteCounterExists,
  checkWriteCounterNegative,
  createCheckInfo
};
