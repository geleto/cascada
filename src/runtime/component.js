'use strict';

import {Command} from './channels/command-base.js';
import {resolveSingle} from './resolve.js';
import inheritanceState, {ensureInheritanceSharedSchemaTable} from './inheritance-state.js';
import inheritanceCall from './inheritance-call.js';
import {createCommandBuffer} from './command-buffer.js';
import {RuntimeFatalError} from './errors.js';
import {createCompositionPayload} from './composition-payload.js';

function _createComponentError(message, errorContext = null) {
  return new RuntimeFatalError(
    message,
    errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
    errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
    errorContext ? errorContext.errorContextString : null,
    errorContext ? errorContext.path : null
  );
}

class ComponentInstance {
  constructor({
    context,
    rootBuffer,
    inheritanceState: inheritanceStateValue,
    env
  }) {
    this.context = context;
    this.rootBuffer = rootBuffer;
    this.inheritanceState = inheritanceStateValue;
    this.env = env;
    this.closed = false;
    this.startupError = null;
  }

  _setStartupError(error) {
    if (!this.startupError) {
      this.startupError = error;
    }
  }

  _throwIfUnavailable(errorContext) {
    if (this.closed) {
      throw _createComponentError('Component instance cannot accept new operations', errorContext);
    }
    if (this.startupError) {
      throw this.startupError;
    }
  }

  _getSharedRootBuffer() {
    return this.inheritanceState.sharedRootBuffer ?? this.rootBuffer;
  }

  callMethod(methodName, args, runtime, cb, errorContext = null) {
    this._throwIfUnavailable(errorContext);
    const sharedRootBuffer = this._getSharedRootBuffer();
    return inheritanceCall.invokeComponentMethod(
      this.inheritanceState,
      methodName,
      args,
      this.context,
      this.env,
      runtime,
      cb,
      sharedRootBuffer,
      errorContext
    );
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rootBuffer.markFinishedAndPatchLinks();
  }
}

function _enqueueSharedObservation(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  instance._throwIfUnavailable(errorContext);
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.channelName) {
    throw _createComponentError('Component shared observation requires a universal observational channel command', errorContext);
  }

  const channelName = observationCommand.channelName;
  if (channelName.charAt(0) === '_') {
    throw _createComponentError(`Shared channel '${channelName}' was not found`, errorContext);
  }

  const sharedSchema = ensureInheritanceSharedSchemaTable(instance.inheritanceState);
  const channelType = sharedSchema[channelName] ?? null;

  if (!channelType) {
    throw _createComponentError(`Shared channel '${channelName}' was not found`, errorContext);
  }
  if (implicitVarRead && channelType !== 'var') {
    throw _createComponentError(
      `Shared channel '${channelName}' cannot be used as a bare symbol. Use '${channelName}.snapshot()' instead.`,
      errorContext
    );
  }

  const sharedRootBuffer = instance._getSharedRootBuffer();
  sharedRootBuffer.add(observationCommand, channelName);
  return observationCommand.promise;
}

async function _resolveComponentInstance(bindingValue, errorContext = null) {
  const resolvedValue = await resolveSingle(bindingValue);
  if (!(resolvedValue instanceof ComponentInstance)) {
    throw _createComponentError('Component binding is not a component instance', errorContext);
  }
  return resolvedValue;
}

class ComponentOperationCommand extends Command {
  constructor({
    methodName = null,
    args = null,
    runtime = null,
    cb = null,
    errorContext = null
  }) {
    super({ withDeferredResult: true });
    this.methodName = methodName;
    this.args = args;
    this.runtime = runtime;
    this.cb = cb;
    this.errorContext = errorContext;
    // Component operations still return a direct deferred result to the caller,
    // but they stay non-observable on the binding lane so the parent buffer
    // treats them as ordered structural work rather than as an extra output
    // stream that would need its own observable slot.
    this.isObservable = false;
  }

  apply(outputChannel) {
    return this._run(outputChannel._getTarget());
  }

  async _run(bindingValue) {
    try {
      const instance = await _resolveComponentInstance(bindingValue, this.errorContext);
      const result = instance.callMethod(
        this.methodName,
        this.args,
        this.runtime,
        this.cb,
        this.errorContext
      );

      const resolvedResult = await result;
      this.resolveResult(resolvedResult);
      return resolvedResult;
    } catch (error) {
      this.rejectResult(error);
      throw error;
    }
  }
}

class StartComponentInstanceCommand extends Command {
  constructor({
    templateOrPromise,
    payload,
    ownerContext,
    env,
    runtime,
    cb = null,
    ownerBuffer,
    bindingName = null,
    errorContext = null
  }) {
    super({ withDeferredResult: true });
    this.templateOrPromise = templateOrPromise;
    this.payload = payload;
    this.ownerContext = ownerContext;
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.ownerBuffer = ownerBuffer;
    this.bindingName = bindingName;
    this.errorContext = errorContext;
    this.isObservable = false;
  }

  apply(outputChannel) {
    void outputChannel;
    return this._run();
  }

  async _run() {
    try {
      const instance = await createComponentInstance(
        {
          templateOrPromise: this.templateOrPromise,
          payload: this.payload,
          ownerContext: this.ownerContext,
          env: this.env,
          runtime: this.runtime,
          cb: this.cb,
          ownerBuffer: this.ownerBuffer,
          bindingName: this.bindingName,
          errorContext: this.errorContext
        }
      );
      this.resolveResult(instance);
      return instance;
    } catch (error) {
      this.rejectResult(error);
      throw error;
    }
  }
}

