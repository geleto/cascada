'use strict';

import {PoisonError, createPoison} from '../errors';
import {Command, contextualizeErrorsForOutput} from './command-base';

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

  apply(output) {
    if (!output) {
      return;
    }
    const contextualizedErrors = contextualizeErrorsForOutput(output, this.pos, this.errors);
    const channelType = output._channelType;
    if (channelType === 'text') {
      if (!Array.isArray(output._target)) {
        output._setTarget([]);
      }
      output._target.push(createPoison(contextualizedErrors));
      output._markStateChanged();
      return;
    }
    output._applyPoisonErrors(contextualizedErrors);
  }
}

const __defaultExport = {
  ErrorCommand,
  TargetPoisonCommand
};
export { ErrorCommand, TargetPoisonCommand };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
