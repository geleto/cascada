import {RuntimeFatalError} from '../errors.js';
import {createInheritanceCallableArgumentFrame} from './invoke.js';
import {declareInheritanceSharedChain} from './shared.js';
import {createBufferErrorContext} from './error-context.js';

class InheritanceInstance {
  constructor(options) {
    this.entryTemplateOrScript = options.entryTemplateOrScript;
    this.runtimeState = options.runtimeState;
    this.env = options.env;
    this.runtime = options.runtime;
    this.cb = options.cb;
    this.rootBuffer = options.rootBuffer;
    this.sharedRootBuffer = options.sharedRootBuffer;
    this.traceParent = options.traceParent || null;
    this.context = options.context;
    // The error context tables are reused by all loads of a given template or script,
    // And are thus each time initialized with a different cb
    // We need to know the error context table for each template or script in the inheritance
    // chain in order to provide correct error contexts (cb) on method invocation.
    this.entryErrorContextTable = options.entryErrorContextTable || null;
    this.errorContextTablesByOwner = new Map();
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
      createBufferErrorContext(options.origin, 'inheritance'),
      traceParent
    );
    const sharedRootBuffer = options.sharedRootBuffer || rootBuffer;
    const chain = await runtime.loadInheritanceChain({
      templateOrScript: options.entryTemplateOrScript,
      env: options.env,
      context,
      runtime,
      origin: options.origin ?? null
    });
    const runtimeState = runtime.finalizeInheritanceChain(chain, context);

    Object.entries(runtimeState.sharedSchema).forEach(([name, schemaEntry]) => {
      declareInheritanceSharedChain(sharedRootBuffer, name, schemaEntry.type, context);
    });

    return new InheritanceInstance({
      entryTemplateOrScript: chain.entries[0].templateOrScript,
      runtimeState,
      env: options.env,
      runtime,
      cb: options.cb ?? function noopCallback() {},
      rootBuffer,
      sharedRootBuffer,
      traceParent,
      context,
      entryErrorContextTable: options.entryErrorContextTable || null
    });
  }

  invoke(methodName, args = [], origin = null) {
    this.assertOpen(origin);
    return this._invokeFromMethodData(this.getMethod(methodName, origin), args, origin, this.sharedRootBuffer, this.context, this.traceParent);
  }

  invokeFromCurrentBuffer(methodName, args, context, currentBuffer, origin = null) {
    this.assertOpen(origin);
    return this._invokeFromMethodData(this.getMethod(methodName, origin), args, origin, currentBuffer, context, currentBuffer);
  }

  invokeSuper(methodData, args, context, currentBuffer, origin = null) {
    this.assertOpen(origin);
    if (!methodData || !methodData.super) {
      throw new RuntimeFatalError(
        `super() in '${methodData ? methodData.name : '<unknown>'}' has no parent implementation`,
        origin
      );
    }
    return this._invokeFromMethodData(methodData.super, args, origin, currentBuffer, context, currentBuffer);
  }

  invokeConstructor(origin = null) {
    this.assertOpen(origin);
    const constructorEntry = this.runtimeState.methods.__constructor__ || null;
    if (!constructorEntry) {
      return undefined;
    }
    return this._invokeFromMethodData(constructorEntry, [], origin, this.sharedRootBuffer, this.context, this.traceParent);
  }

  assertOpen(origin = null) {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      throw new RuntimeFatalError(
        'Inheritance instance is closed and cannot accept new operations',
        origin
      );
    }
  }

  getMethod(methodName, origin) {
    const methodData = this.runtimeState.methods[methodName] || null;
    if (!methodData) {
      throw new RuntimeFatalError(
        `missing inherited method '${methodName}'`,
        origin
      );
    }
    return methodData;
  }

  getErrorContextTableForMethod(methodData, context) {
    const ownerEntry = methodData.ownerEntry || null;
    if (!ownerEntry) {
      return this.entryErrorContextTable;
    }
    if (ownerEntry.templateOrScript === this.entryTemplateOrScript && this.entryErrorContextTable) {
      return this.entryErrorContextTable;
    }
    if (this.errorContextTablesByOwner.has(ownerEntry)) {
      return this.errorContextTablesByOwner.get(ownerEntry);
    }

    // Create and cache the error context table for this owner entry
    const ownerTemplateOrScript = ownerEntry.templateOrScript || null;
    // ownerEntry.path is the source artifact path for parent-owned methods and
    // blocks. The context path fallback is defensive for synthetic/no-path
    // owners and should not be used for normal loaded inheritance entries.
    const ownerPath = ownerEntry.path ?? context.path;
    const prepared = ownerTemplateOrScript && typeof ownerTemplateOrScript.getErrorContexts === 'function'
      ? ownerTemplateOrScript.getErrorContexts(this.runtime, ownerPath, this.cb)
      : null;
    this.errorContextTablesByOwner.set(ownerEntry, prepared);
    return prepared;
  }

  async _invokeFromMethodData(methodData, args, origin, parentBuffer, context, traceParent = null) {
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
      createBufferErrorContext(origin ?? methodData.origin, methodData.name),
      traceParent
    );
    const callablePayload = methodData.isConstructor
      ? null
      : {
        originalArgs: createInheritanceCallableArgumentFrame(
          methodData,
          args,
          origin
        )
      };
    const renderContext = methodData.isConstructor ? undefined : context.getRenderContextVariables();

    try {
      return await methodData.fn(
        this.env,
        context,
        this.runtime,
        this.cb,
        invocationBuffer,
        callablePayload,
        renderContext,
        methodData,
        this,
        this.getErrorContextTableForMethod(methodData, context)
      );
    } finally {
      invocationBuffer.finish();
      await invocationBuffer.getFinishedPromise();
    }
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

async function renderInheritanceParticipantRoot({ entryTemplateOrScript, env, context, runtime, cb, rootBuffer, entryErrorContextTable = null, origin = null }) {
  const instance = await InheritanceInstance.create({
    entryTemplateOrScript,
    env,
    context,
    runtime,
    cb,
    rootBuffer,
    entryErrorContextTable,
    origin
  });
  let entryResult;
  try {
    entryResult = await instance.invokeConstructor(origin);
    return instance.finishRender(entryResult);
  } catch (error) {
    instance.close(error);
    throw error;
  }
}

export {InheritanceInstance, renderInheritanceParticipantRoot};