class ObserveSharedChannelCommand extends Command {
  constructor({
    observationCommand,
    errorContext = null,
    implicitVarRead = false
  }) {
    super({ withDeferredResult: true });
    this.observationCommand = observationCommand;
    this.errorContext = errorContext;
    this.implicitVarRead = !!implicitVarRead;
    this.isObservable = false;
  }

  apply(outputChannel) {
    return this._run(outputChannel._getTarget());
  }

  async _run(bindingValue) {
    try {
      const instance = await _resolveComponentInstance(bindingValue, this.errorContext);
      const result = await _enqueueSharedObservation(
        instance,
        this.observationCommand,
        this.errorContext,
        this.implicitVarRead
      );
      this.resolveResult(result);
      return result;
    } catch (error) {
      this.rejectResult(error);
      throw error;
    }
  }
}

async function createComponentInstance(spec) {
  const {
    templateOrPromise,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    ownerBuffer,
    bindingName = null,
    errorContext = null
  } = spec;
  const template = await resolveSingle(templateOrPromise);
  if (!template) {
    throw _createComponentError('Component target did not resolve to a script or template', errorContext);
  }

  if (typeof template.compile === 'function') {
    template.compile();
  }

  const payloadContext = { ...(payload ?? {}) };
  const renderCtx = ownerContext.getRenderContextVariables();
  const compositionPayload = createCompositionPayload(payloadContext);
  const componentContext = ownerContext.forkForComposition(
    template.path,
    compositionPayload.rootContext,
    renderCtx,
    compositionPayload.payloadContext
  );
  const componentRootBuffer = createCommandBuffer(componentContext, null, null, null);
  const componentInheritanceState = inheritanceState.createInheritanceState();
  componentInheritanceState.sharedRootBuffer = componentRootBuffer;
  componentInheritanceState.compositionPayload = compositionPayload;
  inheritanceState.setComponentCompositionMode(componentInheritanceState, true);

  const instance = new ComponentInstance({
    context: componentContext,
    rootBuffer: componentRootBuffer,
    inheritanceState: componentInheritanceState,
    env
  });

  const componentCallback = (error) => {
    if (error) {
      instance._setStartupError(error);
    }
    if (typeof cb === 'function' && error) {
      cb(error);
    }
  };

  if (typeof template.rootRenderFunc !== 'function') {
    throw _createComponentError('Component target did not expose a compiled rootRenderFunc', errorContext);
  }

  try {
    // Keep sync startup failures on the same deferred availability path as
    // callback-delivered async startup failures: the instance records the
    // startup error immediately, `cb(error)` still observes it, and later
    // namespace operations rethrow through `_throwIfUnavailable(...)`.
    template.rootRenderFunc(
      env,
      componentContext,
      runtime,
      componentCallback,
      true,
      componentRootBuffer,
      componentInheritanceState,
      true
    );
  } catch (error) {
    instance._setStartupError(error);
    if (typeof cb === 'function') {
      cb(error);
    }
  }

  // Components are only exposed after constructor startup settles so callers
  // never observe a half-initialized instance.
  const startupPromise = inheritanceState.awaitInheritanceStartup(componentInheritanceState);
  if (startupPromise) {
    await startupPromise;
  }

  let ownerBindingSnapshot = null;
  if (
    ownerBuffer &&
    bindingName &&
    typeof ownerBuffer.getChannel === 'function'
  ) {
    const bindingChannel = ownerBuffer.getChannel(bindingName);
    if (bindingChannel && typeof bindingChannel.finalSnapshot === 'function') {
      ownerBindingSnapshot = bindingChannel.finalSnapshot();
    }
  }

  if (ownerBindingSnapshot && typeof ownerBindingSnapshot.then === 'function') {
    ownerBindingSnapshot.then(() => {
      instance.close();
    }, () => {
      instance.close();
    });
  }

  return instance;
}

function startComponentInstance(spec) {
  const {
    currentBuffer,
    bindingName,
    templateOrPromise,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    errorContext = null
  } = spec;
  const command = new StartComponentInstanceCommand({
    templateOrPromise,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    ownerBuffer: currentBuffer,
    bindingName,
    errorContext
  });
  currentBuffer.add(command, bindingName);
  return command.promise;
}

function callComponentMethod(spec) {
  const {
    bindingName,
    currentBuffer,
    methodName,
    args,
    runtime,
    cb,
    errorContext = null
  } = spec;
  const command = new ComponentOperationCommand({
    methodName,
    args,
    runtime,
    cb,
    errorContext
  });
  currentBuffer.add(command, bindingName);
  return command.promise;
}

function observeComponentChannel(spec) {
  const {
    bindingName,
    currentBuffer,
    observationCommand,
    errorContext = null,
    implicitVarRead = false
  } = spec;
  const command = new ObserveSharedChannelCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  currentBuffer.add(command, bindingName || observationCommand.channelName);
  return command.promise;
}

export default {
  ComponentInstance,
  createComponentInstance,
  startComponentInstance,
  callComponentMethod,
  observeComponentChannel
};
export { ComponentInstance, createComponentInstance, startComponentInstance, callComponentMethod, observeComponentChannel };
