'use strict';

// Flatten populates Output._target / Output._base (via emitText / built-in handlers).
// snapshot() on Output objects reads from _target/_base after flatten completes.

const {
  CommandBuffer,
  resolveOutputTargets,
  isCommandBuffer,
  getPosonedBufferErrors
} = require('./buffer');
const { PoisonError, RuntimeFatalError, isPoison, handleError } = require('./errors');
const { Command, ErrorCommand, OutputCommand } = require('./commands');
const DataHandler = require('../script/data-handler');
const {
  createFlattenState,
  resolveOutputTypeFromState,
  isTextOutputNameFromState,
  getTextOutputFromState,
  ensureBufferScopeMetadata,
  buildFinalResultFromState,
  resolveOutputValue
} = require('./flatten-shared');
const { suppressValue, suppressValueScript } = require('./safe-output');

const BUILTIN_OUTPUT_TYPES = new Set(['data', 'text', 'value', 'sink']);

function flattenCommandBuffer(buffer, context, outputName, sharedState) {
  if (outputName) {
    const state = createFlattenState(sharedState, buffer._outputTypes || null);
    if (state.scriptMode === undefined && buffer && buffer._scriptMode !== undefined) {
      state.scriptMode = buffer._scriptMode;
    }
    if (state.outputHandlers === undefined && buffer && buffer._outputHandlers) {
      state.outputHandlers = buffer._outputHandlers;
    }
    if (!state.outputCtxs && buffer && buffer._outputs) {
      state.outputCtxs = buffer._outputs;
    }
    flattenCommands(buffer._getOutputArray(outputName), context, outputName, state);

    const finalizeOutput = () => {
      if (sharedState) {
        return state;
      }
      if (state && state.collectedErrors && state.collectedErrors.length > 0) {
        throw new PoisonError(state.collectedErrors);
      }
      return resolveOutputValue(state, outputName);
    };

    const resultState = finalizeOutput();
    if (sharedState) {
      return resultState;
    }
    return resultState;
  }

  if (!context) {
    const textArray = buffer._getOutputArray('text');
    const fallbackArray = (Array.isArray(textArray) && textArray.length > 0)
      ? textArray
      : buffer._getOutputArray('output');
    return flattenCommands(fallbackArray, null, 'text', sharedState);
  }

  const state = createFlattenState(sharedState, buffer._outputTypes || null);
  if (state.scriptMode === undefined && buffer && buffer._scriptMode !== undefined) {
    state.scriptMode = buffer._scriptMode;
  }
  if (state.outputHandlers === undefined && buffer && buffer._outputHandlers) {
    state.outputHandlers = buffer._outputHandlers;
  }
  if (!state.outputCtxs && buffer && buffer._outputs) {
    state.outputCtxs = buffer._outputs;
  }
  const outputTargets = resolveOutputTargets(buffer, null);
  const outputNames = outputTargets
    .map(target => target.name)
    .filter(name => name && name !== 'output');

  const orderedNames = outputNames.includes('text')
    ? ['text', ...outputNames.filter(name => name !== 'text')]
    : outputNames.slice();

  if (orderedNames.length === 0) {
    flattenCommands(buffer._getOutputArray('output'), context, 'text', state);
  } else {
    orderedNames.forEach((name) => {
      flattenCommands(buffer._getOutputArray(name), context, name, state);
    });
  }

  const finalize = () => {
    if (sharedState) {
      return state;
    }

    if (state.collectedErrors.length > 0) {
      throw new PoisonError(state.collectedErrors);
    }

    return buildFinalResultFromState(state);
  };

  return finalize();
}

