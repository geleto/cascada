
import {RETURN_UNSET} from '../markers.js';
import {isPoisonError, handleError} from '../errors.js';
import {ObservableCommand, MutatingResultCommand} from './command-base.js';

class SnapshotCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('SnapshotCommand requires a chain')));
      return;
    }

    try {
      return this.settleResult(chain._resolveSnapshotCommandResult(), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Captures the raw chain target without poison inspection. Used for overwrite semantics (e.g., var-chain set_path) where poisoned leaves may be replaced by the write. Observation command.
class RawSnapshotCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('RawSnapshotCommand requires a chain')));
      return;
    }

    try {
      this.resolveResult(chain._getTarget());
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Ordered return-state observation. This deliberately checks only whether the
// return chain still contains the sentinel; it does not consume or inspect
// the returned value, which may itself be poison.
class ReturnIsUnsetCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('ReturnIsUnsetCommand requires a chain')));
      return;
    }

    try {
      this.resolveResult(chain._getTarget() === RETURN_UNSET);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to a boolean indicating whether the chain currently holds a poisoned (error) value. Observation command.
class IsErrorCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('IsErrorCommand requires a chain')));
      return;
    }

    try {
      const result = chain._isErrorNow();
      return this.settleResult(result, {
        mapValue: (value) => !!value,
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to the current error on the chain (a PoisonError or null). Observation command.
class GetErrorCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('GetErrorCommand requires a chain')));
      return;
    }

    try {
      const result = chain._getErrorNow();
      return this.settleResult(result, {
        mapValue: (value) => value || null,
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Snapshots the current chain state for `try/resume` guard entry. The captured state is passed to a later RestoreGuardStateCommand. Observation command.
class CaptureGuardStateCommand extends ObservableCommand {
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.rejectResult(contextualize(new Error('CaptureGuardStateCommand requires a chain')));
      return;
    }

    try {
      return this.settleResult(chain._captureGuardState(), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Restores a previously captured guard state to the chain, overwriting the current target with the saved snapshot. Carries a result promise.
class RestoreGuardStateCommand extends MutatingResultCommand {
  constructor({ chainName, target, pos = null }) {
    super();
    this.chainName = chainName;
    this.target = target;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(chain) {
    const path = chain && chain._context ? chain._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!chain) {
      this.resolveResult(undefined);
      return;
    }

    try {
      return this.settleResult(chain._restoreGuardState(this.target), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

export { SnapshotCommand, RawSnapshotCommand, ReturnIsUnsetCommand, IsErrorCommand, GetErrorCommand, CaptureGuardStateCommand, RestoreGuardStateCommand };
