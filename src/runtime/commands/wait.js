import {resolveAll} from '../resolve.js';
import {ChainCommand, ObservableCommand} from './base.js';

class WaitResolveCommand extends ChainCommand {
  constructor({ chainName, args = null, pos = null }) {
    super({
      chainName,
      args: args || [],
      pos
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
  constructor({ chainName, pos = null }) {
    super();
    this.chainName = chainName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }

  apply(chain) {
    void chain;
    this.resolveResult(undefined);
    return undefined;
  }
}

export {WaitResolveCommand, WaitCurrentCommand};
