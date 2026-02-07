'use strict';

const { flattenBuffer } = require('./flatten-buffer');
const { CommandBuffer } = require('./buffer');
const { TextCommand, ValueCommand, DataCommand, SinkCommand } = require('./commands');
const { normalizeScriptTextArgs } = require('./safe-output');
const DataHandler = require('../script/data-handler');

class Output {
  constructor(frame, outputName, context, outputType = null) {
    this._frame = frame;
    this._outputName = outputName;//@todo rename to name
    this._outputType = outputType || outputName;//@todo rename to type
    this._context = context;
    this._buffer = frame ? frame._outputBuffer : null;
  }

  _enqueueCommand(command, args) {
    if (!this._buffer) return;
    let entry;
    if (this._outputType === 'text') {
      entry = new TextCommand({
        handler: this._outputName,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._outputType === 'value') {
      entry = new ValueCommand({
        handler: this._outputName,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._outputType === 'data') {
      entry = new DataCommand({
        handler: this._outputName,
        command: command || null,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else if (this._outputType === 'sink') {
      entry = new SinkCommand({
        handler: this._outputName,
        command: command || null,
        args,
        pos: { lineno: 0, colno: 0 }
      });
    } else {
      throw new Error(`Unsupported output type '${this._outputType}' for command enqueueing`);
    }
    this._buffer.add(entry, this._outputName);
  }

  _resolveSnapshotValue(result) {
    if (this._outputType === 'text') {
      if (Array.isArray(this._target)) {
        return this._target.join('');
      }
      return result;
    }
    if (this._base) {
      return typeof this._base.getReturnValue === 'function'
        ? this._base.getReturnValue()
        : this._base;
    }
    return this._target !== undefined ? this._target : result;
  }

  // Resolve the final value from _target/_base after flatten has populated them.
  // @todo - find a way to pass the errorContext rather than using the declaring context
  snapshot() {
    if (this._buffer) {
      const result = flattenBuffer(this);
      return this._resolveSnapshotValue(result);
    }

    // No CommandBuffer available; legacy array fallback removed.
    return this._outputName === 'text' ? '' : undefined;
  }
}

// Shared properties exposed on output facades (proxy/callable).
// These must read/write the underlying Output instance.
const OUTPUT_API_PROPS = new Set([
  '_outputName',
  '_outputType',
  '_frame',
  '_context',
  '_target',
  '_base',
  '_buffer'
]);

// Create a facade that can be callable (text/value) or dynamic-command (data).
// The proxy makes _target/_base/_buffer read/write-through to the Output instance
// so the flattener's writes are visible to snapshot().
function createOutputFacade(output, options) {
  const { callable, dynamicCommands } = options;
  const target = callable
    ? (...args) => output.invoke(...args)
    : output;

  return new Proxy(target, {
    get: (proxyTarget, prop) => {
      if (prop === 'snapshot') {
        return output.snapshot.bind(output);
      }
      if (OUTPUT_API_PROPS.has(prop)) {
        return output[prop];
      }
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return proxyTarget[prop];
      }
      if (dynamicCommands) {
        // Proxy allows arbitrary output commands (e.g., output.set(...)) without
        // predefining methods on the class. It preserves the dynamic command API.
        return (...args) => output._enqueueCommand(prop, args);
      }
      return proxyTarget[prop];
    },
    set: (proxyTarget, prop, value) => {
      if (OUTPUT_API_PROPS.has(prop)) {
        output[prop] = value;
        return true;
      }
      proxyTarget[prop] = value;
      return true;
    }
  });
}

class TextOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    super(frame, outputName, context, outputType);
    this._target = [];
  }

  invoke(...args) {
    if (!this._buffer) return;
    if (args.length === 0) return;
    const autoescape = this._context && this._context.env && this._context.env.opts
      ? this._context.env.opts.autoescape
      : false;
    this._enqueueCommand(null, normalizeScriptTextArgs(args, autoescape));
  }
}

class ValueOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    super(frame, outputName, context, outputType);
    this._target = undefined;
    this._base = null;
  }

  invoke(value) {
    if (!this._buffer) return;
    this._enqueueCommand(null, [value]);
  }
}

class DataOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    super(frame, outputName, context, outputType);
    this._target = {};
    const env = context && context.env ? context.env : null;
    this._base = new DataHandler(context && context.getVariables ? context.getVariables() : {}, env);
  }
}

