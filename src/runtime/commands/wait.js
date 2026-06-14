import {resolveAll, thenValue} from '../resolve.js';
import {isPoisonError} from '../errors.js';
import {ChainCommand, ObservableCommand, requireCommandErrorContext} from './base.js';

// WaitResolveCommand is a timing-only barrier. Poison from the waited value is
// observed through its real chain; non-poison failures must stay fatal.
function ignorePoisonWaitFailure(err) {
  if (isPoisonError(err)) {
    return;
  }
  throw err;
}

class WaitResolveCommand extends ChainCommand {
  constructor({ chainName, args = null, errorContext }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
  }

  apply(chain) {
    super.apply(chain);
    const settle = (resolvedArgs) => {
      const resolved = Array.isArray(resolvedArgs) && resolvedArgs.length <= 1
        ? resolvedArgs[0]
        : resolvedArgs;
      if (chain) {
        chain._setTarget(resolved);
      }
      return resolved;
    };

    const values = Array.isArray(this.arguments) ? this.arguments : [];
    // resolveAllAsync returns poison as a PoisonedValue, which async promise
    // assimilation routes to this rejection handler.
    return thenValue(resolveAll(values), settle, ignorePoisonWaitFailure);
  }
}

class WaitCurrentCommand extends ObservableCommand {
  constructor({ chainName, errorContext }) {
    super();
    this.chainName = chainName;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    void chain;
    this.resolveResult(undefined);
    return undefined;
  }
}

export {WaitResolveCommand, WaitCurrentCommand};
