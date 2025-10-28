'use strict';

const DataHandler = require('../data-handler');
const { BaseEnvironment } = require('./base-environment');
const { AsyncTemplate } = require('./template');
const { AsyncScript } = require('./script');

class AsyncEnvironment extends BaseEnvironment {
  init(loaders, opts) {
    super.init(loaders, opts);

    // Initialize script configuration properties
    this.customDataMethods = {};
    this.commandHandlerClasses = {};
    this.commandHandlerInstances = {};

    // Register the DataHandler as a default command handler
    this.addCommandHandlerClass('data', DataHandler);
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
   * Registers a command handler class that will be instantiated for each script run.
   * @param {string} name - The name used to invoke the handler (e.g., 'turtle').
   * @param {Class} handlerClass - The class constructor.
   */
  addCommandHandlerClass(name, handlerClass) {
    this.commandHandlerClasses[name] = handlerClass;
    return this;
  }

  /**
   * Registers a pre-existing object instance as a command handler (singleton).
   * @param {string} name - The name used to invoke the handler.
   * @param {object} handlerInstance - The object instance to use.
   */
  addCommandHandler(name, handlerInstance) {
    this.commandHandlerInstances[name] = handlerInstance;
    return this;
  }

  async renderTemplate(templateName, ctx, parentFrame) {
    return this._asyncRenderTemplate(templateName, ctx, true, parentFrame);
  }

  async renderScript(templateName, ctx, parentFrame) {
    return this._asyncRenderScript(templateName, ctx, true, parentFrame);
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
            throw new Error(`Template not found: ${script}`);
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
        this._getCompiledAsync(resolvedName, eagerCompile, parentName, ignoreMissing, true, true);
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
