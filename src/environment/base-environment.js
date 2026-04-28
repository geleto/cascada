'use strict';

import waterfall from 'a-sync-waterfall';
import {isArray, _entries, without, isFunction} from '../lib.js';
import filters from '../filters.js';
import {FileSystemLoader, WebLoader, PrecompiledLoader} from '../loader/loaders.js';
import * as tests from '../tests.js';
import globals from '../globals.js';
import {EmitterObj} from '../object.js';
import {handleError} from '../runtime/errors.js';
import expressApp from '../express-app.js';
import {clearStringCache, callLoaders} from '../loader/loader-utils.js';

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
    root(env, context, runtime, cb, compositionMode = false) {
      try {
        if (!compositionMode) {
          cb(null, '');
          return;
        }
        const output = runtime.createCommandBuffer(context, null);
        runtime.declareBufferChannel(output, '__text__', 'text', context, null);
        output.markFinishedAndPatchLinks();
        return output;
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
      this.loaders = isArray(loaders) ? loaders : [loaders];
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

    _entries(filters).forEach(([name, filter]) => this.addFilter(name, filter));
    _entries(tests).forEach(([name, test]) => this.addTest(name, test));
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

    this.extensionsList = without(this.extensionsList, extension);
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

  _getCompiledTemplate(name, eagerCompile, parentName, ignoreMissing, asyncMode, cb) {
    return this._getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, asyncMode, false, cb);
  }

  _getCompiledScript(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, true, true, cb);
  }

  _getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, asyncMode, scriptMode, cb) {
    var that = this;
    var tmpl = null;
    if (name && name.raw) {
      // this fixes autoescape for templates referenced in symbols
      name = name.raw;
    }

    if (isFunction(asyncMode)) {
      cb = asyncMode;
      asyncMode = false;
    }

    if (isFunction(ignoreMissing)) {
      cb = ignoreMissing;
      ignoreMissing = false;
    }

    if (isFunction(parentName)) {
      cb = parentName;
      parentName = null;
      eagerCompile = eagerCompile || false;
    }

    if (isFunction(eagerCompile)) {
      cb = eagerCompile;
      eagerCompile = false;
    }

    const TemplateClass = this.TemplateClass;
    const AsyncTemplateClass = this.AsyncTemplateClass || TemplateClass;
    const ScriptClass = this.ScriptClass;

    // Check if name is a compiled template/script instance
    if ((TemplateClass && name instanceof TemplateClass) || (ScriptClass && name instanceof ScriptClass)) {
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

    const createCompiledScript = (info) => {
      if (!ScriptClass) {
        throw new Error('Script rendering is not available in this environment');
      }
      if (!info) {
        return new ScriptClass(noopTmplSrcAsync, this, '', eagerCompile);
      }

      const compiled = new ScriptClass(info.src, this, info.path, eagerCompile);
      if (!info.noCache) {
        const compiledCache = this._compiledCaches.get(info.loader) || new Map();
        compiledCache.set(name, compiled);
        this._compiledCaches.set(info.loader, compiledCache);
      }
      return compiled;
    };

    const createCompiledTemplate = (info) => {
      let compiled;
      if (!info) {
        compiled = asyncMode
          ? new AsyncTemplateClass(noopTmplSrcAsync, this, '', eagerCompile)
          : new TemplateClass(noopTmplSrc, this, '', eagerCompile);
      } else {
        compiled = asyncMode
          ? new AsyncTemplateClass(info.src, this, info.path, eagerCompile)
          : new TemplateClass(info.src, this, info.path, eagerCompile);
        if (!info.noCache) {
          const compiledCache = this._compiledCaches.get(info.loader) || new Map();
          compiledCache.set(name, compiled);
          this._compiledCaches.set(info.loader, compiledCache);
        }
      }
      return compiled;
    };

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
      const newCompiled = scriptMode
        ? createCompiledScript(info)
        : createCompiledTemplate(info);
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

export { BaseEnvironment, noopTmplSrc, noopTmplSrcAsync };
