'use strict';

const {
  memberLookupAsync,
  memberLookupScriptAsync
} = require('./lookup');
const { callWrapAsync } = require('./call');
const { ensureSequentialPathOutput } = require('./checks');

function withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, isWrite, operation) {
  ensureSequentialPathOutput(frame, pathKey);
  if (!currentBuffer || typeof currentBuffer.addSequentialPathWrite !== 'function' || typeof currentBuffer.addSequentialPathRead !== 'function') {
    throw new Error(
      `Sequential path '${pathKey}' requires a valid currentBuffer for ordered read/write execution`
    );
  }
  const pos = { lineno: errorContext?.lineno ?? 0, colno: errorContext?.colno ?? 0 };
  return isWrite
    ? currentBuffer.addSequentialPathWrite(pathKey, operation, pos, repair)
    : currentBuffer.addSequentialPathRead(pathKey, operation, pos, repair);
}

function sequentialCallWrapValue(func, funcName, context, args, frame, pathKey, errorContext, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, true, () =>
    callWrapAsync(func, funcName, context, args, errorContext)
  );
}

function sequentialContextLookupValue(context, frame, name, pathKey, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, null, repair, false, () =>
    contextLookupOnly(context, name, pathKey)
  );
}

function sequentialContextLookupScriptValue(context, frame, name, pathKey, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, null, repair, false, () =>
    contextLookupOnly(context, name, pathKey)
  );
}

function sequentialMemberLookupAsyncValue(frame, target, key, pathKey, errorContext, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupAsync(target, key, errorContext)
  );
}

function sequentialMemberLookupScriptAsyncValue(frame, target, key, pathKey, errorContext, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupScriptAsync(target, key, errorContext)
  );
}

module.exports = {
  sequentialCallWrapValue,
  sequentialContextLookupValue,
  sequentialContextLookupScriptValue,
  sequentialMemberLookupAsyncValue,
  sequentialMemberLookupScriptAsyncValue
};

function contextLookupOnly(context, name, pathKey) {
  const value = context.lookup(name);
  if (value === undefined) {
    throw new Error(
      `Sequential path '${pathKey}' root '${name}' is not available in context`
    );
  }
  return value;
}
