const RESERVED_ADDED_CONTEXT_KEYS = new Set([
  'label',
  'lineno',
  'colno',
  'path',
  'renderState'
]);

function prepareErrorContexts(path, renderState, labels, specs) {
  return specs.map(([lineno, colno, label, addedContext = null]) => [
    lineno,
    colno,
    typeof label === 'number' ? labels[label] : label,
    path ?? null,
    addedContext,
    renderState ?? null
  ]);
}

function isCompactErrorContext(context) {
  return Array.isArray(context) && context.length === 6;
}

function assertCompactErrorContext(errorContext) {
  if (!isCompactErrorContext(errorContext)) {
    throw new TypeError('Expected compact error context');
  }
}

function getAddedContext(errorContext) {
  assertCompactErrorContext(errorContext);
  return errorContext[4] ?? null;
}

function getRenderState(errorContext) {
  assertCompactErrorContext(errorContext);
  return errorContext[5] ?? null;
}

function validateAddedContext(addedContext) {
  if (!addedContext) {
    return;
  }
  if (typeof addedContext !== 'object' || Array.isArray(addedContext)) {
    throw new TypeError('Added context must be an object when provided');
  }
  for (const key of RESERVED_ADDED_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(addedContext, key)) {
      throw new TypeError(`Added context cannot contain source field '${key}'`);
    }
  }
}

function cloneContext(errorContext) {
  assertCompactErrorContext(errorContext);
  const existingAddedContext = getAddedContext(errorContext);
  validateAddedContext(existingAddedContext);
  return [
    errorContext[0] ?? null,
    errorContext[1] ?? null,
    errorContext[2] ?? null,
    errorContext[3] ?? null,
    existingAddedContext ? { ...existingAddedContext } : null,
    errorContext[5] ?? null
  ];
}

function cloneWithAddedContext(errorContext, addedContext = null) {
  return mergeAddedContext(cloneContext(errorContext), addedContext);
}

function setContextLabel(errorContext, label) {
  assertCompactErrorContext(errorContext);
  errorContext[2] = label ?? null;
  return errorContext;
}

function mergeAddedContext(errorContext, addedContext) {
  assertCompactErrorContext(errorContext);
  validateAddedContext(addedContext);
  const mergedAddedContext = {
    ...(getAddedContext(errorContext) || {}),
    ...(addedContext || {})
  };
  errorContext[4] = Object.keys(mergedAddedContext).length > 0
    ? mergedAddedContext
    : null;
  return errorContext;
}

export {
  prepareErrorContexts,
  isCompactErrorContext,
  assertCompactErrorContext,
  getAddedContext,
  getRenderState,
  cloneContext,
  cloneWithAddedContext,
  mergeAddedContext,
  setContextLabel,
  validateAddedContext
};
