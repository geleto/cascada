'use strict';

const lib = require('../lib');
const scriptTranspiler = require('../script/script-transpiler');
const { Template } = require('./template');

/**
 * AsyncScript class - represents a compiled async Cascada script
 */
class AsyncScript extends Template {
  init(src, env, path, eagerCompile) {
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      const template = scriptTranspiler.scriptToTemplate(src);
      src = template;
    }

    super.init(src, env, path, eagerCompile, true/*async*/, true/*script*/);
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
}

module.exports = {
  AsyncScript
};
