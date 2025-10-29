'use strict';

const waterfall = require('a-sync-waterfall');
const lib = require('../lib');
const filters = require('../filters');
const { FileSystemLoader, WebLoader, PrecompiledLoader } = require('../loader/loaders');
const tests = require('../tests');
const globals = require('../globals');
const { EmitterObj } = require('../object');
const { handleError } = require('../runtime/errors');
const expressApp = require('../express-app');
const { clearStringCache, callLoaders } = require('../loader/loader-utils');
const { Template, AsyncTemplate } = require('./template');
const { Script, AsyncScript } = require('./script');

/**
 * A no-op template, for use with {% include ignore missing %}
 */
const noopTmplSrc = {
  type: 'code',
  obj: {
    root(env, context, frame, runtime, cb) {
      try {
        cb(null, '');
      } catch (e) {
        const err = handleError(e, null, null, null, context ? context.path : null);
        cb(err);
      }
    }
  }
};

const noopTmplSrcAsync = {
  type: 'code',
  obj: {
    // The signature must be updated to accept compositionMode.
    root(env, context, frame, runtime, astate, cb, compositionMode = false) {
      try {
        if (!compositionMode) {
          // Only call the success callback if not in composition mode.
          cb(null, '');
        }
        // In composition mode, we do nothing and let the caller handle success.
        // We still need to return an empty value, like a real template would.
        if (compositionMode) {
          return ''; // A real template would return [], but '' works for flattenBuffer.
        }
      } catch (e) {
        const err = handleError(e, null, null, null, context ? context.path : null);
        cb(err);
      }
    }
  }
};

class BaseEnvironment extends EmitterObj {
  init(loaders, opts) {
    // The dev flag determines the trace that'll be shown on errors.
    // If set to true, returns the full trace from the error point,
    // otherwise will return trace starting from Template.render
    // (the full trace from within nunjucks may confuse developers using
    //  the library)
    // defaults to false
    opts = this.opts = opts || {};
    this.opts.dev = !!opts.dev;

    // The autoescape flag sets global autoescaping. If true,
    // every string variable will be escaped by default.
    // If false, strings can be manually escaped using the `escape` filter.
    // defaults to true
    this.opts.autoescape = opts.autoescape != null ? opts.autoescape : true;

    // If true, this will make the system throw errors if trying
    // to output a null or undefined value
    this.opts.throwOnUndefined = !!opts.throwOnUndefined;
    this.opts.trimBlocks = !!opts.trimBlocks;
    this.opts.lstripBlocks = !!opts.lstripBlocks;

    this.loaders = [];

    if (!loaders) {
      // The filesystem loader is only available server-side
      if (FileSystemLoader) {
        this.loaders = [new FileSystemLoader('views')];
      } else if (WebLoader) {
        this.loaders = [new WebLoader('/views')];
      }
    } else {
      this.loaders = lib.isArray(loaders) ? loaders : [loaders];
    }

    // It's easy to use precompiled templates: just include them
    // before you configure nunjucks and this will automatically
    // pick it up and use it
    if (typeof window !== 'undefined' && window.nunjucksPrecompiled) {
      this.loaders.unshift(
        new PrecompiledLoader(window.nunjucksPrecompiled)
      );
    }

    this._initLoaders();

    this.globals = globals();
    this.filters = {};
    this.tests = {};
    this.asyncFilters = [];
    this.extensions = {};
    this.extensionsList = [];

    lib._entries(filters).forEach(([name, filter]) => this.addFilter(name, filter));
    lib._entries(tests).forEach(([name, test]) => this.addTest(name, test));
  }

  _initLoaders() {
    // Per-loader compiled template caches (internal, non-mutating)
    if (!this._compiledCaches) {
      this._compiledCaches = new WeakMap();
    }
    this.loaders.forEach((loader) => {
      // Initialize compiled cache map for this loader
      if (!this._compiledCaches.get(loader)) {
        this._compiledCaches.set(loader, new Map());
      }
      if (typeof loader.on === 'function') {
        loader.on('update', (name, fullname) => {
          const cache = this._compiledCaches.get(loader);
          if (cache) {
            cache.delete(name);
          }
          this.emit('update', name, fullname, loader);
        });
        loader.on('load', (name, source) => {
          this.emit('load', name, source, loader);
        });
      }
    });
  }

  invalidateCache() {
    this.loaders.forEach((loader) => {
      const cache = this._compiledCaches && this._compiledCaches.get(loader);
      if (cache) {
        cache.clear();
      } else if (this._compiledCaches) {
        this._compiledCaches.set(loader, new Map());
      }
      // Also clear the string cache for this loader
      clearStringCache(loader);
    });
  }

  addExtension(name, extension) {
    extension.__name = name;
    this.extensions[name] = extension;
    this.extensionsList.push(extension);
    return this;
  }

  removeExtension(name) {
    var extension = this.getExtension(name);
    if (!extension) {
      return;
    }

    this.extensionsList = lib.without(this.extensionsList, extension);
    delete this.extensions[name];
  }

  getExtension(name) {
    return this.extensions[name];
  }

  hasExtension(name) {
    return !!this.extensions[name];
  }

