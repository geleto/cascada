import {isPoison, isPoisonError, PoisonError, RuntimeError, rethrowPoisonOrReport} from '../errors.js';
import {ObservableCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';

class SequentialPathReadCommand extends ObservableCommand {
  constructor(spec = {}) {
    super();
    initializeSequentialPathCommand(this, spec);
  }

  apply(chain) {
    return runSequentialPathOperation(this, chain, false);
  }
}

class RepairReadCommand extends MutatingResultCommand {
  constructor(spec = {}) {
    super();
    initializeSequentialPathCommand(this, spec, true);
  }

  apply(chain) {
    return runSequentialPathOperation(this, chain, false);
  }
}

class SequentialPathWriteCommand extends MutatingResultCommand {
  constructor(spec = {}) {
    super();
    initializeSequentialPathCommand(this, spec);
  }

  apply(chain) {
    return runSequentialPathOperation(this, chain, true);
  }
}

class RepairWriteCommand extends SequentialPathWriteCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

function initializeSequentialPathCommand(command, spec, repair = spec.repair) {
  command.chainName = spec.chainName;
  command.pathKey = spec.pathKey || command.chainName;
  command.operation = spec.operation;
  command.repair = !!repair;
  command.errorContext = requireCommandErrorContext(spec.errorContext, command.constructor.name);
}

function runSequentialPathOperation(cmd, chain, isWrite) {
  const existingPoison = chain._getSequentialPathPoisonError();
  if (!cmd.repair && existingPoison) {
    cmd.rejectResult(existingPoison);
    return;
  }

  const rejectPoison = (poisonError) => {
    if (isWrite) {
      chain._applySequentialPathPoisonError(poisonError);
    }
    cmd.rejectResult(poisonError);
  };

  const resolveValue = (value) => {
    if (isPoison(value)) {
      rejectPoison(PoisonError.group(value.errors));
      return;
    }
    if (cmd.repair) {
      chain._clearSequentialPathPoison();
    }
    if (isWrite) {
      chain._setSequentialPathLastResult(value);
    }
    cmd.resolveResult(value);
  };

  let result;
  try {
    result = cmd.operation();
  } catch (err) {
    rethrowPoisonOrReport(err, cmd.errorContext);
  }

  if (result && typeof result.then === 'function') {
    return result.then(resolveValue, (err) => {
      if (isPoisonError(err)) {
        rejectPoison(err);
        return;
      }
      RuntimeError.reportAndThrow(err, cmd.errorContext);
    });
  }

  resolveValue(result);
  return result;
}

export {SequentialPathReadCommand, RepairReadCommand, SequentialPathWriteCommand, RepairWriteCommand};
