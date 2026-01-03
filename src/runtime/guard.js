
const { isError } = require('./errors');

const DEBUG_GUARD = typeof process !== 'undefined' &&
  process.env &&
  process.env.GUARD_DEBUG;

function init(frame, varNames) {
  const guardState = {
    names: varNames ? varNames.slice() : [],
    snapshot: {},
    sequenceErrors: [],
    detectionPromises: []
  };

  if (varNames && varNames.length > 0) {
    if (!frame || !frame.asyncVars) {
      throw new Error('Guard variables require async frame snapshots to be enabled');
    }

    for (const name of varNames) {
      if (!(name in frame.asyncVars)) {
        throw new Error(`Guard variable "${name}" not found in async snapshot`);
      }
      // Simple assignment as requested, no cloning
      guardState.snapshot[name] = frame.asyncVars[name];
    }
  }

  return guardState;
}

async function variablesHavePoison(frame, guardState) {
  if (!guardState) {
    return false;
  }

  if (!frame || !frame.asyncVars) {
    throw new Error('Guard poison detection requires async frame variables');
  }

  // Wait for all sequence lock repair/detection operations to complete
  if (guardState.detectionPromises && guardState.detectionPromises.length > 0) {
    await Promise.all(guardState.detectionPromises);
  }

  const allErrors = [];

  // Check for any detected sequence errors
  if (guardState.sequenceErrors && guardState.sequenceErrors.length > 0) {
    allErrors.push(...guardState.sequenceErrors);
  }

  // Check guarded variables for poison
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
        allErrors.push(...val.errors);
      } else {
        allErrors.push(val);
      }
    }
  }

  // Check monitored sequence locks for new poison (generated inside the block)
  if (guardState.monitoredLocks) {
    for (const lockName of guardState.monitoredLocks) {
      const lockVal = frame.lookup(lockName);
      if (await isError(lockVal)) {
        if (lockVal && lockVal.errors && lockVal.errors.length > 0) {
          allErrors.push(...lockVal.errors);
        } else {
          allErrors.push(lockVal);
        }
      }
    }
  }

  return allErrors;
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

function repairSequenceLocks(frame, guardState, lockNames) {
  if (!Array.isArray(lockNames) || lockNames.length === 0) {
    return;
  }

  if (DEBUG_GUARD) {
    // eslint-disable-next-line no-console
    console.log('[guard-debug] repairing sequence locks', lockNames);
  }

  for (const lockName of lockNames) {
    // We need to:
    // 1. Detect if the *previous* operation on this lock failed (poison detection)
    // 2. Unconditionally repair the lock for future operations

    // Get the current lock state (Promise, value, or poison)
    const currentLockState = frame.lookup(lockName);

    // Create a wrapper promise that will serve both purposes
    const detectionAndRepairPromise = (async () => {
      try {
        // Await the previous lock state to see if it failed
        if (currentLockState && typeof currentLockState.then === 'function') {
          try {
            const result = await currentLockState;
            // console.error('Guard Debug: lock awaited', lockName, result, await isError(result));
            if (await isError(result)) {
              guardState.sequenceErrors.push(result);
            }
          } catch (e) {
            // Rejection implies failure/poison
            guardState.sequenceErrors.push(e);
          }
        } else if (await isError(currentLockState)) {
          // Synchronous poison value
          // console.error('Guard Debug: lock synchronous poison', lockName, currentLockState);
          guardState.sequenceErrors.push(currentLockState);
        } else {
          // console.error('Guard Debug: lock state OK', lockName, currentLockState);
        }
      } catch (e) {
        // Should not typically happen during inspection, but catch just in case
        guardState.sequenceErrors.push(e);
      }
      // Always resolve to true (repair success)
      return true;
    })();

    // Initialize/reset detection collection if missing (e.g. if init wasn't called properly, though it should be)
    if (!guardState.detectionPromises) {
      guardState.detectionPromises = [];
    }
    if (!guardState.sequenceErrors) {
      guardState.sequenceErrors = [];
    }

    // Track this operation so variablesHavePoison can wait for it
    guardState.detectionPromises.push(detectionAndRepairPromise);

    // Update the frame so subsequent operations wait for our repair/wrapper
    frame.set(lockName, detectionAndRepairPromise, true);
  }

  // Store lock names to check for new poison at the end of the block
  if (!guardState.monitoredLocks) {
    guardState.monitoredLocks = [];
  }
  for (const lockName of lockNames) {
    if (!guardState.monitoredLocks.includes(lockName)) {
      guardState.monitoredLocks.push(lockName);
    }
  }
}


// Helper to normalize poison values to PoisonError for the recover block
function normalizeError(val) {
  const { PoisonError, isPoison } = require('./errors');
  if (isPoison(val)) {
    return new PoisonError(val.errors);
  }
  // If it's already an error (or PoisonError), return it
  return val;
}

module.exports = {
  init,
  variablesHavePoison,
  complete,
  repairSequenceLocks,
  normalizeError
};
