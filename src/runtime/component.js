'use strict';

// Component runtime wrapper.
// Owns component-instance lifecycle and maps component operations onto the
// shared inheritance bootstrap/startup/call machinery underneath.

const { createCommandBuffer, isCommandBuffer } = require('./command-buffer');
const { createInheritanceState } = require('./inheritance-state');
const { Command } = require('./commands');
const { resolveSingle } = require('./resolve');
const { createPoison, isPoisonError, RuntimeFatalError, handleError } = require('./errors');
const inheritanceCall = require('./inheritance-call');
const componentBootstrap = require('./component-bootstrap');

class ComponentCommand extends Command {
  constructor({ channelName, pos = null, withDeferredResult = true }) {
    super({ withDeferredResult });
    this.channelName = channelName;
    this.pos = pos || { lineno: 0, colno: 0 };
  }
}

const COMPONENT_OPERATION_METHOD = 'method';
const COMPONENT_OPERATION_OBSERVE = 'observe';
const COMPONENT_OPERATION_CLOSE = 'close';

function _normalizeComponentOperationFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  if (isPoisonError(err)) {
    return createPoison(err.errors);
  }
  return createPoison(handleError(err, pos.lineno, pos.colno, null, path));
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
    const admission = inheritanceCall.admitInheritedMethod(
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
    const valueResult = admission.promise;
    const completion = admission && admission.completion && typeof admission.completion.then === 'function'
      ? admission.completion
      : null;

    if (!completion) {
      return valueResult;
    }

    return valueResult.then(
      (value) => completion.then(() => value),
      (err) => completion.then(
        () => { throw err; },
        () => { throw err; }
      )
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

    const immediateType = this.inheritanceState.shared.getImmediateType(name);
    if (immediateType) {
      return runObservation(immediateType);
    }

    const resolvedType = this.inheritanceState.shared.resolveType(name);
    return resolvedType && typeof resolvedType.then === 'function'
      ? resolvedType.then(runObservation)
      : runObservation(resolvedType);
  }
}

class ComponentOperationCommand extends ComponentCommand {
  constructor({
    channelName,
    operation,
    methodName,
    args = null,
    sharedName,
    observation,
    env,
    runtime,
    cb,
    errorContext,
    pos = null
  }) {
    const normalizedPos = errorContext || pos;
    super({
      channelName,
      pos: normalizedPos,
      withDeferredResult: operation !== COMPONENT_OPERATION_CLOSE
    });
    this.operation = operation;
    this.methodName = methodName || null;
    this.arguments = Array.isArray(args) ? args : [];
    this.sharedName = sharedName || null;
    this.observation = observation || null;
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.errorContext = errorContext || normalizedPos || { lineno: 0, colno: 0, path: null };
    this.isObservable = operation === COMPONENT_OPERATION_OBSERVE;
  }

  apply(bindingChannel) {
    if (this.operation === COMPONENT_OPERATION_CLOSE) {
      return this._applyClose(bindingChannel);
    }
    return _runComponentBindingOperation(
      bindingChannel,
      this.errorContext,
      this._createOperationStart(),
      this
    );
  }

  _createOperationStart() {
    if (this.operation === COMPONENT_OPERATION_METHOD) {
      return (componentInstance) => componentInstance.callMethod(
        this.methodName,
        this.arguments,
        this.env,
        this.runtime,
        this.cb,
        this.errorContext
      );
    }
    if (this.operation === COMPONENT_OPERATION_OBSERVE) {
      return (componentInstance) => componentInstance.observeChannel(
        this.sharedName,
        this.observation,
        this.pos
      );
    }
    throw new Error(`Unsupported component operation '${this.operation}'`);
  }

  _applyClose(bindingChannel) {
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
      ownerBuffer.add(new ComponentOperationCommand({
        channelName: bindingChannelName,
        operation: COMPONENT_OPERATION_CLOSE,
        pos
      }), bindingChannelName);
    });
  }

  return componentBootstrap.startComponentBootstrap({
    templateValue,
    inputValues,
    componentContext,
    componentRoot,
    componentInstance,
    inheritanceState,
    env,
    runtime,
    cb,
    pos
  });
}

module.exports = {
  ComponentInstance,
  ComponentOperationCommand,
  createComponentInstance
};
