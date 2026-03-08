
const { getOutput } = require('./output');

function init(cb = null) {
  const guardState = {
    sequenceErrors: [],
    detectionPromises: [],
    fatalCb: cb
  };

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

async function finalizeGuard(guardState, buffer, allowedHandlers, outputGuardState) {
  const bufferErrors = await collectOutputErrors(buffer, allowedHandlers);
  const sequenceErrors = [];
  if (guardState) {
    if (guardState.detectionPromises && guardState.detectionPromises.length > 0) {
      await Promise.all(guardState.detectionPromises);
    }
    if (guardState.sequenceErrors && guardState.sequenceErrors.length > 0) {
      sequenceErrors.push(...guardState.sequenceErrors);
    }
  }
  const guardErrors = bufferErrors.concat(sequenceErrors);

  if (outputGuardState && guardErrors.length === 0) {
    const commitErrors = await settleSequenceTransactions(outputGuardState, 'commit');
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
    return guardErrors;
  }

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

function repairSequenceOutputs(buffer, guardState, lockNames) {
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
  repairSequenceOutputs,
  restoreOutputs
};

function reportAndThrow(cb, err) {
  const normalized = err instanceof Error ? err : new Error(String(err));
  if (typeof cb === 'function') {
    cb(normalized);
  }
  throw normalized;
}
