'use strict';

const outputArgResolutionErrors = new WeakSet();

function markOutputArgResolutionErrors(errors) {
  if (!Array.isArray(errors)) {
    return errors;
  }
  for (const err of errors) {
    if (!err || (typeof err !== 'object' && typeof err !== 'function')) {
      continue;
    }
    outputArgResolutionErrors.add(err);
  }
  return errors;
}

function isOutputArgResolutionError(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) {
    return false;
  }
  return outputArgResolutionErrors.has(err);
}

module.exports = {
  markOutputArgResolutionErrors,
  isOutputArgResolutionError
};

