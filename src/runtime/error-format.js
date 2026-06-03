function formatDiagnosticInfo(info) {
  const { stack, ...context } = info;
  const lines = [formatDiagnosticContext(context)];

  if (Array.isArray(stack) && stack.length > 0) {
    appendFormattedDiagnosticStack(lines, stack, context);
  }

  return lines.join('\n');
}

function formatDiagnosticMessage(name, message, context, options = {}) {
  const { headerLines = null, stack = null } = options;
  const lines = formatDiagnosticHeader(name, message, headerLines);
  if (name !== 'PoisonErrorGroup') {
    lines.push(formatDiagnosticContext(context));
  }
  if (stack) {
    appendFormattedDiagnosticStack(lines, stack, context);
  }
  return lines.join('\n');
}

function formatDiagnosticHeader(name, message, headerLines = null) {
  if (headerLines) {
    return headerLines.slice();
  }
  return [`${name}: ${message || ''}`];
}

function formatNumberedDiagnostic(index, message) {
  const lines = String(message || '').split('\n');
  const prefix = `  ${index + 1}. `;
  const indent = ' '.repeat(prefix.length);
  return [
    `${prefix}${lines[0] || ''}`,
    ...lines.slice(1).map(line => `${indent}${line}`)
  ].join('\n');
}

function formatPoisonErrorGroupMessages(errors, kinds, limit) {
  const totalErrorCount = errors.length;
  const displayedErrors = errors.slice(0, limit);
  const errorLabel = totalErrorCount === 1 ? 'error' : 'errors';
  const header = totalErrorCount > limit
    ? `PoisonErrorGroup (${totalErrorCount} ${errorLabel}, showing ${displayedErrors.length}) of ${kinds.length} kinds (${kinds.join(', ')}):`
    : `PoisonErrorGroup (${totalErrorCount} ${errorLabel}):`;
  return {
    messageLines: [
      header,
      ...displayedErrors.map((error, index) => formatNumberedDiagnostic(index, error.message))
    ],
    fullMessageLines: [
      header,
      ...displayedErrors.map((error, index) => formatNumberedDiagnostic(index, error.fullMessage))
    ]
  };
}

function appendFormattedDiagnosticStack(lines, stack, primaryContext = null) {
  const primary = primaryContext ? formatDiagnosticContext(primaryContext) : null;
  const stackFrames = primary && stack.length > 0 && formatDiagnosticContext(stack[0]) === primary
    ? stack.slice(1)
    : stack;

  if (stackFrames.length === 0) {
    return;
  }

  lines.push('Stack:');
  stackFrames.forEach((frame, index) => {
    lines.push(`  ${index + 1}. ${formatDiagnosticContext(frame)}`);
  });
}

function formatDiagnosticContext(context) {
  const known = new Set(['path', 'lineno', 'colno', 'label', 'renderState']);
  const operation = formatDiagnosticOperation(context);
  formatDiagnosticConsumedKeys(context).forEach(key => known.add(key));
  const location = formatDiagnosticLocation(context);
  const extras = Object.keys(context)
    .filter(key => !known.has(key) && hasDiagnosticValue(context[key]))
    .map(formatDiagnosticExtra.bind(null, context));
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `${location}${operation ? ` ${operation}` : ''}${suffix}`;
}

function formatDiagnosticLocation(context) {
  const path = context.path || 'unknown path';
  const line = context.lineno ?? '?';
  const column = context.colno ?? '?';
  return `(${path}) [Line ${line}, Column ${column}]`;
}

function formatDiagnosticOperation(context) {
  if (context.label === 'FunCall') {
    if (context.callSignature || context.callableName) {
      return `call ${context.callSignature || context.callableName}`;
    }
    return 'FunCall';
  }
  if (context.label === 'Macro') {
    return `macro ${context.macroSignature || context.macroName || 'anonymous'}`;
  }
  if (context.methodSignature) {
    return `method ${context.methodSignature}`;
  }
  return context.label || '';
}

function formatDiagnosticConsumedKeys(context) {
  if (context.label === 'FunCall') {
    return ['callableName', 'callSignature', 'caller'];
  }
  if (context.label === 'Macro') {
    return ['macroName', 'macroSignature'];
  }
  return ['methodSignature'];
}

function formatDiagnosticExtra(context, key) {
  if (context[key] === true) {
    return formatDiagnosticKey(key);
  }
  return `${formatDiagnosticKey(key)}=${formatDiagnosticValue(context[key], new Set())}`;
}

function hasDiagnosticValue(value) {
  return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
}

function formatDiagnosticKey(key) {
  return key.replace(/[A-Z]/g, char => ` ${char.toLowerCase()}`);
}

function formatDiagnosticValue(value, seen) {
  if (value && typeof value.then === 'function') {
    return '?';
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const result = `[${value.map(item => formatDiagnosticValue(item, seen)).join(', ')}]`;
    seen.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const result = `{ ${Object.keys(value)
      .map(key => `${formatDiagnosticKey(key)}: ${formatDiagnosticValue(value[key], seen)}`)
      .join(', ')} }`;
    seen.delete(value);
    return result;
  }
  return String(value);
}

export { formatDiagnosticInfo, formatDiagnosticMessage, formatNumberedDiagnostic, formatPoisonErrorGroupMessages };
