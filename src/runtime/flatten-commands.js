'use strict';

// Flatten populates Output._target / Output._base (via emitText / built-in handlers).
// snapshot() on Output objects reads from _target/_base after flatten completes.

const {
  CommandBuffer,
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
  resolveOutputValue,
  buildFinalResultFromState
} = require('./flatten-shared');

const BUILTIN_OUTPUT_TYPES = new Set(['data', 'text', 'value', 'sink']);

function flattenCommandBuffer(buffer, context, outputName, sharedState) {
  const targetOutputName = outputName || 'text';
  const effectiveContext = context || (buffer && buffer._context) || null;
  const state = createFlattenState(sharedState, buffer._outputTypes || null);
  if (state.outputHandlers === undefined && buffer && buffer._outputHandlers) {
    state.outputHandlers = buffer._outputHandlers;
  }
  if (!state.outputCtxs && buffer && buffer._outputs) {
    state.outputCtxs = buffer._outputs;
  }
  flattenCommands(buffer._getOutputArray(targetOutputName), effectiveContext, targetOutputName, state, true);

  const finalize = () => {
    if (sharedState) {
      return state;
    }

    if (state.collectedErrors.length > 0) {
      throw new PoisonError(state.collectedErrors);
    }

    return resolveOutputValue(state, targetOutputName);
  };

  return finalize();
}

function flattenCommands(arr, context, outputName, sharedState, fromCommandBuffer = false) {
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
        args.forEach((arg) => {
          processTextArg(arg);
        });
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
    if (fromCommandBuffer) {
      throw new RuntimeFatalError(
        new Error(`Unexpected raw array entry in template command buffer for output '${outputName || 'text'}'`),
        null,
        null,
        outputName || 'text',
        context ? context.path : null
      );
    }
    item.forEach(processItem);
  }

  function processObjectValue(item) {
    const hasCustomToString = item.toString && item.toString !== Object.prototype.toString;

    if (hasCustomToString) {
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

  function processObjectItem(item) {
    if (fromCommandBuffer) {
      throw new RuntimeFatalError(
        new Error(`Unexpected raw object entry in template command buffer for output '${outputName || 'text'}'`),
        null,
        null,
        outputName || 'text',
        context ? context.path : null
      );
    }
    processObjectValue(item);
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

    if (fromCommandBuffer) {
      throw new RuntimeFatalError(
        new Error(`Unexpected raw primitive entry in template command buffer for output '${outputName || 'text'}'`),
        null,
        null,
        outputName || 'text',
        context ? context.path : null
      );
    }

    // Legacy raw-array flattening path for non-CommandBuffer callers.
    if (outputName !== null && !isTextOutputNameFromState(state, outputName)) {
      return;
    }
    emitText(outputName || 'text', [item]);
  }

  function processTextArg(arg) {
    if (arg === null || arg === undefined) return;

    if (arg instanceof CommandBuffer) {
      flattenCommandBuffer(arg, context, outputName, state);
      return;
    }

    if (arg instanceof Command) {
      processItem(arg);
      return;
    }

    if (isPoison(arg)) {
      state.collectedErrors.push(...arg.errors);
      return;
    }

    if (Array.isArray(arg)) {
      processArrayItem(arg);
      return;
    }

    if (typeof arg === 'object') {
      processObjectValue(arg);
      return;
    }

    emitText(outputName || 'text', [arg]);
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
