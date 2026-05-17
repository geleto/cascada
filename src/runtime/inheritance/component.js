import {MutatingCommand, MutatingResultCommand} from '../channels/command-base.js';
import {CommandBuffer} from '../command-buffer.js';
import {RuntimeFatalError, markPromiseHandled} from '../errors.js';
import {resolveSingle} from '../resolve.js';
import {isPrivateSharedName} from '../../inheritance/shared-names.js';
import {InheritanceInstance} from './instance.js';

function getComponentSharedSchemaEntry(instance, channelName, errorContext) {
  if (isPrivateSharedName(channelName)) {
    throw new RuntimeFatalError(`Shared channel '${channelName}' is private and cannot be accessed through a component`, errorContext);
  }
  const schemaEntry = instance.runtimeState.sharedSchema[channelName] || null;
  if (!schemaEntry) {
    throw new RuntimeFatalError(`Shared channel '${channelName}' was not found`, errorContext);
  }
  return schemaEntry;
}

async function observeComponentSharedChannel(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.channelName) {
    throw new RuntimeFatalError('Component shared observation requires a universal observational channel command', errorContext);
  }

  const channelName = observationCommand.channelName;
  const schemaEntry = getComponentSharedSchemaEntry(instance, channelName, errorContext);
  if (implicitVarRead && schemaEntry.type !== 'var') {
    throw new RuntimeFatalError(
      `Shared channel '${channelName}' cannot be used as a bare symbol. Use '${channelName}.snapshot()' instead.`,
      errorContext
    );
  }

  return instance.sharedRootBuffer.addCommand(observationCommand, channelName);
}

class ComponentOperationCommand extends MutatingResultCommand {
  constructor({
    methodName,
    args,
    errorContext = null
  }) {
    super();
    this.methodName = methodName;
    this.args = args;
    this.errorContext = errorContext;
  }

  apply(channel) {
    return this.settleResultFrom(() => {
      return withComponentInstance(channel, (instance) =>
        instance.invoke(this.methodName, this.args, this.errorContext)
      );
    });
  }
}

class ObserveComponentChannelCommand extends MutatingResultCommand {
  constructor({
    observationCommand,
    errorContext = null,
    implicitVarRead = false
  }) {
    super();
    this.observationCommand = observationCommand;
    this.errorContext = errorContext;
    this.implicitVarRead = implicitVarRead;
  }

  apply(channel) {
    return this.settleResultFrom(() => {
      return withComponentInstance(channel, (instance) =>
        observeComponentSharedChannel(
          instance,
          this.observationCommand,
          this.errorContext,
          this.implicitVarRead
        )
      );
    });
  }
}

function withComponentInstance(channel, fn) {
  const target = channel._target;
  if (target && typeof target.then === 'function') {
    return target.then((instance) => {
      channel.setInitialValue(instance);
      return fn(instance);
    });
  }
  return fn(target);
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
    sideChannelName = null,
    bindingName = null,
    errorContext = null
  } = spec;
  const resolvedSideChannelName = sideChannelName ?? bindingName;
  const templateOrScript = await resolveSingle(componentScriptOrTemplate);
  if (!templateOrScript) {
    throw new RuntimeFatalError('Component target did not resolve to a script or template', errorContext);
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

  if (ownerBuffer && resolvedSideChannelName) {
    ownerBuffer.getChannel(resolvedSideChannelName).getFinishedPromise().then(() => instance.close());
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
  const sideChannelName = bindingName;
  const channel = currentBuffer.getChannel(sideChannelName);
  const componentInstancePromise = createComponentInstance({
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    ownerBuffer: currentBuffer,
    sideChannelName,
    errorContext
  });
  markPromiseHandled(componentInstancePromise);
  channel.setInitialValue(componentInstancePromise);
  return componentInstancePromise;
}

function callComponentMethod(spec) {
  const {
    bindingName,
    currentBuffer,
    methodName,
    args,
    errorContext = null
  } = spec;
  const sideChannelName = bindingName;
  const command = new ComponentOperationCommand({
    methodName,
    args,
    errorContext
  });
  currentBuffer.addCommand(command, sideChannelName);
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
  const sideChannelName = bindingName || observationCommand.channelName;
  const command = new ObserveComponentChannelCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  currentBuffer.addCommand(command, sideChannelName);
  return command.promise;
}

export {
  createComponentInstance,
  startComponentInstance,
  callComponentMethod,
  observeComponentChannel
};
