import {isFunction} from '../lib.js';
import {BaseEnvironment} from './base-environment.js';
import {callbackAsap} from './utils.js';
import {PrecompiledTemplate, AsyncPrecompiledTemplate} from './precompiled-template.js';

class PrecompiledEnvironment extends BaseEnvironment {
  init(loaders, opts) {
    super.init(loaders, opts);
    this.TemplateClass = PrecompiledTemplate;
    this.AsyncTemplateClass = PrecompiledTemplate;
    this.ScriptClass = null;
  }

  getTemplate(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiledTemplate(name, eagerCompile, parentName, ignoreMissing, false, cb);
  }

  renderTemplate(name, ctx, cb) {
    if (isFunction(ctx)) {
      cb = ctx;
      ctx = null;
    }

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

  render(name, ctx, cb) {
    return this.renderTemplate(name, ctx, cb);
  }

  renderTemplateString() {
    throw new Error('Template string rendering is not available in a precompiled environment');
  }

  renderString() {
    throw new Error('Template string rendering is not available in a precompiled environment');
  }
}

class AsyncPrecompiledEnvironment extends BaseEnvironment {
  init(loaders, opts) {
    super.init(loaders, opts);
    this.TemplateClass = AsyncPrecompiledTemplate;
    this.AsyncTemplateClass = AsyncPrecompiledTemplate;
    this.ScriptClass = null;
  }

  async renderTemplate(templateName, ctx) {
    ctx = ctx || {};
    const tmpl = await this.getTemplate(templateName, false, null, false);
    if (!tmpl) {
      throw new Error(`Template not found: ${templateName}`);
    }
    return tmpl.render(ctx);
  }

  renderTemplateString() {
    return Promise.reject(new Error('Template string rendering is not available in a precompiled environment'));
  }

  renderScript() {
    return Promise.reject(new Error('Script rendering is not available in a precompiled environment'));
  }

  renderScriptString() {
    return Promise.reject(new Error('Script rendering is not available in a precompiled environment'));
  }

  getTemplate(name, eagerCompile, parentName, ignoreMissing) {
    if (typeof name.then === 'function') {
      return name.then((resolvedName) => {
        return this._getCompiledTemplateAsync(resolvedName, eagerCompile, parentName, ignoreMissing);
      });
    }
    return this._getCompiledTemplateAsync(name, eagerCompile, parentName, ignoreMissing);
  }

  _getCompiledTemplateAsync(name, eagerCompile, parentName, ignoreMissing) {
    return new Promise((resolve, reject) => {
      this._getCompiledTemplate(name, eagerCompile, parentName, ignoreMissing, true, (err, tmpl) => {
        if (err) {
          reject(err);
        } else {
          resolve(tmpl);
        }
      });
    });
  }

  addFilter(name, func, async) {
    if (async) {
      this.asyncFilters.push(name);
      this.filters[name] = (val) => {
        return new Promise((resolve, reject) => {
          func(val, (err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
        });
      };
    } else {
      this.filters[name] = func;
    }
    return this;
  }

  addFilterAsync(name, func) {
    this.asyncFilters.push(name);
    this.filters[name] = func;
    return this;
  }
}

export {
  PrecompiledEnvironment,
  AsyncPrecompiledEnvironment,
  PrecompiledTemplate,
  AsyncPrecompiledTemplate
};
