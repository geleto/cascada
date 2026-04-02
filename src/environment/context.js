'use strict';

const lib = require('../lib');
const { Obj } = require('../object');
const { createPoison } = require('../runtime/errors');

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false, renderCtx) {
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

    this.blocks = {};
    this.exportResolveFunctions = Object.create(null);
    this.exportChannels = Object.create(null);
    this.compositionSourceBuffersByTemplate = Object.create(null);

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

  addBlock(name, block) {
    this.blocks[name] = this.blocks[name] || [];
    this.blocks[name].push(block);
    return this;
  }

  getBlock(name) {
    if (!this.blocks[name]) {
      throw new Error('unknown block "' + name + '"');
    }

    return this.blocks[name][0];
  }

  beginAsyncExtendsBlockRegistration() {
    this.asyncExtendsBlocksPromise = new Promise((resolve, reject) => {
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

  linkDeferredExportsToBuffer(parentBuffer) {
    if (!parentBuffer || !this.exportChannels) {
      return;
    }
    const names = Object.keys(this.exportChannels);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const exportChannel = this.exportChannels[name];
      if (!exportChannel || !exportChannel.buffer || !exportChannel.channelName) {
        continue;
      }
      parentBuffer.linkVisibleChannel(exportChannel.channelName, exportChannel.buffer);
    }
  }

  resolveExports(currentBuffer) {
    const names = Object.keys(this.exportResolveFunctions);
    for (const name of names) {
      const resolve = this.exportResolveFunctions[name];
      if (!resolve) {
        continue;
      }
      const exportChannel = this.exportChannels[name];
      const channel = exportChannel
        ? exportChannel.buffer.findChannel(exportChannel.channelName)
        : currentBuffer.findChannel(name);
      resolve(channel.finalSnapshot());
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

  _getCompositionTemplateKey(templateName) {
    return templateName == null ? '__anonymous__' : String(templateName);
  }

  setCompositionSourceBuffer(templateName, sourceBuffer) {
    const key = this._getCompositionTemplateKey(templateName);
    this.compositionSourceBuffersByTemplate[key] = sourceBuffer || null;
  }

  getCompositionSourceBuffer(templateName) {
    const key = this._getCompositionTemplateKey(templateName);
    return this.compositionSourceBuffersByTemplate[key] || null;
  }

  forkForPath(newPath) {
    // Create a new, empty context object.
    // It will inherit the correct `env` from `this`.
    const newContext = new Context({}, {}, this.env, null, this.scriptMode, this.renderCtx);

    // Share critical state objects by REFERENCE. Do NOT copy them.
    newContext.ctx = this.ctx;           // Share the variable store.
    newContext.renderCtx = this.renderCtx;
    newContext.blocks = this.blocks;       // Share the block definitions for extends/super.
    newContext.exportResolveFunctions = this.exportResolveFunctions;
    newContext.exportChannels = this.exportChannels;
    newContext.compositionSourceBuffersByTemplate = this.compositionSourceBuffersByTemplate;

    // Share async state properties by REFERENCE.
    newContext.asyncExtendsBlocksPromise = this.asyncExtendsBlocksPromise;
    newContext.asyncExtendsBlocksResolver = this.asyncExtendsBlocksResolver;

    // Set the ONLY property that should be different.
    newContext.path = newPath;

    return newContext;
  }

  forkForComposition(newPath, ctx, renderCtx) {
    // Fresh composition context that keeps shared structural state such as
    // blocks/exports, but does not share the mutable variable object with the
    // caller. This lets composition boundaries receive explicit inputs without
    // turning them back into ambient shared scope.
    const newContext = new Context(ctx || {}, {}, this.env, null, this.scriptMode, renderCtx);

    newContext.blocks = this.blocks;
    newContext.exportResolveFunctions = this.exportResolveFunctions;
    newContext.exportChannels = this.exportChannels;
    newContext.compositionSourceBuffersByTemplate = this.compositionSourceBuffersByTemplate;
    newContext.asyncExtendsBlocksPromise = this.asyncExtendsBlocksPromise;
    newContext.asyncExtendsBlocksResolver = this.asyncExtendsBlocksResolver;
    newContext.path = newPath;

    return newContext;
  }
}

module.exports = {
  Context
};
