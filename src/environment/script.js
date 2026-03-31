'use strict';

const lib = require('../lib');
const scriptTranspiler = require('../script/script-transpiler');
const { Template } = require('./template');
const { Context } = require('./context');

/**
 * Script class - represents a compiled Cascada script.
 */
class Script extends Template {
  init(src, env, path, eagerCompile) {
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      const template = scriptTranspiler.scriptToTemplate(src);
      src = template;
    }

    super.init(src, env, path, eagerCompile);
    this.asyncMode = true;
    this.scriptMode = true;
  }

  render(ctx, cb) {
    if (cb) {
      return super._renderAsync(ctx, cb);
    }
    // If no callback is provided, return a promise
    return new Promise((resolve, reject) => {
      super._renderAsync(ctx, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  _compileSource() {
    const compiler = require('../compiler/compiler');
    return compiler.compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: true, asyncMode: true }, this.env.opts)
    );
  }

  _createContext(ctx) {
    return new Context(ctx || {}, this.blocks, this.env, this.path, true);
  }

  _createMacroContext() {
    return new Context({}, this.blocks, this.env, this.path, true);
  }
}

module.exports = {
  Script
};
