'use strict';

const { isError } = require('./errors');
const { withSequenceLock } = require('./sequential');

const DEBUG_GUARD = typeof process !== 'undefined' &&
  process.env &&
  process.env.GUARD_DEBUG;

function init(frame, varNames) {
  if (!Array.isArray(varNames) || varNames.length === 0) {
    return null;
  }

  if (!frame || !frame.asyncVars) {
    throw new Error('Guard variables require async frame snapshots to be enabled');
  }

  const snapshot = {};
  for (const name of varNames) {
    if (!(name in frame.asyncVars)) {
      throw new Error(`Guard variable "${name}" not found in async snapshot`);
    }
    // Simple assignment as requested, no cloning
    snapshot[name] = frame.asyncVars[name];
  }

  return { names: varNames.slice(), snapshot };
}

async function variablesHavePoison(frame, guardState) {
  if (!guardState) {
    return false;
  }

  if (!frame || !frame.asyncVars) {
    throw new Error('Guard poison detection requires async frame variables');
  }

  for (const name of guardState.names) {
    if (!(name in frame.asyncVars)) {
      throw new Error(`Guard variable "${name}" missing from async frame`);
    }
    if (DEBUG_GUARD) {
      // eslint-disable-next-line no-console
      console.log('[guard-debug] checking', name, frame.asyncVars[name]);
    }

    if (await isError(frame.asyncVars[name])) {
      const val = frame.asyncVars[name];
      if (val && val.errors && val.errors.length > 0) {
        return val.errors[0];
      }
      return val;
    }
  }
  return false;
}

function complete(frame, guardState, shouldRevert) {
  if (!guardState) {
    return;
  }

  if (!frame || !frame.asyncVars) {
    throw new Error('Guard completion requires async frame variables');
  }

  for (const name of guardState.names) {
    if (!(name in frame.asyncVars)) {
      throw new Error(`Guard variable "${name}" missing from async frame`);
    }
    if (shouldRevert) {
      frame.asyncVars[name] = guardState.snapshot[name];
    }
    frame._countdownAndResolveAsyncWrites(name, 1);
  }
}

function repairSequenceLocks(frame, lockNames) {
  if (!Array.isArray(lockNames) || lockNames.length === 0) {
    return;
  }

  if (DEBUG_GUARD) {
    // eslint-disable-next-line no-console
    console.log('[guard-debug] repairing sequence locks', lockNames);
  }

  for (const lockName of lockNames) {
    // Unconditional fire-and-forget repair. We don't await this because we want it to
    // be appended to the sequence immediately.
    // The operation () => true ensures the lock resolves to a success value (true)
    // repair: true suppresses any previous error on the lock
    withSequenceLock(frame, lockName, () => true, null, true);
  }
}

module.exports = {
  init,
  variablesHavePoison,
  complete,
  repairSequenceLocks
};
