'use strict';

const lib = require('../lib');
const { Obj } = require('../object');
const { createPoison } = require('../runtime/errors');

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false) {
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

    // Make a duplicate of ctx
    this.ctx = lib.extend({}, ctx);

    this.blocks = {};
    this.exportResolveFunctions = Object.create(null);
    this.exportChannels = Object.create(null);

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

  //if the variable is not found, throws an error
  lookupScriptMode(name) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      if (name in this.ctx) {
        return this.ctx[name];
      } else {
        throw new Error(`Can not look up unknown variable/function: ${name}`);
      }
    }
  }

  //if the variable is not found, returns a poison value
  lookupScriptModeAsync(name, errorContext = null) {
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

  prepareForAsyncBlocks() {
    this.asyncBlocksPromise = new Promise((resolve, reject) => {
      this.asyncBlocksResolver = resolve;
    }).then(() => {
      delete this.asyncBlocksPromise;
      delete this.asyncBlocksResolver;
    });
  }

  async getAsyncBlock(name) {
    // this breaks super(), why?
    //if (this.blocks[name]) {
    //  return this.getBlock(name);
    //}
    if (this.asyncBlocksPromise) {
      await this.asyncBlocksPromise;
    }
    return this.getBlock(name);
  }

  async finishAsyncBlocks() {
    if (this.asyncBlocksResolver) {
      this.asyncBlocksResolver();
    }
  }

  getAsyncSuper(env, name, block, runtime, cb, parentBuffer = null) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    return blk(env, context, runtime, cb, parentBuffer);
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

  forkForPath(newPath) {
    // Create a new, empty context object.
    // It will inherit the correct `env` from `this`.
    const newContext = new Context({}, {}, this.env, null, this.scriptMode);

    // Share critical state objects by REFERENCE. Do NOT copy them.
    newContext.ctx = this.ctx;           // Share the variable store.
    newContext.blocks = this.blocks;       // Share the block definitions for extends/super.
    newContext.exportResolveFunctions = this.exportResolveFunctions;
    newContext.exportChannels = this.exportChannels;

    // Share async state properties by REFERENCE.
    newContext.asyncBlocksPromise = this.asyncBlocksPromise;
    newContext.asyncBlocksResolver = this.asyncBlocksResolver;

    // Set the ONLY property that should be different.
    newContext.path = newPath;

    return newContext;
  }
}

module.exports = {
  Context
};
