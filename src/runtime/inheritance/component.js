import {MutatingResultCommand} from '../commands/base.js';
import {CommandBuffer} from '../command-buffer.js';
import {RuntimeFatalError, markPromiseHandled} from '../errors.js';
import {resolveSingle} from '../resolve.js';
import {getSharedSourceName, isPrivateSharedName} from '../../inheritance/shared-names.js';
import {InheritanceInstance} from './instance.js';

function getComponentSharedSchemaEntry(instance, chainName, errorContext) {
  const sourceName = getSharedSourceName(chainName);
  if (isPrivateSharedName(chainName)) {
    throw new RuntimeFatalError(`Shared chain '${sourceName}' is private and cannot be accessed through a component`, errorContext);
  }
  const schemaEntry = instance.runtimeState.sharedSchema[chainName] || null;
  if (!schemaEntry) {
    throw new RuntimeFatalError(`Shared chain '${sourceName}' was not found`, errorContext);
  }
  return schemaEntry;
}

async function observeComponentSharedChain(instance, observationCommand, errorContext = null, implicitVarRead = false) {
  instance.assertOpen(errorContext);
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.chainName) {
    throw new RuntimeFatalError('Component shared observation requires a universal observational chain command', errorContext);
  }

  const chainName = observationCommand.chainName;
  const schemaEntry = getComponentSharedSchemaEntry(instance, chainName, errorContext);
  if (implicitVarRead && schemaEntry.type !== 'var') {
    const sourceName = getSharedSourceName(chainName);
    throw new RuntimeFatalError(
      `Shared chain 'this.${sourceName}' cannot be used as a bare symbol. Use 'this.${sourceName}.snapshot()' instead.`,
      errorContext
    );
  }

  return instance.sharedRootBuffer.addCommand(observationCommand, chainName);
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

  apply(chain) {
    return this.settleResultFrom(() => {
      return applyWithResolvedComponentInstance(chain, (instance) =>
        instance.invoke(this.methodName, this.args, this.errorContext)
      );
    });
  }
}

class ObserveComponentChainCommand extends MutatingResultCommand {
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

  apply(chain) {
    return this.settleResultFrom(() => {
      return applyWithResolvedComponentInstance(chain, (instance) =>
        observeComponentSharedChain(
          instance,
          this.observationCommand,
          this.errorContext,
          this.implicitVarRead
        )
      );
    });
  }
}

function applyWithResolvedComponentInstance(chain, fn) {
  const target = chain._target;
  if (target && typeof target.then === 'function') {
    return target.then((instance) => {
      // Component startup publishes a promise immediately. Cache the resolved
      // instance on the side-chain so later operations take the direct path.
      chain.setInitialValue(instance);
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
    sideChainName = null,
    bindingName = null,
    errorContext = null
  } = spec;
  const resolvedSideChainName = sideChainName ?? bindingName;
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

  if (ownerBuffer && resolvedSideChainName) {
    ownerBuffer.getChain(resolvedSideChainName).getFinishedPromise().then(() => instance.close());
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
  // The user binding is also the internal side-chain lane that orders later
  // component method calls and observations for this instance.
  const sideChainName = bindingName;
  const chain = currentBuffer.getChain(sideChainName);
  const componentInstancePromise = createComponentInstance({
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    cb,
    ownerBuffer: currentBuffer,
    sideChainName,
    errorContext
  });
  markPromiseHandled(componentInstancePromise);
  chain.setInitialValue(componentInstancePromise);
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
  const sideChainName = bindingName;
  const command = new ComponentOperationCommand({
    methodName,
    args,
    errorContext
  });
  currentBuffer.addCommand(command, sideChainName);
  return command.promise;
}

function observeComponentChain(spec) {
  const {
    bindingName,
    currentBuffer,
    observationCommand,
    errorContext = null,
    implicitVarRead = false
  } = spec;
  const sideChainName = bindingName || observationCommand.chainName;
  const command = new ObserveComponentChainCommand({
    observationCommand,
    errorContext,
    implicitVarRead
  });
  currentBuffer.addCommand(command, sideChainName);
  return command.promise;
}

export {
  createComponentInstance,
  startComponentInstance,
  callComponentMethod,
  observeComponentChain
};
