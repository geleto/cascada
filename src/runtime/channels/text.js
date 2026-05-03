
import {isPoison, PoisonError, createPoison} from '../errors.js';
import {isResolvedValue, unwrapResolvedValue, resolveAll} from '../resolve.js';
import {materializeTemplateTextValue, suppressValue, suppressValueScriptRaw} from '../safe-output.js';
import {ChannelCommand, runWithResolvedArguments, contextualizeChannelError} from './command-base.js';
import {Channel} from './base.js';

class TextCommand extends ChannelCommand {
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
        command: specOrValue.command || null,
        args: specOrValue.args || [],
        subpath: null,
        pos: specOrValue.pos || null
      });
      this.normalizeArgs = specOrValue.normalizeArgs;
      this.initializeIfNotSet = specOrValue.initializeIfNotSet;
      return;
    }
    super({
      channelName: 'text',
      command: null,
      args: [specOrValue],
      subpath: null,
      pos: null
    });
    this.normalizeArgs = false;
    this.initializeIfNotSet = false;
  }

  apply(channel) {
    super.apply(channel);
    return runWithResolvedArguments(this.arguments, this, channel, (resolvedArgs) => {
      if (!channel || !Array.isArray(channel._target)) {
        if (!channel) {
          return;
        }
        channel._setTarget([]);
      }
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        channel._target.push(this.toPoisonValue(poisonErrors));
        channel._markStateChanged();
        return;
      }
      if (this.command === 'set') {
        if (args.length !== 1) {
          channel._setTarget(this.toPoisonValue([
            contextualizeChannelError(channel, this.pos, new Error('text.set() accepts exactly one argument'))
          ]));
          return;
        }
        if (this.initializeIfNotSet && Array.isArray(channel._target) && channel._target.length > 0) {
          return;
        }
        channel._setTarget([]);
      } else if (this.command !== null) {
        channel._setTarget(this.toPoisonValue([
          contextualizeChannelError(channel, this.pos, new Error(`Unsupported text channel command '${this.command}'`))
        ]));
        return;
      }
      if (!this.normalizeArgs) {
        appendTextValues(channel, args, this.pos);
        return;
      }
      const materializedArgs = materializeTextCommandArgs(args, channel, this.pos);
      if (materializedArgs && typeof materializedArgs.then === 'function') {
        return Promise.resolve(materializedArgs).then((finalArgs) => {
          appendTextValues(channel, finalArgs, this.pos);
        });
      }
      appendTextValues(channel, materializedArgs, this.pos);
    });
  }
}

class TextChannel extends Channel {
  constructor(buffer, channelName, context, channelType) {

    super(buffer, channelName, context, channelType, [], null);

  }



  invoke(...args) {

    if (!this._buffer) return;

    if (args.length === 0) return;

    this._buffer.addCommand(new TextCommand({

      channelName: this._channelName,

      args,

      normalizeArgs: true,

      pos: { lineno: 0, colno: 0 }

    }), this._channelName);

  }



  _getCurrentResult() {

    if (!Array.isArray(this._target) || this._target.length === 0) {

      this._setTarget(['']);

      return '';

    }

    const result = this._target.join('');

    // Compact accumulated fragments so future appends keep O(1)-ish growth.

    this._setTarget([result]);

    return result;

  }



  _applyPoisonErrors(errors) {

    if (!Array.isArray(errors) || errors.length === 0) {

      return;

    }

    if (!Array.isArray(this._target)) {

      this._setTarget([]);

    }

    this._target.push(createPoison(errors));

    this._markStateChanged();

  }

}

function normalizeTextCommandArg(value, channel, pos) {
  const materialized = materializeTemplateTextValue(value, buildTextErrorContext(channel, pos));
  if (materialized && typeof materialized.then === 'function') {
    return Promise.resolve(materialized).then((resolved) => normalizeMaterializedTextArg(resolved, channel, pos));
  }
  return normalizeMaterializedTextArg(materialized, channel, pos);
}

// Text commands have a second consumption boundary after top-level argument
// resolution: text values may still need snapshot/finalSnapshot materialization
// before autoescape/suppression turns them into concrete text.
function materializeTextCommandArgs(values, channel, pos) {
  const normalizedArgs = values.map((value) => normalizeTextCommandArg(value, channel, pos));
  const resolvedArgs = resolveAll(normalizedArgs);
  if (isResolvedValue(resolvedArgs)) {
    return unwrapResolvedValue(resolvedArgs);
  }
  if (isPoison(resolvedArgs)) {
    throw new PoisonError(resolvedArgs.errors);
  }
  return Promise.resolve(resolvedArgs).then((resolved) => {
    if (isPoison(resolved)) {
      throw new PoisonError(resolved.errors);
    }
    return resolved;
  });
}

function normalizeMaterializedTextArg(value, channel, pos) {
  const throwOnUndefined = isThrowOnUndefinedEnabled(channel);
  if (throwOnUndefined && (value === null || value === undefined)) {
    throw contextualizeChannelError(channel, pos, new Error('attempted to output null or undefined value'));
  }
  const autoescape = isAutoescapeEnabled(channel);
  if (isScriptOutputMode(channel)) {
    return suppressValueScriptRaw(value, autoescape);
  }
  return suppressValue(value, autoescape);
}

function appendTextValues(channel, values, pos) {
  const args = Array.isArray(values) ? values : [values];
  const commandPos = pos || { lineno: 0, colno: 0 };
  for (const value of args) {
    if (value === null || value === undefined) {
      continue;
    }
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      channel._target.push(value);
      continue;
    }
    if (type === 'object') {
      const hasCustomToString = value.toString && value.toString !== Object.prototype.toString;
      if (hasCustomToString) {
        channel._target.push(value);
        continue;
      }
    }
    const argType = Array.isArray(value) ? 'array' : type;
    throw new Error(`Invalid TextCommand argument type '${argType}' at ${commandPos.lineno}:${commandPos.colno}. TextCommand only accepts text-like scalar values.`);
  }
  channel._markStateChanged();
}

function buildTextErrorContext(channel, pos) {
  return {
    lineno: pos && typeof pos.lineno === 'number' ? pos.lineno : 0,
    colno: pos && typeof pos.colno === 'number' ? pos.colno : 0,
    errorContextString: null,
    path: channel && channel._context ? channel._context.path || null : null
  };
}

function isAutoescapeEnabled(channel) {
  const opts = channel && channel._context && channel._context.env ? channel._context.env.opts : null;
  return !!(opts && opts.autoescape);
}

function isThrowOnUndefinedEnabled(channel) {
  const opts = channel && channel._context && channel._context.env ? channel._context.env.opts : null;
  return !!(opts && opts.throwOnUndefined);
}

function isScriptOutputMode(channel) {
  return !!(channel && channel._context && channel._context.scriptMode);
}

export { TextChannel, TextCommand };
