function init(cb = null) {
  const guardState = {
    sequenceErrors: [],
    detectionPromises: [],
    fatalCb: cb
  };

  return guardState;
}

function initChannelSnapshots(channelNames = null, buffer = null, cb = null) {
  const state = {
    snapshots: Object.create(null),
    sequenceTransactions: [],
    sequentialPathChannels: [],
    sequenceErrors: [],
    setupPromises: [],
    fatalCb: cb
  };

  const targets = channelNames ?? [];

  for (const channelName of targets) {
    const channel = buffer.findChannel(channelName);
    if (!channel) {
      continue;
    }
    const channelType = channel._channelType;
    if (channelType === 'sequence') {
      const tx = { channelName, channel, active: false, token: undefined, beginPromise: null };
      if (typeof channel.beginTransaction === 'function') {
        try {
          tx.beginPromise = Promise.resolve(channel.beginTransaction()).then((result) => {
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
    if (channelType === 'sequential_path') {
      state.sequentialPathChannels.push(channelName);
      continue;
    }
    const capturePromise = buffer.addCaptureGuardState(channelName, { lineno: 0, colno: 0 })
      .then((capturedState) => {
        state.snapshots[channelName] = capturedState;
      });
    state.setupPromises.push(capturePromise);
  }

  return state;
}

async function restoreChannels(buffer, channelGuardState) {
  if (!channelGuardState || !buffer) {
    return [];
  }

  const errors = [];

  const snapshotNames = Object.keys(channelGuardState.snapshots || {});
  if (snapshotNames.length > 0) {
    const restorePromises = snapshotNames.map((channelName) =>
      buffer.addRestoreGuardState(
        channelName,
        channelGuardState.snapshots[channelName],
        { lineno: 0, colno: 0 }
      ).catch((err) => reportAndThrow(channelGuardState.fatalCb, err))
    );
    await Promise.all(restorePromises);
  }

  const sequentialPathChannels = Array.isArray(channelGuardState.sequentialPathChannels)
    ? channelGuardState.sequentialPathChannels
    : [];
  if (sequentialPathChannels.length > 0) {
    const repairPromises = sequentialPathChannels.map((channelName) =>
      buffer.addSequentialPathWrite(
        channelName,
        () => true,
        { lineno: 0, colno: 0 },
        true
      ).catch((err) => reportAndThrow(channelGuardState.fatalCb, err))
    );
    await Promise.all(repairPromises);
  }

  const txErrors = await settleSequenceTransactions(channelGuardState, 'rollback');
  if (txErrors.length > 0) {
    errors.push(...txErrors);
  }
  return errors;
}

async function finalizeGuard(guardState, buffer, allowedChannels, channelGuardState) {
  const bufferErrors = await collectChannelErrors(buffer, allowedChannels);
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

  if (channelGuardState && guardErrors.length === 0) {
    const commitErrors = await settleSequenceTransactions(channelGuardState, 'commit');
    if (commitErrors.length > 0) {
      guardErrors.push(...commitErrors);
    }
  }

  if (guardErrors.length > 0) {
    if (channelGuardState) {
      const rollbackErrors = await restoreChannels(buffer, channelGuardState);
      if (rollbackErrors.length > 0) {
        guardErrors.push(...rollbackErrors);
      }
    }
    return guardErrors;
  }

  return guardErrors;
}

async function collectChannelErrors(buffer, allowedChannels) {

  const names = resolveGuardChannelNames(buffer, allowedChannels);
  const allErrors = [];

  for (const channelName of names) {
    const channelError = await buffer.addGetError(channelName, { lineno: 0, colno: 0 });
    if (!channelError) {
      continue;
    }
    if (Array.isArray(channelError.errors) && channelError.errors.length > 0) {
      allErrors.push(...channelError.errors);
      continue;
    }
    allErrors.push(channelError);
  }

  return allErrors;
}

function resolveGuardChannelNames(buffer, allowedChannels) {
  if (Array.isArray(allowedChannels)) {
    if (allowedChannels.length === 0) {
      return [];
    }
    return Array.from(new Set(allowedChannels));
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
      .then((channelError) => {
        if (!channelError) {
          return true;
        }
        if (Array.isArray(channelError.errors) && channelError.errors.length > 0) {
          guardState.sequenceErrors.push(...channelError.errors);
        } else {
          guardState.sequenceErrors.push(channelError);
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

async function settleSequenceTransactions(channelGuardState, mode) {
  const errors = [];
  if (!channelGuardState || !Array.isArray(channelGuardState.sequenceTransactions)) {
    return errors;
  }

  if (Array.isArray(channelGuardState.setupPromises) && channelGuardState.setupPromises.length > 0) {
    const settledSetup = await Promise.allSettled(channelGuardState.setupPromises);
    const failedSetup = settledSetup.find((result) => result && result.status === 'rejected');
    if (failedSetup) {
      const setupErr = failedSetup.reason instanceof Error
        ? failedSetup.reason
        : new Error(String(failedSetup.reason));
      reportAndThrow(channelGuardState.fatalCb, setupErr);
    }
  }

  if (Array.isArray(channelGuardState.sequenceErrors) && channelGuardState.sequenceErrors.length > 0) {
    errors.push(...channelGuardState.sequenceErrors);
    channelGuardState.sequenceErrors.length = 0;
  }

  for (let i = channelGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = channelGuardState.sequenceTransactions[i];
    try {
      if (tx.beginPromise) {
        await tx.beginPromise;
      }
      if (!tx || !tx.channel) {
        continue;
      }
      if (!tx.active) {
        continue;
      }
      const fn = mode === 'commit' ? tx.channel.commitTransaction : tx.channel.rollbackTransaction;
      if (typeof fn !== 'function') {
        continue;
      }
      await Promise.resolve(fn.call(tx.channel, tx));
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

export { init, initChannelSnapshots, finalizeGuard, repairSequenceOutputs, restoreChannels };

function reportAndThrow(cb, err) {
  const normalized = err instanceof Error ? err : new Error(String(err));
  if (typeof cb === 'function') {
    cb(normalized);
  }
  throw normalized;
}
