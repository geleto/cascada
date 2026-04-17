'use strict';

const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');
const { createInheritanceState } = require('./inheritance-state');
const { declareBufferChannel } = require('./channel');
const { WaitResolveCommand } = require('./commands');
const { resolveSingle } = require('./resolve');
const { createPoison, isPoisonError, RuntimeFatalError, handleError } = require('./errors');
const inheritanceBootstrap = require('./inheritance-bootstrap');
const inheritanceCall = require('./inheritance-call');

class ComponentCommand {
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

function _normalizeComponentOperationFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  if (isPoisonError(err)) {
    return createPoison(err.errors);
  }
  return createPoison(handleError(err, pos.lineno, pos.colno, null, path));
}

function _normalizeComponentBootstrapFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, path);
}

function _resolveComponentInstance(value, pos, path) {
  try {
    const resolved = resolveSingle(value);
    if (!resolved || typeof resolved.then !== 'function') {
      if (!resolved || !resolved.__isComponentInstance) {
        throw new RuntimeFatalError('Component binding is not a component instance', pos.lineno, pos.colno, null, path);
      }
      return resolved;
    }
    return resolved.then((componentInstance) => {
      if (!componentInstance || !componentInstance.__isComponentInstance) {
        throw new RuntimeFatalError('Component binding is not a component instance', pos.lineno, pos.colno, null, path);
      }
      return componentInstance;
    });
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw err;
    }
    throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, path);
  }
}

function _settleComponentCommandResult(result, pos, path, command) {
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
        const normalized = _normalizeComponentOperationFailure(err, pos, path);
        command.resolveResult(normalized);
        return normalized;
      } catch (fatalErr) {
        command.rejectResult(fatalErr);
        throw fatalErr;
      }
    }
  );
}

function _settleComponentOperationFailure(err, pos, path, command) {
  try {
    const normalized = _normalizeComponentOperationFailure(err, pos, path);
    command.resolveResult(normalized);
    return normalized;
  } catch (fatalErr) {
    command.rejectResult(fatalErr);
    throw fatalErr;
  }
}

function _resolveComponentBinding(bindingChannel, pos) {
  const bindingValue = bindingChannel && typeof bindingChannel._getTarget === 'function'
    ? bindingChannel._getTarget()
    : undefined;
  const path = bindingChannel && bindingChannel._context ? bindingChannel._context.path : null;
  return {
    path,
    componentInstance: _resolveComponentInstance(bindingValue, pos, path)
  };
}

function _runComponentBindingOperation(bindingChannel, pos, start, command) {
  const { path, componentInstance } = _resolveComponentBinding(bindingChannel, pos);
  try {
    if (!componentInstance || typeof componentInstance.then !== 'function') {
      return _settleComponentCommandResult(start(componentInstance), pos, path, command);
    }
    return componentInstance
      .then((resolvedComponentInstance) =>
        _settleComponentCommandResult(start(resolvedComponentInstance), pos, path, command)
      )
      .catch((err) => _settleComponentOperationFailure(err, pos, path, command));
  } catch (err) {
    return _settleComponentOperationFailure(err, pos, path, command);
  }
}