function flattenCommands(arr, context, outputName, sharedState) {
  if (Array.isArray(arr)) {
    ensureBufferScopeMetadata(arr);
  }

  const state = createFlattenState(sharedState, null);
  const env = context.env;

  function collectPoisonArgs(args) {
    for (const arg of args) {
      if (isPoison(arg)) {
        state.collectedErrors.push(...arg.errors);
        return true;
      }
    }
    return false;
  }

  // Resolve the Output object for a handler name from state.outputCtxs.
  // Returns null if not found (e.g. template mode or undeclared handler).
  function getOutputCtx(handlerName) {
    if (state.outputCtxs && state.outputCtxs[handlerName]) {
      return state.outputCtxs[handlerName];
    }
    return null;
  }

  function resolveDeclaredType(handlerName) {
    return resolveOutputTypeFromState(state, handlerName) || (BUILTIN_OUTPUT_TYPES.has(handlerName) ? handlerName : null);
  }

  function getOrInstantiateDataHandler(handlerName) {
    if (state.handlerInstances[handlerName]) {
      return state.handlerInstances[handlerName];
    }
    const outputCtx = getOutputCtx(handlerName);
    if (outputCtx && outputCtx._base) {
      state.handlerInstances[handlerName] = outputCtx._base;
      return outputCtx._base;
    }

    const instance = new DataHandler(context ? context.getVariables() : {}, env);
    state.handlerInstances[handlerName] = instance;
    if (outputCtx && !outputCtx._base) {
      outputCtx._base = instance;
    }
    return instance;
  }

  function getSinkOutputHandler(handlerName) {
    const outputCtx = getOutputCtx(handlerName);
    if (outputCtx && typeof outputCtx._resolveSink === 'function') {
      return outputCtx;
    }
    if (state.outputHandlers && state.outputHandlers[handlerName] && typeof state.outputHandlers[handlerName]._resolveSink === 'function') {
      return state.outputHandlers[handlerName];
    }
    return null;
  }

  function resolveCommandTarget(handlerName) {
    const handlerType = resolveDeclaredType(handlerName);
    const isTextHandler = !handlerName || handlerName === 'text' || handlerType === 'text';
    if (isTextHandler) {
      const targetName = (outputName && isTextOutputNameFromState(state, outputName))
        ? outputName
        : (handlerName || 'text');
      return { kind: 'text', name: targetName };
    }

    if (handlerType === 'value') {
      return { kind: 'value', name: handlerName };
    }
    if (handlerType === 'data') {
      return { kind: 'data', name: handlerName, instance: getOrInstantiateDataHandler(handlerName) };
    }
    if (handlerType === 'sink') {
      return { kind: 'sink', name: handlerName, output: getSinkOutputHandler(handlerName) };
    }

    return { kind: 'unsupported', name: handlerName };
  }

  function getPosition(item) {
    if (item && item.pos) {
      return { lineno: item.pos.lineno || 0, colno: item.pos.colno || 0 };
    }
    return { lineno: 0, colno: 0 };
  }

  function formatHandlerRef(handlerName, subpath, commandName) {
    const pathSuffix = subpath && subpath.length > 0 ? `.${subpath.join('.')}` : '';
    const commandSuffix = commandName ? `.${commandName}` : '';
    return `${handlerName}${pathSuffix}${commandSuffix}`;
  }

  function resolveSubpath(targetObject, subpath, handlerName, pos) {
    if (!subpath || subpath.length === 0) {
      return targetObject;
    }

    let current = targetObject;
    for (const pathSegment of subpath) {
      if (current && typeof current === 'object' && current !== null) {
        current = current[pathSegment];
        continue;
      }

      const err = handleError(
        new Error(`Cannot access property '${pathSegment}' on ${typeof current} in handler '${handlerName}'`),
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath.slice(0, subpath.indexOf(pathSegment) + 1), null),
        context ? context.path : null
      );
      state.collectedErrors.push(err);
      return null;
    }

    return current;
  }

  function resolveSinkSubpath(sinkOutput, subpath, handlerName, pos) {
    const sinkVal = sinkOutput._sink;
    if (sinkVal && typeof sinkVal.then === 'function') {
      throw new RuntimeFatalError(
        new Error('Sink must be resolved before command execution'),
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath, null),
        context ? context.path : null
      );
    }
    return resolveSubpath(sinkVal, subpath, handlerName, pos);
  }

  function emitText(name, values) {
    getTextOutputFromState(state, name).push(...values);
    // Also populate Output._target for the new command-based pipeline
    const outputCtx = getOutputCtx(name);
    if (outputCtx && Array.isArray(outputCtx._target)) {
      outputCtx._target.push(...values);
    }
  }

  function pushUnsupportedTargetError(handlerName, pos) {
    const errUnsupported = handleError(
      new Error(`Unsupported output command target: ${handlerName}`),
      pos.lineno,
      pos.colno,
      handlerName,
      context ? context.path : null
    );
    state.collectedErrors.push(errUnsupported);
  }

  function processOutputCommand(item) {
    const handlerName = item.handler;
    const commandName = item.command;
    const subpath = item.subpath;
    const pos = getPosition(item);
    const args = item.arguments;
    if (collectPoisonArgs(args)) return;
    const target = resolveCommandTarget(handlerName);
    try {
      if (target.kind === 'unsupported') {
        pushUnsupportedTargetError(handlerName, pos);
        return;
      }

      if (target.kind === 'text') {
        const autoescape = env && env.opts ? env.opts.autoescape : false;
        if (state.scriptMode) {
          args.forEach((arg) => {
            const normalized = suppressValueScript(arg, autoescape);
            processItem(normalized);
          });
          return;
        }

        const normalizedArgs = args.map((arg) => suppressValue(arg, autoescape));
        const tempOutput = { _target: [] };
        const originalArgs = item.arguments;
        item.arguments = normalizedArgs;
        item.apply(tempOutput);
        item.arguments = originalArgs;
        emitText(target.name, tempOutput._target);
        return;
      }

      if (target.kind === 'value') {
        const outputCtx = getOutputCtx(handlerName);
        if (outputCtx) {
          item.apply(outputCtx);
          return;
        }
        if (!state.handlerInstances[handlerName]) {
          state.handlerInstances[handlerName] = {
            _value: undefined,
            getReturnValue() {
              return this._value;
            }
          };
        }
        const valueHolder = { _target: state.handlerInstances[handlerName]._value };
        item.apply(valueHolder);
        state.handlerInstances[handlerName]._value = valueHolder._target;
        return;
      }

      if (target.kind === 'data') {
        if (!target.instance) {
          pushUnsupportedTargetError(handlerName, pos);
          return;
        }
        const targetObject = resolveSubpath(target.instance, subpath, handlerName, pos);
        if (!targetObject) return;
        item.apply({ _base: targetObject });
        return;
      }

      if (target.kind === 'sink') {
        if (!target.output) {
          pushUnsupportedTargetError(handlerName, pos);
          return;
        }
        const sinkTarget = resolveSinkSubpath(target.output, subpath, handlerName, pos);
        if (!sinkTarget) return;
        item.apply({ _sink: sinkTarget });
      }
    } catch (err) {
      if (err instanceof RuntimeFatalError) {
        throw err;
      }
      const handled = handleError(
        err,
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath, commandName),
        context ? context.path : null
      );
      state.collectedErrors.push(handled);
    }
  }

  function processArrayItem(item) {
    item.forEach(processItem);
  }

  function processObjectItem(item) {
    const hasCustomToString = item.toString && item.toString !== Object.prototype.toString;
    const isPromise = typeof item.then === 'function';

    if (hasCustomToString || isPromise) {
      if (!outputName || isTextOutputNameFromState(state, outputName)) {
        emitText(outputName || 'text', [item]);
      }
      return;
    }

    if (item.text && (!outputName || isTextOutputNameFromState(state, outputName))) {
      emitText(outputName || 'text', [item.text]);
    }

    // Merge named handler values (e.g. {data: ...} from macro/call-block returns)
    // regardless of which output buffer is being flattened.
    Object.keys(item).forEach(key => {
      if (key === 'text') return;
      if (outputName && key !== outputName) return;
      if (key === 'data') {
        const instance = getOrInstantiateDataHandler('data');
        if (instance && typeof instance.merge === 'function') {
          instance.merge(null, item[key]);
        }
      }
    });
  }

  function processItem(item) {
    if (item === null || item === undefined) return;

    if (item instanceof Command) {
      if (item instanceof ErrorCommand) {
        const outputCtx = getOutputCtx(outputName || 'text');
        if (outputCtx) {
          item.apply(outputCtx);
        }
        if (item.value && item.value.errors) {
          state.collectedErrors.push(...item.value.errors);
        }
        return;
      }

      if (item instanceof OutputCommand) {
        processOutputCommand(item);
        return;
      }
    }

    if (isPoison(item)) {
      state.collectedErrors.push(...item.errors);
      return;
    }

    if (item instanceof CommandBuffer) {
      if (state.scriptMode && isTextOutputNameFromState(state, outputName || 'text')) {
        flattenCommandBuffer(item, context, null, state);
        return;
      }
      flattenCommandBuffer(item, context, outputName, state);
      return;
    }

    if (Array.isArray(item)) {
      processArrayItem(item);
      return;
    }

    if (typeof item === 'object') {
      processObjectItem(item);
      return;
    }

    // Fallback for primitive items from nested arrays that bypassed _wrapCommand.
    if (outputName !== null && !isTextOutputNameFromState(state, outputName)) {
      return;
    }

    emitText(outputName || 'text', [item]);
  }

  // Try chain-based iteration first (for CommandBuffers)
  // This validates the command chain implementation
  if (isCommandBuffer(arr)) {
    const handlerName = outputName || 'output';
    const first = arr.firstCommand(handlerName);
    if (first) {
      // Collect any poison values that are not part of the command chain
      const poisonErrors = getPosonedBufferErrors(arr, outputName ? [outputName] : null);
      if (poisonErrors && poisonErrors.length > 0) {
        state.collectedErrors.push(...poisonErrors);
      }
      let current = first;
      while (current) {
        processItem(current);
        current = current.next;
      }
    } else {
      // Chain not available, fall back to array iteration
      if (Array.isArray(arr)) {
        arr.forEach(processItem);
      } else {
        processItem(arr);
      }
    }

  } else {
    // Not a CommandBuffer - use array iteration
    if (Array.isArray(arr)) {
      arr.forEach(processItem);
    } else {
      processItem(arr);
    }
  }

  const finalize = () => {
    if (sharedState) {
      return state;
    }

    if (state.collectedErrors.length > 0) {
      throw new PoisonError(state.collectedErrors);
    }

    if (outputName) {
      return resolveOutputValue(state, outputName);
    }

    return buildFinalResultFromState(state);
  };

  return finalize();
}

module.exports = {
  flattenCommandBuffer,
  flattenCommands
};
