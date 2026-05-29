import {isPoison, PoisonError} from '../errors.js';
import {ObservableCommand, MutatingResultCommand, requireCommandErrorContext} from './base.js';

class SequentialPathReadCommand extends ObservableCommand {
  constructor({ chainName, pathKey, operation, repair = false, errorContext }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    return runSequentialPathOperation(this, chain, false);
  }
}

class RepairReadCommand extends SequentialPathReadCommand {
  constructor(spec = {}) {
    super({
      ...spec,
      repair: true
    });
  }
}

class SequentialPathWriteCommand extends MutatingResultCommand {
  constructor({ chainName, pathKey, operation, repair = false, errorContext }) {
    super();
    this.chainName = chainName;
    this.pathKey = pathKey || this.chainName;
    this.operation = operation;
    this.repair = !!repair;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
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
    rejectPoison(PoisonError.wrap(err, cmd.errorContext));
    return;
  }

  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).then(resolveValue, (err) => {
      rejectPoison(PoisonError.wrap(err, cmd.errorContext));
    });
  }

  resolveValue(result);
  return result;
}

export {SequentialPathReadCommand, RepairReadCommand, SequentialPathWriteCommand, RepairWriteCommand};
