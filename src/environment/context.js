'use strict';

const lib = require('../lib');
const { Obj } = require('../object');
const { Environment } = require('./environment');
const { createPoison } = require('../runtime/errors');

class Context extends Obj {
  init(ctx, blocks, env, path) {
    // Has to be tied to an environment so we can tap into its globals.
    this.env = env || new Environment();
    this.path = path || null;

    // Make a duplicate of ctx
    this.ctx = lib.extend({}, ctx);

    this.blocks = {};
    this.exported = [];

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
  lookupScriptModeAsync(name) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      if (name in this.ctx) {
        return this.ctx[name];
      } else {
        return createPoison(new Error(`Can not look up unknown variable/function: ${name}`));
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

  getSuper(env, name, block, frame, runtime, astate, cb) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (typeof astate === 'function') {
      cb = astate;
      astate = null;
    }

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    if (astate) {
      // Async mode - block returns output directly, cb is error-only
      return blk(env, context, frame, runtime, astate, cb);
    }
    else {
      // Sync mode - block uses callback for result
      blk(env, context, frame, runtime, cb);
    }
  }

  addExport(name) {
    this.exported.push(name);
  }

  getExported() {
    var exported = {};
    this.exported.forEach((name) => {
      exported[name] = this.ctx[name];
    });
    return exported;
  }

  forkForPath(newPath) {
    // Create a new, empty context object.
    // It will inherit the correct `env` from `this`.
    const newContext = new Context({}, {}, this.env);

    // Share critical state objects by REFERENCE. Do NOT copy them.
    newContext.ctx = this.ctx;           // Share the variable store.
    newContext.blocks = this.blocks;       // Share the block definitions for extends/super.
    newContext.exported = this.exported;   // Share the list of exported variables for import.

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
