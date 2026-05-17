import {isPoison, PoisonError} from '../errors.js';
import {isResolvedValue, unwrapResolvedValue, resolveAll} from '../resolve.js';
import {materializeTemplateTextValue, suppressValue, suppressValueScriptRaw} from '../safe-output.js';
import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';
import {contextualizeChainError} from './errors.js';

class TextCommand extends ChainCommand {
  constructor({
    chainName,
    args = null,
    operation = null,
    pos = null,
    normalizeArgs = false,
    initializeIfNotSet = false
  }) {
    super({
      chainName,
      args: args || [],
      pos
    });
    this.operation = operation || null;
    this.normalizeArgs = normalizeArgs;
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, chain, (resolvedArgs) => {
      if (!chain || !Array.isArray(chain._target)) {
        if (!chain) {
          return;
        }
        chain._setTarget([]);
      }
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonErrors = this.extractPoisonFromArgs(args);
      if (poisonErrors.length > 0) {
        chain._target.push(this.toPoisonValue(poisonErrors));
        chain._markStateChanged();
        return;
      }
      if (this.operation === 'set') {
        if (args.length !== 1) {
          chain._setTarget(this.toPoisonValue([
            contextualizeChainError(chain, this.pos, new Error('text.set() accepts exactly one argument'))
          ]));
          return;
        }
        if (this.initializeIfNotSet && Array.isArray(chain._target) && chain._target.length > 0) {
          return;
        }
        chain._setTarget([]);
      } else if (this.operation !== null) {
        chain._setTarget(this.toPoisonValue([
          contextualizeChainError(chain, this.pos, new Error(`Unsupported text chain command '${this.operation}'`))
        ]));
        return;
      }
      if (!this.normalizeArgs) {
        appendTextValues(chain, args, this.pos);
        return;
      }
      const materializedArgs = materializeTextCommandArgs(args, chain, this.pos);
      if (materializedArgs && typeof materializedArgs.then === 'function') {
        return Promise.resolve(materializedArgs).then((finalArgs) => {
          appendTextValues(chain, finalArgs, this.pos);
        });
      }
      appendTextValues(chain, materializedArgs, this.pos);
    });
  }
}

function normalizeTextCommandArg(value, chain, pos) {
  const materialized = materializeTemplateTextValue(value, buildTextErrorContext(chain, pos));
  if (materialized && typeof materialized.then === 'function') {
    return Promise.resolve(materialized).then((resolved) => normalizeMaterializedTextArg(resolved, chain, pos));
  }
  return normalizeMaterializedTextArg(materialized, chain, pos);
}

function materializeTextCommandArgs(values, chain, pos) {
  const normalizedArgs = values.map((value) => normalizeTextCommandArg(value, chain, pos));
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

function normalizeMaterializedTextArg(value, chain, pos) {
  const throwOnUndefined = isThrowOnUndefinedEnabled(chain);
  if (throwOnUndefined && (value === null || value === undefined)) {
    throw contextualizeChainError(chain, pos, new Error('attempted to output null or undefined value'));
  }
  const autoescape = isAutoescapeEnabled(chain);
  if (isScriptOutputMode(chain)) {
    return suppressValueScriptRaw(value, autoescape);
  }
  return suppressValue(value, autoescape);
}

function appendTextValues(chain, values, pos) {
  const args = Array.isArray(values) ? values : [values];
  const commandPos = pos || { lineno: 0, colno: 0 };
  for (const value of args) {
    if (value === null || value === undefined) {
      continue;
    }
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      chain._target.push(value);
      continue;
    }
    if (type === 'object') {
      const hasCustomToString = value.toString && value.toString !== Object.prototype.toString;
      if (hasCustomToString) {
        chain._target.push(value);
        continue;
      }
    }
    const argType = Array.isArray(value) ? 'array' : type;
    throw new Error(`Invalid TextCommand argument type '${argType}' at ${commandPos.lineno}:${commandPos.colno}. TextCommand only accepts text-like scalar values.`);
  }
  chain._markStateChanged();
}

function buildTextErrorContext(chain, pos) {
  return {
    lineno: pos && typeof pos.lineno === 'number' ? pos.lineno : 0,
    colno: pos && typeof pos.colno === 'number' ? pos.colno : 0,
    errorContextString: null,
    path: chain && chain._context ? chain._context.path || null : null
  };
}

function isAutoescapeEnabled(chain) {
  const opts = chain && chain._context && chain._context.env ? chain._context.env.opts : null;
  return !!(opts && opts.autoescape);
}

function isThrowOnUndefinedEnabled(chain) {
  const opts = chain && chain._context && chain._context.env ? chain._context.env.opts : null;
  return !!(opts && opts.throwOnUndefined);
}

function isScriptOutputMode(chain) {
  return !!(chain && chain._context && chain._context.scriptMode);
}

export {TextCommand};
