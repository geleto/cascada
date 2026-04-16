'use strict';

const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');
const { createInheritanceState } = require('./inheritance-state');
const { declareBufferChannel } = require('./channel');
const { WaitResolveCommand } = require('./commands');
const { resolveSingle } = require('./resolve');
const { createPoison, isPoisonError, RuntimeFatalError, handleError } = require('./errors');
const call = require('./call');

class NamespaceCommand {
  constructor({ channelName, pos = null }) {
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = true;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.catch(() => {});
  }

  resolveResult(value) {
    if (!this.resolve) {
      return;
    }
    this.resolve(value);
    this.resolve = null;
    this.reject = null;
  }

  rejectResult(err) {
    if (!this.reject) {
      return;
    }
    this.reject(err);
    this.resolve = null;
    this.reject = null;
  }
}

function _normalizeNamespaceOperationFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  if (isPoisonError(err)) {
    return createPoison(err.errors);
  }
  return createPoison(handleError(err, pos.lineno, pos.colno, null, path));
}

function _normalizeNamespaceBootstrapFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, path);
}

function _resolveNamespaceInstance(value, pos, path) {
  try {
    const resolved = resolveSingle(value);
    if (!resolved || typeof resolved.then !== 'function') {
      if (!resolved || !resolved.__isNamespaceInstance) {
        throw new RuntimeFatalError('Namespace binding is not a namespace instance', pos.lineno, pos.colno, null, path);
      }
      return resolved;
    }
    return resolved.then((namespaceInstance) => {
      if (!namespaceInstance || !namespaceInstance.__isNamespaceInstance) {
        throw new RuntimeFatalError('Namespace binding is not a namespace instance', pos.lineno, pos.colno, null, path);
      }
      return namespaceInstance;
    });
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw err;
    }
    throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, path);
  }
}

function _settleNamespaceCommandResult(result, pos, path, command) {
  if (!result || typeof result.then !== 'function') {
    command.resolveResult(result);
    return result;
  }
  return result.then(
    (value) => {
      command.resolveResult(value);
      return value;
    },
    (err) => {
      try {
        const normalized = _normalizeNamespaceOperationFailure(err, pos, path);
        command.resolveResult(normalized);
        return normalized;
      } catch (fatalErr) {
        command.rejectResult(fatalErr);
        throw fatalErr;
      }
    }
  );
}

function _settleNamespaceOperationFailure(err, pos, path, command) {
  try {
    const normalized = _normalizeNamespaceOperationFailure(err, pos, path);
    command.resolveResult(normalized);
    return normalized;
  } catch (fatalErr) {
    command.rejectResult(fatalErr);
    throw fatalErr;
  }
}

function _resolveNamespaceBinding(bindingChannel, pos) {
  const bindingValue = bindingChannel && typeof bindingChannel._getTarget === 'function'
    ? bindingChannel._getTarget()
    : undefined;
  const path = bindingChannel && bindingChannel._context ? bindingChannel._context.path : null;
  return {
    path,
    namespaceInstance: _resolveNamespaceInstance(bindingValue, pos, path)
  };
}

function _runNamespaceBindingOperation(bindingChannel, pos, start, command) {
  const { path, namespaceInstance } = _resolveNamespaceBinding(bindingChannel, pos);
  try {
    if (!namespaceInstance || typeof namespaceInstance.then !== 'function') {
      return _settleNamespaceCommandResult(start(namespaceInstance), pos, path, command);
    }
    return namespaceInstance
      .then((resolvedNamespaceInstance) =>
        _settleNamespaceCommandResult(start(resolvedNamespaceInstance), pos, path, command)
      )
      .catch((err) => _settleNamespaceOperationFailure(err, pos, path, command));
  } catch (err) {
    return _settleNamespaceOperationFailure(err, pos, path, command);
  }
}

