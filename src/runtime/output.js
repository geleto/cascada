'use strict';

const { TextCommand, ValueCommand, DataCommand, SinkCommand } = require('./commands');
const { normalizeScriptTextArgs } = require('./safe-output');
const DataHandler = require('../script/data-handler');
const { BufferIterator } = require('./buffer-iterator');
const { PoisonError, isPoisonError } = require('./errors');

class Output {
  constructor(frame, outputName, context, outputType = null, target = undefined, base = null) {
    this._frame = frame;
    this._outputName = outputName;//@todo rename to name
    this._outputType = outputType || outputName;//@todo rename to type
    this._context = context;
    this._buffer = frame ? frame._outputBuffer : null;
    this._target = target;
    this._base = base;

    this._iterator = new BufferIterator(this);
    this._errors = [];
    this._completionResolved = false;
    this._completionPromise = new Promise((resolve) => {
      this._resolveCompletion = resolve;
    });

    if (this._buffer && this._buffer._registerOutput) {
      this._buffer._registerOutput(this._outputName, this);
    } else if (this._buffer && this._buffer._outputs instanceof Map) {
      this._buffer._outputs.set(this._outputName, this);
      this._iterator.bindToCurrentBuffer();
    }
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

  getCurrentResult() {
    throw new Error(`Output type '${this._outputType}' must implement getCurrentResult()`);
  }

  _recordError(err) {
    if (!err) return;
    if (isPoisonError(err)) {
      if (Array.isArray(err.errors) && err.errors.length > 0) {
        this._errors.push(...err.errors);
      }
      return;
    }
    this._errors.push(err);
  }

  _applyCommand(cmd) {
    if (!cmd) return;
    try {
      const result = cmd.apply(this);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((err) => {
          this._recordError(err);
        });
      }
    } catch (err) {
      this._recordError(err);
    }
  }

  _onIteratorFinished() {
    if (this._completionResolved) {
      return;
    }
    this._completionResolved = true;
    this._resolveCompletion();
  }

  _buildSnapshotPromise() {
    return this._completionPromise.then(() => {
      if (this._errors.length > 0) {
        throw new PoisonError(this._errors.slice());
      }
      return this.getCurrentResult();
    });
  }

  // Resolve the final value from _target/_base after flatten has populated them.
  // @todo - find a way to pass the errorContext rather than using the declaring context
  snapshot() {
    if (this._buffer) {
      if (!this._iterator.finished) {
        if (this._errors.length > 0) {
          throw new PoisonError(this._errors.slice());
        }
        return this.getCurrentResult();
      }
      return this._buildSnapshotPromise();
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
  '_buffer',
  '_iterator',
  '_errors',
  '_completionResolved'
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
      if (prop === 'getCurrentResult') {
        return output.getCurrentResult.bind(output);
      }
      if (prop === '_applyCommand') {
        return output._applyCommand.bind(output);
      }
      if (prop === '_onIteratorFinished') {
        return output._onIteratorFinished.bind(output);
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
    super(frame, outputName, context, outputType, [], null);
  }

  invoke(...args) {
    if (!this._buffer) return;
    if (args.length === 0) return;
    const autoescape = this._context && this._context.env && this._context.env.opts
      ? this._context.env.opts.autoescape
      : false;
    this._enqueueCommand(null, normalizeScriptTextArgs(args, autoescape));
  }

  getCurrentResult() {
    if (!Array.isArray(this._target) || this._target.length === 0) {
      this._target = [''];
      return '';
    }
    const result = this._target.join('');
    // Compact accumulated fragments so future appends keep O(1)-ish growth.
    this._target = [result];
    return result;
  }
}

class ValueOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    super(frame, outputName, context, outputType, undefined, null);
  }

  invoke(value) {
    if (!this._buffer) return;
    this._enqueueCommand(null, [value]);
  }

  getCurrentResult() {
    return this._target;
  }
}

class DataOutput extends Output {
  constructor(frame, outputName, context, outputType) {
    const env = context && context.env ? context.env : null;
    super(
      frame,
      outputName,
      context,
      outputType,
      {},
      new DataHandler(context && context.getVariables ? context.getVariables() : {}, env)
    );
  }

