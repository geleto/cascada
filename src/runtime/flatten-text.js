'use strict';

const { CommandBuffer, resolveBufferArray, processReverts } = require('./buffer');
const { ensureBufferScopeMetadata } = require('./flatten-shared');
const { PoisonError, isPoison, isPoisonError } = require('./errors');

function flattenText(arr, outputName, sharedState, flattenBuffer) {
  if (!Array.isArray(arr)) {
    return arr || '';
  }

  ensureBufferScopeMetadata(arr);
  processReverts(arr, outputName);

  const errors = [];
  const result = arr.reduce((acc, item) => {
    if (item && typeof item === 'object' && item.__cascadaPoisonMarker === true) {
      if (item.errors && Array.isArray(item.errors)) {
        errors.push(...item.errors);
      }
      return acc;
    }

    if (isPoison(item)) {
      errors.push(...item.errors);
      return acc;
    }

    if (item instanceof CommandBuffer) {
      try {
        return acc + flattenBuffer(resolveBufferArray(item, outputName), null, null, outputName, sharedState);
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return acc;
      }
    }

    if (Array.isArray(item)) {
      try {
        return acc + flattenBuffer(item, null, null, outputName, sharedState);
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return acc;
      }
    }

    if (typeof item === 'function') {
      return (item(acc) || '');
    }

    return acc + ((item !== null && item !== undefined) ? item : '');
  }, '');

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return result;
}

module.exports = {
  flattenText
};