class NamespaceInstance {
  constructor({ context, rootBuffer, inheritanceState, template, ownerBuffer, ownerChannelName }) {
    this.__isNamespaceInstance = true;
    this.context = context;
    this.rootBuffer = rootBuffer;
    this.inheritanceState = inheritanceState;
    this.template = template;
    this.ownerBuffer = ownerBuffer;
    this.ownerChannelName = ownerChannelName;
    this.closed = false;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.rootBuffer && typeof this.rootBuffer.markFinishedAndPatchLinks === 'function') {
      this.rootBuffer.markFinishedAndPatchLinks();
    }
  }

  _assertOpen(pos) {
    if (!this.closed) {
      return;
    }
    throw new RuntimeFatalError(
      'Namespace instance is closed and cannot accept new operations',
      pos.lineno,
      pos.colno,
      null,
      this.context && this.context.path ? this.context.path : null
    );
  }

  callMethod(name, args, env, runtime, cb, errorContext) {
    this._assertOpen(errorContext || { lineno: 0, colno: 0 });
    return call.callInheritedMethodDetailed(
      this.context,
      this.inheritanceState,
      name,
      args,
      env,
      runtime,
      cb,
      this.rootBuffer,
      errorContext
    );
  }

  observeChannel(name, observation, pos) {
    this._assertOpen(pos);
    const path = this.context && this.context.path ? this.context.path : null;
    const runObservation = (channelType) => {
      if (!channelType) {
        throw new RuntimeFatalError(`Shared channel '${name}' was not found on the namespace instance`, pos.lineno, pos.colno, null, path);
      }
      if (observation === 'value' && channelType !== 'var') {
        throw new RuntimeFatalError(
          `Namespace member '${name}' is a shared ${channelType} channel; use ns.${name}.snapshot(), .isError(), or .getError()`,
          pos.lineno,
          pos.colno,
          null,
          path
        );
      }
      if (observation === 'value' || observation === 'snapshot') {
        return this.rootBuffer.addSnapshot(name, pos);
      }
      if (observation === 'isError') {
        return this.rootBuffer.addIsError(name, pos);
      }
      if (observation === 'getError') {
        return this.rootBuffer.addGetError(name, pos);
      }
      throw new RuntimeFatalError(`Unsupported namespace observation '${observation}'`, pos.lineno, pos.colno, null, path);
    };

    const immediateType = this.inheritanceState.getImmediateSharedChannelType(name);
    if (immediateType) {
      return runObservation(immediateType);
    }

    const resolvedType = this.inheritanceState.resolveSharedChannelType(this.context, name);
    return resolvedType && typeof resolvedType.then === 'function'
      ? resolvedType.then(runObservation)
      : runObservation(resolvedType);
  }
}

class NamespaceMethodCallCommand extends NamespaceCommand {
  constructor({ channelName, methodName, args = null, env, runtime, cb, errorContext }) {
    super({ channelName, pos: errorContext });
    this.isObservable = false;
    this.methodName = methodName;
    this.arguments = Array.isArray(args) ? args : [];
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.errorContext = errorContext || { lineno: 0, colno: 0, path: null };
  }

  apply(bindingChannel) {
    const start = (namespaceInstance) => namespaceInstance.callMethod(
      this.methodName,
      this.arguments,
      this.env,
      this.runtime,
      this.cb,
      this.errorContext
    );
    return _runNamespaceBindingOperation(
      bindingChannel,
      this.errorContext,
      start,
      this
    );
  }
}

class NamespaceObserveCommand extends NamespaceCommand {
  constructor({ channelName, sharedName, observation, pos = null }) {
    super({ channelName, pos });
    this.sharedName = sharedName;
    this.observation = observation;
  }

  apply(bindingChannel) {
    const start = (namespaceInstance) => namespaceInstance.observeChannel(
      this.sharedName,
      this.observation,
      this.pos
    );
    return _runNamespaceBindingOperation(
      bindingChannel,
      this.pos,
      start,
      this
    );
  }
}

class NamespaceCloseCommand {
  constructor({ channelName, pos = null }) {
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = false;
  }

  apply(bindingChannel) {
    try {
      const { namespaceInstance } = _resolveNamespaceBinding(bindingChannel, this.pos);
      if (!namespaceInstance || typeof namespaceInstance.then !== 'function') {
        namespaceInstance.close();
        return;
      }
      return namespaceInstance.then((resolvedNamespaceInstance) => {
        if (resolvedNamespaceInstance && typeof resolvedNamespaceInstance.close === 'function') {
          resolvedNamespaceInstance.close();
        }
      }, () => undefined);
    } catch (err) {
      void err;
      return undefined;
    }
  }
}

