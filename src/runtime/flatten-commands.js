'use strict';

const {
  CommandBuffer,
  resolveBufferArray,
  resolveOutputTargets,
  processReverts
} = require('./buffer');
const { PoisonError, RuntimeFatalError, isPoison, handleError } = require('./errors');
const {
  createFlattenState,
  resolveOutputTypeFromState,
  isTextOutputNameFromState,
  getTextOutputFromState,
  ensureBufferScopeMetadata,
  ensureFocusOutputExists,
  buildFinalResultFromState,
  resolveOutputNameReturn
} = require('./flatten-shared');

function flattenCommandBuffer(buffer, context, focusOutput, outputName, sharedState, flattenBuffer) {
  if (outputName) {
    const state = createFlattenState(sharedState, buffer._outputTypes || null);
    return flattenBuffer(resolveBufferArray(buffer, outputName), context, focusOutput, outputName, state);
  }

  if (!context) {
    const textArray = resolveBufferArray(buffer, 'text');
    const fallbackArray = (Array.isArray(textArray) && textArray.length > 0)
      ? textArray
      : resolveBufferArray(buffer, 'output');
    return flattenBuffer(fallbackArray, null, null, 'text', sharedState);
  }

  const state = createFlattenState(sharedState, buffer._outputTypes || null);
  ensureFocusOutputExists(context, state, focusOutput, buffer._outputTypes || null);

  const outputTargets = resolveOutputTargets(buffer, null);
  const outputNames = outputTargets
    .map(target => target.name)
    .filter(name => name && name !== 'output');

  const orderedNames = outputNames.includes('text')
    ? ['text', ...outputNames.filter(name => name !== 'text')]
    : outputNames.slice();

  if (orderedNames.length === 0) {
    flattenBuffer(resolveBufferArray(buffer, 'output'), context, null, 'text', state);
  } else {
    orderedNames.forEach((name) => {
      flattenBuffer(resolveBufferArray(buffer, name), context, null, name, state);
    });
  }

  if (sharedState) {
    return state;
  }

  if (state.collectedErrors.length > 0) {
    throw new PoisonError(state.collectedErrors);
  }

  const finalResult = buildFinalResultFromState(state);

  if (focusOutput) {
    if (focusOutput === 'text') {
      const textResult = state.textOutput.text ? state.textOutput.text.join('') : '';
      return textResult ? textResult : undefined;
    }
    if (state.textOutput[focusOutput]) {
      return state.textOutput[focusOutput].join('');
    }
    return finalResult[focusOutput];
  }

  return finalResult;
}

function flattenCommands(arr, context, focusOutput, outputName, sharedState, flattenBuffer) {
  if (Array.isArray(arr)) {
    ensureBufferScopeMetadata(arr);
    processReverts(arr, outputName);
  }

  const state = createFlattenState(sharedState, null);
  const env = context.env;

  ensureFocusOutputExists(context, state, focusOutput);

  function collectPoisonArgs(args) {
    for (const arg of args) {
      if (isPoison(arg)) {
        state.collectedErrors.push(...arg.errors);
        return true;
      }
    }
    return false;
  }

  function getOrInstantiateHandler(handlerName) {
    if (state.handlerInstances[handlerName]) {
      return state.handlerInstances[handlerName];
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
    return `@${handlerName}${pathSuffix}${commandSuffix}`;
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

    const target = resolveCommandTarget(handlerName);
    if (target.kind === 'text') {
      emitText(target.name, args);
      return;
    }

    try {
      const handlerInstance = target.instance;
      if (!handlerInstance) {
        const err1 = handleError(
          new Error(`Unknown command handler: ${handlerName}`),
          pos.lineno,
          pos.colno,
          `@${handlerName}`,
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
            `@${handlerName}${subpath ? '.' + subpath.join('.') : ''}`,
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

  function processItem(item) {
    if (item === null || item === undefined) return;

    if (item && typeof item === 'object' && item.__cascadaPoisonMarker === true) {
      processPoisonMarker(item);
      return;
    }

    if (isPoison(item)) {
      state.collectedErrors.push(...item.errors);
      return;
    }

    if (item instanceof CommandBuffer) {
      if (item._reverted) return;
      flattenBuffer(resolveBufferArray(item, outputName), context, null, outputName, state);
      return;
    }

    if (Array.isArray(item)) {
      processArrayItem(item);
      return;
    }

    if (typeof item === 'object' && (item.method || item.handler !== undefined)) {
      processCommandItem(item);
      return;
    }

    if (outputName !== null && !isTextOutputNameFromState(state, outputName)) {
      return;
    }

    if (typeof item === 'object') {
      processObjectItem(item);
      return;
    }

    emitText(outputName || 'text', [item]);
  }

  if (Array.isArray(arr)) {
    arr.forEach(processItem);
  } else {
    processItem(arr);
  }

  if (sharedState) {
    return state;
  }

  if (state.collectedErrors.length > 0) {
    throw new PoisonError(state.collectedErrors);
  }

  if (outputName) {
    return resolveOutputNameReturn(state, outputName, focusOutput, sharedState);
  }

  if (focusOutput) {
    if (isTextOutputNameFromState(state, focusOutput)) {
      const textArr = state.textOutput[focusOutput] || [];
      return textArr.join('');
    }
    const handler = state.handlerInstances[focusOutput];
    if (!handler) return undefined;
    return typeof handler.getReturnValue === 'function' ? handler.getReturnValue() : handler;
  }

  return buildFinalResultFromState(state);
}

module.exports = {
  flattenCommandBuffer,
  flattenCommands
};
