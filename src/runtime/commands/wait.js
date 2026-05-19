import {resolveAll} from '../resolve.js';
import {ChainCommand, ObservableCommand} from './base.js';

class WaitResolveCommand extends ChainCommand {
  constructor({ chainName, args = null, errorContext = null }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
  }

  async apply(chain) {
    super.apply(chain);
    try {
      const values = Array.isArray(this.arguments) ? this.arguments : [];
      const resolvedArgs = await resolveAll(values);
      const resolved = Array.isArray(resolvedArgs) && resolvedArgs.length <= 1
        ? resolvedArgs[0]
        : resolvedArgs;
      if (chain) {
        chain._setTarget(resolved);
      }
      return resolved;
    } catch (err) {
      void err;
      return undefined;
    }
  }
}

class WaitCurrentCommand extends ObservableCommand {
  constructor({ chainName, errorContext = null }) {
    super();
    this.chainName = chainName;
    this.errorContext = errorContext || null;
  }

  apply(chain) {
    void chain;
    this.resolveResult(undefined);
    return undefined;
  }
}

export {WaitResolveCommand, WaitCurrentCommand};
