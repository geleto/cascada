'use strict';

const { isPoison, PoisonError, createPoison } = require('../errors');
const { isResolvedValue, unwrapResolvedValue, resolveAll } = require('../resolve');
const {
  materializeTemplateTextValue,
  suppressValue,
  suppressValueScriptRaw
} = require('../safe-output');
const {
  ChannelCommand,
  runWithResolvedArguments,
  contextualizeOutputError
} = require('./command-base');
const { Channel } = require('./base');

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
            contextualizeOutputError(channel, this.pos, new Error('text.set() accepts exactly one argument'))
          ]));
          return;
        }
        if (this.initializeIfNotSet && Array.isArray(channel._target) && channel._target.length > 0) {
          return;
        }
        channel._setTarget([]);
      } else if (this.command !== null) {
        channel._setTarget(this.toPoisonValue([
          contextualizeOutputError(channel, this.pos, new Error(`Unsupported text channel command '${this.command}'`))
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
    this._buffer.add(new TextCommand({
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

function normalizeTextCommandArg(value, output, pos) {
  const materialized = materializeTemplateTextValue(value, buildTextErrorContext(output, pos));
  if (materialized && typeof materialized.then === 'function') {
    return Promise.resolve(materialized).then((resolved) => normalizeMaterializedTextArg(resolved, output, pos));
  }
  return normalizeMaterializedTextArg(materialized, output, pos);
}

// Text commands have a second consumption boundary after top-level argument
// resolution: text values may still need snapshot/finalSnapshot materialization
// before autoescape/suppression turns them into concrete text.
function materializeTextCommandArgs(values, output, pos) {
  const normalizedArgs = values.map((value) => normalizeTextCommandArg(value, output, pos));
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

function normalizeMaterializedTextArg(value, output, pos) {
  const throwOnUndefined = isThrowOnUndefinedEnabled(output);
  if (throwOnUndefined && (value === null || value === undefined)) {
    throw contextualizeOutputError(output, pos, new Error('attempted to output null or undefined value'));
  }
  const autoescape = isAutoescapeEnabled(output);
  if (isScriptOutputMode(output)) {
    return suppressValueScriptRaw(value, autoescape);
  }
  return suppressValue(value, autoescape);
}

function appendTextValues(output, values, pos) {
  const args = Array.isArray(values) ? values : [values];
  const commandPos = pos || { lineno: 0, colno: 0 };
  for (const value of args) {
    if (value === null || value === undefined) {
      continue;
    }
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      output._target.push(value);
      continue;
    }
    if (type === 'object') {
      const hasCustomToString = value.toString && value.toString !== Object.prototype.toString;
      if (hasCustomToString) {
        output._target.push(value);
        continue;
      }
    }
    const argType = Array.isArray(value) ? 'array' : type;
    throw new Error(`Invalid TextCommand argument type '${argType}' at ${commandPos.lineno}:${commandPos.colno}. TextCommand only accepts text-like scalar values.`);
  }
  output._markStateChanged();
}

function buildTextErrorContext(output, pos) {
  return {
    lineno: pos && typeof pos.lineno === 'number' ? pos.lineno : 0,
    colno: pos && typeof pos.colno === 'number' ? pos.colno : 0,
    errorContextString: null,
    path: output && output._context ? output._context.path || null : null
  };
}

function isAutoescapeEnabled(output) {
  const opts = output && output._context && output._context.env ? output._context.env.opts : null;
  return !!(opts && opts.autoescape);
}

function isThrowOnUndefinedEnabled(output) {
  const opts = output && output._context && output._context.env ? output._context.env.opts : null;
  return !!(opts && opts.throwOnUndefined);
}

function isScriptOutputMode(output) {
  return !!(output && output._context && output._context.scriptMode);
}

module.exports = {
  TextChannel,
  TextCommand
};
