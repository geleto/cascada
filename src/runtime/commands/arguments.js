import {
  isPoison,
  poisonOrReport,
} from '../errors.js';
import {RESOLVE_MARKER, unwrapResolvedValue} from '../resolve.js';

// `value` is always a command's argument array (ChainCommand: `this.arguments = args || []`).
// Resolve each entry's top-level value (and its lazy RESOLVE_MARKER) before applying.
// A failed argument becomes poison in its own slot, so the command still applies with the rest.
function runCommandWithResolvedArguments(value, cmd, applyFn) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === undefined) {
      continue;
    }
    const fastValue = unwrapResolvedValue(value[i]);
    if (fastValue !== value[i]) {
      value[i] = fastValue;
    }
    if (isPoison(fastValue)) {
      continue;
    }
    if (fastValue && (typeof fastValue.then === 'function' || fastValue[RESOLVE_MARKER])) {
      return runCommandWithResolvedArgumentsAsync(value, cmd, applyFn);
    }
  }

  return applyFn(value);
}

async function runCommandWithResolvedArgumentsAsync(value, cmd, applyFn) {
  const resolvedArray = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    // Resolve each entry to its concrete value: await a promise (if any), then finalize a
    // lazy RESOLVE_MARKER (if any). A failure poisons only this slot; poison is stored as-is.
    let resolved = unwrapResolvedValue(value[i]);
    try {
      if (resolved && typeof resolved.then === 'function' && !isPoison(resolved)) {
        resolved = await resolved;
      }
      if (resolved && resolved[RESOLVE_MARKER]) {
        await resolved[RESOLVE_MARKER];
      }
    } catch (err) {
      resolved = classifyCommandArgumentFailure(cmd, err);
    }
    resolvedArray[i] = resolved;
  }
  return applyFn(resolvedArray);
}

function classifyCommandArgumentFailure(cmd, err) {
  return poisonOrReport(err, cmd.errorContext);
}

export {runCommandWithResolvedArguments};
