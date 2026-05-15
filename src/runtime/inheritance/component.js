import {Command} from '../channels/command-base.js';
import {CommandBuffer} from '../command-buffer.js';
import {RuntimeFatalError} from '../errors.js';
import {resolveSingle} from '../resolve.js';
import {InheritanceInstance} from './instance.js';
import {isPrivateSharedName} from '../../inheritance/shared-names.js';

function createComponentError(message, errorContext = null) {
  return new RuntimeFatalError(
    message,
    errorContext?.lineno ?? 0,
    errorContext?.colno ?? 0,
    errorContext?.errorContextString ?? null,
    errorContext?.path ?? null
  );
}

function getComponentSharedSchemaEntry(instance, channelName, errorContext) {
  if (isPrivateSharedName(channelName)) {
    throw createComponentError(`Shared channel '${channelName}' was not found`, errorContext);
  }
  const schemaEntry = instance.runtimeState.sharedSchema[channelName] || null;
  if (!schemaEntry) {
    throw createComponentError(`Shared channel '${channelName}' was not found`, errorContext);
  }
  return schemaEntry;
}

async function observeComponentSharedChannel(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.channelName) {
    throw createComponentError('Component shared observation requires a universal observational channel command', errorContext);
  }

  const channelName = observationCommand.channelName;
  const schemaEntry = getComponentSharedSchemaEntry(instance, channelName, errorContext);
  if (implicitVarRead && schemaEntry.type !== 'var') {
    throw createComponentError(
      `Shared channel '${channelName}' cannot be used as a bare symbol. Use '${channelName}.snapshot()' instead.`,
      errorContext
    );
  }

  const channel = instance.sharedRootBuffer.getChannelIfExists(channelName);
  if (!channel) {
    throw createComponentError(`Shared channel '${channelName}' was not found`, errorContext);
  }
  return instance.sharedRootBuffer.addCommand(observationCommand, channelName);
}

class ComponentOperationCommand extends Command {
  constructor({
    methodName,
    args,
    errorContext = null
  }) {
    super({ withDeferredResult: true, resolveApplyResult: true });
    this.methodName = methodName;
    this.args = args;
    this.errorContext = errorContext;
    this.isObservable = false;
  }

  async apply(channel) {
    const instance = await resolveSingle(channel._getTarget());
    return instance.invoke(this.methodName, this.args, this.errorContext);
  }
}

class StartComponentInstanceCommand extends Command {
  constructor({
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    cb = null,
    ownerBuffer,
    bindingName,
    errorContext = null
  }) {
    super({ withDeferredResult: true, resolveApplyResult: true });
    this.componentScriptOrTemplate = componentScriptOrTemplate;
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
    return createComponentInstance({
      componentScriptOrTemplate: this.componentScriptOrTemplate,
      payload: this.payload,
      ownerContext: this.ownerContext,
      env: this.env,
      runtime: this.runtime,
      cb: this.cb,
      ownerBuffer: this.ownerBuffer,
      bindingName: this.bindingName,
      errorContext: this.errorContext
    });
  }
}

class ObserveComponentChannelCommand extends Command {
  constructor({
    observationCommand,
    errorContext = null,
    implicitVarRead = false
  }) {
    super({ withDeferredResult: true, resolveApplyResult: true });
    this.observationCommand = observationCommand;
    this.errorContext = errorContext;
    this.implicitVarRead = implicitVarRead;
    this.isObservable = false;
  }

  async apply(channel) {
    const instance = await resolveSingle(channel._getTarget());
    return observeComponentSharedChannel(
      instance,
      this.observationCommand,
      this.errorContext,
      this.implicitVarRead
    );
  }
}

async function createComponentInstance(spec) {
  const {
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    ownerBuffer,
    bindingName = null,
    errorContext = null
  } = spec;
  const templateOrScript = await resolveSingle(componentScriptOrTemplate);
  if (!templateOrScript) {
    throw createComponentError('Component target did not resolve to a script or template', errorContext);
  }

  const payloadContext = { ...(payload ?? {}) };
  const componentContext = ownerContext.forkForComposition(
    templateOrScript.path,
    payloadContext,
    ownerContext.getRenderContextVariables(),
    payloadContext
  );
  const rootBuffer = new CommandBuffer(componentContext, null, null, null);
  const sharedRootBuffer = new CommandBuffer(componentContext, null, null, null);
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript: templateOrScript,
    env,
    context: componentContext,
    runtime,
    cb,
    rootBuffer,
    sharedRootBuffer,
    origin: errorContext
  });

  try {
    await instance.invokeConstructor(errorContext);
  } catch (error) {
    instance.close();
    if (cb) {
      cb(error);
    }
    throw error;
  }

  if (ownerBuffer && bindingName) {
    const bindingSnapshot = ownerBuffer.getChannel(bindingName).finalSnapshot();
    Promise.resolve(bindingSnapshot).then(
      () => instance.close(),
      () => instance.close()
    );
  }

  return instance;
}

function startComponentInstance(spec) {
  const {
    currentBuffer,
    bindingName,
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    errorContext = null
  } = spec;
  const command = new StartComponentInstanceCommand({
    componentScriptOrTemplate,
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

function callComponentMethod(spec) {
  const {
    bindingName,
    currentBuffer,
    methodName,
    args,
    errorContext = null
  } = spec;
  const command = new ComponentOperationCommand({
    methodName,
    args,
    errorContext
  });
  currentBuffer.addCommand(command, bindingName);
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
  const command = new ObserveComponentChannelCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  currentBuffer.addCommand(command, bindingName || observationCommand.channelName);
  return command.promise;
}

export {
  createComponentInstance,
  startComponentInstance,
  callComponentMethod,
  observeComponentChannel
};
