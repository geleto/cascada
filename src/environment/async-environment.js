'use strict';
const { BaseEnvironment } = require('./base-environment');
const { AsyncTemplate } = require('./template');
const { AsyncScript } = require('./script');

class AsyncEnvironment extends BaseEnvironment {
  init(loaders, opts) {
    super.init(loaders, opts);

    // Initialize script configuration properties
    this.customDataMethods = {};
    this.commandChannelClasses = {};
    this.commandChannels = {};

  }

  /**
   * Merges a map of custom methods into the built-in data methods.
   * @param {Object.<string, Function>} methods - An object where keys are command names
   * and values are the functions to execute.
   */
  addDataMethods(methods) {
    Object.assign(this.customDataMethods, methods);
    return this;
  }

  /**
   * Stores a command channel class registration for compatibility.
   * NOTE: Stored values are currently inert for channel-command execution.
   */
  addCommandChannelClass(name, channelClass) {
    this.commandChannelClasses[name] = channelClass;
    return this;
  }

  /**
   * Stores a command channel instance registration for compatibility.
   * NOTE: Stored values are currently inert for channel-command execution.
   */
  addCommandChannel(name, channelInstance) {
    this.commandChannels[name] = channelInstance;
    return this;
  }

  async renderTemplate(templateName, ctx) {
    return this._asyncRenderTemplate(templateName, ctx, true);
  }

  async renderScript(templateName, ctx) {
    return this._asyncRenderScript(templateName, ctx, true);
  }

  async renderTemplateString(src, ctx, opts) {
    return this._asyncRenderTemplate(src, ctx, false, opts || {});
  }

  async renderScriptString(scriptStr, ctx, opts) {
    return this._asyncRenderScript(scriptStr, ctx, false, opts || {});
  }

  //@todo - rewrite once template.render with no callback returns a promise
  async _asyncRenderTemplate(template, ctx, namedTemplate, opts) {
    ctx = ctx || {};
    const result = await new Promise((resolve, reject) => {
      let callback = (err, res) => {
        if (err || res === null) {
          reject(err || new Error('No render result'));
        } else {
          resolve(res);
        }
      };
      if (namedTemplate) {
        // render template
        this.getTemplate(template, false, null, false).then((tmpl) => {
          if (!tmpl) {
            throw new Error(`Template not found: ${template}`);
          }
          tmpl.render(ctx, callback);
        }).catch(err => {
          reject(err);
        });
      } else {
        // render template string
        const tmpl = new AsyncTemplate(template, this, opts.path);
        tmpl.render(ctx, callback);
      }
    });
    return result;
  }

  async _asyncRenderScript(script, ctx, namedScript, opts) {
    ctx = ctx || {};
    const result = await new Promise((resolve, reject) => {
      let callback = (err, res) => {
        if (err || res === null) {
          reject(err || new Error('No render result'));
        } else {
          resolve(res);
        }
      };

      if (namedScript) {
        // render script object
        this.getScript(script, false, null, false).then((scr) => {
          if (!scr) {
            throw new Error(`Script not found: ${script}`);
          }
          scr.render(ctx, callback);
        });
      } else {
        // render script string
        const tmpl = new AsyncScript(script, this, opts.path);
        tmpl.render(ctx, callback);
      }
    });
    return result;
  }

  //returns a Promise, unlike the sync version
  getTemplate(name, eagerCompile, parentName, ignoreMissing) {
    if (typeof name.then === 'function') { // the name is a promise
      return name.then((resolvedName) => {
        return this._getCompiledAsync(resolvedName, eagerCompile, parentName, ignoreMissing, true, false);
      });
    }
    return this._getCompiledAsync(name, eagerCompile, parentName, ignoreMissing, true, false);
  }

  //@todo - in script mode use instead of getTemplate
  //or maybe it's not needed, just use getCompiled?
  getScript(name, eagerCompile, parentName, ignoreMissing) {
    if (typeof name.then === 'function') { // the name is a promise
      return name.then((resolvedName) => {
        return this._getCompiledAsync(resolvedName, eagerCompile, parentName, ignoreMissing, true, true);
      });
    }
    return this._getCompiledAsync(name, eagerCompile, parentName, ignoreMissing, true, true);
  }

  _getCompiledAsync(name, eagerCompile, parentName, ignoreMissing, asyncMode, scriptMode) {
    return new Promise((resolve, reject) => {
      this._getCompiled(name, eagerCompile, parentName, ignoreMissing, asyncMode, scriptMode, (err, tmpl) => {
        if (err) {
          reject(err);
        } else {
          resolve(tmpl);
        }
      });
    });
  }

  //@todo - AsyncEnvironment should only support async functions,
  // not functions with callbacks
  addFilter(name, func, async) {
    if (async) {
      this.asyncFilters.push(name);
    }
    if (async) {
      //func is a callback runction, convert to a function that returns a promise
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

module.exports = {
  AsyncEnvironment
};
