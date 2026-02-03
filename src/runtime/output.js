'use strict';

const { flattenBuffer } = require('./flatten-buffer');

class Output {
  constructor(frame, outputName, context, outputType = null) {
    this._frame = frame;
    this._outputName = outputName;
    this._outputType = outputType || outputName;
    this._context = context;
  }

  _enqueueCommand(command, args) {
    if (!this._frame || !this._frame._outputBuffer) return;
    const entry = {
      handler: this._outputName,
      command: command || null,
      arguments: args,
      pos: { lineno: 0, colno: 0 }
    };
    this._frame._outputBuffer.add(entry, this._outputName);
  }

  // @todo - get rid of focusOverride later
  snapshot() {
    const focus = this._outputName === 'output' ? null : this._outputName;
    return this._snapshotFocus(focus);
  }

  _snapshotFocus(focusName) {
    const buffer = this._frame._outputBuffer;
    if (buffer) {
      // For explicit outputs, preserve default empty snapshots without flattening.
      // Skip this shortcut in script mode because focused data snapshots can
      // depend on Result Objects emitted to the text stream.
      if (!buffer._scriptMode &&
          this._outputName &&
          this._outputName !== 'output' &&
          typeof buffer._getOutputArray === 'function') {
        const target = buffer._getOutputArray(this._outputName);
        if (!target || target.length === 0) {
          if (this._outputType === 'data') return {};
          if (this._outputType === 'text') return '';
          if (this._outputType === 'value') return undefined;
        }
      }
      const outputName = null;//(this._outputName && this._outputName !== 'output') ? this._outputName : null;
      const result = flattenBuffer(buffer, this._context, focusName || null, outputName);
      if (!buffer._scriptMode || this._outputName === 'output') {
        return result;
      }
      const applyDefault = (value) => {
        if (value !== undefined) return value;
        if (this._outputType === 'data') return {};
        if (this._outputType === 'text') return '';
        if (this._outputType === 'value') return undefined;
        return value;
      };
      if (result && typeof result.then === 'function') {
        return result.then((value) => applyDefault(value));
      }
      return applyDefault(result);
    }

    const outputArray = this._frame[this._outputName];
    if (!outputArray) {
      return this._outputName === 'text' ? '' : undefined;
    }

    const outputName = (this._outputName && this._outputName !== 'output') ? this._outputName : null;
    return flattenBuffer(outputArray, this._context, focusName || null, outputName);
  }
}

function attachOutputApi(target, output) {
  target.snapshot = output.snapshot.bind(output);
  target._snapshotFocus = output._snapshotFocus.bind(output);
  target._outputName = output._outputName;
  target._outputType = output._outputType;
  target._frame = output._frame;
  target._context = output._context;
  return target;
}

class TextOutput extends Output {
  invoke(...args) {
    if (!this._frame || !this._frame._outputBuffer) return;
    if (args.length === 0) return;
    this._enqueueCommand(null, args);
  }
}

class ValueOutput extends Output {
  invoke(value) {
    if (!this._frame || !this._frame._outputBuffer) return;
    this._enqueueCommand(null, [value]);
  }
}

class DataOutput extends Output {}

function createOutputProxy(output) {
  // Proxy is required so output instances can handle arbitrary commands
  // (e.g. myData.set(...) / myData.merge(...)) without predefining methods.
  return new Proxy(output, {
    get: (target, prop) => {
      if (prop === 'snapshot') {
        return target.snapshot.bind(target);
      }
      if (prop === '_snapshotFocus') {
        return target._snapshotFocus.bind(target);
      }
      if (prop === '_outputName' || prop === '_outputType' || prop === '_frame' || prop === '_context') {
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
    const buffer = this._frame ? this._frame._outputBuffer : null;
    const outputName = this._outputName || null;
    const finalize = (resolvedSink) => this._snapshotFromSink(resolvedSink);

    if (buffer) {
      const flattened = flattenBuffer(buffer, this._context, outputName);
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

module.exports = {
  Output,
  DataOutput,
  TextOutput,
  ValueOutput,
  createOutput,
  SinkOutputHandler,
  createSinkOutput,
  getOutputHandler
};
