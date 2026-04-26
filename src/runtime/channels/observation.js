'use strict';

const { isPoisonError, handleError } = require('../errors');
const { Command } = require('./command-base');

class SnapshotCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isUniversalObservationCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.rejectResult(contextualize(new Error('SnapshotCommand requires a channel')));
      return;
    }

    try {
      const result = output._resolveSnapshotCommandResult();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => {
            this.resolveResult(value);
          },
          (err) => {
            this.rejectResult(contextualize(err));
          }
        );
      }
      this.resolveResult(result);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Captures the raw channel target without poison inspection. Used for overwrite semantics (e.g., var-channel set_path) where poisoned leaves may be replaced by the write. Observation command.
class RawSnapshotCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.rejectResult(contextualize(new Error('RawSnapshotCommand requires a channel')));
      return;
    }

    try {
      this.resolveResult(output._getTarget());
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to a boolean indicating whether the channel currently holds a poisoned (error) value. Observation command.
class IsErrorCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isUniversalObservationCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.rejectResult(contextualize(new Error('IsErrorCommand requires a channel')));
      return;
    }

    try {
      const result = output._isErrorNow();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(!!value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(!!result);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Resolves to the current error on the channel (a PoisonError or null). Observation command.
class GetErrorCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.isUniversalObservationCommand = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.rejectResult(contextualize(new Error('GetErrorCommand requires a channel')));
      return;
    }

    try {
      const result = output._getErrorNow();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value || null),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result || null);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Snapshots the current channel state for `try/resume` guard entry. The captured state is passed to a later RestoreGuardStateCommand. Observation command.
class CaptureGuardStateCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.rejectResult(contextualize(new Error('CaptureGuardStateCommand requires a channel')));
      return;
    }

    try {
      const result = output._captureGuardState();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result);
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

// Restores a previously captured guard state to the channel, overwriting the current target with the saved snapshot. Carries a deferred result.
class RestoreGuardStateCommand extends Command {
  constructor({ channelName, target, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.target = target;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(output) {
    const path = output && output._context ? output._context.path : null;
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : handleError(err, this.pos.lineno, this.pos.colno, null, path));

    if (!output) {
      this.resolveResult(undefined);
      return;
    }

    try {
      const result = output._restoreGuardState(this.target);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          (value) => this.resolveResult(value),
          (err) => this.rejectResult(contextualize(err))
        );
      }
      this.resolveResult(result);
      return result;
    } catch (err) {
      this.rejectResult(contextualize(err));
    }
  }
}

module.exports = {
  SnapshotCommand,
  RawSnapshotCommand,
  IsErrorCommand,
  GetErrorCommand,
  CaptureGuardStateCommand,
  RestoreGuardStateCommand
};
