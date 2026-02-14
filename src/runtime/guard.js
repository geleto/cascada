
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
    sequenceHandlers: [],
    sequenceTransactions: [],
    clearHandlers: []
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
      state.sequenceHandlers.push(handlerName);
      continue;
    }
    if (bufferScopedOnly) {
      continue;
    }
    if (typeof output._captureGuardState !== 'function') {
      continue;
    }
    state.snapshots[handlerName] = output._captureGuardState();
  }

  return state;
}

function restoreOutputs(buffer, outputGuardState) {
  if (!outputGuardState || !buffer) {
    return;
  }

  if (Array.isArray(outputGuardState.clearHandlers) && outputGuardState.clearHandlers.length > 0) {
    clearBuffer(buffer, outputGuardState.clearHandlers);
    return;
  }

  const snapshotNames = Object.keys(outputGuardState.snapshots || {});
  const handlersToClear = snapshotNames.slice();
  if (Array.isArray(outputGuardState.sinkHandlers) && outputGuardState.sinkHandlers.length > 0) {
    handlersToClear.push(...outputGuardState.sinkHandlers);
  }
  if (Array.isArray(outputGuardState.sequenceHandlers) && outputGuardState.sequenceHandlers.length > 0) {
    handlersToClear.push(...outputGuardState.sequenceHandlers);
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
}

function shouldPauseBuffer(outputGuardState) {
  if (!outputGuardState) {
    return false;
  }
  if (Array.isArray(outputGuardState.clearHandlers) && outputGuardState.clearHandlers.length > 0) {
    return true;
  }
  if (Array.isArray(outputGuardState.sinkHandlers) && outputGuardState.sinkHandlers.length > 0) {
    return true;
  }
  const snapshotNames = Object.keys(outputGuardState.snapshots || {});
  return snapshotNames.length > 0;
}

async function beginOutputTransactions(frame, outputGuardState) {
  if (!outputGuardState || !Array.isArray(outputGuardState.sequenceHandlers) || outputGuardState.sequenceHandlers.length === 0) {
    return;
  }

  outputGuardState.sequenceTransactions = [];

  for (const handlerName of outputGuardState.sequenceHandlers) {
    const output = getOutputHandler(frame, handlerName);
    if (!output || output._outputType !== 'sequence' || typeof output._ensureSinkResolved !== 'function') {
      continue;
    }
    const sequence = await output._ensureSinkResolved();
    if (!sequence ||
      typeof sequence.begin !== 'function' ||
      typeof sequence.commit !== 'function' ||
      typeof sequence.rollback !== 'function') {
      continue;
    }
    const token = await sequence.begin();
    outputGuardState.sequenceTransactions.push({ sequence, token });
  }
}

async function commitOutputTransactions(outputGuardState, errors = null) {
  if (!outputGuardState || !Array.isArray(outputGuardState.sequenceTransactions)) {
    return;
  }

  for (let i = outputGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = outputGuardState.sequenceTransactions[i];
    if (!tx || !tx.sequence || typeof tx.sequence.commit !== 'function') {
      continue;
    }
    try {
      if (tx.token === undefined) {
        await tx.sequence.commit();
      } else {
        await tx.sequence.commit(tx.token);
      }
    } catch (err) {
      if (Array.isArray(errors)) {
        errors.push(err);
      } else {
        throw err;
      }
    }
  }
  outputGuardState.sequenceTransactions = [];
}

async function rollbackOutputTransactions(outputGuardState, errors = null) {
  if (!outputGuardState || !Array.isArray(outputGuardState.sequenceTransactions)) {
    return;
  }

  for (let i = outputGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = outputGuardState.sequenceTransactions[i];
    if (!tx || !tx.sequence || typeof tx.sequence.rollback !== 'function') {
      continue;
    }
    try {
      if (tx.token === undefined) {
        await tx.sequence.rollback();
      } else {
        await tx.sequence.rollback(tx.token);
      }
    } catch (err) {
      if (Array.isArray(errors)) {
        errors.push(err);
      } else {
        throw err;
      }
    }
  }
  outputGuardState.sequenceTransactions = [];
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

module.exports = {
  init,
  initOutputSnapshots,
  getErrors,
  complete,
  repairSequenceLocks,
  restoreOutputs,
  shouldPauseBuffer,
  beginOutputTransactions,
  commitOutputTransactions,
  rollbackOutputTransactions
};

