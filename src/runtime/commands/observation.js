import {RETURN_UNSET} from '../markers.js';
import {poisonOrReportedFatal} from '../errors.js';
import {ObservableCommand, UniversalObservationCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';

class SnapshotCommand extends UniversalObservationCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('SnapshotCommand requires a chain');
    }

    this.settleResult(
      chain._makeSnapshot(this.errorContext),
      null,
      (err) => poisonOrReportedFatal(err, this.errorContext)
    );
    return undefined;
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

class IsErrorCommand extends UniversalObservationCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('IsErrorCommand requires a chain');
    }

    this.settleResult(
      chain._isError(),
      (value) => !!value,
      (err) => poisonOrReportedFatal(err, this.errorContext)
    );
    return undefined;
  }
}

class GetErrorCommand extends UniversalObservationCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    if (!chain) {
      throw new Error('GetErrorCommand requires a chain');
    }

    this.settleResult(
      chain._getErrors(),
      (value) => value || null,
      (err) => poisonOrReportedFatal(err, this.errorContext)
    );
    return undefined;
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