  addGlobal(name, value) {
    this.globals[name] = value;
    return this;
  }

  getGlobal(name) {
    if (typeof this.globals[name] === 'undefined') {
      throw new Error('global not found: ' + name);
    }
    return this.globals[name];
  }

  //@todo
  //add option to send unresolved values to the filter
  addFilter(name, func, async) {
    if (async) {
      this.asyncFilters.push(name);
    }
    this.filters[name] = func;
    return this;
  }

  getFilter(name) {
    if (!this.filters[name]) {
      throw new Error('filter not found: ' + name);
    }
    return this.filters[name];
  }

  addTest(name, func) {
    this.tests[name] = func;
    return this;
  }

  getTest(name) {
    if (!this.tests[name]) {
      throw new Error('test not found: ' + name);
    }
    return this.tests[name];
  }

  resolveFromLoader(loader, parentName, filename) {
    var isRelative = (loader.isRelative && parentName) ? loader.isRelative(filename) : false;
    return (isRelative && loader.resolve) ? loader.resolve(parentName, filename) : filename;
  }

  _getCompiled(name, eagerCompile, parentName, ignoreMissing, asyncMode, scriptMode, cb) {
    var that = this;
    var tmpl = null;
    if (name && name.raw) {
      // this fixes autoescape for templates referenced in symbols
      name = name.raw;
    }

    if (lib.isFunction(asyncMode)) {
      cb = asyncMode;
      asyncMode = false;
    }

    if (lib.isFunction(ignoreMissing)) {
      cb = ignoreMissing;
      ignoreMissing = false;
    }

    if (lib.isFunction(parentName)) {
      cb = parentName;
      parentName = null;
      eagerCompile = eagerCompile || false;
    }

    if (lib.isFunction(eagerCompile)) {
      cb = eagerCompile;
      eagerCompile = false;
    }

    // Check if name is a Template or Script instance
    if (name instanceof Template || name instanceof Script || name instanceof AsyncScript) {
      tmpl = name;
    } else if (typeof name !== 'string') {
      throw new Error('template names must be a string: ' + name);
    } else {
      for (let i = 0; i < this.loaders.length; i++) {
        const loader = this.loaders[i];
        const cache = this._compiledCaches && this._compiledCaches.get(loader);
        const key = this.resolveFromLoader(loader, parentName, name);
        tmpl = cache ? cache.get(key) : undefined;
        if (tmpl) {
          if (!!tmpl.asyncMode !== asyncMode) {
            throw new Error('The same template can not be compiled in both async and sync mode');
          }
          break;
        }
      }
    }

    if (tmpl) {
      if (eagerCompile) {
        tmpl.compile();
      }

      if (cb) {
        cb(null, tmpl);
        return undefined;
      } else {
        return tmpl;
      }
    }
    let syncResult;

    const createTemplate = (err, info) => {
      if (!info && !err && !ignoreMissing) {
        err = new Error(`${scriptMode ? 'Script' : 'Template'} not found: ` + name);
      }

      if (err) {
        if (cb) {
          cb(err);
          return;
        } else {
          throw err;
        }
      }
      let newCompiled;
      if (scriptMode) {
        if (!info) {
          newCompiled = asyncMode ?
            new AsyncScript(noopTmplSrcAsync, this, '', eagerCompile) :
            new Script(noopTmplSrc, this, '', eagerCompile);
        } else {
          newCompiled = asyncMode ?
            new AsyncScript(info.src, this, info.path, eagerCompile) :
            new Script(info.src, this, info.path, eagerCompile);
          if (!info.noCache) {
            const compiledCache = this._compiledCaches.get(info.loader) || new Map();
            compiledCache.set(name, newCompiled);
            this._compiledCaches.set(info.loader, compiledCache);
          }
        }
      }
      else {
        if (!info) {
          newCompiled = asyncMode ?
            new AsyncTemplate(noopTmplSrcAsync, this, '', eagerCompile, asyncMode, scriptMode) :
            new Template(noopTmplSrc, this, '', eagerCompile, asyncMode, scriptMode);
        } else {
          newCompiled = asyncMode ?
            new AsyncTemplate(info.src, this, info.path, eagerCompile, asyncMode, scriptMode) :
            new Template(info.src, this, info.path, eagerCompile, asyncMode, scriptMode);
          if (!info.noCache) {
            const compiledCache = this._compiledCaches.get(info.loader) || new Map();
            compiledCache.set(name, newCompiled);
            this._compiledCaches.set(info.loader, compiledCache);
          }
        }
      }
      if (cb) {
        cb(null, newCompiled);
      } else {
        syncResult = newCompiled;
      }
    };

    callLoaders(this.loaders, name, (loader, templateName) => {
      return that.resolveFromLoader(loader, parentName, templateName);
    }, createTemplate);

    return syncResult;
  }

  express(app) {
    return expressApp(this, app);
  }

  waterfall(tasks, callback, forceAsync) {
    return waterfall(tasks, callback, forceAsync);
  }
}

module.exports = {
  BaseEnvironment,
  noopTmplSrc,
  noopTmplSrcAsync
};
