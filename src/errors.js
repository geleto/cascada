class CascadaError extends Error {
  constructor(name, message, context, options = {}) {
    const {
      cause: explicitCause = null
    } = options;

    super(message || '', { cause: explicitCause });

    this.name = name;
    this.context = context;
    this.lineno = context.lineno;
    this.colno = context.colno;
    this.path = context.path;
    this.label = context.label;
  }

  toString() {
    return this.message;
  }
}

class CompileError extends CascadaError {
  static _formatMessage(message, { lineno, colno, label, path }) {
    let prefix = '(' + (path || 'unknown path') + ')';

    if (lineno && colno) {
      prefix += ` [Line ${lineno}, Column ${colno}]`;
    } else if (lineno) {
      prefix += ` [Line ${lineno}]`;
    }

    if (label) {
      prefix += ` ${label}`;
    }

    return `CompileError: ${message || ''}\n${prefix}`;
  }

  constructor(message, options = {}) {
    const {
      lineno = null,
      colno = null,
      label = null,
      path = null,
      cause = null
    } = options;
    const context = { lineno, colno, label, path };
    const description = message || '';

    super(
      'CompileError',
      CompileError._formatMessage(description, context),
      context,
      { cause }
    );
    this.description = description;
    this.fullMessage = this.message;
  }
}

function isCompileError(error) {
  return error instanceof CompileError;
}

export { CascadaError, CompileError, isCompileError };
