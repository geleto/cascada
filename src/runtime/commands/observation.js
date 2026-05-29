import {RETURN_UNSET} from '../markers.js';
import {ObservableCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';

class SnapshotCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.isUniversalObservationCommand = true;
  }

  apply(chain) {
    if (!chain) {
      throw new Error('SnapshotCommand requires a chain');
    }

    return this.settleResult(chain._resolveSnapshotCommandResult());
  }
}

class RawSnapshotCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('RawSnapshotCommand requires a chain');
    }

    this.resolveResult(chain._getTarget());
  }
}

class ReturnIsUnsetCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('ReturnIsUnsetCommand requires a chain');
    }

    this.resolveResult(chain._getTarget() === RETURN_UNSET);
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
    if (!chain) {
      throw new Error('IsErrorCommand requires a chain');
    }

    const result = chain._isErrorNow();
    return this.settleResult(result, {
      mapValue: (value) => !!value
    });
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
    if (!chain) {
      throw new Error('GetErrorCommand requires a chain');
    }

    const result = chain._getErrorNow();
    return this.settleResult(result, {
      mapValue: (value) => value || null
    });
  }
}

class CaptureGuardStateCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('CaptureGuardStateCommand requires a chain');
    }

    return this.settleResult(chain._captureGuardState());
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
    if (!chain) {
      this.resolveResult(undefined);
      return;
    }

    return this.settleResult(chain._restoreGuardState(this.target));
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
