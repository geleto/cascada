'use strict';

//@todo - this will be completely rewritten and simplified togather
// with implementing proper snapshot() for outputs

const {
  CommandBuffer,
  resolveBufferArray,
  resolveOutputTargets,
  isCommandBuffer
} = require('./buffer');
const { PoisonError, RuntimeFatalError, isPoison, handleError } = require('./errors');
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
const { resolveAll } = require('./resolve');

const RESOLVE_MARKER = Symbol.for('cascada.resolve');

function flattenCommandBuffer(buffer, context, outputName, sharedState, flattenBuffer) {
  if (outputName) {
    const state = createFlattenState(sharedState, buffer._outputTypes || null);
    if (state.scriptMode === undefined && buffer && buffer._scriptMode !== undefined) {
      state.scriptMode = buffer._scriptMode;
    }
    if (state.outputHandlers === undefined && buffer && buffer._outputHandlers) {
      state.outputHandlers = buffer._outputHandlers;
    }
    const resultState = flattenBuffer(resolveBufferArray(buffer, outputName), context, outputName, state);
    if (sharedState) {
      return resultState;
    }
    if (resultState && typeof resultState.then === 'function') {
      return resultState.then((res) => {
        if (res && res.collectedErrors && res.collectedErrors.length > 0) {
          throw new PoisonError(res.collectedErrors);
        }
        return resolveOutputValue(res, outputName);
      });
    }
    if (resultState && resultState.collectedErrors && resultState.collectedErrors.length > 0) {
      throw new PoisonError(resultState.collectedErrors);
    }
    return resolveOutputValue(resultState, outputName);
  }

  if (!context) {
    const textArray = resolveBufferArray(buffer, 'text');
    const fallbackArray = (Array.isArray(textArray) && textArray.length > 0)
      ? textArray
      : resolveBufferArray(buffer, 'output');
    return flattenBuffer(fallbackArray, null, 'text', sharedState);
  }

  const state = createFlattenState(sharedState, buffer._outputTypes || null);
  if (state.scriptMode === undefined && buffer && buffer._scriptMode !== undefined) {
    state.scriptMode = buffer._scriptMode;
  }
  if (state.outputHandlers === undefined && buffer && buffer._outputHandlers) {
    state.outputHandlers = buffer._outputHandlers;
  }
  const outputTargets = resolveOutputTargets(buffer, null);
  const outputNames = outputTargets
    .map(target => target.name)
    .filter(name => name && name !== 'output');

  const orderedNames = outputNames.includes('text')
    ? ['text', ...outputNames.filter(name => name !== 'text')]
    : outputNames.slice();

  const pending = [];
  const queueFlatten = (name, arrayName) => {
    const res = flattenBuffer(resolveBufferArray(buffer, arrayName), context, name, state);
    if (res && typeof res.then === 'function') {
      pending.push(res);
    }
  };

  if (orderedNames.length === 0) {
    queueFlatten('text', 'output');
  } else {
    orderedNames.forEach((name) => {
      queueFlatten(name, name);
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

  if (pending.length > 0) {
    return Promise.all(pending).then(() => finalize());
  }

  return finalize();
}

function flattenCommands(arr, context, outputName, sharedState, flattenBuffer) {
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

  function hasAsyncArg(arg) {
    if (!arg) return false;
    if (typeof arg.then === 'function') return true;
    if (arg[RESOLVE_MARKER]) return true;
    if (Array.isArray(arg)) {
      return arg.some(hasAsyncArg);
    }
    return false;
  }

  async function resolveCommandArgs(args) {
    const resolved = await resolveAll(args);
    if (isPoison(resolved)) {
      return resolved;
    }
    const result = resolved.slice();
    for (let i = 0; i < result.length; i++) {
      const value = result[i];
      if (Array.isArray(value)) {
        const nested = await resolveAll(value);
        if (isPoison(nested)) {
          return nested;
        }
        result[i] = nested;
      }
    }
    return result;
  }

  function getOrInstantiateHandler(handlerName) {
    if (state.handlerInstances[handlerName]) {
      return state.handlerInstances[handlerName];
    }
    if (state.outputHandlers && state.outputHandlers[handlerName]) {
      const instance = state.outputHandlers[handlerName];
      state.handlerInstances[handlerName] = instance;
      return instance;
    }
    const declaredType = resolveOutputTypeFromState(state, handlerName);

    if (declaredType && declaredType !== handlerName && declaredType !== 'text') {
      if (env.commandHandlerInstances[declaredType]) {
        const instance = env.commandHandlerInstances[declaredType];
        if (typeof instance._init === 'function') {
          instance._init(context.getVariables());
        }
        state.handlerInstances[handlerName] = instance;
        return instance;
      }
      if (env.commandHandlerClasses[declaredType]) {
        const HandlerClass = env.commandHandlerClasses[declaredType];
        const instance = new HandlerClass(context.getVariables(), env);
        state.handlerInstances[handlerName] = instance;
        return instance;
      }
    }

    if (env.commandHandlerInstances[handlerName]) {
      const instance = env.commandHandlerInstances[handlerName];
      if (typeof instance._init === 'function') {
        instance._init(context.getVariables());
      }
      state.handlerInstances[handlerName] = instance;
      return instance;
    }
    if (env.commandHandlerClasses[handlerName]) {
      const HandlerClass = env.commandHandlerClasses[handlerName];
      const instance = new HandlerClass(context.getVariables(), env);
      state.handlerInstances[handlerName] = instance;
      return instance;
    }
    return null;
  }

  function resolveCommandTarget(handlerName) {
    const handlerType = resolveOutputTypeFromState(state, handlerName);
    const isTextHandler = !handlerName || handlerName === 'text' || handlerType === 'text';
    if (isTextHandler) {
      const targetName = (outputName && isTextOutputNameFromState(state, outputName))
        ? outputName
        : (handlerName || 'text');
      return { kind: 'text', name: targetName };
    }

    return { kind: 'handler', name: handlerName, instance: getOrInstantiateHandler(handlerName) };
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

  function emitText(name, values) {
    getTextOutputFromState(state, name).push(...values);
  }

  function processPoisonMarker(item) {
    if (item.errors && Array.isArray(item.errors)) {
      state.collectedErrors.push(...item.errors);
    }
  }

  function processCommandItem(item) {
    const handlerName = item.handler;
    const commandName = item.command;
    const subpath = item.subpath;
    const args = item.arguments;
    const pos = getPosition(item);

    if (collectPoisonArgs(args)) {
      return;
    }

    if (hasAsyncArg(args)) {
      asyncMode = true;
      queueAsync(() => processCommandItemAsync(item));
      return;
    }

    const target = resolveCommandTarget(handlerName);
    if (target.kind === 'text') {
      const autoescape = env && env.opts ? env.opts.autoescape : false;
      if (state.scriptMode) {
        args.forEach((arg) => {
          const normalized = suppressValueScript(arg, autoescape);
          processItem(normalized);
        });
      } else {
        args.forEach((arg) => {
          emitText(target.name, [suppressValue(arg, autoescape)]);
        });
      }
      return;
    }

    try {
      const handlerInstance = target.instance;
      if (!handlerInstance) {
        const err1 = handleError(
          new Error(`Unknown command handler: ${handlerName}`),
          pos.lineno,
          pos.colno,
          handlerName,
          context ? context.path : null
        );
        state.collectedErrors.push(err1);
        return;
      }

      const targetObject = resolveSubpath(handlerInstance, subpath, handlerName, pos);
      if (!targetObject) return;

      const commandFunc = commandName ? targetObject[commandName] : targetObject;

      if (typeof commandFunc === 'function') {
        commandFunc.apply(targetObject, args);
        return;
      }

      if (!commandName) {
        try {
          commandFunc(...args);
        } catch (e) {
          const err3 = handleError(
            new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} is not callable`),
            pos.lineno,
            pos.colno,
            `${handlerName}${subpath ? '.' + subpath.join('.') : ''}`,
            context ? context.path : null
          );
          state.collectedErrors.push(err3);
        }
        return;
      }

      const err5 = handleError(
        new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}'`),
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath, commandName),
        context ? context.path : null
      );
      state.collectedErrors.push(err5);
    } catch (err) {
      throw new RuntimeFatalError(
        err,
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath, commandName),
        context ? context.path : null
      );
    }
  }

  function flattenStringifiable(subArr) {
    const subErrors = [];
    const result = subArr.reduce((acc, current) => {
      if (isPoison(current)) {
        subErrors.push(...current.errors);
        return acc;
      }
      if (Array.isArray(current)) {
        return acc + flattenStringifiable(current);
      }
      return acc + ((current !== null && current !== undefined) ? current : '');
    }, '');

    if (subErrors.length > 0) {
      state.collectedErrors.push(...subErrors);
    }

    return result;
  }

  function processArrayItem(item) {
    const last = item.length > 0 ? item[item.length - 1] : null;
    if (typeof last === 'function') {
      const subArray = item.slice(0, -1);
      const subResult = flattenStringifiable(subArray);
      const finalResult = last(subResult);
      processItem(finalResult);
      return;
    }
    item.forEach(processItem);
  }

  function processObjectItem(item) {
    const hasCustomToString = item.toString && item.toString !== Object.prototype.toString;
    const isPromise = typeof item.then === 'function';

    if (hasCustomToString || isPromise) {
      emitText(outputName || 'text', [item]);
      return;
    }

    if (item.text) {
      emitText(outputName || 'text', [item.text]);
    }

    Object.keys(item).forEach(key => {
      if (key === 'text') return;
      if (key === 'data') {
        const instance = getOrInstantiateHandler('data');
        if (instance && typeof instance.merge === 'function') {
          instance.merge(null, item[key]);
        }
      }
    });
  }

  let asyncChain = null;
  let asyncMode = false;

  function queueAsync(fn) {
    asyncChain = asyncChain ? asyncChain.then(fn) : Promise.resolve().then(fn);
  }

  async function processCommandItemAsync(item) {
    const handlerName = item.handler;
    const commandName = item.command;
    const subpath = item.subpath;
    const args = item.arguments;
    const pos = getPosition(item);

    const resolvedArgs = await resolveCommandArgs(args);
    if (isPoison(resolvedArgs)) {
      state.collectedErrors.push(...resolvedArgs.errors);
      return;
    }

    if (collectPoisonArgs(resolvedArgs)) {
      return;
    }

    const target = resolveCommandTarget(handlerName);
    if (target.kind === 'text') {
      const autoescape = env && env.opts ? env.opts.autoescape : false;
      if (state.scriptMode) {
        resolvedArgs.forEach((arg) => {
          const normalized = suppressValueScript(arg, autoescape);
          processItem(normalized);
        });
      } else {
        resolvedArgs.forEach((arg) => {
          emitText(target.name, [suppressValue(arg, autoescape)]);
        });
      }
      return;
    }

    const handlerInstance = target.instance;
    if (!handlerInstance) {
      const err1 = handleError(
        new Error(`Unknown command handler: ${handlerName}`),
        pos.lineno,
        pos.colno,
        handlerName,
        context ? context.path : null
      );
      state.collectedErrors.push(err1);
      return;
    }

    const targetObject = resolveSubpath(handlerInstance, subpath, handlerName, pos);
    if (!targetObject) return;

    const isSinkHandler = targetObject && typeof targetObject._resolveSink === 'function';
    if (isSinkHandler) {
      const sink = await targetObject._resolveSink();
      if (!sink) return;
      const sinkCommand = commandName ? sink[commandName] : sink;
      if (typeof sinkCommand === 'function') {
        try {
          const result = sinkCommand.apply(sink, resolvedArgs);
          if (result && typeof result.then === 'function') {
            await result;
          }
          return;
        } catch (err) {
          throw new RuntimeFatalError(
            err,
            pos.lineno,
            pos.colno,
            formatHandlerRef(handlerName, subpath, commandName),
            context ? context.path : null
          );
        }
      }
      throw new RuntimeFatalError(
        new Error(`Sink method '${commandName}' not found`),
        pos.lineno,
        pos.colno,
        formatHandlerRef(handlerName, subpath, commandName),
        context ? context.path : null
      );
    }

    if (!targetObject) return;

    const commandFunc = commandName ? targetObject[commandName] : targetObject;

    if (typeof commandFunc === 'function') {
      try {
        commandFunc.apply(targetObject, resolvedArgs);
      } catch (err) {
        throw new RuntimeFatalError(
          err,
          pos.lineno,
          pos.colno,
          formatHandlerRef(handlerName, subpath, commandName),
          context ? context.path : null
        );
      }
      return;
    }

    if (!commandName) {
      try {
        commandFunc(...resolvedArgs);
      } catch (e) {
        const err3 = handleError(
          new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} is not callable`),
          pos.lineno,
          pos.colno,
          `${handlerName}${subpath ? '.' + subpath.join('.') : ''}`,
          context ? context.path : null
        );
        state.collectedErrors.push(err3);
      }
      return;
    }

    const err5 = handleError(
      new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}'`),
      pos.lineno,
      pos.colno,
      formatHandlerRef(handlerName, subpath, commandName),
      context ? context.path : null
    );
    state.collectedErrors.push(err5);
  }

  function processItem(item) {
    if (item === null || item === undefined) return;

    if (item.__cascadaPoisonMarker === true) {
      processPoisonMarker(item);
      return;
    }

    if (isPoison(item)) {
      state.collectedErrors.push(...item.errors);
      return;
    }

    if (item instanceof CommandBuffer) {
      if (state.scriptMode && isTextOutputNameFromState(state, outputName || 'text')) {
        flattenBuffer(item, context, null, state);
        return;
      }
      flattenBuffer(resolveBufferArray(item, outputName), context, outputName, state);
      return;
    }

    if (Array.isArray(item)) {
      processArrayItem(item);
      return;
    }

    // All buffer items are command objects — dispatch to handler
    if (item.handler !== undefined) {
      const handlerInstance = getOrInstantiateHandler(item.handler);
      const isSinkHandler = handlerInstance && typeof handlerInstance._resolveSink === 'function';
      if (isSinkHandler) {
        asyncMode = true;
        queueAsync(() => processCommandItemAsync(item));
        return;
      }
      if (asyncMode) {
        queueAsync(() => processCommandItemAsync(item));
        return;
      }
      processCommandItem(item);
      return;
    }

    // Fallback for items from nested arrays that bypassed _wrapCommand
    if (outputName !== null && !isTextOutputNameFromState(state, outputName)) {
      return;
    }

    if (typeof item === 'object') {
      processObjectItem(item);
      return;
    }

    emitText(outputName || 'text', [item]);
  }

  // Try chain-based iteration first (for CommandBuffers)
  // This validates the command chain implementation
  if (isCommandBuffer(arr)) {
    const usedChain = arr.traverseChain(outputName || 'output', (wrappedCmd) => {
      // Process the wrapped command's value
      processItem(wrappedCmd);
    });

    // If chain traversal succeeded, we're done
    if (usedChain) {
      // Chain iteration complete
    } else {
      // Chain not available, fall back to array iteration
      if (Array.isArray(arr)) {
        arr.forEach(processItem);
      } else {
        processItem(arr);
      }
    }
  } else {
    // Not a CommandBuffer or not in async mode - use array iteration
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

  if (asyncMode) {
    return asyncChain.then(() => finalize());
  }

  return finalize();
}

module.exports = {
  flattenCommandBuffer,
  flattenCommands
};
