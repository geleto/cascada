import {RuntimeFatalError} from '../errors.js';
import {createInheritanceCallableArgumentFrame} from './invoke.js';
import {declareInheritanceSharedChain} from './shared.js';

class InheritanceInstance {
  constructor(options) {
    this.entryTemplateOrScript = options.entryTemplateOrScript;
    this.runtimeState = options.runtimeState;
    this.env = options.env;
    this.runtime = options.runtime;
    this.renderState = options.renderState;
    this.rootBuffer = options.rootBuffer;
    this.sharedRootBuffer = options.sharedRootBuffer;
    this.traceParent = options.traceParent || null;
    this.context = options.context;
    this.failure = null;
    this.closed = false;
  }

  static async create(options) {
    const runtime = options.runtime;
    const context = options.context;
    const traceParent = options.traceParent || null;
    const rootBuffer = options.rootBuffer || new runtime.CommandBuffer(
      context,
      null,
      null,
      null,
      null,
      { ec: options.errorContext, branchName: 'inheritance' },
      traceParent,
      options.renderState
    );
    const sharedRootBuffer = options.sharedRootBuffer || rootBuffer;
    const chain = await runtime.loadInheritanceChain({
      templateOrScript: options.entryTemplateOrScript,
      env: options.env,
      context,
      runtime,
      errorContext: options.errorContext ?? null,
      renderState: options.renderState
    });
    const runtimeState = runtime.finalizeInheritanceChain(chain, context);
    const boundRuntimeState = runtime.bindInheritanceRuntimeState(runtimeState, runtime, options.renderState.reportError);

    Object.entries(boundRuntimeState.sharedSchema).forEach(([name, schemaEntry]) => {
      declareInheritanceSharedChain(sharedRootBuffer, name, schemaEntry.type, context, undefined, schemaEntry.errorContext);
    });

    return new InheritanceInstance({
      entryTemplateOrScript: chain.entries[0].templateOrScript,
      runtimeState: boundRuntimeState,
      env: options.env,
      runtime,
      renderState: options.renderState,
      rootBuffer,
      sharedRootBuffer,
      traceParent,
      context
    });
  }

  invoke(methodName, args = [], errorContext = null) {
    this.assertCanInvoke(errorContext);
    return this._invokeFromMethodData(this.getMethod(methodName, errorContext), args, errorContext, this.sharedRootBuffer, this.context, this.traceParent);
  }

  invokeFromCurrentBuffer(methodName, args, context, currentBuffer, errorContext = null) {
    this.assertCanInvoke(errorContext);
    return this._invokeFromMethodData(this.getMethod(methodName, errorContext), args, errorContext, currentBuffer, context, currentBuffer);
  }

  invokeSuper(methodData, args, context, currentBuffer, errorContext = null) {
    this.assertCanInvoke(errorContext);
    if (!methodData.super) {
      throw new RuntimeFatalError(
        `super() in '${methodData.name}' has no parent implementation`,
        errorContext
      );
    }
    return this._invokeFromMethodData(methodData.super, args, errorContext, currentBuffer, context, currentBuffer);
  }

  invokeConstructor(errorContext = null) {
    this.assertCanInvoke(errorContext);
    const constructorEntry = this.runtimeState.methods.__constructor__ || null;
    if (!constructorEntry) {
      return undefined;
    }
    return this._invokeFromMethodData(constructorEntry, [], errorContext, this.sharedRootBuffer, this.context, this.traceParent);
  }

  assertCanInvoke(errorContext = null) {
    this.renderState.throwIfFatalErrorReported();
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      throw new RuntimeFatalError(
        'Inheritance instance is closed and cannot accept new operations',
        errorContext
      );
    }
  }

  getMethod(methodName, errorContext) {
    const methodData = this.runtimeState.methods[methodName] || null;
    if (!methodData) {
      throw new RuntimeFatalError(
        `missing inherited method '${methodName}'`,
        errorContext
      );
    }
    return methodData;
  }

  _invokeFromMethodData(methodData, args, errorContext, parentBuffer, context, traceParent = null) {
    const effectiveErrorContext = errorContext ?? methodData.errorContext;
    const visibleChains = Array.from(new Set([
      ...methodData.mergedLinkedChains,
      ...methodData.mergedMutatedChains
    ]));
    const invocationBuffer = new this.runtime.CommandBuffer(
      context,
      parentBuffer,
      visibleChains,
      parentBuffer,
      methodData.mergedMutatedChains,
      { ec: effectiveErrorContext, branchName: methodData.name },
      traceParent,
      this.renderState
    );
    const callablePayload = methodData.isConstructor
      ? null
      : {
        originalArgs: createInheritanceCallableArgumentFrame(
          methodData,
          args,
          effectiveErrorContext
        )
      };
    const renderContext = methodData.isConstructor ? undefined : context.getRenderContextVariables();

    let result;
    try {
      result = methodData.fn(
        this.env,
        context,
        this.runtime,
        this.renderState,
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

async function renderInheritanceParticipantRoot({ entryTemplateOrScript, env, context, runtime, renderState, rootBuffer, errorContext = null }) {
  renderState.throwIfFatalErrorReported();
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript,
    env,
    context,
    runtime,
    renderState,
    rootBuffer,
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
