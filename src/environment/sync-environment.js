'use strict';

const lib = require('../lib');
const scriptTranspiler = require('../script/script-transpiler');
const { BaseEnvironment } = require('./base-environment');
const { callbackAsap } = require('./utils');

class Environment extends BaseEnvironment {
  getTemplate(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiled(name, eagerCompile, parentName, ignoreMissing, false, false, cb);
  }

  getScript(name, eagerCompile, parentName, ignoreMissing, cb) {
    // Scripts use the same template loading mechanism, conversion happens at Script class level
    return this._getCompiled(name, eagerCompile, parentName, ignoreMissing, false, true, cb);
  }

  /** @deprecated Use renderTemplate instead */
  render(name, ctx, cb) {
    if (lib.isFunction(ctx)) {
      cb = ctx;
      ctx = null;
    }

    // We support a synchronous API to make it easier to migrate
    // existing code to async. This works because if you don't do
    // anything async work, the whole thing is actually run
    // synchronously.
    let syncResult = null;

    this.getTemplate(name, false, null, false, (err, tmpl) => {
      if (err && cb) {
        callbackAsap(cb, err);
      } else if (err) {
        throw err;
      } else {
        syncResult = tmpl.render(ctx, cb);
      }
    });

    return syncResult;
  }

  renderTemplate(name, ctx, cb) {
    return this.render(name, ctx, cb);
  }

  /** @deprecated Use renderTemplateString instead */
  renderString(src, ctx, opts, cb) {
    return this.renderTemplateString(src, ctx, opts, cb);
  }

  renderTemplateString(src, ctx, opts, cb) {
    if (lib.isFunction(opts)) {
      cb = opts;
      opts = {};
    }
    opts = opts || {};

    // Lazy load Template to avoid circular dependency
    const { Template } = require('./template');
    const tmpl = new Template(src, this, opts.path);
    return tmpl.render(ctx, cb);
  }

  renderScriptString(scriptStr, ctx, opts, cb) {
    if (lib.isFunction(ctx)) {
      cb = ctx;
      ctx = {};
    }

    // Convert script to template
    let template;
    try {
      template = scriptTranspiler.scriptToTemplate(scriptStr);
    } catch (error) {
      if (cb) {
        callbackAsap(cb, error);
        return undefined;
      }
      throw error;
    }

    // Lazy load Template to avoid circular dependency
    const { Template } = require('./template');
    const tmpl = new Template(template, this, opts.path);
    return tmpl.render(ctx, cb);
  }
}

module.exports = {
  Environment
};
