import {
  isPoison,
  markPromiseHandled,
  poisonOrReport,
} from '../errors.js';
import {RESOLVE_MARKER, isResolvedValue, unwrapResolvedValue} from '../resolve.js';

function runWithResolvedArguments(value, cmd, applyFn) {
  if (Array.isArray(value)) {
    let hasAsync = false;

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
      if (!fastValue || (typeof fastValue.then !== 'function' && !fastValue[RESOLVE_MARKER])) {
        continue;
      }
      hasAsync = true;
      break;
    }

    if (!hasAsync) {
      return applyFn(value);
    }

    return runWithResolvedArgumentsAsync(value, cmd, applyFn);
  }

  if (value === undefined) {
    return applyFn(undefined);
  }

  value = unwrapResolvedValue(value);
  if (isPoison(value) || !value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return applyFn(value);
  }

  if (value[RESOLVE_MARKER]) {
    return value[RESOLVE_MARKER].then(() => {
      return applyFn(value);
    }, (err) => {
      return applyFn(classifyCommandArgumentFailure(cmd, err));
    });
  }

  return value.then((resolvedValue) => {
    if (resolvedValue && resolvedValue[RESOLVE_MARKER]) {
      return resolvedValue[RESOLVE_MARKER].then(() => applyFn(resolvedValue));
    }
    return applyFn(resolvedValue);
  }, (err) => {
    return applyFn(classifyCommandArgumentFailure(cmd, err));
  });
}

async function runWithResolvedArgumentsAsync(value, cmd, applyFn) {
  const resolvedArray = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === undefined) {
      resolvedArray[i] = undefined;
      continue;
    }
    const fastValue = unwrapResolvedValue(entry);
    if (isPoison(fastValue) || !fastValue || (typeof fastValue.then !== 'function' && !fastValue[RESOLVE_MARKER])) {
      resolvedArray[i] = fastValue;
      continue;
    }
    if (fastValue[RESOLVE_MARKER]) {
      try {
        await fastValue[RESOLVE_MARKER];
        resolvedArray[i] = fastValue;
      } catch (err) {
        resolvedArray[i] = classifyCommandArgumentFailure(cmd, err);
      }
      continue;
    }

    try {
      const resolvedValue = await fastValue;
      if (resolvedValue && resolvedValue[RESOLVE_MARKER]) {
        try {
          await resolvedValue[RESOLVE_MARKER];
          resolvedArray[i] = resolvedValue;
        } catch (err) {
          resolvedArray[i] = classifyCommandArgumentFailure(cmd, err);
        }
      } else {
        resolvedArray[i] = resolvedValue;
      }
    } catch (err) {
      resolvedArray[i] = classifyCommandArgumentFailure(cmd, err);
    }
  }
  return applyFn(resolvedArray);
}

function classifyCommandArgumentFailure(cmd, err) {
  return poisonOrReport(err, cmd.errorContext);
}

function isHandledDeferredPromise(value) {
  return value instanceof Promise;
}

function markDeferredThenablesHandled(value, seen = null) {
  if (value === null || value === undefined) {
    return;
  }

  if (isPoison(value)) {
    return;
  }

  if (isResolvedValue(value)) {
    return;
  }

  const nextSeen = seen || new WeakSet();
  if (typeof value === 'object' || typeof value === 'function') {
    if (nextSeen.has(value)) {
      return;
    }
    nextSeen.add(value);
  }

  if (isHandledDeferredPromise(value)) {
    markPromiseHandled(value);
    return;
  }

  if (value && isHandledDeferredPromise(value[RESOLVE_MARKER])) {
    markPromiseHandled(value[RESOLVE_MARKER]);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      markDeferredThenablesHandled(entry, nextSeen);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      markDeferredThenablesHandled(value[key], nextSeen);
    }
  }
}

export {runWithResolvedArguments, markDeferredThenablesHandled};
