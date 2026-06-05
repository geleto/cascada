import {isPoison, PoisonError} from '../errors.js';
import {isResolvedValue, unwrapResolvedValue, resolveAll, thenValue} from '../resolve.js';
import {materializeTemplateTextValue, suppressValue, suppressValueScriptRaw} from '../safe-output.js';
import {ChainCommand} from './base.js';
import {runWithResolvedArguments} from './arguments.js';

class TextCommand extends ChainCommand {
  constructor({
    chainName,
    args = null,
    operation = null,
    errorContext,
    normalizeArgs = false,
    initializeIfNotSet = false
  }) {
    super({
      chainName,
      args: args || [],
      errorContext
    });
    this.operation = operation || null;
    this.normalizeArgs = normalizeArgs;
    this.initializeIfNotSet = initializeIfNotSet;
  }

  apply(chain) {
    super.apply(chain);
    return runWithResolvedArguments(this.arguments, this, (resolvedArgs) => {
      if (!chain || !Array.isArray(chain._target)) {
        if (!chain) {
          return;
        }
        chain._setTarget([]);
      }
      const args = Array.isArray(resolvedArgs) ? resolvedArgs : [];
      const poisonError = this.getPoisonFromArgs(args);
      if (poisonError) {
        chain._target.push(this.toPoisonValue(poisonError));
        chain._markStateChanged();
        return;
      }
      if (this.operation === 'set') {
        if (this.initializeIfNotSet && Array.isArray(chain._target) && chain._target.length > 0) {
          return;
        }
        chain._setTarget([]);
      } else if (this.operation !== null) {
        chain._setTarget(this.toPoisonValue(
          PoisonError.create(`Unsupported text chain command '${this.operation}'`, this.errorContext, 'MissingFunction')
        ));
        return;
      }
      if (!this.normalizeArgs) {
        appendTextValues(chain, args, this.errorContext);
        return;
      }
      const materializedArgs = materializeTextCommandArgs(args, chain, this.errorContext);
      return thenValue(materializedArgs, (finalArgs) => {
        appendTextValues(chain, finalArgs, this.errorContext);
      });
    });
  }
}

function normalizeTextCommandArg(value, chain, errorContext) {
  const materialized = materializeTemplateTextValue(value, errorContext);
  return thenValue(materialized, (resolved) => normalizeMaterializedTextArg(resolved, chain, errorContext));
}

function materializeTextCommandArgs(values, chain, errorContext) {
  const normalizedArgs = values.map((value) => normalizeTextCommandArg(value, chain, errorContext));
  const resolvedArgs = resolveAll(normalizedArgs);
  if (isResolvedValue(resolvedArgs)) {
    return unwrapResolvedValue(resolvedArgs);
  }
  if (isPoison(resolvedArgs)) {
    throw PoisonError.group(resolvedArgs.errors);
  }
  return resolvedArgs.then((resolved) => {
    if (isPoison(resolved)) {
      throw PoisonError.group(resolved.errors);
    }
    return resolved;
  });
}

function normalizeMaterializedTextArg(value, chain, errorContext) {
  const throwOnUndefined = isThrowOnUndefinedEnabled(chain);
  if (throwOnUndefined && (value === null || value === undefined)) {
    throw PoisonError.create('attempted to output null or undefined value', errorContext, 'InvalidTextValue');
  }
  const autoescape = isAutoescapeEnabled(chain);
  if (isScriptOutputMode(chain)) {
    if (!isAppendableTextValue(value) && !isScriptTextEnvelope(value)) {
      return value;
    }
    return suppressValueScriptRaw(value, autoescape);
  }
  return suppressValue(value, autoescape);
}

function isAppendableTextValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return true;
  }
  if (type !== 'object' || Array.isArray(value)) {
    return false;
  }
  return value.toString && value.toString !== Object.prototype.toString;
}

function isScriptTextEnvelope(value) {
  // Preserve the existing script text-output envelope shape handled by suppressValueScriptRaw.
  return value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'text');
}

function appendTextValues(chain, values, errorContext) {
  const args = Array.isArray(values) ? values : [values];
  for (const value of args) {
    if (value === null || value === undefined) {
      continue;
    }
    if (isAppendableTextValue(value)) {
      chain._target.push(value);
      continue;
    }
    const type = typeof value;
    const argType = Array.isArray(value) ? 'array' : type;
    throw PoisonError.create(
      `Invalid TextCommand argument type '${argType}'. TextCommand only accepts text-like scalar values.`,
      errorContext,
      'InvalidTextValue'
    );
  }
  chain._markStateChanged();
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
