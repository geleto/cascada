'use strict';

const { CommandBuffer } = require('./buffer');
const { ensureBufferScopeMetadata } = require('./flatten-shared');
const { RuntimeFatalError } = require('./errors');

function flattenText(arr, outputName, sharedState, flattenBuffer) {
  if (!Array.isArray(arr)) {
    return arr || '';
  }

  ensureBufferScopeMetadata(arr);

  const result = arr.reduce((acc, item) => {
    if (item === null || item === undefined) return acc;

    if (item instanceof CommandBuffer) {
      throw new RuntimeFatalError(`Unexpected CommandBuffer in flattenText for output '${outputName || 'text'}'`);
    }

    if (Array.isArray(item)) {
      return acc + flattenBuffer(item, null, outputName, sharedState);
    }

    return acc + item;
  }, '');

  return result;
}

module.exports = {
  flattenText
};
