'use strict';

const { Command } = require('./commands');
const { resolveSingle } = require('./resolve');
const lookup = require('./lookup');
const inheritanceCall = require('./inheritance-call');
const inheritanceState = require('./inheritance-state');
const { createCommandBuffer, waitForCurrentBufferChannel } = require('./command-buffer');
const { RuntimeFatalError } = require('./errors');

const COMPONENT_COMPOSITION_MODE = '__component__';

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

async function _waitForComponentSharedChannels(sharedRootBuffer, stateValue, channelNames, errorContext = null) {
  if (!sharedRootBuffer || !Array.isArray(channelNames) || channelNames.length === 0) {
    return;
  }

  const pos = errorContext && typeof errorContext === 'object'
    ? {
      lineno: typeof errorContext.lineno === 'number' ? errorContext.lineno : 0,
      colno: typeof errorContext.colno === 'number' ? errorContext.colno : 0
    }
    : { lineno: 0, colno: 0 };
  const seen = new Set();
  const waits = [];

  for (let i = 0; i < channelNames.length; i++) {
    const channelName = channelNames[i];
    if (!channelName || channelName === '__return__' || seen.has(channelName)) {
      continue;
    }
    seen.add(channelName);

    let channel = typeof sharedRootBuffer.findChannel === 'function'
      ? sharedRootBuffer.findChannel(channelName)
      : null;
    if (!channel) {
      const sharedSchema = stateValue && stateValue.sharedSchema && typeof stateValue.sharedSchema === 'object'
        ? stateValue.sharedSchema
        : null;
      if (sharedSchema && Object.prototype.hasOwnProperty.call(sharedSchema, channelName)) {
        await inheritanceCall.resolveInheritanceSharedChannel(stateValue, channelName, errorContext);
        channel = typeof sharedRootBuffer.findChannel === 'function'
          ? sharedRootBuffer.findChannel(channelName)
          : null;
        if (!channel) {
          throw _createComponentError(
            `Shared channel '${channelName}' was registered without an observable runtime channel`,
            errorContext
          );
        }
      } else {
        continue;
      }
    }

    waits.push(waitForCurrentBufferChannel(sharedRootBuffer, channelName, pos));
  }

  if (waits.length > 0) {
    await Promise.all(waits);
  }
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
    const result = runtime.invokeInheritedMethod(
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
    // `invokeInheritedMethod(...)` returns the observable method result promise
    // and exposes `result.completion` plus `result.resolvedMethodMeta` for
    // callers that must also wait for admission teardown and then observe the
    // resolved linked-channel set without re-running inheritance resolution.
    if (
      result &&
      typeof result.then === 'function' &&
      result.completion &&
      typeof result.completion.then === 'function' &&
      result.resolvedMethodMeta &&
      typeof result.resolvedMethodMeta.then === 'function'
    ) {
      return result.completion.then(() => result.resolvedMethodMeta).then((methodMeta) => {
        return _waitForComponentSharedChannels(
          sharedRootBuffer,
          this.inheritanceState,
          methodMeta && methodMeta.linkedChannels,
          errorContext
        );
      }).then(() => result);
    }
    return result;
  }

  observeChannel(channelName, runtime, errorContext = null, mode = 'snapshot', implicitVarRead = false) {
    this._throwIfUnavailable(errorContext);
    const sharedRootBuffer = this._getSharedRootBuffer();
    return lookup.observeInheritanceSharedChannel(
      channelName,
      sharedRootBuffer,
      errorContext,
      this.inheritanceState,
      mode,
      implicitVarRead
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

class ComponentOperationCommand extends Command {
  constructor({
    channelName,
    operation,
    methodName = null,
    channelToObserve = null,
    mode = 'snapshot',
    implicitVarRead = false,
    args = null,
    env = null,
    runtime = null,
    cb = null,
    errorContext = null
  }) {
    super({ withDeferredResult: operation !== 'close' });
    this.channelName = channelName;
    this.operation = operation;
    this.methodName = methodName;
    this.channelToObserve = channelToObserve;
    this.mode = mode;
    this.implicitVarRead = !!implicitVarRead;
    this.args = Array.isArray(args) ? args : [];
    this.env = env;
    this.runtime = runtime;
    this.cb = cb;
    this.errorContext = errorContext;
    // Component operations still return a direct deferred result to the caller,
    // but they stay non-observable on the binding lane so the parent buffer
    // treats them as ordered structural work rather than as an extra output
    // stream that would need its own observable slot.
    this.isObservable = false;
  }

  async _resolveComponentInstance(bindingValue) {
    const resolvedValue = await resolveSingle(bindingValue);
    if (!(resolvedValue instanceof ComponentInstance)) {
      throw _createComponentError('Component binding is not a component instance', this.errorContext);
    }
    return resolvedValue;
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
      const instance = await this._resolveComponentInstance(bindingValue);
      let result;

      if (this.operation === 'method') {
        result = instance.callMethod(
          this.methodName,
          this.args,
          this.runtime,
          this.cb,
          this.errorContext
        );
      } else if (this.operation === 'observe') {
        result = instance.observeChannel(
          this.channelToObserve,
          this.runtime,
          this.errorContext,
          this.mode,
          this.implicitVarRead
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

async function createComponentInstance(
  templateOrPromise,
  payload,
  ownerContext,
  env,
  runtime,
  cb,
  ownerBuffer,
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
  componentInheritanceState.componentCompositionMode = COMPONENT_COMPOSITION_MODE;

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

  const constructorBoundaryPromise =
    componentInheritanceState && componentInheritanceState.constructorBoundaryPromise;
  if (constructorBoundaryPromise && typeof constructorBoundaryPromise.then === 'function') {
    // Components are only exposed after constructor startup settles so callers
    // never observe a half-initialized instance.
    await constructorBoundaryPromise;
  }

  let ownerCompletionPromise = null;
  if (ownerBuffer) {
    if (typeof ownerBuffer.getFinishCompletePromise !== 'function') {
      throw new Error('Component owner buffer must expose getFinishCompletePromise()');
    }
    ownerCompletionPromise = ownerBuffer.getFinishCompletePromise();
  }

  if (ownerCompletionPromise && typeof ownerCompletionPromise.then === 'function') {
    ownerCompletionPromise.then(() => {
      instance.close();
    }, () => {
      instance.close();
    });
  }

  return instance;
}

function _enqueueComponentOperation(command, currentBuffer, bindingName) {
  if (!currentBuffer) {
    throw new Error('Component operations require a current buffer');
  }
  currentBuffer.add(command, bindingName);
  return command.promise;
}

function callComponentMethod(bindingName, currentBuffer, methodName, args, env, runtime, cb, errorContext = null) {
  const command = new ComponentOperationCommand({
    channelName: bindingName,
    operation: 'method',
    methodName,
    args,
    env,
    runtime,
    cb,
    errorContext
  });
  return _enqueueComponentOperation(command, currentBuffer, bindingName);
}

function observeComponentChannel(bindingName, currentBuffer, channelName, runtime, errorContext = null, mode = 'snapshot', implicitVarRead = false) {
  const command = new ComponentOperationCommand({
    channelName: bindingName,
    operation: 'observe',
    channelToObserve: channelName,
    mode,
    implicitVarRead,
    runtime,
    errorContext
  });
  return _enqueueComponentOperation(command, currentBuffer, bindingName);
}

module.exports = {
  COMPONENT_COMPOSITION_MODE,
  ComponentInstance,
  ComponentOperationCommand,
  createComponentInstance,
  callComponentMethod,
  observeComponentChannel
};
