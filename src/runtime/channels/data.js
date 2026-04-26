'use strict';

const { isPoison, isPoisonError } = require('../errors');
const { ChannelCommand, runWithResolvedArguments, contextualizeOutputError } = require('./command-base');
const DataChannelTarget = require('../../script/data-channel');
const { createPoison } = require('../errors');
const {
  Channel,
  cloneSnapshotValue,
  mergePoisonErrors
} = require('./base');

class DataCommand extends ChannelCommand {
  constructor({ channelName, command, args = null, pos = null, initializeIfNotSet = false }) {
    super({
      channelName,
      command: command || null,
      args: args || [],
      subpath: null,
      pos
    });
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(channel) {
    super.apply(channel);
    return runWithResolvedArguments(this.arguments, this, channel, (resolvedArgs) => {
      if (!channel || !channel._base) return;
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const rawPath = args.length > 0 ? args[0] : null;
      const dataPath = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (this.command !== 'set') {
        const existing = readDataValueAtPath(channel._base.data, dataPath);
        if (isPoison(existing) || isPoisonError(existing)) {
          if (poisonErrors.length > 0) {
            setDataPoisonAtPath(channel, args, this.toPoisonValue(poisonErrors));
          }
          return;
        }
      }
      if (poisonErrors.length > 0) {
        setDataPoisonAtPath(channel, args, this.toPoisonValue(poisonErrors));
        return;
      }
      const method = this.command ? channel._base[this.command] : channel._base;
      if (typeof method !== 'function') {
        setDataPoisonAtPath(
          channel,
          args,
          this.toPoisonValue([
            contextualizeOutputError(channel, this.pos, new Error(`has no method '${this.command}'`))
          ])
        );
        return;
      }
      try {
        if (
          this.initializeIfNotSet &&
          this.command === 'set' &&
          channel._getTarget() &&
          typeof channel._getTarget() === 'object' &&
          Object.keys(channel._getTarget()).length > 0
        ) {
          return;
        }
        method.apply(channel._base, args);
        channel._setTarget(channel._base.data);
      } catch (err) {
        setDataPoisonAtPath(
          channel,
          args,
          this.toPoisonValue([
            contextualizeOutputError(channel, this.pos, err)
          ])
        );
      }
    });
  }
}

class DataChannel extends Channel {
  constructor(buffer, channelName, context, channelType) {
    const env = context && context.env ? context.env : null;
    const base = new DataChannelTarget(context && context.getVariables ? context.getVariables() : {}, env);
    super(
      buffer,
      channelName,
      context,
      channelType,
      base.data,
      base
    );
    this._snapshotShared = false;
    this._installCommandMethods();
  }

  _getCurrentResult() {
    return this._target;
  }

  _installCommandMethods() {
    const methods = this._base && this._base.methods ? this._base.methods : null;
    if (!methods) {
      return;
    }
    Object.keys(methods).forEach((methodName) => {
      if (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError') {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(this, methodName) || typeof this[methodName] !== 'undefined') {
        return;
      }
      Object.defineProperty(this, methodName, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: (...args) => {
          if (!this._buffer) return;
          this._buffer.add(new DataCommand({
            channelName: this._channelName,
            command: methodName,
            args,
            pos: { lineno: 0, colno: 0 }
          }), this._channelName);
        }
      });
    });
  }

  _resolveSnapshotCommandResult() {
    const value = super._resolveSnapshotCommandResult();
    if (value && typeof value === 'object') {
      this._snapshotShared = true;
    }
    return value;
  }

  _beforeApplyCommand(cmd) {
    if (!cmd || cmd.isObservable || !this._snapshotShared || !this._base) {
      return;
    }
    const cloned = cloneSnapshotValue(this._target);
    this._setTarget(cloned);
    this._base.data = cloned;
    this._snapshotShared = false;
  }

  _captureGuardState() {
    return {
      target: cloneSnapshotValue(this._target)
    };
  }

  _restoreGuardState(state) {
    const nextTarget = state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'target')
      ? state.target
      : state;
    this._setTarget(nextTarget);
    if (this._base) {
      this._base.data = nextTarget;
    }
    this._snapshotShared = false;
  }

  _applyPoisonErrors(errors, cmd = null) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return;
    }
    const mergedRootErrors = mergePoisonErrors(extractPoisonErrors(this._getTarget()), errors);
    const poison = createPoison(mergedRootErrors);
    const rawPath = cmd && Array.isArray(cmd.arguments) && cmd.arguments.length > 0 ? cmd.arguments[0] : null;
    const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
    if (this._base) {
      try {
        this._base.set(path, poison);
        this._setTarget(this._base.data);
        return;
      } catch (err) {
        void err;
      }
    }
    this._setTarget(poison);
  }
}

function setDataPoisonAtPath(output, args, poisonValue) {
  if (!output || !output._base) {
    return;
  }
  const rawPath = Array.isArray(args) && args.length > 0 ? args[0] : null;
  const path = (Array.isArray(rawPath) || rawPath === null) ? rawPath : null;
  const existingValue = readDataValueAtPath(output._base.data, path);
  const existingErrors = extractPoisonErrors(existingValue);
  const newErrors = extractPoisonErrors(poisonValue);
  const mergedPoison = (existingErrors.length > 0 || newErrors.length > 0)
    ? createPoison([...existingErrors, ...newErrors])
    : poisonValue;
  output._base.set(path, mergedPoison);
  output._setTarget(output._base.data);
}

function readDataValueAtPath(root, path) {
  if (!Array.isArray(path) || path.length === 0 || (path.length === 1 && path[0] === null)) {
    return root;
  }
  let current = root;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (segment === '[]') {
      if (!Array.isArray(current) || current.length === 0) {
        return undefined;
      }
      current = current[current.length - 1];
      continue;
    }
    current = current[segment];
  }
  return current;
}

function extractPoisonErrors(value) {
  if (isPoison(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  if (isPoisonError(value) && Array.isArray(value.errors)) {
    return value.errors;
  }
  return [];
}

module.exports = {
  DataChannel,
  DataCommand
};