function createNamespaceInstance(templateValue, inputValues, context, env, runtime, cb, ownerBuffer, bindingChannelName, ownerChannelName, errorContext) {
  const pos = errorContext || { lineno: 0, colno: 0, path: context && context.path ? context.path : null };
  const namespaceContext = context.forkForComposition(null, {}, {}, {});
  const namespaceRoot = isCommandBuffer(ownerBuffer)
    ? createCommandBuffer(namespaceContext, ownerBuffer, [ownerChannelName], ownerBuffer)
    : createCommandBuffer(namespaceContext, null, null, null);
  // Shared-channel declarations stop their upward root walk at namespace
  // boundaries so one namespace instance keeps its own shared root rather than
  // merging into the caller hierarchy.
  namespaceRoot._sharedRootBoundary = true;
  const inheritanceState = createInheritanceState();
  const namespaceInstance = new NamespaceInstance({
    context: namespaceContext,
    rootBuffer: namespaceRoot,
    inheritanceState,
    template: null,
    ownerBuffer,
    ownerChannelName
  });

  if (isCommandBuffer(ownerBuffer) && typeof ownerBuffer.getFinishStartedPromise === 'function') {
    ownerBuffer.getFinishStartedPromise().then(() => {
      ownerBuffer.add(new NamespaceCloseCommand({
        channelName: bindingChannelName,
        pos
      }), bindingChannelName);
    });
  }

  const bootstrapChannelName = '__namespace_bootstrap__';
  declareBufferChannel(namespaceRoot, bootstrapChannelName, 'var', namespaceContext, null);

  const bootstrap = (resolvedTemplate) => {
    if (!resolvedTemplate || typeof resolvedTemplate.compile !== 'function') {
      throw new RuntimeFatalError('Namespace import requires a resolved script/template object', pos.lineno, pos.colno, null, pos.path);
    }
    if (namespaceInstance.closed) {
      return namespaceInstance;
    }

    resolvedTemplate.compile();
    namespaceContext.path = resolvedTemplate.path;
    namespaceInstance.template = resolvedTemplate;

    try {
      runtime.bootstrapInheritanceMetadata(
        inheritanceState,
        resolvedTemplate.methods || {},
        resolvedTemplate.sharedSchema || [],
        resolvedTemplate.path,
        namespaceRoot,
        namespaceContext
      );
    } catch (err) {
      _normalizeNamespaceBootstrapFailure(err, pos, namespaceContext.path || pos.path);
    }

    if (inputValues && typeof inputValues === 'object' && Object.keys(inputValues).length > 0) {
      try {
        runtime.preloadSharedInputs(
          resolvedTemplate.sharedSchema || [],
          inputValues,
          namespaceRoot,
          namespaceContext,
          pos,
          'namespace import'
        );
      } catch (err) {
        _normalizeNamespaceBootstrapFailure(err, pos, namespaceContext.path || pos.path);
      }
    }

    const constructorEntry = (resolvedTemplate.methods || {}).__constructor__;
    if (constructorEntry) {
      const admission = call.admitMethodEntryWithCompletion(
        namespaceContext,
        inheritanceState,
        constructorEntry,
        [],
        env,
        runtime,
        cb,
        namespaceRoot,
        pos
      );
      if (admission && admission.completion && typeof admission.completion.then === 'function') {
        admission.completion.catch((err) => {
          // Namespace constructors ignore their own return value. Non-fatal
          // failures remain visible through poisoned shared channel state; only
          // fatal completion failures need explicit cb() routing here.
          if (err instanceof RuntimeFatalError) {
            cb(err);
          }
        });
      }
    }

    return namespaceInstance;
  };

  try {
    const resolvedTemplate = resolveSingle(templateValue);
    if (!resolvedTemplate || typeof resolvedTemplate.then !== 'function') {
      return bootstrap(resolvedTemplate);
    }
    const bootstrapPromise = resolvedTemplate.then(bootstrap);
    namespaceRoot.add(new WaitResolveCommand({
      channelName: bootstrapChannelName,
      args: [bootstrapPromise],
      pos
    }), bootstrapChannelName);
    return bootstrapPromise;
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw err;
    }
    throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, pos.path);
  }
}

module.exports = {
  NamespaceInstance,
  NamespaceMethodCallCommand,
  NamespaceObserveCommand,
  NamespaceCloseCommand,
  createNamespaceInstance
};
