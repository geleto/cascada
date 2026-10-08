import * as lib from '../lib.js';
import * as filters from '../builtins/filters.js';
import * as tests from '../builtins/tests.js';
import {createGlobals} from '../builtins/globals.js';
import {EmitterObj} from '../object.js';
import {createSyncRuntimeError} from '../runtime/errors.js';
import {express as expressApp} from './express-app.js';
import {clearStringCache, callLoaders, SourceCache} from '../loader/loader-utils.js';
import {subscribeLoaderEvent} from '../loader/loader-events.js';
import {NotFoundError} from '../loader/errors.js';

function onLoaderUpdate(environment, loader, name, fullname) {
  const cache = environment._compiledCaches.get(loader);
  for (const [key, {acquisition}] of cache) {
    if (acquisition.name === name || acquisition.origin.path === name ||
        (fullname != null && acquisition.origin.path === fullname)) {
      cache.delete(key);
    }
  }
  environment.emit('update', name, fullname, loader);
}

function onLoaderLoad(environment, loader, name, source) {
  environment.emit('load', name, source, loader);
}

const LOAD_FAILURE_KINDS = new Set(['import', 'component', 'include']);
let DefaultFileSystemLoader = null;
let DefaultWebLoader = null;

function executeWaterfallAsync(fn) {
  if (typeof setImmediate === 'function') {
    setImmediate(fn);
  } else {
    queueMicrotask(fn);
  }
}

function makeWaterfallIterator(tasks) {
  function makeCallback(index) {
    const fn = function(...args) {
      if (tasks.length) {
        tasks[index](...args);
      }
      return fn.next();
    };
    fn.next = function() {
      return index < tasks.length - 1 ? makeCallback(index + 1) : null;
    };
    return fn;
  }
  return makeCallback(0);
}

function waterfall(tasks, callback = function() {}, forceAsync = false) {
  const schedule = forceAsync ? executeWaterfallAsync : (fn) => fn();
  if (!Array.isArray(tasks)) {
    callback(new Error('First argument to waterfall must be an array of functions'));
    return;
  }
  if (!tasks.length) {
    callback();
    return;
  }

  function wrapIterator(iterator) {
    return function(err, ...values) {
      if (err) {
        callback(err, ...values);
        callback = function() {};
        return;
      }
      const next = iterator.next();
      values.push(next ? wrapIterator(next) : callback);
      schedule(() => iterator(...values));
    };
  }

  wrapIterator(makeWaterfallIterator(tasks))();
}

function setDefaultLoaderClasses(FileSystemLoader, WebLoader) {
  DefaultFileSystemLoader = FileSystemLoader;
  DefaultWebLoader = WebLoader;
}

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
        const err = createSyncRuntimeError(e, null, null, null, context ? context.path : null);
        cb(err);
      }
    }
  }
};

