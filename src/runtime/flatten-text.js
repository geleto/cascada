'use strict';

const { CommandBuffer, resolveBufferArray, unwrapCommand } = require('./buffer');
const { ensureBufferScopeMetadata } = require('./flatten-shared');
const { PoisonError, isPoison, isPoisonError } = require('./errors');

function flattenText(arr, outputName, sharedState, flattenBuffer) {
  if (!Array.isArray(arr)) {
    return arr || '';
  }

  ensureBufferScopeMetadata(arr);

  const errors = [];
  const result = arr.reduce((acc, item) => {
    // Handle wrapped commands - extract the value
    const actualValue = unwrapCommand(item);

    if (actualValue && typeof actualValue === 'object' && actualValue.__cascadaPoisonMarker === true) {
      if (actualValue.errors && Array.isArray(actualValue.errors)) {
        errors.push(...actualValue.errors);
      }
      return acc;
    }

    if (isPoison(actualValue)) {
      errors.push(...actualValue.errors);
      return acc;
    }

    if (actualValue instanceof CommandBuffer) {
      try {
        return acc + flattenBuffer(resolveBufferArray(actualValue, outputName), null, null, outputName, sharedState);
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return acc;
      }
    }

    if (Array.isArray(actualValue)) {
      try {
        return acc + flattenBuffer(actualValue, null, null, outputName, sharedState);
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return acc;
      }
    }

    if (typeof actualValue === 'function') {
      return (actualValue(acc) || '');
    }

    return acc + ((actualValue !== null && actualValue !== undefined) ? actualValue : '');
  }, '');

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return result;
}

module.exports = {
  flattenText
};