  getCurrentResult() {
    return this._base && typeof this._base.getReturnValue === 'function'
      ? this._base.getReturnValue()
      : this._base;
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
    this._iterator = new BufferIterator(this);
    this._errors = [];
    this._completionResolved = false;
    this._completionPromise = new Promise((resolve) => {
      this._resolveCompletion = resolve;
    });
    this._sinkReady = false;
    this._sinkReadyPromise = null;

    if (this._buffer && this._buffer._registerOutput) {
      this._buffer._registerOutput(this._outputName, this);
    } else if (this._buffer && this._buffer._outputs instanceof Map) {
      this._buffer._outputs.set(this._outputName, this);
      this._iterator.bindToCurrentBuffer();
    }
  }

  _resolveSink() {
    return this._sink;
  }

  _ensureSinkResolved() {
    if (this._sinkReady) {
      return this._sink;
    }
    if (!this._sinkReadyPromise) {
      const sinkVal = this._resolveSink();
      if (!sinkVal || typeof sinkVal.then !== 'function') {
        this._sink = sinkVal;
        this._sinkReady = true;
        return this._sink;
      }
      this._sinkReadyPromise = Promise.resolve(sinkVal)
        .then((resolvedSink) => {
          this._sink = resolvedSink;
          this._sinkReady = true;
          return resolvedSink;
        });
    }
    return this._sinkReadyPromise;
  }

  _recordError(err) {
    if (!err) return;
    if (isPoisonError(err)) {
      if (Array.isArray(err.errors) && err.errors.length > 0) {
        this._errors.push(...err.errors);
      }
      return;
    }
    this._errors.push(err);
  }

  _applyCommand(cmd) {
    if (!cmd) return;
    try {
      const sink = this._ensureSinkResolved();
      const apply = () => cmd.apply(this);
      const result = (sink && typeof sink.then === 'function')
        ? Promise.resolve(sink).then(apply)
        : apply();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((err) => {
          this._recordError(err);
        });
      }
    } catch (err) {
      this._recordError(err);
    }
  }

  _onIteratorFinished() {
    if (this._completionResolved) {
      return;
    }
    this._completionResolved = true;
    this._resolveCompletion();
  }

  _snapshotFromSink(sink) {
    if (!sink) return sink;
    if (typeof sink.snapshot === 'function') return sink.snapshot();
    if (typeof sink.getReturnValue === 'function') return sink.getReturnValue();
    if (typeof sink.finalize === 'function') return sink.finalize();
    return sink;
  }

  getCurrentResult() {
    return this._snapshotFromSink(this._sink);
  }

  snapshot() {
    if (!this._buffer) {
      return this.getCurrentResult();
    }

    if (!this._iterator.finished) {
      if (this._errors.length > 0) {
        throw new PoisonError(this._errors.slice());
      }
      const sinkVal = this._ensureSinkResolved();
      if (sinkVal && typeof sinkVal.then === 'function') {
        return sinkVal.then((resolved) => this._snapshotFromSink(resolved));
      }
      return this._snapshotFromSink(sinkVal);
    }

    return this._completionPromise.then(async () => {
      await this._ensureSinkResolved();
      if (this._errors.length > 0) {
        throw new PoisonError(this._errors.slice());
      }
      this._sinkFinalized = true;
      return this._snapshotFromSink(this._sink);
    });
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
    // No implicit CommandBuffer creation here by design.
    // Buffer ownership/creation must come from root/managed scope-root/async block setup.
    throw new Error(`Output "${outputName}" declared without an active CommandBuffer`);
  }

  buffer._outputTypes = buffer._outputTypes || Object.create(null);
  buffer._outputTypes[outputName] = outputType;

  const output = (outputType === 'sink')
    ? createSinkOutput(frame, outputName, context, initializer)
    : createOutput(frame, outputName, context, outputType);

  output._buffer = buffer;
  frame._outputs[outputName] = output;

  if (buffer._registerOutput) {
    buffer._registerOutput(outputName, output);
  } else if (buffer._outputs instanceof Map) {
    buffer._outputs.set(outputName, output);
    output._iterator.bindToCurrentBuffer();
  }

  if (outputType === 'sink') {
    buffer._outputHandlers = buffer._outputHandlers || Object.create(null);
    buffer._outputHandlers[outputName] = output;
  }

  return output;
}

function finalizeUnobservedSinks(frame, context) {
  // No-op: sink commands execute on the fly as iterator progresses.
  // Unobserved sink errors remain non-fatal and are surfaced only by snapshot().
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
