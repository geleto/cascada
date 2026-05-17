import {MutatingCommand, MutatingResultCommand} from '../channels/command-base.js';
import {CommandBuffer} from '../command-buffer.js';
import {RuntimeFatalError, markPromiseHandled} from '../errors.js';
import {resolveSingle} from '../resolve.js';
import {getSharedSourceName, isPrivateSharedName} from '../../inheritance/shared-names.js';
import {InheritanceInstance} from './instance.js';

function getComponentSharedSchemaEntry(instance, channelName, errorContext) {
  const sourceName = getSharedSourceName(channelName);
  if (isPrivateSharedName(channelName)) {
    throw new RuntimeFatalError(`Shared channel '${sourceName}' is private and cannot be accessed through a component`, errorContext);
  }
  const schemaEntry = instance.runtimeState.sharedSchema[channelName] || null;
  if (!schemaEntry) {
    throw new RuntimeFatalError(`Shared channel '${sourceName}' was not found`, errorContext);
  }
  return schemaEntry;
}

async function observeComponentSharedChannel(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  instance.assertOpen(errorContext);
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.channelName) {
    throw new RuntimeFatalError('Component shared observation requires a universal observational channel command', errorContext);
  }

  const channelName = observationCommand.channelName;
  const schemaEntry = getComponentSharedSchemaEntry(instance, channelName, errorContext);
  if (implicitVarRead && schemaEntry.type !== 'var') {
    const sourceName = getSharedSourceName(channelName);
    throw new RuntimeFatalError(
      `Shared channel 'this.${sourceName}' cannot be used as a bare symbol. Use 'this.${sourceName}.snapshot()' instead.`,
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
      return applyWithResolvedComponentInstance(channel, (instance) =>
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
      return applyWithResolvedComponentInstance(channel, (instance) =>
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

function applyWithResolvedComponentInstance(channel, fn) {
  const target = channel._target;
  if (target && typeof target.then === 'function') {
    return target.then((instance) => {
      // Component startup publishes a promise immediately. Cache the resolved
      // instance on the side-channel so later operations take the direct path.
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
    instance.close(error);
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
  // The user binding is also the internal side-channel lane that orders later
  // component method calls and observations for this instance.
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
