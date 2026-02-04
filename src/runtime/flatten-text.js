'use strict';

const { CommandBuffer, resolveBufferArray } = require('./buffer');
const { ensureBufferScopeMetadata } = require('./flatten-shared');
const { PoisonError, isPoison, isPoisonError } = require('./errors');

function flattenText(arr, outputName, sharedState, flattenBuffer) {
  if (!Array.isArray(arr)) {
    return arr || '';
  }

  ensureBufferScopeMetadata(arr);

  const errors = [];
  const result = arr.reduce((acc, item) => {
    if (item === null || item === undefined) return acc;

    if (item.__cascadaPoisonMarker === true) {
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
        return acc + flattenBuffer(resolveBufferArray(item, outputName), null, outputName, sharedState);
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
        return acc + flattenBuffer(item, null, outputName, sharedState);
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        return acc;
      }
    }

    // Text command - extract the value. typeof guard needed because
    // Function.prototype.arguments throws in strict mode.
    const value = (item && typeof item === 'object' && item.arguments) ? item.arguments[0] : item;
    return acc + ((value !== null && value !== undefined) ? value : '');
  }, '');

  if (errors.length > 0) {
    throw new PoisonError(errors);
  }

  return result;
}

module.exports = {
  flattenText
};
