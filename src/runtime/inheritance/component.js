// Wraps component instances around the inheritance runtime.
// Components own an independent inheritance state, root buffer, and context.

import {Command} from '../channels/command-base.js';
import {declareBufferChannel} from '../channels/index.js';
import {CommandBuffer} from '../command-buffer.js';
import {createCompositionPayload} from '../composition-payload.js';
import {RuntimeFatalError} from '../errors.js';
import {resolveSingle} from '../resolve.js';
import {
  createInheritanceState,
  setInheritanceSharedRootBuffer,
  setInheritanceStartupPromise
} from './state.js';
import {finalizeInheritanceMetadata} from './finalize.js';
import {invokeInheritedCallable} from './invoke.js';
import {ensureInheritanceSharedSchemaTable} from './shared.js';

/*
// Runtime component instance.
type ComponentInstance = {
  context: object,
  rootBuffer: CommandBuffer,
  inheritanceState: InheritanceState,
  env: object,
  closed: boolean,
  startupError: Error | null
}

// Command that starts one component instance on the binding channel.
type StartComponentInstanceCommandShape = {
  templateOrPromise: Template | Script | Promise<Template | Script>,
  payload: object | null,
  ownerContext: object,
  ownerBuffer: CommandBuffer,
  bindingName: string
}

// Command that invokes one method on a component binding.
type ComponentOperationCommandShape = {
  methodName: string,
  args: unknown[],
  errorContext: SourceOrigin | null
}

// Command that observes one shared channel on a component binding.
type ObserveSharedChannelCommandShape = {
  observationCommand: Command,
  implicitVarRead: boolean,
  errorContext: SourceOrigin | null
}
*/

function createComponentError(message, errorContext = null) {
  return new RuntimeFatalError(
    message,
    errorContext?.lineno ?? 0,
    errorContext?.colno ?? 0,
    errorContext?.errorContextString ?? null,
    errorContext?.path ?? null
  );
}

class ComponentInstance {
  constructor({
    context,
    rootBuffer,
    inheritanceState,
    env
  }) {
    this.context = context;
    this.rootBuffer = rootBuffer;
    this.inheritanceState = inheritanceState;
    this.env = env;
    this.closed = false;
    this.startupError = null;
  }

  setStartupError(error) {
    if (!this.startupError) {
      this.startupError = error;
    }
  }

  throwIfUnavailable(errorContext) {
    if (this.closed) {
      throw createComponentError('Component instance cannot accept new operations', errorContext);
    }
    if (this.startupError) {
      throw this.startupError;
    }
  }

  callMethod(methodName, args, runtime, cb, errorContext = null) {
    this.throwIfUnavailable(errorContext);
    return invokeInheritedCallable(
      this.inheritanceState,
      methodName,
      args,
      this.context,
      this.env,
      runtime,
      cb,
      this.rootBuffer,
      errorContext
    );
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rootBuffer.finish();
  }
}

async function resolveComponentInstance(bindingValue, errorContext = null) {
  const resolvedValue = await resolveSingle(bindingValue);
  if (!(resolvedValue instanceof ComponentInstance)) {
    throw createComponentError('Component binding is not a component instance', errorContext);
  }
  return resolvedValue;
}

class ComponentOperationCommand extends Command {
  constructor({
    methodName,
    args,
    runtime,
    cb,
    errorContext = null
  }) {
    super({ withDeferredResult: true });
    this.methodName = methodName;
    this.args = args;
    this.runtime = runtime;
    this.cb = cb;
    this.errorContext = errorContext;
    this.isObservable = false;
  }

  apply(channel) {
    return this.run(channel._getTarget());
  }

