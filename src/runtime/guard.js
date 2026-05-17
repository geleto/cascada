// @todo - this is temporary implementation
// use the dropped AST-lowering guard implementation as a reference
// for a more robust compiler-only implementation

import {
  CaptureGuardStateCommand,
  RestoreGuardStateCommand,
  GetErrorCommand,
} from './chains/observation.js';
import {
  RepairWriteCommand,
} from './chains/sequential-path.js';

function init(cb = null) {
  const guardState = {
    sequenceErrors: [],
    detectionPromises: [],
    fatalCb: cb
  };

  return guardState;
}

function initChainSnapshots(chainNames = null, buffer = null, cb = null) {
  const state = {
    snapshots: Object.create(null),
    sequenceTransactions: [],
    sequentialPathChains: [],
    sequenceErrors: [],
    setupPromises: [],
    fatalCb: cb
  };

  const targets = chainNames ?? [];

  for (const chainName of targets) {
    const chain = buffer.getChainIfExists(chainName);
    if (!chain) {
      continue;
    }
    const chainType = chain._chainType;
    if (chainType === 'sequence') {
      const tx = { chainName, chain, active: false, token: undefined, beginPromise: null };
      if (typeof chain.beginTransaction === 'function') {
        try {
          tx.beginPromise = Promise.resolve(chain.beginTransaction()).then((result) => {
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
    if (chainType === 'sequential_path') {
      state.sequentialPathChains.push(chainName);
      continue;
    }
    const capturePromise = buffer.addCommand(new CaptureGuardStateCommand({
      chainName,
      pos: { lineno: 0, colno: 0 }
    }), chainName)
      .then((capturedState) => {
        state.snapshots[chainName] = capturedState;
      });
    state.setupPromises.push(capturePromise);
  }

  return state;
}

async function restoreChains(buffer, chainGuardState) {
  if (!chainGuardState || !buffer) {
    return [];
  }

  const errors = [];

  const snapshotNames = Object.keys(chainGuardState.snapshots || {});
  if (snapshotNames.length > 0) {
    const restorePromises = snapshotNames.map((chainName) =>
      buffer.addCommand(new RestoreGuardStateCommand({
        chainName,
        target: chainGuardState.snapshots[chainName],
        pos: { lineno: 0, colno: 0 }
      }), chainName).catch((err) => reportAndThrow(chainGuardState.fatalCb, err))
    );
    await Promise.all(restorePromises);
  }

  const sequentialPathChains = Array.isArray(chainGuardState.sequentialPathChains)
    ? chainGuardState.sequentialPathChains
    : [];
  if (sequentialPathChains.length > 0) {
    const repairPromises = sequentialPathChains.map((chainName) =>
      buffer.addCommand(new RepairWriteCommand({
        chainName,
        pathKey: chainName,
        operation: () => true,
        pos: { lineno: 0, colno: 0 }
      }), chainName).catch((err) => reportAndThrow(chainGuardState.fatalCb, err))
    );
    await Promise.all(repairPromises);
  }

  const txErrors = await settleSequenceTransactions(chainGuardState, 'rollback');
  if (txErrors.length > 0) {
    errors.push(...txErrors);
  }
  return errors;
}

async function finalizeGuard(guardState, buffer, allowedChains, chainGuardState) {
  const bufferErrors = await collectChainErrors(buffer, allowedChains);
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

  if (chainGuardState && guardErrors.length === 0) {
    const commitErrors = await settleSequenceTransactions(chainGuardState, 'commit');
    if (commitErrors.length > 0) {
      guardErrors.push(...commitErrors);
    }
  }

  if (guardErrors.length > 0) {
    if (chainGuardState) {
      const rollbackErrors = await restoreChains(buffer, chainGuardState);
      if (rollbackErrors.length > 0) {
        guardErrors.push(...rollbackErrors);
      }
    }
    return guardErrors;
  }

  return guardErrors;
}

async function collectChainErrors(buffer, allowedChains) {

  const names = resolveGuardChainNames(buffer, allowedChains);
  const allErrors = [];

  for (const chainName of names) {
    const chainError = await buffer.addCommand(new GetErrorCommand({
      chainName,
      pos: { lineno: 0, colno: 0 }
    }), chainName);
    if (!chainError) {
      continue;
    }
    if (Array.isArray(chainError.errors) && chainError.errors.length > 0) {
      allErrors.push(...chainError.errors);
      continue;
    }
    allErrors.push(chainError);
  }

  return allErrors;
}

function resolveGuardChainNames(buffer, allowedChains) {
  if (Array.isArray(allowedChains)) {
    if (allowedChains.length === 0) {
      return [];
    }
    return Array.from(new Set(allowedChains));
  }
  return Object.keys(buffer.arrays || Object.create(null));
}

function repairSequenceChains(buffer, guardState, lockNames) {
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
    const detectPromise = buffer.addCommand(new GetErrorCommand({
      chainName: lockName,
      pos: { lineno: 0, colno: 0 }
    }), lockName)
      .then((chainError) => {
        if (!chainError) {
          return true;
        }
        if (Array.isArray(chainError.errors) && chainError.errors.length > 0) {
          guardState.sequenceErrors.push(...chainError.errors);
        } else {
          guardState.sequenceErrors.push(chainError);
        }
        return true;
      })
      .catch((err) => reportAndThrow(guardState.fatalCb, err));

    const repairPromise = buffer.addCommand(new RepairWriteCommand({
      chainName: lockName,
      pathKey: lockName,
      // Repair is unconditional: clear poison and publish a healthy lock state.
      operation: () => true,
      pos: { lineno: 0, colno: 0 }
    }), lockName).catch((err) => reportAndThrow(guardState.fatalCb, err));

    guardState.detectionPromises.push(Promise.all([detectPromise, repairPromise]).then(() => true));
  }
}

async function settleSequenceTransactions(chainGuardState, mode) {
  const errors = [];
  if (!chainGuardState || !Array.isArray(chainGuardState.sequenceTransactions)) {
    return errors;
  }

  if (Array.isArray(chainGuardState.setupPromises) && chainGuardState.setupPromises.length > 0) {
    const settledSetup = await Promise.allSettled(chainGuardState.setupPromises);
    const failedSetup = settledSetup.find((result) => result && result.status === 'rejected');
    if (failedSetup) {
      const setupErr = failedSetup.reason instanceof Error
        ? failedSetup.reason
        : new Error(String(failedSetup.reason));
      reportAndThrow(chainGuardState.fatalCb, setupErr);
    }
  }

  if (Array.isArray(chainGuardState.sequenceErrors) && chainGuardState.sequenceErrors.length > 0) {
    errors.push(...chainGuardState.sequenceErrors);
    chainGuardState.sequenceErrors.length = 0;
  }

  for (let i = chainGuardState.sequenceTransactions.length - 1; i >= 0; i--) {
    const tx = chainGuardState.sequenceTransactions[i];
    try {
      if (tx.beginPromise) {
        await tx.beginPromise;
      }
      if (!tx || !tx.chain) {
        continue;
      }
      if (!tx.active) {
        continue;
      }
      const fn = mode === 'commit' ? tx.chain.commitTransaction : tx.chain.rollbackTransaction;
      if (typeof fn !== 'function') {
        continue;
      }
      await Promise.resolve(fn.call(tx.chain, tx));
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}

export { init, initChainSnapshots, finalizeGuard, repairSequenceChains, restoreChains };

function reportAndThrow(cb, err) {
  const normalized = err instanceof Error ? err : new Error(String(err));
  if (typeof cb === 'function') {
    cb(normalized);
  }
  throw normalized;
}
