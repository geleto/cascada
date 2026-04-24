'use strict';

const { Command } = require('./commands');
const { resolveSingle } = require('./resolve');
const {
  ensureInheritanceSharedSchemaTable
} = require('./inheritance-state');
const inheritanceState = require('./inheritance-state');
const { createCommandBuffer } = require('./command-buffer');
const { RuntimeFatalError } = require('./errors');

const REGULAR_COMPOSITION_MODE = Object.freeze({ kind: 'regular-composition-mode' });
const COMPONENT_COMPOSITION_MODE = Object.freeze({ kind: 'component-composition-mode' });

function _createComponentError(message, errorContext = null) {
  return new RuntimeFatalError(
    message,
    errorContext && typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
    errorContext && typeof errorContext.colno === 'number' ? errorContext.colno : 0,
    errorContext ? errorContext.errorContextString : null,
    errorContext ? errorContext.path : null
  );
}

function _normalizeComponentPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      explicitInputValues: {},
      explicitInputNames: [],
      rootContext: {},
      externContext: {}
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(payload, 'explicitInputValues') ||
    Object.prototype.hasOwnProperty.call(payload, 'explicitInputNames') ||
    Object.prototype.hasOwnProperty.call(payload, 'rootContext') ||
    Object.prototype.hasOwnProperty.call(payload, 'externContext')
  ) {
    return {
      explicitInputValues: payload.explicitInputValues && typeof payload.explicitInputValues === 'object'
        ? payload.explicitInputValues
        : {},
      explicitInputNames: Array.isArray(payload.explicitInputNames)
        ? payload.explicitInputNames.slice()
        : Object.keys(payload.explicitInputValues || {}),
      rootContext: payload.rootContext && typeof payload.rootContext === 'object'
        ? payload.rootContext
        : {},
      externContext: payload.externContext && typeof payload.externContext === 'object'
        ? payload.externContext
        : {}
    };
  }

  return {
    explicitInputValues: payload,
    explicitInputNames: Object.keys(payload),
    rootContext: Object.assign({}, payload),
    externContext: Object.assign({}, payload)
  };
}

function _throwIfClosed(instance, errorContext) {
  if (!instance || !instance.closed) {
    return;
  }
  throw _createComponentError('Component instance cannot accept new operations', errorContext);
}

class ComponentInstance {
  constructor({
    context,
    rootBuffer,
    inheritanceState: inheritanceStateValue,
    template,
    ownerBuffer,
    env
  }) {
    this.context = context;
    this.rootBuffer = rootBuffer;
    this.inheritanceState = inheritanceStateValue;
    this.template = template;
    this.ownerBuffer = ownerBuffer || null;
    this.env = env || null;
    this.closed = false;
    this.startupError = null;
  }

  _setStartupError(error) {
    if (!this.startupError) {
      this.startupError = error;
    }
  }

  _throwIfUnavailable(errorContext) {
    _throwIfClosed(this, errorContext);
    if (this.startupError) {
      throw this.startupError;
    }
  }

  _getSharedRootBuffer() {
    return (this.inheritanceState && this.inheritanceState.sharedRootBuffer) || this.rootBuffer;
  }