class ComponentInstance {
  constructor({ context, rootBuffer, inheritanceState, template, ownerBuffer, ownerChannelName }) {
    this.__isComponentInstance = true;
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
      'Component instance is closed and cannot accept new operations',
      pos.lineno,
      pos.colno,
      null,
      this.context && this.context.path ? this.context.path : null
    );
  }

  callMethod(name, args, env, runtime, cb, errorContext) {
    this._assertOpen(errorContext || { lineno: 0, colno: 0 });
    return inheritanceCall.callInheritedMethodDetailed(
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
        throw new RuntimeFatalError(`Shared channel '${name}' was not found on the component instance`, pos.lineno, pos.colno, null, path);
      }
      if (observation === 'value' && channelType !== 'var') {
        throw new RuntimeFatalError(
          `Component member '${name}' is a shared ${channelType} channel; use ns.${name}.snapshot(), .isError(), or .getError()`,
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
      throw new RuntimeFatalError(`Unsupported component observation '${observation}'`, pos.lineno, pos.colno, null, path);
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

class ComponentMethodCallCommand extends ComponentCommand {
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
    const start = (componentInstance) => componentInstance.callMethod(
      this.methodName,
      this.arguments,
      this.env,
      this.runtime,
      this.cb,
      this.errorContext
    );
    return _runComponentBindingOperation(
      bindingChannel,
      this.errorContext,
      start,
      this
    );
  }
}

class ComponentObserveCommand extends ComponentCommand {
  constructor({ channelName, sharedName, observation, pos = null }) {
    super({ channelName, pos });
    this.sharedName = sharedName;
    this.observation = observation;
  }

  apply(bindingChannel) {
    const start = (componentInstance) => componentInstance.observeChannel(
      this.sharedName,
      this.observation,
      this.pos
    );
    return _runComponentBindingOperation(
      bindingChannel,
      this.pos,
      start,
      this
    );
  }
}

class ComponentCloseCommand {
  constructor({ channelName, pos = null }) {
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
    this.isObservable = false;
  }

  apply(bindingChannel) {
    try {
      const { componentInstance } = _resolveComponentBinding(bindingChannel, this.pos);
      if (!componentInstance || typeof componentInstance.then !== 'function') {
        componentInstance.close();
        return;
      }
      return componentInstance.then((resolvedComponentInstance) => {
        if (resolvedComponentInstance && typeof resolvedComponentInstance.close === 'function') {
          resolvedComponentInstance.close();
        }
      }, () => undefined);
    } catch (err) {
      void err;
      return undefined;
    }
  }
}

function createComponentInstance(templateValue, inputValues, context, env, runtime, cb, ownerBuffer, bindingChannelName, ownerChannelName, errorContext) {
  const pos = errorContext || { lineno: 0, colno: 0, path: context && context.path ? context.path : null };
  const componentContext = context.forkForComposition(null, {}, {}, {});
  const componentRoot = isCommandBuffer(ownerBuffer)
    ? createCommandBuffer(componentContext, ownerBuffer, [ownerChannelName], ownerBuffer)
    : createCommandBuffer(componentContext, null, null, null);
  // Shared-channel declarations stop their upward root walk at component
  // boundaries so one component instance keeps its own shared root rather than
  // merging into the caller hierarchy.
  componentRoot._sharedRootBoundary = true;
  const inheritanceState = createInheritanceState();
  const componentInstance = new ComponentInstance({
    context: componentContext,
    rootBuffer: componentRoot,
    inheritanceState,
    template: null,
    ownerBuffer,
    ownerChannelName
  });

  if (isCommandBuffer(ownerBuffer) && typeof ownerBuffer.getFinishStartedPromise === 'function') {
    ownerBuffer.getFinishStartedPromise().then(() => {
      ownerBuffer.add(new ComponentCloseCommand({
        channelName: bindingChannelName,
        pos
      }), bindingChannelName);
    });
  }

  const bootstrapChannelName = '__component_bootstrap__';
  declareBufferChannel(componentRoot, bootstrapChannelName, 'var', componentContext, null);

  const bootstrap = (resolvedTemplate) => {
    if (!resolvedTemplate || typeof resolvedTemplate.compile !== 'function') {
      throw new RuntimeFatalError('Component import requires a resolved script/template object', pos.lineno, pos.colno, null, pos.path);
    }
    if (componentInstance.closed) {
      return componentInstance;
    }

    resolvedTemplate.compile();
    componentContext.path = resolvedTemplate.path;
    componentInstance.template = resolvedTemplate;

    try {
      inheritanceBootstrap.bootstrapInheritanceMetadata(
        inheritanceState,
        resolvedTemplate.methods || {},
        resolvedTemplate.sharedSchema || [],
        resolvedTemplate.path,
        componentRoot,
        componentContext
      );
    } catch (err) {
      _normalizeComponentBootstrapFailure(err, pos, componentContext.path || pos.path);
    }

    if (inputValues && typeof inputValues === 'object' && Object.keys(inputValues).length > 0) {
      try {
        inheritanceBootstrap.preloadSharedInputs(
          resolvedTemplate.sharedSchema || [],
          inputValues,
          componentRoot,
          componentContext,
          pos,
          'component import'
        );
      } catch (err) {
        _normalizeComponentBootstrapFailure(err, pos, componentContext.path || pos.path);
      }
    }

    const constructorEntry = (resolvedTemplate.methods || {}).__constructor__;
    if (constructorEntry) {
      const admission = inheritanceCall.admitMethodEntryWithCompletion(
        componentContext,
        inheritanceState,
        constructorEntry,
        [],
        env,
        runtime,
        cb,
        componentRoot,
        pos
      );
      if (admission && admission.completion && typeof admission.completion.then === 'function') {
        admission.completion.catch((err) => {
          // Component constructors ignore their own return value. Non-fatal
          // failures remain visible through poisoned shared channel state; only
          // fatal completion failures need explicit cb() routing here.
          if (err instanceof RuntimeFatalError) {
            cb(err);
          }
        });
      }
    }

    return componentInstance;
  };

  try {
    const resolvedTemplate = resolveSingle(templateValue);
    if (!resolvedTemplate || typeof resolvedTemplate.then !== 'function') {
      return bootstrap(resolvedTemplate);
    }
    const bootstrapPromise = resolvedTemplate.then(bootstrap);
    componentRoot.add(new WaitResolveCommand({
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
  ComponentInstance,
  ComponentMethodCallCommand,
  ComponentObserveCommand,
  ComponentCloseCommand,
  createComponentInstance
};