function createOutput(frame, outputName, context, outputType = null) {
  const type = outputType || outputName;
  if (type === 'text') {
    // Text output is callable; args are appended to the text buffer.
    return createOutputFacade(new TextOutput(frame, outputName, context, type), {
      callable: true,
      dynamicCommands: false
    });
  }
  if (type === 'value') {
    // Value output is callable; args replace the current value.
    return createOutputFacade(new ValueOutput(frame, outputName, context, type), {
      callable: true,
      dynamicCommands: false
    });
  }
  // Data output supports arbitrary commands (set, push, merge, etc.).
  return createOutputFacade(new DataOutput(frame, outputName, context, type), {
    callable: false,
    dynamicCommands: true
  });
}

class SinkOutputHandler {
  constructor(frame, outputName, context, sink) {
    this._frame = frame;
    this._outputName = outputName;
    this._outputType = 'sink';
    this._context = context;
    this._sink = sink;
    this._target = undefined;
    this._base = null;
    this._buffer = frame ? frame._outputBuffer : null;
    this._sinkFinalized = false;
  }

  _resolveSink() {
    return this._sink;
  }

  _snapshotFromSink(sink) {
    if (!sink) return sink;
    if (typeof sink.snapshot === 'function') return sink.snapshot();
    if (typeof sink.getReturnValue === 'function') return sink.getReturnValue();
    if (typeof sink.finalize === 'function') return sink.finalize();
    return sink;
  }

  snapshot() {
    const runSnapshot = (resolvedSink) => {
      this._sink = resolvedSink;
      if (this._buffer) {
        flattenBuffer(this, this._context);
      }
      this._sinkFinalized = true;
      return this._snapshotFromSink(this._sink);
    };

    const sinkVal = this._resolveSink();
    if (sinkVal && typeof sinkVal.then === 'function') {
      return sinkVal.then((resolved) => runSnapshot(resolved));
    }

    return runSnapshot(sinkVal);
  }
}

function createSinkOutput(frame, outputName, context, sink) {
  return new SinkOutputHandler(frame, outputName, context, sink);
}

function getOutputHandler(frame, outputName) {
  let current = frame;
  while (current) {
    if (current._outputs && Object.prototype.hasOwnProperty.call(current._outputs, outputName)) {
      return current._outputs[outputName];
    }
    // Outputs follow the same scoping rules as variables: lexical parent chain only.
    current = current.parent;
  }
  return undefined;
}

function findOutputBuffer(frame) {
  let current = frame;
  while (current) {
    if (current._outputBuffer) {
      return current._outputBuffer;
    }
    if (current.outputScope) {
      break;
    }
    current = current.parent;
  }
  return null;
}

function declareOutput(frame, outputName, outputType, context, initializer = null) {
  frame._outputs = frame._outputs || Object.create(null);

  let buffer = findOutputBuffer(frame);
  if (!buffer) {
    buffer = new CommandBuffer(context, null);
    frame._outputBuffer = buffer;
  }

  if (!buffer._outputs) {
    buffer._outputs = frame._outputs;
  }
  buffer._outputTypes = buffer._outputTypes || Object.create(null);
  buffer._outputTypes[outputName] = outputType;

  const output = (outputType === 'sink')
    ? createSinkOutput(frame, outputName, context, initializer)
    : createOutput(frame, outputName, context, outputType);

  output._buffer = buffer;
  frame._outputs[outputName] = output;

  if (buffer._outputs && buffer._outputs !== frame._outputs) {
    buffer._outputs[outputName] = output;
  }

  if (outputType === 'sink') {
    buffer._outputHandlers = buffer._outputHandlers || Object.create(null);
    buffer._outputHandlers[outputName] = output;
  }

  return output;
}

function finalizeUnobservedSinks(frame, context) {
  if (!frame || !frame._outputs) {
    return undefined;
  }

  Object.keys(frame._outputs).forEach((name) => {
    const out = frame._outputs[name];
    if (!out || out._outputType !== 'sink' || out._sinkFinalized) {
      return;
    }
    try {
      // Snapshot owns sink finalization semantics and sink resolution.
      out.snapshot();
    } catch (e) {
      // Ignore unused sink errors by design.
    }
  });

  return undefined;
}

module.exports = {
  Output,
  DataOutput,
  TextOutput,
  ValueOutput,
  createOutput,
  SinkOutputHandler,
  createSinkOutput,
  getOutputHandler,
  declareOutput,
  findOutputBuffer,
  finalizeUnobservedSinks
};
