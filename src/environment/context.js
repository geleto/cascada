'use strict';

const lib = require('../lib');
const { Obj } = require('../object');
const { createPoison } = require('../runtime/errors');

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false, renderCtx, externCtx = undefined) {
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
    this.externCtx = externCtx === undefined ? null : lib.extend({}, externCtx);

    this.blocks = {};
    this.exportResolveFunctions = Object.create(null);
    this.exportChannels = Object.create(null);
    this.compositionSourceBuffersByTemplate = Object.create(null);
    this.extendsCompositionByParent = new WeakMap();

    lib.keys(blocks).forEach(name => {
      this.addBlock(name, blocks[name]);
    });
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

  getExternContextVariables() {
    return this.externCtx || this.ctx;
  }

  addBlock(name, block) {
    this.blocks[name] = this.blocks[name] || [];
    if (this.blocks[name].length > 0) {
      this._validateBlockContractCompatibility(name, this.blocks[name][this.blocks[name].length - 1], block);
    }
    this.blocks[name].push(block);
    return this;
  }

  // Transitional dual-syntax compatibility check.
  // While legacy `with ...` block inputs still exist, we allow pure-legacy
  // pairs through here. Once Step D/E remove that syntax, this can collapse to
  // a single explicit-signature validation path.
  _validateBlockContractCompatibility(name, overridingBlock, parentBlock) {
    const overridingContract = overridingBlock && overridingBlock.blockContract;
    const parentContract = parentBlock && parentBlock.blockContract;
    if (!overridingContract || !parentContract) {
      return;
    }
    if (!overridingContract.signatureDeclared && !parentContract.signatureDeclared) {
      return;
    }

    const overridingNames = overridingContract.inputNames || [];
    const parentNames = parentContract.inputNames || [];
    const sameLength = overridingNames.length === parentNames.length;
    const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
    const sameContextMode = !!overridingContract.withContext === !!parentContract.withContext;
    if (sameNames && sameContextMode) {
      return;
    }

    const formatContract = (contract) => {
      const args = (contract.inputNames || []).join(', ');
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

  // Temporary bridge for the explicit-signature migration.
  // Step D removes runtime block-entry dependence on this metadata, and Step E
  // can remove the helper entirely once no runtime readers remain.
  getBlockContract(name) {
    const blocks = this.blocks[name] || [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block && block.blockContract) {
        return block.blockContract;
      }
    }
    return null;
  }

  beginAsyncExtendsBlockRegistration() {
    if (this.asyncExtendsBlocksPromise) {
      throw new Error('Async extends block registration is already in progress for this context');
    }
    this.asyncExtendsBlocksPromise = new Promise((resolve) => {
      this.asyncExtendsBlocksResolver = resolve;
    }).then(() => {
      delete this.asyncExtendsBlocksPromise;
      delete this.asyncExtendsBlocksResolver;
    });
  }

  async getAsyncBlock(name) {
    if (this.asyncExtendsBlocksPromise) {
      await this.asyncExtendsBlocksPromise;
    }
    return this.getBlock(name);
  }

  async finishAsyncExtendsBlockRegistration() {
    if (this.asyncExtendsBlocksResolver) {
      this.asyncExtendsBlocksResolver();
    }
  }

  getAsyncSuper(env, name, block, runtime, cb, parentBuffer = null, blockContext = null, blockRenderCtx = undefined) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    return blk(env, context, runtime, cb, parentBuffer, blockContext, blockRenderCtx);
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
  }

  addDeferredExport(name, channelName, buffer) {
    if (this.exportResolveFunctions[name] !== undefined) {
      return;
    }

    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    this.exportResolveFunctions[name] = resolve;
    this.exportChannels[name] = { channelName, buffer };
    this.ctx[name] = promise;
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

  // Temporary bridge helper for Step D migration.
  // This exists only for the remaining composition-source-buffer path and
  // should disappear when that bridge is removed.
  _getCompositionTemplateKey(templateName) {
    return templateName == null ? '__anonymous__' : String(templateName);
  }

  // Temporary bridge for Step D migration.
  // Remove this once inheritance payloads stop rediscovering same-template
  // locals through composition source buffers.
  setCompositionSourceBuffer(templateName, sourceBuffer) {
    const key = this._getCompositionTemplateKey(templateName);
    this.compositionSourceBuffersByTemplate[key] = sourceBuffer || null;
  }

  // Temporary bridge for Step D migration.
  // Remove this together with the remaining buffer-based local recovery path.
  getCompositionSourceBuffer(templateName) {
    const key = this._getCompositionTemplateKey(templateName);
    return this.compositionSourceBuffersByTemplate[key] || null;
  }

  setExtendsComposition(templateObject, rootContext, externContext) {
    if (!templateObject || typeof templateObject !== 'object') {
      throw new Error('Extends composition requires a resolved parent template/script object');
    }
    this.extendsCompositionByParent.set(templateObject, {
      // forkForComposition() copies these again into the new child Context, so
      // keep only a single stored snapshot here.
      rootContext: rootContext || {},
      externContext: externContext || {}
    });
  }

  getExtendsComposition(templateObject) {
    if (!templateObject || typeof templateObject !== 'object') {
      throw new Error('Extends composition lookup requires a resolved parent template/script object');
    }
    return this.extendsCompositionByParent.get(templateObject) || null;
  }

  // Temporary bridge until shared composition/inheritance runtime state moves
  // into its own reusable object. At that point forks should share that object
  // directly instead of copying this field list manually.
  _copySharedStructuralState(newContext) {
    newContext.blocks = this.blocks;
    newContext.exportResolveFunctions = this.exportResolveFunctions;
    newContext.exportChannels = this.exportChannels;
    newContext.compositionSourceBuffersByTemplate = this.compositionSourceBuffersByTemplate;
    newContext.extendsCompositionByParent = this.extendsCompositionByParent;
    newContext.asyncExtendsBlocksPromise = this.asyncExtendsBlocksPromise;
    newContext.asyncExtendsBlocksResolver = this.asyncExtendsBlocksResolver;
    return newContext;
  }

  forkForPath(newPath) {
    // Create a new, empty context object.
    // It will inherit the correct `env` from `this`.
    const newContext = new Context({}, {}, this.env, null, this.scriptMode, this.renderCtx, this.externCtx);

    // Share critical state objects by REFERENCE. Do NOT copy them.
    newContext.ctx = this.ctx;           // Share the variable store.
    newContext.renderCtx = this.renderCtx;
    this._copySharedStructuralState(newContext);

    // Set the ONLY property that should be different.
    newContext.path = newPath;

    return newContext;
  }

  forkForComposition(newPath, ctx, renderCtx, externCtx = undefined) {
    // Fresh composition context that keeps shared structural state such as
    // blocks/exports, but does not share the mutable variable object with the
    // caller. This lets composition boundaries receive explicit inputs without
    // turning them back into ambient shared scope.
    const newContext = new Context(ctx || {}, {}, this.env, null, this.scriptMode, renderCtx, externCtx);

    this._copySharedStructuralState(newContext);
    newContext.path = newPath;

    return newContext;
  }
}

module.exports = {
  Context
};
