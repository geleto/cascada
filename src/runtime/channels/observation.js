
import {RETURN_UNSET} from '../markers.js';
import {isPoisonError, handleError} from '../errors.js';
import {ObservableCommand, MutatingResultCommand} from './command-base.js';

class SnapshotCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('SnapshotCommand requires a channel')));
      return;
    }

    try {
      return this.settleResult(channel._resolveSnapshotCommandResult(), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Captures the raw channel target without poison inspection. Used for overwrite semantics (e.g., var-channel set_path) where poisoned leaves may be replaced by the write. Observation command.
class RawSnapshotCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('RawSnapshotCommand requires a channel')));
      return;
    }

    try {
      this.resolveResult(channel._getTarget());
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Ordered return-state observation. This deliberately checks only whether the
// return channel still contains the sentinel; it does not consume or inspect
// the returned value, which may itself be poison.
class ReturnIsUnsetCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('ReturnIsUnsetCommand requires a channel')));
      return;
    }

    try {
      this.resolveResult(channel._getTarget() === RETURN_UNSET);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to a boolean indicating whether the channel currently holds a poisoned (error) value. Observation command.
class IsErrorCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('IsErrorCommand requires a channel')));
      return;
    }

    try {
      const result = channel._isErrorNow();
      return this.settleResult(result, {
        mapValue: (value) => !!value,
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to the current error on the channel (a PoisonError or null). Observation command.
class GetErrorCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isUniversalObservationCommand = true;
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('GetErrorCommand requires a channel')));
      return;
    }

    try {
      const result = channel._getErrorNow();
      return this.settleResult(result, {
        mapValue: (value) => value || null,
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Snapshots the current channel state for `try/resume` guard entry. The captured state is passed to a later RestoreGuardStateCommand. Observation command.
class CaptureGuardStateCommand extends ObservableCommand {
  constructor({ channelName, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.rejectResult(contextualize(new Error('CaptureGuardStateCommand requires a channel')));
      return;
    }

    try {
      return this.settleResult(channel._captureGuardState(), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Restores a previously captured guard state to the channel, overwriting the current target with the saved snapshot. Carries a result promise.
class RestoreGuardStateCommand extends MutatingResultCommand {
  constructor({ channelName, target, pos = null }) {
    super();
    this.channelName = channelName;
    this.target = target;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(channel) {
    const path = channel && channel._context ? channel._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!channel) {
      this.resolveResult(undefined);
      return;
    }

    try {
      return this.settleResult(channel._restoreGuardState(this.target), {
        mapError: contextualize
      });
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

export { SnapshotCommand, RawSnapshotCommand, ReturnIsUnsetCommand, IsErrorCommand, GetErrorCommand, CaptureGuardStateCommand, RestoreGuardStateCommand };
