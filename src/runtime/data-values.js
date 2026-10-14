import {RESOLVE_MARKER, isWrappedResolvedValue, unwrapResolvedValue} from './resolve.js';
import {isPoison, isPoisonError, PoisonError} from './errors.js';

function isDataRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !(Symbol.asyncIterator in value);
}

// Clone records and arrays; return async iterables and class instances unchanged.
function cloneDataValue(value) {
  if (Array.isArray(value) && !(Symbol.asyncIterator in value)) return value.map(item => cloneDataValue(item));
  if (!isDataRecord(value)) return value;
  const clone = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const item = cloneDataValue(value[key]);
    if (key === '__proto__') {
      Object.defineProperty(clone, key, {value: item, enumerable: true, writable: true, configurable: true});
    } else {
      clone[key] = item;
    }
  }
  return clone;
}

function inspectTargetForErrors(target) {
  const state = {
    seenObjects: new Set(),
    queuedMarkers: new Set(),
    errors: [],
    pending: []
  };

  visitTargetForErrors(target, state);

  if (state.pending.length > 0) {
    return inspectPendingTargetErrors(state);
  }

  return getInspectionError(state.errors);
}

async function inspectPendingTargetErrors(state) {
  let checked = 0;
  let fatalError = null;
  // Pending inspection callbacks can discover more pending work while this
  // function awaits. Drain in waves so every discovered promise gets a handler.
  // If any branch reports a fatal error, keep draining first to avoid late
  // unhandled rejections, then rethrow the first fatal error.
  while (checked < state.pending.length) {
    const batch = state.pending.slice(checked);
    checked = state.pending.length;
    const results = await Promise.allSettled(batch);
    for (const result of results) {
      if (result.status === 'rejected' && !fatalError) {
        fatalError = result.reason;
      }
    }
  }
  if (fatalError) {
    throw fatalError;
  }
  return getInspectionError(state.errors);
}

function getInspectionError(errors) {
  return errors.length === 0 ? null : PoisonError.group(errors);
}

function addInspectionError(state, err) {
  if (err) {
    state.errors.push(err);
  }
}

function addInspectionErrors(state, list) {
  if (!Array.isArray(list)) {
    return;
  }
  for (const err of list) {
    addInspectionError(state, err);
  }
}

function collectOrThrowInspectionError(state, err) {
  if (isPoisonError(err)) {
    addInspectionErrors(state, err.errors);
    return;
  }
  // This diagnostic walker has no source context of its own; raw
  // promise/marker failures must surface unchanged as fatal errors.
  throw err;
}

function queueResolvedInspection(value, state, onResolved) {
  state.pending.push(Promise.resolve(value).then(
    onResolved,
    (err) => collectOrThrowInspectionError(state, err)
  ));
}

function queueMarkerInspection(value, state) {
  if (state.queuedMarkers.has(value)) {
    return;
  }
  state.queuedMarkers.add(value);
  // Once the marker has finalized the object in place, revisit the same object
  // but skip marker handling so normal array/object traversal can inspect the
  // resolved leaves.
  queueResolvedInspection(value[RESOLVE_MARKER], state, () => visitTargetForErrors(value, state, true));
}

function visitTargetForErrors(value, state, markerAlreadyResolved = false) {
  if (isWrappedResolvedValue(value)) {
    visitTargetForErrors(unwrapResolvedValue(value), state, markerAlreadyResolved);
    return;
  }

  if (isPoison(value)) {
    addInspectionErrors(state, value.errors);
    return;
  }

  if (value && typeof value.then === 'function') {
    queueResolvedInspection(value, state, (resolved) => visitTargetForErrors(resolved, state));
    return;
  }

  if (value && value[RESOLVE_MARKER] && !markerAlreadyResolved) {
    queueMarkerInspection(value, state);
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (state.seenObjects.has(value)) {
    return;
  }
  state.seenObjects.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      visitTargetForErrors(entry, state);
    }
    return;
  }

  if (isDataRecord(value)) {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Error inspection must not trigger accessor side effects on external objects.
      if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
        continue;
      }
      visitTargetForErrors(value[key], state);
    }
  }
}

// Inspect fully settled data without starting asynchronous work.
function inspectSettledTargetForErrors(target) {
  const seenObjects = new Set();
  const errors = [];

  const visit = (value) => {
    if (isPoison(value)) {
      errors.push(...value.errors);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    if (isPoisonError(value)) {
      throw new TypeError('DataChain target contains a raw PoisonError instead of a PoisonedValue');
    }
    if (typeof value.then === 'function' || value[RESOLVE_MARKER]) {
      throw new TypeError('DataChain target contains an unresolved async value after command application');
    }
    if (seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!isDataRecord(value)) {
      return;
    }

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
        continue;
      }
      visit(value[key]);
    }
  };

  visit(target);

  return errors.length === 0 ? null : PoisonError.group(errors);
}

export {isDataRecord, cloneDataValue, inspectTargetForErrors, inspectSettledTargetForErrors};
