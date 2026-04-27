'use strict';

import lib from '../lib';
import {Obj} from '../object';
import {createPoison, markPromiseHandled} from '../runtime/errors';

class ContextExecutionState {
  constructor() {
    this.blocks = {};
    this.exportResolveFunctions = Object.create(null);
    this.exportRejectFunctions = Object.create(null);
    this.exportError = null;
    this.exportChannels = Object.create(null);
  }
}

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false, renderCtx, compositionPayloadVars = undefined, executionState = null) {
    // Has to be tied to an environment so we can tap into its globals.
    if (!env) {
      // Lazy load Environment to avoid circular dependency
      const { Environment } = require('./environment');
      this.env = new Environment();
    } else {
      this.env = env;
    }
    this.path = path || null;
    this.scriptMode = !!scriptMode;

    // Preserve the original render context separately from the working context
    // so async composition can expose it explicitly via `with context`
    // without leaking current local vars/channels.
    const initialRenderCtx = renderCtx === undefined ? ctx : (renderCtx || {});
    this.renderCtx = lib.extend({}, initialRenderCtx);
    this.ctx = lib.extend({}, ctx);
    this.compositionContextVars = lib.extend({}, ctx);
    // undefined means no composition payload was supplied; null means an
    // explicit empty payload baseline that should still use payload semantics.
    this.compositionPayloadVars = compositionPayloadVars === undefined ? null : lib.extend({}, compositionPayloadVars);
    this.executionState = executionState || new ContextExecutionState();

    lib.keys(blocks).forEach(name => {
      this.addBlock(name, blocks[name]);
    });
  }

  get blocks() {
    return this.executionState.blocks;
  }

  get exportResolveFunctions() {
    return this.executionState.exportResolveFunctions;
  }

  get exportRejectFunctions() {
    return this.executionState.exportRejectFunctions;
  }

  get exportChannels() {
    return this.executionState.exportChannels;
  }

  //if the variable is not found, returns undefined
  lookup(name) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      return this.ctx[name];
    }
  }

  //if the variable is not found, returns a poison value
  lookupScript(name, errorContext = null) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      if (name in this.ctx) {
        return this.ctx[name];
      } else {
        return createPoison(
          new Error(`Can not look up unknown variable/function: ${name}`),
          errorContext?.lineno ?? 0,
          errorContext?.colno ?? 0,
          errorContext?.errorContextString ?? null,
          errorContext?.path ?? this.path ?? null
        );
      }
    }
  }

  setVariable(name, val) {
    this.ctx[name] = val;
  }

  getVariables() {
    return this.ctx;
  }

  getRenderContextVariables() {
    return this.renderCtx;
  }

  getCompositionContextVariables() {
    return this.compositionContextVars;
  }

  getCompositionPayloadVariables() {
    return this.compositionPayloadVars;
  }

  addBlock(name, block) {
    this.blocks[name] = this.blocks[name] || [];
    if (this.blocks[name].length > 0) {
      this._validateBlockContractCompatibility(name, this.blocks[name][this.blocks[name].length - 1], block);
    }
    this.blocks[name].push(block);
    return this;
  }

  _validateBlockContractCompatibility(name, overridingBlock, parentBlock) {
    const overridingContract = overridingBlock && overridingBlock.blockContract;
    const parentContract = parentBlock && parentBlock.blockContract;
    if (!overridingContract || !parentContract) {
      return;
    }

    const overridingNames = overridingContract.argNames || [];
    const parentNames = parentContract.argNames || [];
    const sameLength = overridingNames.length === parentNames.length;
    const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
    const sameContextMode = !!overridingContract.withContext === !!parentContract.withContext;
    if (sameNames && sameContextMode) {
      return;
    }

    const formatContract = (contract) => {
      const args = (contract.argNames || []).join(', ');
      const contextSuffix = contract.withContext ? ' with context' : '';
      return `${name}(${args})${contextSuffix}`;
    };

    throw new lib.TemplateError(
      `block "${name}" signature mismatch: overriding block declares ${formatContract(overridingContract)} but parent declares ${formatContract(parentContract)}`
    );
  }

  getBlock(name) {
    if (!this.blocks[name]) {
      throw new Error('unknown block "' + name + '"');
    }

    return this.blocks[name][0];
  }

  getSyncSuper(env, name, block, frame, runtime, cb) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    blk(env, context, frame, runtime, cb);
  }

  addResolvedExport(name, value) {
    if (this.exportResolveFunctions[name] !== undefined) {
      return;
    }
    this.ctx[name] = value;
    this.exportResolveFunctions[name] = null;
    this.exportRejectFunctions[name] = null;
  }

  addDeferredExport(name, channelName, buffer) {
    if (this.exportResolveFunctions[name] !== undefined) {
      return;
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Deferred exports are often internal-only script locals. If such a local
    // resolves to poison and no consumer reads the export promise directly, the
    // channel still owns the error; the export promise should not become a
    // process-level unhandled rejection.
    markPromiseHandled(promise);
    this.exportResolveFunctions[name] = resolve;
    this.exportRejectFunctions[name] = reject;
    this.exportChannels[name] = { channelName, buffer };
    this.ctx[name] = promise;
    if (this.executionState.exportError) {
      reject(this.executionState.exportError);
    }
  }

  resolveExports() {
    const names = Object.keys(this.exportResolveFunctions);
    for (const name of names) {
      const resolve = this.exportResolveFunctions[name];
      if (!resolve) {
        continue;
      }
      const exportChannel = this.exportChannels[name];
      if (!exportChannel || !exportChannel.buffer || !exportChannel.channelName) {
        throw new Error(`Deferred export "${name}" is missing an explicit producer record${this.path ? ` in ${this.path}` : ''}`);
      }
      const channel = exportChannel.buffer.getOwnChannel(exportChannel.channelName);
      if (!channel) {
        throw new Error(`Deferred export "${name}" could not resolve producer channel "${exportChannel.channelName}"${this.path ? ` in ${this.path}` : ''}`);
      }
      resolve(channel.finalSnapshot());
      this.exportResolveFunctions[name] = null;
      this.exportRejectFunctions[name] = null;
    }
  }

  rejectExports(error) {
    if (!error) {
      return;
    }
    this.executionState.exportError = error;
    const names = Object.keys(this.exportRejectFunctions);
    for (const name of names) {
      const reject = this.exportRejectFunctions[name];
      if (reject) {
        reject(error);
        this.exportResolveFunctions[name] = null;
        this.exportRejectFunctions[name] = null;
      }
    }
  }

  getExported() {
    var exported = {};
    const exportNames = Object.keys(this.exportResolveFunctions);
    exportNames.forEach((name) => {
      exported[name] = this.ctx[name];
    });
    return exported;
  }

  forkForPath(newPath) {
    const newContext = new Context({}, {}, this.env, null, this.scriptMode, this.renderCtx, this.compositionPayloadVars, this.executionState);
    newContext.ctx = this.ctx;
    newContext.renderCtx = this.renderCtx;
    newContext.compositionContextVars = this.compositionContextVars;
    newContext.compositionPayloadVars = this.compositionPayloadVars;
    newContext.path = newPath;

    return newContext;
  }

  forkForComposition(newPath, ctx, renderCtx, compositionPayloadVars = undefined) {
    // Fresh composition context that keeps shared structural state such as
    // blocks/exports, but does not share the mutable variable object with the
    // caller. This lets composition boundaries receive explicit inputs without
    // turning them back into ambient shared scope.
    const payloadVars = compositionPayloadVars === undefined ? (ctx || {}) : (compositionPayloadVars || {});
    const newContext = new Context(ctx || {}, {}, this.env, null, this.scriptMode, renderCtx, payloadVars, this.executionState);
    newContext.path = newPath;

    return newContext;
  }

  forkForCompositionPayload(newPath, compositionPayload, renderCtx) {
    return this.forkForComposition(
      newPath,
      compositionPayload.rootContext,
      renderCtx,
      compositionPayload.payloadContext
    );
  }
}

const __defaultExport = {
  Context
};
export { Context };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
