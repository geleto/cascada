'use strict';

import {ChannelCommand, runWithResolvedArguments, contextualizeOutputError} from './command-base.js';
import {Channel} from './base.js';

class VarCommand extends ChannelCommand {
  constructor(specOrValue) {
    const isSpecObject = !!specOrValue &&
      typeof specOrValue === 'object' &&
      !Array.isArray(specOrValue) &&
      (
        Object.prototype.hasOwnProperty.call(specOrValue, 'channelName') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'args') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'command') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'subpath') ||
        Object.prototype.hasOwnProperty.call(specOrValue, 'pos')
      );
    if (isSpecObject) {
      super({
        channelName: specOrValue.channelName,
        command: null,
        args: specOrValue.args || [],
        subpath: null,
        pos: specOrValue.pos || null
      });
      this.initializeIfNotSet = specOrValue.initializeIfNotSet;
      return;
    }
    super({
      channelName: 'var',
      command: null,
      args: [specOrValue],
      subpath: null,
      pos: null
    });
    this.initializeIfNotSet = false;
  }

  apply(channel) {
    super.apply(channel);
    return runWithResolvedArguments(this.arguments, this, channel, (resolvedArgs) => {
      if (!channel) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        channel._setTarget(this.toPoisonValue(poisonErrors));
        return;
      }
      if (args.length === 0) {
        channel._setTarget(undefined);
        return;
      }
      if (args.length > 1) {
        channel._setTarget(this.toPoisonValue([
          contextualizeOutputError(channel, this.pos, new Error('var channel accepts exactly one argument'))
        ]));
        return;
      }
      if (this.initializeIfNotSet && channel._getTarget() !== undefined) {
        return;
      }
      channel._setTarget(args[0]);
    });
  }
}

class VarChannel extends Channel {
  constructor(buffer, channelName, context, channelType, initialValue = undefined) {

    // Keep declaration-only var channels aligned with `none` semantics unless

    // a caller provides an explicit initializer.

    super(buffer, channelName, context, channelType, initialValue, null);

  }



  invoke(value) {

    if (!this._buffer) return;

    this._buffer.add(new VarCommand({

      channelName: this._channelName,

      args: [value],

      pos: { lineno: 0, colno: 0 }

    }), this._channelName);

  }



  _getCurrentResult() {

    return this._target;

  }

}

export { VarChannel, VarCommand };
