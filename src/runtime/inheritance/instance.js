import {cloneWithAddedContext} from '../error-context.js';
import {RuntimeError} from '../errors.js';
import {createInheritanceCallableArgumentFrame} from './invoke.js';
import {declareInheritanceSharedChain} from './shared.js';

class InheritanceInstance {
  constructor(options) {
    this.runtimeState = options.runtimeState;
    this.ownerState = options.ownerState;
    this.rootBuffer = options.rootBuffer;
    this.sharedRootBuffer = options.sharedRootBuffer;
    this.traceParent = options.traceParent || null;
    this.context = options.context;
    this.failure = null;
    this.closed = false;
  }

  static async create(options) {
    const ownerState = options.ownerState;
    const context = options.context;
    const traceParent = options.traceParent || null;
    const rootBuffer = options.rootBuffer || new ownerState.runtime.CommandBuffer(
      context,
      null,
      null,
      null,
      null,
      cloneWithAddedContext(options.errorContext, { entryName: 'inheritance' }),
      traceParent,
      ownerState.renderState
    );
    const sharedRootBuffer = options.sharedRootBuffer || rootBuffer;
    try {
      const chain = await ownerState.runtime.loadInheritanceChain({
        templateOrScript: options.entryTemplateOrScript,
        ownerState,
        context,
        errorContext: options.errorContext,
        directMacroBindings: options.directMacroBindings
      });
      const runtimeState = ownerState.runtime.finalizeInheritanceChain(chain, context);
      const boundRuntimeState = ownerState.runtime.bindInheritanceRuntimeState(runtimeState);

      Object.entries(boundRuntimeState.sharedSchema).forEach(([name, schemaEntry]) => {
        declareInheritanceSharedChain(sharedRootBuffer, name, schemaEntry.type, context, undefined, schemaEntry.errorContext);
      });

      return new InheritanceInstance({
        runtimeState: boundRuntimeState,
        ownerState,
        rootBuffer,
        sharedRootBuffer,
        traceParent,
        context
      });
    } catch (error) {
      rootBuffer.finish();
      if (sharedRootBuffer !== rootBuffer) {
        sharedRootBuffer.finish();
      }
      throw error;
    }
  }

  invoke(methodName, args = [], errorContext) {
    this.assertCanInvoke(errorContext);
    return this._invokeFromMethodData(this.requireMethod(methodName, errorContext), args, errorContext, this.sharedRootBuffer, this.context, this.traceParent);
  }

  invokeFromCurrentBuffer(methodName, args, context, currentBuffer, errorContext) {
    this.assertCanInvoke(errorContext);
    return this._invokeFromMethodData(this.requireMethod(methodName, errorContext), args, errorContext, currentBuffer, context, currentBuffer);
  }

  invokeSuper(methodData, args, context, currentBuffer, errorContext) {
    this.assertCanInvoke(errorContext);
    if (!methodData.super) {
      RuntimeError.reportAndThrow(
        `super() in '${methodData.name}' has no parent implementation`,
        errorContext
      );
    }
    return this._invokeFromMethodData(methodData.super, args, errorContext, currentBuffer, context, currentBuffer);
  }

  invokeConstructor(errorContext) {
    this.assertCanInvoke(errorContext);
    const constructorEntry = this.runtimeState.methods.__constructor__ || null;
    if (!constructorEntry) {
      return undefined;
    }
    return this._invokeFromMethodData(constructorEntry, [], errorContext, this.sharedRootBuffer, this.context, this.traceParent);
  }

  assertCanInvoke(errorContext) {
    this.ownerState.renderState.throwIfFatalErrorReported();
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      RuntimeError.reportAndThrow(
        'Inheritance instance is closed and cannot accept new operations',
        errorContext
      );
    }
  }

  requireMethod(methodName, errorContext) {
    const methodData = this.runtimeState.methods[methodName] || null;
    if (!methodData) {
      RuntimeError.reportAndThrow(
        `missing inherited method '${methodName}'`,
        errorContext
      );
    }
    return methodData;
  }

  getDirectMacroBinding(methodData, name, errorContext) {
    const bindings = methodData.ownerEntry.directMacroBindings;
    if (bindings && Object.hasOwn(bindings, name)) {
      return bindings[name];
    }
    RuntimeError.reportAndThrow(
      `missing direct binding '${name}'`,
      errorContext
    );
  }

  setDirectMacroBinding(methodData, name, value, errorContext) {
    const bindings = methodData.ownerEntry.directMacroBindings;
    if (!bindings) {
      RuntimeError.reportAndThrow(
        `missing direct binding table for '${name}'`,
        errorContext
      );
    }
    bindings[name] = value;
  }

  _invokeFromMethodData(methodData, args, errorContext, parentBuffer, context, traceParent = null) {
    const invocationBuffer = new this.ownerState.runtime.CommandBuffer(
      context,
      parentBuffer,
      [methodData.mergedObservedChains, methodData.mergedMutatedChains],
      [methodData.mergedObservedChains, methodData.mergedMutatedChains],
      parentBuffer,
      this.ownerState.runtime.cloneWithAddedContext(errorContext, {
        methodName: methodData.name,
        methodSignature: `${methodData.name}(${methodData.signature.argNames.join(', ')})`
      }),
      traceParent,
      this.ownerState.renderState
    );
    const callablePayload = methodData.isConstructor
      ? null
      : {
        originalArgs: createInheritanceCallableArgumentFrame(
          methodData,
          args,
          errorContext
        )
      };
    const renderContext = methodData.isConstructor ? undefined : context.getRenderContextVariables();

    let result;
    try {
      result = methodData.fn(
        methodData.ownerEntry.ownerState,
        context,
        invocationBuffer,
        callablePayload,
        renderContext,
        methodData,
        this
      );
    } catch (error) {
      // Cleanup only: this remains a fatal structural error, but the invocation
      // owns this child buffer and must close it so linked waiters do not hang.
      invocationBuffer.finish();
      return invocationBuffer.getFinishedPromise().then(() => {
        throw error;
      });
    }

    const finishWithValue = (value) => {
      invocationBuffer.finish();
      return invocationBuffer.getFinishedPromise().then(() => value);
    };
    const finishWithError = (error) => {
      invocationBuffer.finish();
      return invocationBuffer.getFinishedPromise().then(() => {
        throw error;
      });
    };

    return result && typeof result.then === 'function'
      ? result.then(finishWithValue, finishWithError)
      : finishWithValue(result);
  }

  finishRender(entryResult) {
    this.close();
    const finished = this.rootBuffer.getFinishedPromise();
    return finished.then(() => entryResult);
  }

  close(error = null) {
    if (error && !this.failure) {
      this.failure = error;
    }
    this.closed = true;
    this.sharedRootBuffer.finish();
    this.rootBuffer.finish();
  }
}

async function renderInheritanceParticipantRoot({ ownerState, context, rootBuffer, directMacroBindings, errorContext }) {
  ownerState.renderState.throwIfFatalErrorReported();
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript: ownerState.templateOrScript,
    ownerState,
    context,
    rootBuffer,
    directMacroBindings,
    errorContext
  });
  let entryResult;
  try {
    entryResult = await instance.invokeConstructor(errorContext);
    return instance.finishRender(entryResult);
  } catch (error) {
    // Cleanup only: constructor failures remain fatal, but this adapter owns the
    // root/shared buffers and must close them so linked waiters do not hang.
    instance.close(error);
    throw error;
  }
}

export {InheritanceInstance, renderInheritanceParticipantRoot};
