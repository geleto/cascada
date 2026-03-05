'use strict';

const {
  memberLookupAsync,
  memberLookupScriptAsync,
  contextOrFrameLookup,
  contextOrValueLookupScriptAsync
} = require('./lookup');
const { callWrapAsync } = require('./call');
const { ensureSequentialPathOutput } = require('./checks');

function withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, isWrite, operation) {
  ensureSequentialPathOutput(frame, pathKey);
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

function sequentialCallWrap(func, funcName, context, args, frame, writeKey, readKey, errorContext, repair = false, currentBuffer = null) {
  return sequentialCallWrapValue(func, funcName, context, args, frame, writeKey, errorContext, repair, currentBuffer);
}

function sequentialContextLookupValue(context, frame, name, pathKey, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, null, repair, false, () =>
    contextOrFrameLookup(context, frame, name)
  );
}

function sequentialContextLookup(context, frame, name, writeKey, readKey, repair = false, currentBuffer = null) {
  return sequentialContextLookupValue(context, frame, name, writeKey, repair, currentBuffer);
}

function sequentialContextLookupScriptValue(context, frame, name, pathKey, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, null, repair, false, () =>
    contextOrValueLookupScriptAsync(context, frame, name, currentBuffer)
  );
}

function sequentialContextLookupScript(context, frame, name, writeKey, readKey, repair = false, currentBuffer = null) {
  return sequentialContextLookupScriptValue(context, frame, name, writeKey, repair, currentBuffer);
}

function sequentialMemberLookupAsyncValue(frame, target, key, pathKey, errorContext, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupAsync(target, key, errorContext)
  );
}

function sequentialMemberLookupAsync(frame, target, key, writeKey, readKey, errorContext, repair = false, currentBuffer = null) {
  return sequentialMemberLookupAsyncValue(frame, target, key, writeKey, errorContext, repair, currentBuffer);
}

function sequentialMemberLookupScriptAsyncValue(frame, target, key, pathKey, errorContext, repair = false, currentBuffer = null) {
  return withSequentialPathOutput(frame, currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupScriptAsync(target, key, errorContext)
  );
}

function sequentialMemberLookupScriptAsync(frame, target, key, writeKey, readKey, errorContext, repair = false, currentBuffer = null) {
  return sequentialMemberLookupScriptAsyncValue(frame, target, key, writeKey, errorContext, repair, currentBuffer);
}

module.exports = {
  sequentialCallWrap,
  sequentialCallWrapValue,
  sequentialContextLookup,
  sequentialContextLookupValue,
  sequentialContextLookupScript,
  sequentialContextLookupScriptValue,
  sequentialMemberLookupAsync,
  sequentialMemberLookupAsyncValue,
  sequentialMemberLookupScriptAsync,
  sequentialMemberLookupScriptAsyncValue
};