  callMethod(methodName, args, runtime, cb, errorContext = null) {
    this._throwIfUnavailable(errorContext);
    const sharedRootBuffer = this._getSharedRootBuffer();
    return runtime.invokeInheritedMethod(
      this.inheritanceState,
      methodName,
      Array.isArray(args) ? args : [],
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
    if (this.rootBuffer && typeof this.rootBuffer.markFinishedAndPatchLinks === 'function') {
      this.rootBuffer.markFinishedAndPatchLinks();
    }
  }
}

function _validateSharedObservationCommand(observationCommand, errorContext = null) {
  if (
    !observationCommand ||
    typeof observationCommand !== 'object' ||
    !observationCommand.isSnapshotCommand ||
    !observationCommand.channelName
  ) {
    throw _createComponentError('Component shared observation requires an observational channel command', errorContext);
  }
  return observationCommand;
}

function _enqueueSharedObservation(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  instance._throwIfUnavailable(errorContext);
  const command = _validateSharedObservationCommand(observationCommand, errorContext);
  const channelName = command.channelName;
  const sharedSchema = ensureInheritanceSharedSchemaTable(instance.inheritanceState || {});
  const channelType = Object.prototype.hasOwnProperty.call(sharedSchema, channelName)
    ? sharedSchema[channelName]
    : null;

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
  sharedRootBuffer.add(command, channelName);
  return command.promise;
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
    operation,
    methodName = null,
    args = null,
    runtime = null,
    cb = null,
    errorContext = null
  }) {
    super({ withDeferredResult: operation !== 'close' });
    this.operation = operation;
    this.methodName = methodName;
    this.args = Array.isArray(args) ? args : [];
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
    const bindingValue = outputChannel && typeof outputChannel._getTarget === 'function'
      ? outputChannel._getTarget()
      : undefined;

    if (this.operation === 'close') {
      if (bindingValue instanceof ComponentInstance) {
        bindingValue.close();
      }
      return null;
    }

    return this._run(bindingValue);
  }

  async _run(bindingValue) {
    try {
      const instance = await _resolveComponentInstance(bindingValue, this.errorContext);
      let result;

      if (this.operation === 'method') {
        result = instance.callMethod(
          this.methodName,
          this.args,
          this.runtime,
          this.cb,
          this.errorContext
        );
      } else {
        throw _createComponentError(`Unknown component operation '${this.operation}'`, this.errorContext);
      }

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
        this.templateOrPromise,
        this.payload,
        this.ownerContext,
        this.env,
        this.runtime,
        this.cb,
        this.ownerBuffer,
        this.bindingName,
        this.errorContext
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
    const bindingValue = outputChannel && typeof outputChannel._getTarget === 'function'
      ? outputChannel._getTarget()
      : undefined;
    return this._run(bindingValue);
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

async function createComponentInstance(
  templateOrPromise,
  payload,
  ownerContext,
  env,
  runtime,
  cb,
  ownerBuffer,
  bindingName = null,
  errorContext = null
) {
  const template = await resolveSingle(templateOrPromise);
  if (!template) {
    throw _createComponentError('Component target did not resolve to a script or template', errorContext);
  }

  if (typeof template.compile === 'function') {
    template.compile();
  }

  const normalizedPayload = _normalizeComponentPayload(payload);
  // Component payload keys are explicit composition inputs, not an import-style
  // "only declared externs may pass" surface. The component path only validates
  // that any required externs are available from the effective extern context.
  runtime.validateExternInputs(
    template.externSpec || [],
    [],
    Object.keys(normalizedPayload.externContext || {}),
    'component'
  );
  const renderCtx = ownerContext && typeof ownerContext.getRenderContextVariables === 'function'
    ? ownerContext.getRenderContextVariables()
    : {};
  const componentContext = ownerContext && typeof ownerContext.forkForComposition === 'function'
    ? ownerContext.forkForComposition(
      template.path,
      normalizedPayload.rootContext || {},
      renderCtx,
      normalizedPayload.externContext || {}
    )
    : ownerContext;
  const componentRootBuffer = createCommandBuffer(componentContext, null, null, null);
  const componentInheritanceState = inheritanceState.createInheritanceState();
  componentInheritanceState.sharedRootBuffer = componentRootBuffer;
  componentInheritanceState.compositionPayload = normalizedPayload;
  inheritanceState.setInheritanceCompositionMode(componentInheritanceState, COMPONENT_COMPOSITION_MODE);

  const instance = new ComponentInstance({
    context: componentContext,
    rootBuffer: componentRootBuffer,
    inheritanceState: componentInheritanceState,
    template,
    ownerBuffer,
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
      COMPONENT_COMPOSITION_MODE,
      componentRootBuffer,
      componentInheritanceState
    );
  } catch (error) {
    instance._setStartupError(error);
    if (typeof cb === 'function') {
      cb(error);
    }
  }

  // Components are only exposed after constructor startup settles so callers
  // never observe a half-initialized instance.
  const startupPromise = runtime.awaitInheritanceStartup(componentInheritanceState);
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

function startComponentInstance(
  currentBuffer,
  bindingName,
  templateOrPromise,
  payload,
  ownerContext,
  env,
  runtime,
  cb,
  errorContext = null
) {
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
  if (!currentBuffer) {
    throw new Error('Component operations require a current buffer');
  }
  currentBuffer.add(command, bindingName);
  return command.promise;
}

function callComponentMethod(bindingName, currentBuffer, methodName, args, runtime, cb, errorContext = null) {
  const command = new ComponentOperationCommand({
    operation: 'method',
    methodName,
    args,
    runtime,
    cb,
    errorContext
  });
  if (!currentBuffer) {
    throw new Error('Component operations require a current buffer');
  }
  currentBuffer.add(command, bindingName);
  return command.promise;
}

function observeComponentChannel(bindingName, currentBuffer, observationCommand, errorContext = null, implicitVarRead = false) {
  const observationChannelName = observationCommand && observationCommand.channelName
    ? observationCommand.channelName
    : null;
  const command = new ObserveSharedChannelCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  if (!currentBuffer) {
    throw new Error('Component operations require a current buffer');
  }
  currentBuffer.add(command, bindingName || observationChannelName);
  return command.promise;
}

module.exports = {
  REGULAR_COMPOSITION_MODE,
  COMPONENT_COMPOSITION_MODE,
  ComponentInstance,
  ComponentOperationCommand,
  StartComponentInstanceCommand,
  ObserveSharedChannelCommand,
  createComponentInstance,
  startComponentInstance,
  callComponentMethod,
  observeComponentChannel
};
