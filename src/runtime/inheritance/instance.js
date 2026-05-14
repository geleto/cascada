import {RuntimeFatalError} from '../errors.js';
import {normalizeFinalPromise} from '../resolve.js';
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
    const rootBuffer = options.rootBuffer || new runtime.CommandBuffer(context, null, null, null);
    // TODO(Step 6): Components need a distinct shared root buffer with
    // component-owned close timing. Direct render uses the render root buffer.
    const sharedRootBuffer = rootBuffer;
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
    const visibleChannels = Array.from(new Set([
      ...methodData.mergedLinkedChannels,
      ...methodData.mergedMutatedChannels
    ]));
    const invocationBuffer = new this.runtime.CommandBuffer(
      context,
      parentBuffer,
      visibleChannels,
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
      const result = await methodData.fn(
        this.env,
        context,
        this.runtime,
        this.cb,
        invocationBuffer,
        callablePayload,
        renderContext,
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
    this.sharedRootBuffer.finish();
    this.rootBuffer.finish();
    const finished = this.rootBuffer.getFinishedPromise();
    return finished.then(() => entryResult);
  }

  close() {
    // TODO(Step 6): Component lifetime will own failure/closed-state behavior
    // and side-channel completion timing around this buffer close.
    this.closed = true;
    this.sharedRootBuffer.finish();
    this.rootBuffer.finish();
  }
}

async function renderInheritanceParticipantRoot({ entryTemplateOrScript, env, context, runtime, cb, rootBuffer, origin = null }) {
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript,
    env,
    context,
    runtime,
    cb,
    rootBuffer,
    origin
  });
  let entryResult;
  entryResult = await instance.invoke('__constructor__', [], origin);
  return normalizeFinalPromise(instance.finishRender(entryResult));
}

export {InheritanceInstance, renderInheritanceParticipantRoot};
