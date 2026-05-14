import {RuntimeFatalError} from '../errors.js';
import {createInheritanceCallableArgumentFrame} from './invoke.js';
import {declareInheritanceSharedChannel} from './shared.js';

class InheritanceInstance {
  constructor(options) {
    this.entryTemplateOrScript = options.entryTemplateOrScript;
    this.runtimeState = options.runtimeState;
    this.env = options.env;
    this.runtime = options.runtime;
    this.cb = options.cb;
    this.rootBuffer = options.rootBuffer;
    this.sharedRootBuffer = options.sharedRootBuffer;
    this.context = options.context;
    this.failure = null;
    this.closed = false;
  }

  static async create(options) {
    const runtime = options.runtime;
    const context = options.context;
    const rootBuffer = options.output || new runtime.CommandBuffer(context, options.ownerBuffer || null, null, null);
    const sharedRootBuffer = new runtime.CommandBuffer(context, rootBuffer, null, null);
    const chain = await runtime.loadInheritanceChain({
      templateOrScript: options.entryTemplateOrScript,
      env: options.env,
      context,
      runtime,
      origin: options.origin ?? null
    });
    const runtimeState = runtime.finalizeInheritanceChain(chain, context);

    Object.entries(runtimeState.sharedSchema).forEach(([name, schemaEntry]) => {
      declareInheritanceSharedChannel(sharedRootBuffer, name, schemaEntry.type, context);
    });

    return new InheritanceInstance({
      entryTemplateOrScript: chain.entries[0].templateOrScript,
      runtimeState,
      env: options.env,
      runtime,
      cb: options.cb ?? function noopCallback() {},
      rootBuffer,
      sharedRootBuffer,
      context
    });
  }

  invoke(methodName, args = [], origin = null) {
    return this._invokeFromMethodData(this.getMethod(methodName, origin), args, origin, this.sharedRootBuffer, this.context);
  }

  invokeFromCurrentBuffer(methodName, args, context, currentBuffer, origin = null) {
    return this._invokeFromMethodData(this.getMethod(methodName, origin), args, origin, currentBuffer, context);
  }

  invokeSuper(methodData, args, context, currentBuffer, origin = null, forwardedOriginalArgs = null) {
    if (!methodData || !methodData.super) {
      throw new RuntimeFatalError(
        `super() in '${methodData ? methodData.name : '<unknown>'}' has no parent implementation`,
        origin?.lineno ?? 0,
        origin?.colno ?? 0,
        origin?.errorContextString ?? null,
        origin?.path ?? null
      );
    }
    return this._invokeFromMethodData(methodData.super, args, origin, currentBuffer, context, {
      forwardedOriginalArgs
    });
  }

  getMethod(methodName, origin) {
    const methodData = this.runtimeState.methods[methodName] || null;
    if (!methodData) {
      throw new RuntimeFatalError(
        `missing inherited method '${methodName}'`,
        origin?.lineno ?? 0,
        origin?.colno ?? 0,
        origin?.errorContextString ?? null,
        origin?.path ?? null
      );
    }
    return methodData;
  }

  async _invokeFromMethodData(methodData, args, origin, parentBuffer, context, options = {}) {
    const invocationBuffer = new this.runtime.CommandBuffer(
      context,
      parentBuffer,
      methodData.mergedLinkedChannels,
      parentBuffer,
      methodData.mergedMutatedChannels
    );
    const callablePayload = methodData.isConstructor
      ? null
      : {
        originalArgs: createInheritanceCallableArgumentFrame(
          methodData,
          args,
          origin,
          options.forwardedOriginalArgs ?? null
        )
      };
    const renderContext = methodData.isConstructor ? undefined : context.getRenderContextVariables();

    try {
      // TODO(Step 5): Generated callable ABI still has both inheritanceState
      // and currentInstance. Both receive this instance until shared-root
      // setup no longer references inheritanceState.
      const result = await methodData.fn(
        this.env,
        context,
        this.runtime,
        this.cb,
        invocationBuffer,
        callablePayload,
        renderContext,
        this,
        methodData,
        this
      );
      invocationBuffer.finish();
      await invocationBuffer.getFinishedPromise();
      return result;
    } catch (error) {
      invocationBuffer.finish();
      await invocationBuffer.getFinishedPromise();
      throw error;
    }
  }

  finishRender(entryResult) {
    // TODO(Step 5): Replace this placeholder with direct-render completion.
    // Templates finish the root text channel; scripts return entryResult.
    return entryResult;
  }

  close() {
    // TODO(Step 6): Component lifetime will own failure/closed-state behavior
    // and side-channel completion timing around this buffer close.
    this.closed = true;
    this.sharedRootBuffer.finish();
    this.rootBuffer.finish();
  }
}

export {InheritanceInstance};
