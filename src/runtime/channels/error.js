
import {PoisonError, createPoison} from '../errors.js';
import {Command, contextualizeErrorsForChannel} from './command-base.js';

class ErrorCommand extends Command {
  constructor(errors) {
    super();
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(ctx) {
    void ctx;
    throw this.getError();
  }
}

// Writes poison directly into a channel target: pushes a PoisonedValue onto a text buffer, or replaces a data/var/sequence target with one.
class TargetPoisonCommand extends Command {
  constructor({ channelName, errors = null, pos = null }) {
    super();
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.errors = Array.isArray(errors) ? errors : [errors || new Error('Command buffer entry produced an unspecified error')];
  }

  getError() {
    return new PoisonError(this.errors);
  }

  apply(channel) {
    if (!channel) {
      return;
    }
    const contextualizedErrors = contextualizeErrorsForChannel(channel, this.pos, this.errors);
    const channelType = channel._channelType;
    if (channelType === 'text') {
      if (!Array.isArray(channel._target)) {
        channel._setTarget([]);
      }
      channel._target.push(createPoison(contextualizedErrors));
      channel._markStateChanged();
      return;
    }
    channel._applyPoisonErrors(contextualizedErrors);
  }
}

export { ErrorCommand, TargetPoisonCommand };
