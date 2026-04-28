'use strict';

import {isFunction} from '../lib.js';
import {BaseEnvironment} from './base-environment.js';
import {callbackAsap} from './utils.js';
import {Template} from './template.js';

class Environment extends BaseEnvironment {
  init(loaders, opts) {
    super.init(loaders, opts);
    this.TemplateClass = Template;
    this.AsyncTemplateClass = Template;
    this.ScriptClass = null;
  }

  getTemplate(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiledTemplate(name, eagerCompile, parentName, ignoreMissing, false, cb);
  }

  /** @deprecated Use renderTemplate instead */
  render(name, ctx, cb) {
    if (isFunction(ctx)) {
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
    if (isFunction(opts)) {
      cb = opts;
      opts = {};
    }
    opts = opts || {};

    const tmpl = new Template(src, this, opts.path);
    return tmpl.render(ctx, cb);
  }
}

export { Environment };
