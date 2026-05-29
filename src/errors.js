class CascadaError extends Error {
  static _formatMessage(message, { lineno, colno, label, path }, options = {}) {
    const {
      alwaysPrefix = false,
      separator = ' : '
    } = options;

    if (!alwaysPrefix && lineno == null && colno == null && label == null && path == null) {
      return message || '';
    }

    let prefix = '(' + (path || 'unknown path') + ')';

    if (lineno && colno) {
      prefix += ` [Line ${lineno}, Column ${colno}]`;
    } else if (lineno) {
      prefix += ` [Line ${lineno}]`;
    }

    if (label) {
      prefix += ` doing '${label}'`;
    }

    return `${prefix}${separator}${message || ''}`;
  }

  constructor(name, message, context, options = {}) {
    const {
      cause: explicitCause = null
    } = options;

    super(CascadaError._formatMessage(message, context, options), { cause: explicitCause });

    this.name = name;
    this.lineno = context.lineno;
    this.colno = context.colno;
    this.path = context.path;
    this.label = context.label;
  }
}

class CompileError extends CascadaError {
  constructor(message, options = {}) {
    const {
      lineno = null,
      colno = null,
      label = null,
      path = null,
      cause = null
    } = options;

    super(
      'CompileError',
      message,
      { lineno, colno, label, path },
      { cause, alwaysPrefix: true, separator: '\n  ' }
    );
  }
}

export { CascadaError, CompileError };
