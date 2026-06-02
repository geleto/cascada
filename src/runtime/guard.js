// @todo - this is temporary implementation
// use the dropped AST-lowering guard implementation as a reference
// for a more robust compiler-only implementation

import {
  CaptureGuardStateCommand,
  RestoreGuardStateCommand,
  GetErrorCommand,
} from './commands/observation.js';
import {
  RepairWriteCommand,
} from './commands/sequential-path.js';
import {requireCommandErrorContext} from './commands/base.js';
import {markPromiseHandled} from './errors.js';

function init(renderState = null, errorContext) {
  errorContext = requireCommandErrorContext(errorContext, 'guard.init');
  const guardState = {
    sequenceErrors: [],
    detectionPromises: [],
    renderState,
    errorContext
  };

  return guardState;
}

function initChainSnapshots(chainNames = null, buffer = null, renderState = null, errorContext) {
  errorContext = requireCommandErrorContext(errorContext, 'guard.initChainSnapshots');
  const state = {
    snapshots: Object.create(null),
    sequenceTransactions: [],
    sequentialPathChains: [],
    sequenceErrors: [],
    setupPromises: [],
    renderState,
    errorContext
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
      errorContext
    }), chainName)
      .then((capturedState) => {
        state.snapshots[chainName] = capturedState;
      });
    // The guard finalizer observes this later; suppress delayed internal rejection noise.
    markPromiseHandled(capturePromise);
    state.setupPromises.push(capturePromise);
  }

  return state;
}

async function restoreChains(buffer, chainGuardState, errorContext) {
  if (!chainGuardState || !buffer) {
    return [];
  }
  errorContext = requireCommandErrorContext(errorContext, 'guard.restoreChains');

  const errors = [];
  const snapshotNames = Object.keys(chainGuardState.snapshots || {});
  if (snapshotNames.length > 0) {
    const restorePromises = snapshotNames.map((chainName) =>
      buffer.addCommand(new RestoreGuardStateCommand({
        chainName,
        target: chainGuardState.snapshots[chainName],
        errorContext
      }), chainName).catch((err) => chainGuardState.renderState.reportAndThrowFatalError(err, errorContext))
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
        errorContext
      }), chainName).catch((err) => chainGuardState.renderState.reportAndThrowFatalError(err, errorContext))
    );
    await Promise.all(repairPromises);
  }

  const txErrors = await settleSequenceTransactions(chainGuardState, 'rollback');
  if (txErrors.length > 0) {
    errors.push(...txErrors);
  }
  return errors;
}

async function finalizeGuard(guardState, buffer, allowedChains, chainGuardState, errorContext) {
  errorContext = requireCommandErrorContext(errorContext, 'guard.finalizeGuard');
  const bufferErrors = await collectChainErrors(buffer, allowedChains, errorContext);
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
      const rollbackErrors = await restoreChains(buffer, chainGuardState, errorContext);
      if (rollbackErrors.length > 0) {
        guardErrors.push(...rollbackErrors);
      }
    }
    return guardErrors;
  }

  return guardErrors;
}

async function collectChainErrors(buffer, allowedChains, errorContext) {

  const names = resolveGuardChainNames(buffer, allowedChains);
  const allErrors = [];

  for (const chainName of names) {
    const chainError = await buffer.addCommand(new GetErrorCommand({
      chainName,
      errorContext
    }), chainName);
    if (!chainError) {
      continue;
    }
    if (chainError.errors) {
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

function repairSequenceChains(buffer, guardState, lockNames, errorContext) {
  if (!lockNames || lockNames.length === 0) {
    return;
  }
  errorContext = requireCommandErrorContext(errorContext, 'guard.repairSequenceChains');

  if (!guardState.detectionPromises) {
    guardState.detectionPromises = [];
  }
  if (!guardState.sequenceErrors) {
    guardState.sequenceErrors = [];
  }
  for (const lockName of lockNames) {
    const detectPromise = buffer.addCommand(new GetErrorCommand({
      chainName: lockName,
      errorContext
    }), lockName)
      .then((chainError) => {
        if (!chainError) {
          return true;
        }
        if (chainError.errors) {
          guardState.sequenceErrors.push(...chainError.errors);
        } else {
          guardState.sequenceErrors.push(chainError);
        }
        return true;
      })
      .catch((err) => guardState.renderState.reportAndThrowFatalError(err, errorContext));

    const repairPromise = buffer.addCommand(new RepairWriteCommand({
      chainName: lockName,
      pathKey: lockName,
      // Repair is unconditional: clear poison and publish a healthy lock state.
      operation: () => true,
      errorContext
    }), lockName).catch((err) => guardState.renderState.reportAndThrowFatalError(err, errorContext));

    const detectionPromise = Promise.all([detectPromise, repairPromise]).then(() => true);
    // The guard finalizer observes this later; suppress delayed internal rejection noise.
    markPromiseHandled(detectionPromise);
    guardState.detectionPromises.push(detectionPromise);
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
      chainGuardState.renderState.reportAndThrowFatalError(setupErr, chainGuardState.errorContext);
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
