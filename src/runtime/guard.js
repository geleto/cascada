
const { isError } = require('./errors');
const { getOutput } = require('./output');

const DEBUG_GUARD = typeof process !== 'undefined' &&
  process.env &&
  process.env.GUARD_DEBUG;

function init(frame, varNames, cb = null) {
  const guardState = {
    names: varNames === '*' ? '*' : (varNames ? varNames.slice() : []),
    snapshot: {},
    sequenceErrors: [],
    detectionPromises: [],
    fatalCb: cb
  };

  if (varNames && varNames !== '*' && varNames.length > 0) {
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

function initOutputSnapshots(frame, handlerNames = null, buffer = null, cb = null) {
  const state = {
    snapshots: Object.create(null),
    sequenceTransactions: [],
    sequentialPathHandlers: [],
    sequenceErrors: [],
    setupPromises: [],
    fatalCb: cb
  };

  const targets = handlerNames ?? [];

  for (const handlerName of targets) {
    const output = getOutput(frame, handlerName);
    if (!output) {
      continue;
    }
    if (output._outputType === 'sequence') {
      const tx = { handlerName, output, active: false, token: undefined, beginPromise: null };
      if (typeof output.beginTransaction === 'function') {
        try {
          tx.beginPromise = Promise.resolve(output.beginTransaction()).then((result) => {
            if (result && result.active) {
              tx.active = true;
              tx.token = result.token;
            }
          }, (err) => {
            state.sequenceErrors.push(err);
          });
        } catch (err) {
          state.sequenceErrors.push(err);
        }
      }
      state.sequenceTransactions.push(tx);
      continue;
    }
    if (output._outputType === 'sequential_path') {
      state.sequentialPathHandlers.push(handlerName);
      continue;
    }
    const capturePromise = buffer.addCaptureGuardState(handlerName, { lineno: 0, colno: 0 })
      .then((capturedState) => {
        state.snapshots[handlerName] = capturedState;
      });
    state.setupPromises.push(capturePromise);
  }

  return state;
}

async function restoreOutputs(buffer, outputGuardState) {
  if (!outputGuardState || !buffer) {
    return [];
  }

  const errors = [];

  const snapshotNames = Object.keys(outputGuardState.snapshots || {});
  if (snapshotNames.length > 0) {
    const restorePromises = snapshotNames.map((handlerName) =>
      buffer.addRestoreGuardState(
        handlerName,
        outputGuardState.snapshots[handlerName],
        { lineno: 0, colno: 0 }
      ).catch((err) => reportAndThrow(outputGuardState.fatalCb, err))
    );
    await Promise.all(restorePromises);
  }

  const sequentialPathHandlers = Array.isArray(outputGuardState.sequentialPathHandlers)
    ? outputGuardState.sequentialPathHandlers
    : [];
  if (sequentialPathHandlers.length > 0) {
    const repairPromises = sequentialPathHandlers.map((handlerName) =>
      buffer.addSequentialPathWrite(
        handlerName,
        () => true,
        { lineno: 0, colno: 0 },
        true
      ).catch((err) => reportAndThrow(outputGuardState.fatalCb, err))
    );
    await Promise.all(repairPromises);
  }

  const txErrors = await settleSequenceTransactions(outputGuardState, 'rollback');
  if (txErrors.length > 0) {
    errors.push(...txErrors);
  }
  return errors;
}

async function commitOutputTransactions(outputGuardState) {
  if (!outputGuardState) {
    return [];
  }
  return settleSequenceTransactions(outputGuardState, 'commit');
}

async function collectGuardVariableErrors(frame, guardState) {
  const variableErrors = [];
  const sequenceErrors = [];

  if (!guardState) {
    return { variableErrors, sequenceErrors };
  }

  const hasVariableNames = guardState.names === '*' ? true : (guardState.names.length > 0);
  if (hasVariableNames) {
    if (!frame || !frame.asyncVars) {
      throw new Error('Guard poison detection requires async frame variables');
    }
  }

  // Wait for all sequence lock repair/detection operations to complete
  if (guardState.detectionPromises && guardState.detectionPromises.length > 0) {
    await Promise.all(guardState.detectionPromises);
  }

  // Check for any detected sequence errors
  if (guardState.sequenceErrors && guardState.sequenceErrors.length > 0) {
    sequenceErrors.push(...guardState.sequenceErrors);
  }

  // Check guarded variables for poison
  if (guardState.names === '*') {
    if (!frame || !frame.asyncVars) {
      throw new Error('Guard completion requires async frame variables');
    }
    for (const name of Object.keys(frame.asyncVars)) {
      if (guardState.ignoredNames && guardState.ignoredNames.has(name)) {
        continue;
      }
      if (guardState.skipVariablesUntil && guardState.skipVariablesUntil.has(name)) {
        continue;
      }
    }
  }
  for (const name of guardState.names === '*' ? Object.keys(frame.asyncVars) : guardState.names) {
    if (!(name in frame.asyncVars)) {
      throw new Error(`Guard variable "${name}" missing from async frame`);
    }
    if (DEBUG_GUARD) {
      // eslint-disable-next-line no-console
      console.log('[guard-debug] checking', name, frame.asyncVars[name]);
    }

    const currentValue = frame.asyncVars[name];
    if (await isError(currentValue)) {
      if (currentValue && currentValue.errors && currentValue.errors.length > 0) {
        variableErrors.push(...currentValue.errors);
      } else {
        variableErrors.push(currentValue);
      }
    }
  }

  // Check monitored sequence locks for new poison (generated inside the block)
  if (guardState.monitoredLocks) {
    for (const lockName of guardState.monitoredLocks) {
      const lockVal = frame.lookup(lockName);
      if (await isError(lockVal)) {
        if (lockVal && lockVal.errors && lockVal.errors.length > 0) {
          sequenceErrors.push(...lockVal.errors);
        } else {
          sequenceErrors.push(lockVal);
        }
      }
    }
  }

  return { variableErrors, sequenceErrors };
}

async function getErrors(frame, guardState, bufferArr, allowedHandlers) {
  const bufferErrors = await collectOutputErrors(bufferArr, allowedHandlers);
  const { variableErrors, sequenceErrors } = await collectGuardVariableErrors(frame, guardState);
  return bufferErrors.concat(variableErrors, sequenceErrors);
}

async function finalizeGuard(frame, guardState, buffer, allowedHandlers, outputGuardState) {
  const guardErrors = await getErrors(frame, guardState, buffer, allowedHandlers);

  if (outputGuardState && guardErrors.length === 0) {
    const commitErrors = await commitOutputTransactions(outputGuardState);
    if (commitErrors.length > 0) {
      guardErrors.push(...commitErrors);
    }
  }

  if (guardErrors.length > 0) {
    if (outputGuardState) {
      const rollbackErrors = await restoreOutputs(buffer, outputGuardState);
      if (rollbackErrors.length > 0) {
        guardErrors.push(...rollbackErrors);
      }
    }
    complete(frame, guardState, true);
    return guardErrors;
  }

  complete(frame, guardState, false);
  return guardErrors;
}

async function collectOutputErrors(buffer, allowedHandlers) {

  const names = resolveGuardOutputNames(buffer, allowedHandlers);
  const allErrors = [];

  for (const outputName of names) {
    const outputError = await buffer.addGetError(outputName, { lineno: 0, colno: 0 });
    if (!outputError) {
      continue;
    }
    if (Array.isArray(outputError.errors) && outputError.errors.length > 0) {
      allErrors.push(...outputError.errors);
      continue;
    }
    allErrors.push(outputError);
  }

  return allErrors;
}

function resolveGuardOutputNames(buffer, allowedHandlers) {
  if (Array.isArray(allowedHandlers)) {
    if (allowedHandlers.length === 0) {
      return [];
    }
    return Array.from(new Set(allowedHandlers));
  }
  return Object.keys(buffer.arrays || Object.create(null));
}

function complete(frame, guardState, shouldRevert) {
  if (!guardState) {
    return;
  }

  const hasVariableNames = guardState.names === '*' ? true : (guardState.names.length > 0);
  if (!hasVariableNames) {
    return;
  }

  if (!frame || !frame.asyncVars) {
    throw new Error('Guard completion requires async frame variables');
  }

  if (guardState.names === '*') {
    for (const name of Object.keys(frame.asyncVars)) {
      frame._countdownAndResolveAsyncWrites(name, 1);
    }
    return;
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

    // Track this operation so guard poison detection can wait for it
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

function repairSequenceOutputs(frame, buffer, guardState, lockNames) {
  if (!lockNames || lockNames.length === 0) {
    return;
  }

  if (!guardState.detectionPromises) {
    guardState.detectionPromises = [];
  }
  if (!guardState.sequenceErrors) {
    guardState.sequenceErrors = [];
  }

  for (const lockName of lockNames) {
    const detectPromise = buffer.addGetError(lockName, { lineno: 0, colno: 0 })
      .then((outputError) => {
        if (!outputError) {
          return true;
        }
        if (Array.isArray(outputError.errors) && outputError.errors.length > 0) {
          guardState.sequenceErrors.push(...outputError.errors);
        } else {
          guardState.sequenceErrors.push(outputError);
        }
        return true;
      })
      .catch((err) => reportAndThrow(guardState.fatalCb, err));

    const repairPromise = buffer.addSequentialPathWrite(
      lockName,
      // Repair is unconditional: clear poison and publish a healthy lock state.
      () => true,
      { lineno: 0, colno: 0 },
      true
    ).catch((err) => reportAndThrow(guardState.fatalCb, err));

    guardState.detectionPromises.push(Promise.all([detectPromise, repairPromise]).then(() => true));
  }
}

async function settleSequenceTransactions(outputGuardState, mode) {
  const errors = [];
  if (!outputGuardState || !Array.isArray(outputGuardState.sequenceTransactions)) {
    return errors;
  }

  if (Array.isArray(outputGuardState.setupPromises) && outputGuardState.setupPromises.length > 0) {
    const settledSetup = await Promise.allSettled(outputGuardState.setupPromises);
    const failedSetup = settledSetup.find((result) => result && result.status === 'rejected');
    if (failedSetup) {
      const setupErr = failedSetup.reason instanceof Error
        ? failedSetup.reason
        : new Error(String(failedSetup.reason));
      reportAndThrow(outputGuardState.fatalCb, setupErr);
    }
  }

  if (Array.isArray(outputGuardState.sequenceErrors) && outputGuardState.sequenceErrors.length > 0) {
    errors.push(...outputGuardState.sequenceErrors);
    outputGuardState.sequenceErrors.length = 0;
  }

  for (let i = outputGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = outputGuardState.sequenceTransactions[i];
    try {
      if (tx.beginPromise) {
        await tx.beginPromise;
      }
      if (!tx || !tx.output) {
        continue;
      }
      if (!tx.active) {
        continue;
      }
      const fn = mode === 'commit' ? tx.output.commitTransaction : tx.output.rollbackTransaction;
      if (typeof fn !== 'function') {
        continue;
      }
      await Promise.resolve(fn.call(tx.output, tx));
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

module.exports = {
  init,
  initOutputSnapshots,
  finalizeGuard,
  getErrors,
  complete,
  repairSequenceLocks,
  repairSequenceOutputs,
  restoreOutputs,
  commitOutputTransactions
};

function reportAndThrow(cb, err) {
  const normalized = err instanceof Error ? err : new Error(String(err));
  if (typeof cb === 'function') {
    cb(normalized);
  }
  throw normalized;
}
