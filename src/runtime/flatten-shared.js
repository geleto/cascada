'use strict';

function createFlattenState(sharedState, outputTypes) {
  if (sharedState) return sharedState;
  return {
    textOutput: Object.create(null),
    handlerInstances: {},
    collectedErrors: [],
    outputTypes: outputTypes || null
  };
}

function resolveOutputTypeFromState(state, name) {
  if (!state.outputTypes || !name) return null;
  return state.outputTypes[name] || null;
}

function isTextOutputNameFromState(state, name) {
  return name === 'text' || resolveOutputTypeFromState(state, name) === 'text';
}

function getTextOutputFromState(state, name) {
  const key = name || 'text';
  if (!state.textOutput[key]) {
    state.textOutput[key] = [];
  }
  return state.textOutput[key];
}

function buildFinalResultFromState(state) {
  const finalResult = {};
  const defaultTextArr = state.textOutput.text || [];
  const textResult = defaultTextArr.join('');
  if (textResult) finalResult.text = textResult;

  Object.keys(state.textOutput).forEach((name) => {
    if (name === 'text') return;
    const textArr = state.textOutput[name];
    if (textArr && textArr.length > 0) {
      finalResult[name] = textArr.join('');
    }
  });

  Object.keys(state.handlerInstances).forEach(handlerName => {
    const handler = state.handlerInstances[handlerName];
    if (typeof handler.getReturnValue === 'function') {
      finalResult[handlerName] = handler.getReturnValue();
    } else {
      finalResult[handlerName] = handler;
    }
  });

  return finalResult;
}

function resolveOutputValue(state, outputName) {
  const isText = isTextOutputNameFromState(state, outputName);
  if (isText) {
    const textArr = state.textOutput[outputName] || [];
    return textArr.join('');
  }
  const handler = state.handlerInstances[outputName];
  if (!handler) {
    return undefined;
  }
  return typeof handler.getReturnValue === 'function' ? handler.getReturnValue() : handler;
}

function ensureBufferScopeMetadata(buffer) {
  if (!Array.isArray(buffer)) return;
  if (buffer._outputScopeRoot === undefined) {
    buffer._outputScopeRoot = true;
  }
  if (buffer._hasRevert === undefined) {
    buffer._hasRevert = false;
  }
}

module.exports = {
  createFlattenState,
  resolveOutputTypeFromState,
  isTextOutputNameFromState,
  getTextOutputFromState,
  buildFinalResultFromState,
  resolveOutputValue,
  ensureBufferScopeMetadata
};
