'use strict';

const { flattenBuffer } = require('./flatten-buffer');

class Output {
  constructor(frame, outputName, context, outputType = null) {
    this._frame = frame;
    this._outputName = outputName;
    this._outputType = outputType || outputName;
    this._context = context;
  }

  _normalizeDataArgs(args) {
    if (!args || args.length === 0) return args;
    const path = args[0];
    if (typeof path === 'string') {
      return [[path], ...args.slice(1)];
    }
    return args;
  }

  _enqueueCommand(command, args) {
    if (!this._frame || !this._frame._outputBuffer) return;
    let normalizedArgs = args;
    if (this._outputType === 'data') {
      normalizedArgs = this._normalizeDataArgs(args);
    }
    const entry = {
      handler: this._outputName,
      command: command || null,
      arguments: normalizedArgs,
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
      // Skip the implicit "output" handler so templates keep legacy behavior.
      if (this._outputName && this._outputName !== 'output' && typeof buffer._getOutputArray === 'function') {
        const target = buffer._getOutputArray(this._outputName);
        if (!target || target.length === 0) {
          if (this._outputType === 'data') return {};
          if (this._outputType === 'text') return '';
          if (this._outputType === 'value') return undefined;
        }
      }
      return flattenBuffer(buffer, this._context, focusName || null);
    }

    const outputArray = this._frame[this._outputName];
    if (!outputArray) {
      return this._outputName === 'text' ? '' : undefined;
    }

    return flattenBuffer(outputArray, this._context, focusName || null, this._outputName);
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
    args.forEach((value) => {
      this._frame._outputBuffer.add(value, this._outputName);
    });
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
  constructor(sink) {
    this._sink = sink;
    // Sink initializers may be async; cache the promise and resolve once.
    this._sinkPromise = null;
    if (sink && typeof sink.then === 'function') {
      this._sink = null;
      this._sinkPromise = sink.then((resolved) => {
        this._sink = resolved;
        return resolved;
      });
    }
  }

  _resolveSink() {
    // Always return a promise to simplify proxy forwarding.
    if (this._sinkPromise) {
      return this._sinkPromise;
    }
    return Promise.resolve(this._sink);
  }

  _snapshotFromSink(sink) {
    if (!sink) return sink;
    if (typeof sink.snapshot === 'function') return sink.snapshot();
    if (typeof sink.getReturnValue === 'function') return sink.getReturnValue();
    if (typeof sink.finalize === 'function') return sink.finalize();
    return sink;
  }

  snapshot() {
    // Snapshot waits for async sink initializers, then delegates to sink hooks.
    if (this._sinkPromise) {
      return this._sinkPromise.then((resolved) => this._snapshotFromSink(resolved));
    }
    return this._snapshotFromSink(this._sink);
  }
}

function createSinkOutput(sink) {
  const output = new SinkOutputHandler(sink);
  return new Proxy(output, {
    get: (target, prop) => {
      if (prop === 'snapshot') {
        return target.snapshot.bind(target);
      }
      if (prop === '_sink') {
        return sink;//return target._sink;
      }
      if (prop === 'then') {
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return target[prop];
      }
      // Proxy forwards any method/property to the underlying sink object,
      // keeping the sink API transparent to templates/scripts.
      if (target._sinkPromise) {
        // Lazy-resolve async sinks before forwarding.
        return (...args) => target._resolveSink().then((resolved) => {
          if (!resolved) return undefined;
          const value = resolved[prop];
          if (typeof value === 'function') {
            return value.apply(resolved, args);
          }
          return value;
        });
      }
      const value = sink ? sink[prop] : undefined;
      if (typeof value === 'function') {
        return value.bind(sink);
      }
      return value;
    }
  });
}

function getOutputHandler(frame, outputName) {
  let current = frame;
  while (current) {
    if (current._outputs && Object.prototype.hasOwnProperty.call(current._outputs, outputName)) {
      return current._outputs[outputName];
    }
    // Allow macro/caller scopes to expose outputs via _outputParent.
    current = current.parent || current._outputParent;
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