const noopTmplSrcAsync = {
  type: 'code',
  obj: {
    getErrorContexts() {
      return [];
    },

    root(env, context, runtime, cb) {
      return '';
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
    opts = this.opts = { ...(opts || {}) };
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
    this.opts.loadFailFatal = normalizeLoadFailFatal(opts.loadFailFatal);

    this.loaders = [];

    if (!loaders) {
      // The filesystem loader is only available server-side
      if (DefaultFileSystemLoader) {
        this.loaders = [new DefaultFileSystemLoader('views')];
      } else if (DefaultWebLoader) {
        this.loaders = [new DefaultWebLoader('/views')];
      }
    } else {
      this.loaders = lib.isArray(loaders) ? loaders : [loaders];
    }

    this._initLoaders();

    this.globals = createGlobals();
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
    if (!this._sourceCaches) {
      this._sourceCaches = new WeakMap();
    }
    this.loaders.forEach((loader) => {
      // Initialize compiled cache map for this loader
      if (!this._compiledCaches.get(loader)) {
        this._compiledCaches.set(loader, new Map());
      }
      if (!this._sourceCaches.get(loader)) {
        this._sourceCaches.set(loader, new SourceCache(loader));
      }
      subscribeLoaderEvent(loader, 'update', this, onLoaderUpdate);
      subscribeLoaderEvent(loader, 'load', this, onLoaderLoad);
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
      this._sourceCaches.get(loader).clear();
      // Also clear the string cache for this loader
      clearStringCache(loader);
    });
  }

  /** Loads literal text through this environment's loader chain and source cache. */
  loadString(name, parentName) {
    return new Promise((resolve, reject) => {
      if (typeof name !== 'string') {
        reject(new TypeError('resource names must be a string: ' + name));
        return;
      }
      this._getSource(name, parentName, (error, acquisition) => {
        if (error) {
          reject(error);
        } else if (!acquisition) {
          reject(new NotFoundError(name));
        } else if (typeof acquisition.source.src !== 'string') {
          reject(new TypeError('Resource is not a string: ' + name));
        } else {
          resolve(acquisition.source.src);
        }
      });
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

  _resolveFromLoader(loader, parentName, filename, origin) {
    const resolver = origin?.loader === loader ? origin.owner : loader;
    const isRelative = resolver.isRelative && parentName && resolver.isRelative(filename);
    return isRelative && resolver.resolve ? resolver.resolve(parentName, filename) : filename;
  }

  _getSource(name, parentName, callback) {
    const origin = parentName && typeof parentName === 'object' ? parentName : undefined;
    const parentPath = origin ? origin.path : parentName;
    return callLoaders(this.loaders, name, (loader, filename) => {
      return this._resolveFromLoader(loader, parentPath, filename, origin);
    }, callback, this._sourceCaches, parentPath);
  }

  _getCompiledTemplate(name, eagerCompile, parentName, ignoreMissing, asyncMode, cb) {
    return this._getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, asyncMode, false, cb);
  }

  _getCompiledScript(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, true, true, cb);
  }

  _getCompiledByMode(name, eagerCompile, parentName, ignoreMissing, asyncMode, scriptMode, cb) {
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

    const TemplateClass = this.TemplateClass;
    const AsyncTemplateClass = this.AsyncTemplateClass || TemplateClass;
    const ScriptClass = this.ScriptClass;

    // Check if name is a compiled template/script instance
    if ((TemplateClass && name instanceof TemplateClass) || (ScriptClass && name instanceof ScriptClass)) {
      tmpl = name;
    } else if (typeof name !== 'string') {
      throw new Error('template names must be a string: ' + name);
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

    const cacheCompiled = (acquisition, compiled) => {
      compiled.sourceOrigin = acquisition.origin;
      const loader = acquisition.origin.loader;
      if (this._sourceCaches.get(loader).has(acquisition)) {
        this._compiledCaches.get(loader).set(acquisition.cacheKey, {acquisition, compiled});
      }
      return compiled;
    };

    const createCompiledScript = (info) => {
      if (!ScriptClass) {
        throw new Error('Script rendering is not available in this environment');
      }
      if (!info) {
        return new ScriptClass(noopTmplSrcAsync, this, '', eagerCompile);
      }

      return cacheCompiled(info, new ScriptClass(info.source.src, this, info.origin.path, eagerCompile));
    };

    const createCompiledTemplate = (info) => {
      let compiled;
      if (!info) {
        compiled = asyncMode
          ? new AsyncTemplateClass(noopTmplSrcAsync, this, '', eagerCompile)
          : new TemplateClass(noopTmplSrc, this, '', eagerCompile);
      } else {
        compiled = asyncMode
          ? new AsyncTemplateClass(info.source.src, this, info.origin.path, eagerCompile)
          : new TemplateClass(info.source.src, this, info.origin.path, eagerCompile);
        cacheCompiled(info, compiled);
      }
      return compiled;
    };

    const createTemplate = (err, info, resolvedName) => {
      if (!info && !err && !ignoreMissing) {
        err = new NotFoundError(name);
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
      try {
        const cached = info && this._compiledCaches.get(info.origin.loader).get(resolvedName);
        newCompiled = cached && cached.acquisition === info ? cached.compiled : null;
        if (newCompiled) {
          if (!!newCompiled.asyncMode !== asyncMode) {
            throw new Error('The same template can not be compiled in both async and sync mode');
          }
          if (eagerCompile) {
            newCompiled.compile();
          }
        } else {
          newCompiled = scriptMode
            ? createCompiledScript(info)
            : createCompiledTemplate(info);
        }
      } catch (error) {
        if (cb) {
          cb(error);
          return;
        }
        throw error;
      }
      if (cb) {
        cb(null, newCompiled);
      } else {
        syncResult = newCompiled;
      }
    };

    this._getSource(name, parentName, createTemplate);

    return syncResult;
  }

  express(app) {
    return expressApp(this, app);
  }

  waterfall(tasks, callback, forceAsync) {
    return waterfall(tasks, callback, forceAsync);
  }
}

function normalizeLoadFailFatal(value) {
  if (value === undefined || value === true) {
    return new Set(LOAD_FAILURE_KINDS);
  }
  if (value === false) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new Error('loadFailFatal must be true, false, or an array of load kinds');
  }

  const result = new Set();
  for (const kind of value) {
    if (!LOAD_FAILURE_KINDS.has(kind)) {
      throw new Error(`Invalid loadFailFatal kind '${kind}'`);
    }
    result.add(kind);
  }
  return result;
}

export { BaseEnvironment, noopTmplSrc, noopTmplSrcAsync, setDefaultLoaderClasses };
