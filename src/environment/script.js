'use strict';

const lib = require('../lib');
const scriptTranspiler = require('../script/script-transpiler');
const DataHandler = require('../script/data-handler');
const ValueHandler = require('../script/value-handler');
const { Template } = require('./template');

function ensureCoreScriptHandlers(env) {
  if (!env || typeof env.addCommandHandlerClass !== 'function') {
    return;
  }
  const classes = env.commandHandlerClasses || {};
  if (!classes.data) {
    env.addCommandHandlerClass('data', DataHandler);
  }
  if (!classes.value) {
    env.addCommandHandlerClass('value', ValueHandler);
  }
}

/**
 * Script class - represents a compiled Cascada script
 */
class Script extends Template {
  init(src, env, path, eagerCompile) {
    ensureCoreScriptHandlers(env);
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      src = scriptTranspiler.scriptToTemplate(src);
    }

    super.init(src, env, path, eagerCompile, false/*async*/, true/*script*/);
  }
}

/**
 * AsyncScript class - represents a compiled async Cascada script
 */
class AsyncScript extends Template {
  init(src, env, path, eagerCompile) {
    ensureCoreScriptHandlers(env);
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      const template = scriptTranspiler.scriptToTemplate(src);
      src = template;
    }

    super.init(src, env, path, eagerCompile, true/*async*/, true/*script*/);
  }

  render(ctx, parentFrame, astate, cb) {
    if (cb) {
      return super.render(ctx, parentFrame, astate, cb);
    }
    // If no callback is provided, return a promise
    return new Promise((resolve, reject) => {
      super.render(ctx, parentFrame, astate, (err, res) => {
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
  Script,
  AsyncScript
};
