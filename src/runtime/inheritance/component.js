import {MutatingResultCommand, requireCommandErrorContext} from '../commands/base.js';
import {CommandBuffer} from '../command-buffer.js';
import {cloneContext, cloneWithAddedContext} from '../error-context.js';
import {RuntimeError, isPoisonError, markPromiseHandled} from '../errors.js';
import {getSharedSourceName, isPrivateSharedName} from '../../inheritance/shared-names.js';
import {InheritanceInstance} from './instance.js';

function requireComponentSharedSchemaEntry(instance, chainName, errorContext) {
  const sourceName = getSharedSourceName(chainName);
  if (isPrivateSharedName(chainName)) {
    RuntimeError.reportAndThrow(`Shared chain '${sourceName}' is private and cannot be accessed through a component`, errorContext);
  }
  const schemaEntry = instance.runtimeState.sharedSchema[chainName] || null;
  if (!schemaEntry) {
    RuntimeError.reportAndThrow(`Shared chain '${sourceName}' was not found`, errorContext);
  }
  return schemaEntry;
}

async function observeComponentSharedChain(instance, observationCommand, errorContext, implicitVarRead = false) {
  instance.assertCanInvoke(errorContext);
  if (!observationCommand.isUniversalObservationCommand || !observationCommand.chainName) {
    RuntimeError.reportAndThrow('Component shared observation requires a universal observational chain command', errorContext);
  }

  const chainName = observationCommand.chainName;
  const schemaEntry = requireComponentSharedSchemaEntry(instance, chainName, errorContext);
  if (implicitVarRead && schemaEntry.type !== 'var') {
    const sourceName = getSharedSourceName(chainName);
    RuntimeError.reportAndThrow(
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
    errorContext
  }) {
    super();
    this.methodName = methodName;
    this.args = args;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
  }

  apply(chain) {
    return this.settleResultFrom(() => {
      return applyWithResolvedComponentInstance(
        chain,
        (instance) => instance.invoke(this.methodName, this.args, this.errorContext),
        this.errorContext
      );
    });
  }
}

class ObserveComponentChainCommand extends MutatingResultCommand {
  constructor({
    observationCommand,
    errorContext,
    implicitVarRead = false
  }) {
    super();
    this.observationCommand = observationCommand;
    this.errorContext = requireCommandErrorContext(errorContext, this.constructor.name);
    this.implicitVarRead = implicitVarRead;
  }

  apply(chain) {
    return this.settleResultFrom(() => {
      return applyWithResolvedComponentInstance(
        chain,
        (instance) => observeComponentSharedChain(
          instance,
          this.observationCommand,
          this.errorContext,
          this.implicitVarRead
        ),
        this.errorContext
      );
    });
  }
}

function requireComponentInstance(instance, errorContext) {
  if (!instance || typeof instance.invoke !== 'function') {
    RuntimeError.reportAndThrow('instance.invoke is not a function', errorContext);
  }
  return instance;
}

function applyWithResolvedComponentInstance(chain, fn, errorContext) {
  const target = chain._target;
  if (target && typeof target.then === 'function') {
    return target.then((instance) => {
      instance = requireComponentInstance(instance, errorContext);
      // Component startup publishes a promise immediately. Cache the resolved
      // instance on the side-chain so later operations take the direct path.
      chain.setInitialValue(instance);
      return fn(instance);
    });
  }
  return fn(requireComponentInstance(target, errorContext));
}

async function createComponentInstance(spec) {
  const {
    componentScriptOrTemplate,
    payload,
    ownerContext,
    env,
    runtime,
    renderState,
    ownerBuffer,
    sideChainName = null,
    bindingName = null,
    errorContext
  } = spec;
  const resolvedSideChainName = sideChainName ?? bindingName;
  let templateOrScript = componentScriptOrTemplate;
  if (templateOrScript && typeof templateOrScript.then === 'function') {
    try {
      templateOrScript = await templateOrScript;
    } catch (error) {
      RuntimeError.reportAndThrow(error, errorContext);
    }
  }
  if (!templateOrScript) {
    RuntimeError.reportAndThrow('Component target did not resolve to a script or template', errorContext);
  }

  const payloadContext = { ...(payload ?? {}) };
  const componentContext = ownerContext.forkForComposition(
    templateOrScript.path,
    payloadContext,
    ownerContext.getRenderContextVariables(),
    payloadContext
  );
  const componentErrorContext = cloneWithAddedContext(errorContext, { componentName: bindingName || 'component' });
  renderState.throwIfFatalErrorReported();
  const rootBuffer = new CommandBuffer(componentContext, null, null, null, null, componentErrorContext, ownerBuffer || null, renderState);
  const sharedRootBuffer = new CommandBuffer(componentContext, null, null, null, null, cloneContext(componentErrorContext), ownerBuffer || null, renderState);
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript: templateOrScript,
    env,
    context: componentContext,
    runtime,
    renderState,
    rootBuffer,
    sharedRootBuffer,
    traceParent: ownerBuffer || null,
    errorContext: errorContext
  });

  try {
    await instance.invokeConstructor(errorContext);
  } catch (error) {
    instance.close(error);
    renderState.reportAndThrowFatalError(error, errorContext);
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
    renderState,
    errorContext
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
    renderState,
    ownerBuffer: currentBuffer,
    sideChainName,
    errorContext
  });
  componentInstancePromise.catch((error) => {
    if (isPoisonError(error)) {
      return;
    }
    renderState.reportFatalError(error, errorContext);
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
    errorContext
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
    errorContext,
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