  async run(bindingValue) {
    try {
      const instance = await resolveComponentInstance(bindingValue, this.errorContext);
      const result = await instance.callMethod(
        this.methodName,
        this.args,
        this.runtime,
        this.cb,
        this.errorContext
      );
      this.resolveResult(result);
      return result;
    } catch (err) {
      this.rejectResult(err);
      throw err;
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
    cb,
    ownerBuffer,
    bindingName,
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

  apply() {
    return this.run();
  }

  async run() {
    try {
      const instance = await createComponentInstance({
        templateOrPromise: this.templateOrPromise,
        payload: this.payload,
        ownerContext: this.ownerContext,
        env: this.env,
        runtime: this.runtime,
        cb: this.cb,
        ownerBuffer: this.ownerBuffer,
        bindingName: this.bindingName,
        errorContext: this.errorContext
      });
      this.resolveResult(instance);
      return instance;
    } catch (err) {
      this.rejectResult(err);
      throw err;
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

  apply(channel) {
    return this.run(channel._getTarget());
  }

  async run(bindingValue) {
    try {
      const instance = await resolveComponentInstance(bindingValue, this.errorContext);
      const result = await observeInstanceSharedChannel(
        instance,
        this.observationCommand,
        this.errorContext,
        this.implicitVarRead
      );
      this.resolveResult(result);
      return result;
    } catch (err) {
      this.rejectResult(err);
      throw err;
    }
  }
}

async function createComponentInstance({
  templateOrPromise,
  payload,
  ownerContext,
  env,
  runtime,
  cb,
  ownerBuffer,
  bindingName = null,
  errorContext = null
}) {
  const template = await resolveSingle(templateOrPromise);
  if (!template) {
    throw createComponentError('Component target did not resolve to a script or template', errorContext);
  }
  if (typeof template.compile === 'function') {
    template.compile();
  }
  if (typeof template.rootRenderFunc !== 'function') {
    throw createComponentError('Component target did not expose a compiled rootRenderFunc', errorContext);
  }

  const compositionPayload = createCompositionPayload({ ...(payload ?? {}) });
  const componentContext = ownerContext.forkForComposition(
    template.path,
    compositionPayload.rootContext,
    ownerContext.getRenderContextVariables(),
    compositionPayload.payloadContext
  );
  const componentRootBuffer = new CommandBuffer(componentContext, null, null, null);
  if (template.scriptMode === false) {
    declareBufferChannel(componentRootBuffer, '__text__', 'text', componentContext, null);
  }
  const componentInheritanceState = createInheritanceState();
  setInheritanceSharedRootBuffer(componentInheritanceState, componentRootBuffer);
  componentInheritanceState.compositionPayload = compositionPayload;

  const instance = new ComponentInstance({
    context: componentContext,
    rootBuffer: componentRootBuffer,
    inheritanceState: componentInheritanceState,
    env
  });

  const componentCallback = (error) => {
    if (error) {
      instance.setStartupError(error);
      if (typeof cb === 'function') {
        cb(error);
      }
    }
  };

  try {
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
  } catch (err) {
    instance.setStartupError(err);
    if (typeof cb === 'function') {
      cb(err);
    }
  }

  const rootStartupPromise = componentInheritanceState.startupPromise;
  const componentStartupPromise = completeComponentStartup(
    instance,
    rootStartupPromise,
    runtime,
    cb,
    errorContext
  );
  setInheritanceStartupPromise(componentInheritanceState, componentStartupPromise);
  await componentStartupPromise;
  registerCloseOnOwnerComplete(instance, ownerBuffer, bindingName);

  return instance;
}

async function completeComponentStartup(instance, rootStartupPromise, runtime, cb, errorContext = null) {
  try {
    if (rootStartupPromise) {
      await rootStartupPromise;
    }
    if (!instance.inheritanceState.finalized && !instance.startupError) {
      finalizeInheritanceMetadata(instance.inheritanceState, instance.context);
    }
    if (!instance.startupError) {
      await runComponentConstructor(instance, runtime, cb, errorContext);
    }
  } catch (err) {
    instance.setStartupError(err);
    instance.close();
    if (typeof cb === 'function') {
      cb(err);
    }
    throw err;
  }
}

async function runComponentConstructor(instance, runtime, cb, errorContext = null) {
  const constructorEntry = instance.inheritanceState.methods.__constructor__;
  if (!constructorEntry) {
    return;
  }
  const result = invokeInheritedCallable(
    instance.inheritanceState,
    '__constructor__',
    runtime.createArray([]),
    instance.context,
    instance.env,
    runtime,
    cb,
    instance.rootBuffer,
    errorContext
  );
  await resolveSingle(result);
}

function registerCloseOnOwnerComplete(instance, ownerBuffer, bindingName) {
  if (!ownerBuffer || !bindingName || typeof ownerBuffer.getChannel !== 'function') {
    return;
  }
  const bindingChannel = ownerBuffer.getChannel(bindingName);
  const bindingSnapshot = bindingChannel?.finalSnapshot ? bindingChannel.finalSnapshot() : null;
  if (bindingSnapshot && typeof bindingSnapshot.then === 'function') {
    const closeInstance = () => instance.close();
    bindingSnapshot.then(closeInstance, closeInstance);
  }
}

function observeInstanceSharedChannel(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  instance.throwIfUnavailable(errorContext);
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.channelName) {
    throw createComponentError('Component shared observation requires a universal observational channel command', errorContext);
  }
  const channelName = observationCommand.channelName;
  if (channelName.charAt(0) === '_') {
    throw createComponentError(`Shared channel "${channelName}" is private and cannot be observed`, errorContext);
  }

  const sharedSchema = ensureInheritanceSharedSchemaTable(instance.inheritanceState);
  const channelType = sharedSchema[channelName] ?? null;
  if (!channelType) {
    throw createComponentError(`Shared channel "${channelName}" was not found`, errorContext);
  }
  if (implicitVarRead && channelType !== 'var') {
    throw createComponentError(
      `Shared channel "${channelName}" cannot be used as a bare symbol. Use "${channelName}.snapshot()" instead.`,
      errorContext
    );
  }

  instance.rootBuffer.addCommand(observationCommand, channelName);
  return observationCommand.promise;
}

function startComponentInstance({
  currentBuffer,
  bindingName,
  templateOrPromise,
  payload,
  ownerContext,
  env,
  runtime,
  cb,
  errorContext = null
}) {
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
  currentBuffer.addCommand(command, bindingName);
  return command.promise;
}

function callComponentMethod({
  bindingName,
  currentBuffer,
  methodName,
  args,
  runtime,
  cb,
  errorContext = null
}) {
  const command = new ComponentOperationCommand({
    methodName,
    args,
    runtime,
    cb,
    errorContext
  });
  currentBuffer.addCommand(command, bindingName);
  return command.promise;
}

function observeComponentChannel({
  bindingName,
  currentBuffer,
  observationCommand,
  errorContext = null,
  implicitVarRead = false
}) {
  if (!bindingName) {
    throw createComponentError('Component shared observation requires a component binding name', errorContext);
  }
  const command = new ObserveSharedChannelCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  currentBuffer.addCommand(command, bindingName);
  return command.promise;
}

export {
  ComponentInstance,
  callComponentMethod,
  createComponentInstance,
  observeComponentChannel,
  startComponentInstance
};
