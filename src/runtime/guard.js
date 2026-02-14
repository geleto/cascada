
const { isError } = require('./errors');
const { getPosonedBufferErrors } = require('./command-buffer');
const { getOutputHandler } = require('./output');
const { SetTargetCommand } = require('./commands');
const { clearBuffer } = require('./command-buffer');

const DEBUG_GUARD = typeof process !== 'undefined' &&
  process.env &&
  process.env.GUARD_DEBUG;

function init(frame, varNames) {
  const guardState = {
    names: varNames === '*' ? '*' : (varNames ? varNames.slice() : []),
    snapshot: {},
    sequenceErrors: [],
    detectionPromises: []
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

function initOutputSnapshots(frame, handlerNames = null) {
  const state = {
    snapshots: Object.create(null),
    sinkHandlers: [],
    clearHandlers: [],
    sequenceTransactions: [],
    sequenceErrors: []
  };

  const targets = handlerNames ?? [];
  const outputBuffer = frame && frame._outputBuffer;
  const bufferScopedOnly = !!(
    outputBuffer &&
    outputBuffer.parent &&
    typeof outputBuffer.parent.isPaused === 'function' &&
    outputBuffer.parent.isPaused()
  );

  if (bufferScopedOnly) {
    state.clearHandlers = targets.slice();
    return state;
  }

  for (const handlerName of targets) {
    const output = getOutputHandler(frame, handlerName);
    if (!output) {
      continue;
    }
    if (output._outputType === 'sink') {
      state.sinkHandlers.push(handlerName);
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
    if (typeof output._captureGuardState !== 'function') {
      continue;
    }
    state.snapshots[handlerName] = output._captureGuardState();
  }

  return state;
}

async function restoreOutputs(buffer, outputGuardState) {
  if (!outputGuardState || !buffer) {
    return [];
  }

  if (Array.isArray(outputGuardState.clearHandlers) && outputGuardState.clearHandlers.length > 0) {
    clearBuffer(buffer, outputGuardState.clearHandlers);
    return settleSequenceTransactions(outputGuardState, 'rollback');
  }

  const snapshotNames = Object.keys(outputGuardState.snapshots || {});
  const handlersToClear = snapshotNames.slice();
  if (Array.isArray(outputGuardState.sinkHandlers) && outputGuardState.sinkHandlers.length > 0) {
    handlersToClear.push(...outputGuardState.sinkHandlers);
  }
  if (handlersToClear.length > 0) {
    clearBuffer(buffer, handlersToClear);
  }

  for (const handlerName of snapshotNames) {
    buffer.add(new SetTargetCommand({
      handler: handlerName,
      target: outputGuardState.snapshots[handlerName],
      pos: { lineno: 0, colno: 0 }
    }), handlerName);
  }
  return settleSequenceTransactions(outputGuardState, 'rollback');
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
  const bufferErrors = getPosonedBufferErrors(bufferArr, allowedHandlers) || [];
  const { variableErrors, sequenceErrors } = await collectGuardVariableErrors(frame, guardState);
  return bufferErrors.concat(variableErrors, sequenceErrors);
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

async function settleSequenceTransactions(outputGuardState, mode) {
  const errors = [];
  if (!outputGuardState || !Array.isArray(outputGuardState.sequenceTransactions)) {
    return errors;
  }

  if (Array.isArray(outputGuardState.sequenceErrors) && outputGuardState.sequenceErrors.length > 0) {
    errors.push(...outputGuardState.sequenceErrors);
    outputGuardState.sequenceErrors.length = 0;
  }

  for (let i = outputGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = outputGuardState.sequenceTransactions[i];
    if (!tx || !tx.output) {
      continue;
    }
    try {
      if (tx.beginPromise) {
        await tx.beginPromise;
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
  getErrors,
  complete,
  repairSequenceLocks,
  restoreOutputs,
  commitOutputTransactions
};