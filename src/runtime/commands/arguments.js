import {
  isPoison,
  poisonOrReport,
} from '../errors.js';
import {isResolvedValue, resolveSingle, thenValue, unwrapResolvedValue} from '../resolve.js';

// `value` is always a command's argument array (ChainCommand: `this.arguments = args || []`).
// Resolve each entry's top-level value (and its lazy RESOLVE_MARKER) before applying.
// A failed argument becomes poison in its own slot, so the command still applies with the rest.
function runCommandWithResolvedArguments(value, cmd, applyFn) {
  const resolvedArgs = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const resolved = resolveSingle(value[i]);
    if (isResolvedValue(resolved)) {
      resolvedArgs[i] = unwrapResolvedValue(resolved);
      continue;
    }
    if (isPoison(resolved)) {
      resolvedArgs[i] = resolved;
      continue;
    }
    return thenValue(
      runCommandWithResolvedArgumentsAsync(value, resolvedArgs, i, resolved, cmd),
      applyFn
    );
  }
  return applyFn(resolvedArgs);
}

async function runCommandWithResolvedArgumentsAsync(value, resolvedArgs, startIndex, firstResolved, cmd) {
  for (let i = startIndex; i < value.length; i++) {
    const resolved = i === startIndex ? firstResolved : resolveSingle(value[i]);
    if (isResolvedValue(resolved)) {
      resolvedArgs[i] = unwrapResolvedValue(resolved);
      continue;
    }
    if (isPoison(resolved)) {
      resolvedArgs[i] = resolved;
      continue;
    }
    try {
      resolvedArgs[i] = await resolved;
    } catch (err) {
      resolvedArgs[i] = poisonOrReport(err, cmd.errorContext);
    }
  }
  return resolvedArgs;
}

export {runCommandWithResolvedArguments};
