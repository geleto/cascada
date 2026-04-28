
import {memberLookupAsync, memberLookupScript} from './lookup.js';
import {callWrapAsync} from './call.js';
import {ensureSequentialPathChannel} from './checks.js';

function withSequentialPathChannel(currentBuffer, pathKey, errorContext, repair, isWrite, operation) {
  if (!currentBuffer) {
    throw new Error(
      `Sequential path '${pathKey}' requires a valid currentBuffer for ordered read/write execution`
    );
  }
  ensureSequentialPathChannel(currentBuffer, pathKey);
  const pos = { lineno: errorContext?.lineno ?? 0, colno: errorContext?.colno ?? 0 };
  return isWrite
    ? currentBuffer.addSequentialPathWrite(pathKey, operation, pos, repair)
    : currentBuffer.addSequentialPathRead(pathKey, operation, pos, repair);
}

function sequentialCallWrapValue(func, funcName, context, args, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChannel(currentBuffer, pathKey, errorContext, repair, true, () =>
    callWrapAsync(func, funcName, context, args, errorContext)
  );
}

function sequentialContextLookupValue(context, name, pathKey, repair = false, currentBuffer) {
  return withSequentialPathChannel(currentBuffer, pathKey, null, repair, false, () =>
    contextLookupOnly(context, name, pathKey)
  );
}

function sequentialMemberLookupAsyncValue(target, key, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChannel(currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupAsync(target, key, errorContext)
  );
}

function sequentialMemberLookupScriptValue(target, key, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChannel(currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupScript(target, key, errorContext)
  );
}

export { sequentialCallWrapValue, sequentialContextLookupValue, sequentialMemberLookupAsyncValue, sequentialMemberLookupScriptValue };

function contextLookupOnly(context, name, pathKey) {
  const value = context.lookup(name);
  if (value === undefined) {
    throw new Error(
      `Sequential path '${pathKey}' root '${name}' is not available in context`
    );
  }
  return value;
}
