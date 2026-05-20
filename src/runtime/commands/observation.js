import {RETURN_UNSET} from '../markers.js';
import {isPoisonError, contextualizeError} from '../errors.js';
import {ObservableCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';

class SnapshotCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class RawSnapshotCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class ReturnIsUnsetCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class IsErrorCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class GetErrorCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class CaptureGuardStateCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

class RestoreGuardStateCommand extends MutatingResultCommand {
  constructor({ chainName, target, errorContext }) {
    super();
    this.chainName = chainName;
    this.target = target;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    const contextualize = (err) => (isPoisonError(err)
      ? err
      : contextualizeError(err, this.errorContext));

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

export {
  SnapshotCommand,
  RawSnapshotCommand,
  ReturnIsUnsetCommand,
  IsErrorCommand,
  GetErrorCommand,
  CaptureGuardStateCommand,
  RestoreGuardStateCommand
};
