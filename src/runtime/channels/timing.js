'use strict';

import {resolveAll} from '../resolve.js';
import {ChannelCommand, Command} from './command-base.js';

// Timing-only sync point: awaits an iteration value for limited-concurrency
// loop synchronization. Does not propagate errors.
class WaitResolveCommand extends ChannelCommand {
  constructor({ channelName, args = null, pos = null }) {
    super({
      channelName,
      command: null,
      args: args || [],
      subpath: null,
      pos
    });
    // isObservable is intentionally false: routing through _applyMutable ensures
    // this command waits for all pending observables, which is the sync guarantee
    // concurrency-limited loops depend on.
  }

  async apply(channel) {
    super.apply(channel);
    try {
      const values = Array.isArray(this.arguments) ? this.arguments : [];
      const resolvedArgs = await resolveAll(values);
      const resolved = Array.isArray(resolvedArgs) && resolvedArgs.length <= 1
        ? resolvedArgs[0]
        : resolvedArgs;
      if (channel) {
        channel._setTarget(resolved);
      }
      return resolved;
    } catch (err) {
      // Timing-only command: do not alter functional error flow.
      void err;
      return undefined;
    }
  }
}

// Ordered timing-only sync point for a specific channel lane. Resolves once the
// iterator reaches this source position on that lane without coupling the wait
// to any snapshot/error-read semantics.
class WaitCurrentCommand extends Command {
  constructor({ channelName, pos = null }) {
    super({ withDeferredResult: true });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
  }

  apply(output) {
    void output;
    this.resolveResult(undefined);
    return undefined;
  }
}

export { WaitResolveCommand, WaitCurrentCommand };
