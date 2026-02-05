'use strict';

/**
 * Command classes for the script-mode output pipeline.
 *
 * Each command carries the data needed to mutate an Output object (ctx).
 * The flattener calls command.apply(outputCtx) in source order; ctx is the
 * Output instance for the target handler.
 *
 * apply() mutates ctx in place; callers must not rely on return values.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

class Command {
  apply(ctx) {
    throw new Error('Command.apply() must be overridden');
  }
}

// ---------------------------------------------------------------------------
// TextCommand  –  pushes escaped value into ctx._target (array)
// ---------------------------------------------------------------------------

class TextCommand extends Command {
  constructor(value) {
    super();
    this.value = value;
  }

  apply(ctx) {
    ctx._target.push(this.value);
  }
}

// ---------------------------------------------------------------------------
// ValueCommand  –  replaces ctx._target with the new value
// ---------------------------------------------------------------------------

class ValueCommand extends Command {
  constructor(value) {
    super();
    this.value = value;
  }

  apply(ctx) {
    ctx._target = this.value;
  }
}

// ---------------------------------------------------------------------------
// HandlerCommand  –  shared base for commands that dispatch to ctx._base
// ---------------------------------------------------------------------------

class HandlerCommand extends Command {
  constructor(subpath) {
    super();
    this.subpath = subpath || null;
  }
}

// ---------------------------------------------------------------------------
// DataCommand  –  dispatches to ctx._base (DataHandler)
//   path      – path array for the data handler method
//   command   – method name on the handler (e.g. 'set', 'push')
//   args      – argument array passed to the method
// ---------------------------------------------------------------------------

class DataCommand extends HandlerCommand {
  constructor(path, command, args) {
    super(null);
    this.path = path;
    this.command = command;
    this.args = args;
  }

  apply(ctx) {
    // _base must already be resolved before apply is called
    if (!ctx._base) return;
    const method = this.command ? ctx._base[this.command] : ctx._base;
    if (typeof method === 'function') {
      method.apply(ctx._base, this.args);
    }
  }
}

// ---------------------------------------------------------------------------
// SinkCommand  –  dispatches to ctx._base (resolved sink)
//   command   – method name on the sink
//   args      – argument array
//   subpath   – subpath into the handler before the sink
// ---------------------------------------------------------------------------

class SinkCommand extends HandlerCommand {
  constructor(command, args, subpath) {
    super(subpath);
    this.command = command;
    this.args = args;
  }

  apply(ctx) {
    // _base must already be resolved before apply is called
    if (!ctx._base) return;
    const method = this.command ? ctx._base[this.command] : ctx._base;
    if (typeof method === 'function') {
      method.apply(ctx._base, this.args);
    }
  }
}

// ---------------------------------------------------------------------------
// ErrorCommand  –  replaces ctx._target with a PoisonedValue
//   value  – the PoisonedValue to store
// ---------------------------------------------------------------------------

class ErrorCommand extends Command {
  constructor(value) {
    super();
    this.value = value;
  }

  apply(ctx) {
    ctx._target = this.value;
  }
}

module.exports = {
  Command,
  TextCommand,
  ValueCommand,
  HandlerCommand,
  DataCommand,
  SinkCommand,
  ErrorCommand
};
