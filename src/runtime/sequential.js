
import {memberLookupAsync, memberLookupScript} from './lookup.js';
import {callWrapAsync} from './call.js';
import {ensureSequentialPathChain} from './checks.js';
import {
  SequentialPathReadCommand,
  RepairReadCommand,
  SequentialPathWriteCommand,
  RepairWriteCommand,
} from './commands/sequential-path.js';

function withSequentialPathChain(currentBuffer, pathKey, errorContext, repair, isWrite, operation) {
  if (!currentBuffer) {
    throw new Error(
      `Sequential path '${pathKey}' requires a valid currentBuffer for ordered read/write execution`
    );
  }
  ensureSequentialPathChain(currentBuffer, pathKey);
  const pos = { lineno: errorContext?.lineno ?? 0, colno: errorContext?.colno ?? 0 };
  const CommandClass = isWrite
    ? (repair ? RepairWriteCommand : SequentialPathWriteCommand)
    : (repair ? RepairReadCommand : SequentialPathReadCommand);
  return currentBuffer.addCommand(new CommandClass({
    chainName: pathKey,
    pathKey,
    operation,
    pos
  }), pathKey);
}

function sequentialCallWrapValue(func, funcName, context, args, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChain(currentBuffer, pathKey, errorContext, repair, true, () =>
    callWrapAsync(func, funcName, context, args, errorContext)
  );
}

function sequentialContextLookupValue(context, name, pathKey, repair = false, currentBuffer) {
  return withSequentialPathChain(currentBuffer, pathKey, null, repair, false, () =>
    contextLookupOnly(context, name, pathKey)
  );
}

function sequentialMemberLookupAsyncValue(target, key, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChain(currentBuffer, pathKey, errorContext, repair, false, () =>
    memberLookupAsync(target, key, errorContext)
  );
}

function sequentialMemberLookupScriptValue(target, key, pathKey, errorContext, repair = false, currentBuffer) {
  return withSequentialPathChain(currentBuffer, pathKey, errorContext, repair, false, () =>
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
