'use strict';

const { flattenBuffer } = require('./flatten-buffer');
const { CommandBuffer } = require('./buffer');

class Output {
  constructor(frame, outputName, context, outputType = null) {
    this._frame = frame;
    this._outputName = outputName;
    this._outputType = outputType || outputName;
    this._context = context;
    this._buffer = frame ? frame._outputBuffer : null;
  }

  _enqueueCommand(command, args) {
    if (!this._buffer) return;
    const entry = {
      handler: this._outputName,
      command: command || null,
      arguments: args,
      pos: { lineno: 0, colno: 0 }
    };
    this._buffer.add(entry, this._outputName);
  }

  // Resolve the final value from _target/_base after flatten has populated them.
  // @todo - find a way to pass the errorContext rather than using the declaring context
  snapshot() {
    if (this._buffer) {
      return flattenBuffer(this);
    }

    // No CommandBuffer available; legacy array fallback removed.
    return this._outputName === 'text' ? '' : undefined;
  }
}

function attachOutputApi(target, output) {
  target.snapshot = output.snapshot.bind(output);
  target._outputName = output._outputName;
  target._outputType = output._outputType;
  target._frame = output._frame;
  target._context = output._context;
  // _target and _base are mutable accumulator state; use live bindings
  // so that the flattener's writes to outputCtx._target propagate to the
  // underlying Output instance and snapshot() can read them.
  Object.defineProperty(target, '_target', {
    get() { return output._target; },
    set(v) { output._target = v; },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(target, '_base', {
    get() { return output._base; },
    set(v) { output._base = v; },
    enumerable: true,
    configurable: true
  });
  Object.defineProperty(target, '_buffer', {
    get() { return output._buffer; },
    set(v) { output._buffer = v; },
    enumerable: true,
    configurable: true
  });
  return target;
}

class TextOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    super(frame, outputName, context, outputType);
    this._target = [];
  }

  invoke(...args) {
    if (!this._buffer) return;
    if (args.length === 0) return;
    this._enqueueCommand(null, args);
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
    this._base = null;
  }
}

function createOutputProxy(output) {
  // Proxy is required so output instances can handle arbitrary commands
  // (e.g. myData.set(...) / myData.merge(...)) without predefining methods.
  return new Proxy(output, {
    get: (target, prop) => {
      if (prop === 'snapshot') {
        return target.snapshot.bind(target);
      }
      if (prop === '_outputName' || prop === '_outputType' || prop === '_frame' || prop === '_context' || prop === '_target' || prop === '_base' || prop === '_buffer') {
        return target[prop];
      }
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return target[prop];
      }
      // Proxy allows arbitrary output commands (e.g., output.set(...)) without
      // predefining methods on the class. It preserves the dynamic command API.
      return (...args) => target._enqueueCommand(prop, args);
    }
  });
}

function createCallableOutput(output) {
  const handler = (...args) => output.invoke(...args);
  return attachOutputApi(handler, output);
}

function createOutput(frame, outputName, context, outputType = null) {
  const type = outputType || outputName;
  if (type === 'text') {
    return createCallableOutput(new TextOutput(frame, outputName, context, type));
  }
  if (type === 'value') {
    return createCallableOutput(new ValueOutput(frame, outputName, context, type));
  }
  return createOutputProxy(new DataOutput(frame, outputName, context, type));
}

class SinkOutputHandler {
  constructor(frame, outputName, context, sink) {
    this._frame = frame;
    this._outputName = outputName;
    this._context = context;
    this._sink = sink;
    this._target = undefined;
    this._base = null;
    this._buffer = frame ? frame._outputBuffer : null;
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
    const buffer = this._buffer;
    const outputName = this._outputName || null;
    const finalize = (resolvedSink) => this._snapshotFromSink(resolvedSink);

    if (buffer) {
      // Ensure commands execute once (cached) before resolving the sink value.
      const flattened = flattenBuffer(this, this._context);
      if (flattened && typeof flattened.then === 'function') {
        return flattened.then(() => {
          const sinkVal = this._resolveSink();
          if (sinkVal && typeof sinkVal.then === 'function') {
            return sinkVal.then((resolved) => finalize(resolved));
          }
          return finalize(sinkVal);
        });
      }
    }

    const sinkVal = this._resolveSink();
    if (sinkVal && typeof sinkVal.then === 'function') {
      return sinkVal.then((resolved) => finalize(resolved));
    }
    return finalize(sinkVal);
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

function declareOutput(frame, outputName, outputType, context, initializer = null, isScript = false) {
  frame._outputs = frame._outputs || Object.create(null);

  let buffer = findOutputBuffer(frame);
  if (!buffer) {
    buffer = new CommandBuffer(context, null);
    frame._outputBuffer = buffer;
    if (isScript) {
      buffer._scriptMode = true;
    }
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
  findOutputBuffer
};
