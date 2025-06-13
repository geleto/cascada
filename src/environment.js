'use strict';

const asap = require('asap');
const waterfall = require('a-sync-waterfall');
const lib = require('./lib');
const compiler = require('./compiler');
const filters = require('./filters');
const { FileSystemLoader, WebLoader, PrecompiledLoader } = require('./loaders');
const tests = require('./tests');
const globals = require('./globals');
const { Obj, EmitterObj } = require('./object');
const globalRuntime = require('./runtime');
const { handleError, Frame, AsyncFrame, AsyncState } = globalRuntime;
const expressApp = require('./express-app');
const { scriptToTemplate } = require('./script-convertor');

// If the user is using the async API, *always* call it
// asynchronously even if the template was synchronous.
function callbackAsap(cb, err, res) {
  asap(() => {
    cb(err, res);
  });
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
        cb(handleError(e, null, null));
      }
    }
  }
};

const noopTmplSrcAsync = {
  type: 'code',
  obj: {
    root(env, context, frame, runtime, astate, cb) {
      try {
        cb(null, '');
      } catch (e) {
        cb(handleError(e, null, null));
      }
    }
  }
};

class Environment extends EmitterObj {
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
    this.loaders.forEach((loader) => {
      // Caching and cache busting
      loader.cache = {};
      if (typeof loader.on === 'function') {
        loader.on('update', (name, fullname) => {
          loader.cache[name] = null;
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
      loader.cache = {};
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

  getTemplate(name, eagerCompile, parentName, ignoreMissing, cb) {
    return this._getCompiled(name, eagerCompile, parentName, ignoreMissing, false, false, cb);
  }

  getScript(name, eagerCompile, parentName, ignoreMissing, cb) {
    // Scripts use the same template loading mechanism, conversion happens at Script class level
    return this._getCompiled(name, eagerCompile, parentName, ignoreMissing, false, true, cb);
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

    if (name instanceof Template || name instanceof Script) {
      tmpl = name;
    } else if (typeof name !== 'string') {
      throw new Error('template names must be a string: ' + name);
    } else {
      for (let i = 0; i < this.loaders.length; i++) {
        const loader = this.loaders[i];
        tmpl = loader.cache[this.resolveFromLoader(loader, parentName, name)];
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
            info.loader.cache[name] = newCompiled;
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
            info.loader.cache[name] = newCompiled;
          }
        }
      }
      if (cb) {
        cb(null, newCompiled);
      } else {
        syncResult = newCompiled;
      }
    };

    lib.asyncIter(this.loaders, (loader, i, next, done) => {
      function handle(err, src) {
        if (err) {
          done(err);
        } else if (src) {
          src.loader = loader;
          done(null, src);
        } else {
          next();
        }
      }

      // Resolve name relative to parentName
      name = that.resolveFromLoader(loader, parentName, name);

      if (loader.async) {
        loader.getSource(name, handle);
      } else {
        handle(null, loader.getSource(name));
      }
    }, createTemplate);

    return syncResult;
  }

  express(app) {
    return expressApp(this, app);
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

    this.getTemplate(name, false, (err, tmpl) => {
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
      template = scriptToTemplate(scriptStr);
    } catch (error) {
      if (cb) {
        callbackAsap(cb, error);
        return undefined;
      }
      throw error;
    }

    const tmpl = new Template(template, this, opts.path);
    return tmpl.render(ctx, cb);
  }

  waterfall(tasks, callback, forceAsync) {
    return waterfall(tasks, callback, forceAsync);
  }
}

class AsyncEnvironment extends Environment {
  init(loaders, opts) {
    super.init(loaders, opts);

    // Initialize script configuration properties
    this.dataMethods = {}; // Pre-fill with built-in methods later
    this.commandHandlerClasses = {};
    this.commandHandlerInstances = {};
    this.resultStructure = {//@todo - remove
      dataKey: 'data',
      textKey: 'text'
    };
  }

  /**
   * Merges a map of custom methods into the built-in data methods.
   * @param {Object.<string, Function>} methods - An object where keys are command names
   * and values are the functions to execute.
   */
  addDataMethods(methods) {
    Object.assign(this.dataMethods, methods);
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

  /**
   * Customizes the top-level keys in the script's final result object.
   * @param {object} opts - Options object with `dataKey` and/or `textKey`.
   */
  setResultStructure(opts) {
    Object.assign(this.resultStructure, opts);
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
    ctx = ctx || {};

    // Convert script to template
    let template;
    try {
      template = scriptToTemplate(scriptStr);
    } catch (error) {
      throw new Error(`Error converting script to template: ${error.message}`);
    }

    // Use the async template renderer
    return this._asyncRenderTemplate(template, ctx, false, opts || {});
  }

  //@todo - rewrite once template.render with no callback returns a promise
  async _asyncRenderTemplate(template, ctx, namedTemplate, opts) {
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
        this.getScript(script, false, null, false, (err, tmpl) => {
          if (err) {
            callbackAsap(callback, err);
          } else {
            tmpl.render(ctx, callback);
          }
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

class Context extends Obj {
  init(ctx, blocks, env) {
    // Has to be tied to an environment so we can tap into its globals.
    this.env = env || new Environment();

    // Make a duplicate of ctx
    this.ctx = lib.extend({}, ctx);

    this.blocks = {};
    this.exported = [];

    lib.keys(blocks).forEach(name => {
      this.addBlock(name, blocks[name]);
    });
  }

  lookup(name) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      return this.ctx[name];
    }
  }

  setVariable(name, val) {
    this.ctx[name] = val;
  }

  getVariables() {
    return this.ctx;
  }

  addBlock(name, block) {
    this.blocks[name] = this.blocks[name] || [];
    this.blocks[name].push(block);
    return this;
  }

  getBlock(name) {
    if (!this.blocks[name]) {
      throw new Error('unknown block "' + name + '"');
    }

    return this.blocks[name][0];
  }

  prepareForAsyncBlocks() {
    this.asyncBlocksPromise = new Promise((resolve, reject) => {
      this.asyncBlocksResolver = resolve;
    }).then(() => {
      delete this.asyncBlocksPromise;
      delete this.asyncBlocksResolver;
    });
  }

  async getAsyncBlock(name) {
    // this breaks super(), why?
    //if (this.blocks[name]) {
    //  return this.getBlock(name);
    //}
    if (this.asyncBlocksPromise) {
      await this.asyncBlocksPromise;
    }
    return this.getBlock(name);
  }

  async finsihsAsyncBlocks() {
    if (this.asyncBlocksResolver) {
      this.asyncBlocksResolver();
    }
  }

  getSuper(env, name, block, frame, runtime, astate, cb) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (typeof astate === 'function') {
      cb = astate;
      astate = null;
    }

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    if (astate) {
      //async mode
      blk(env, context, frame, runtime, astate, cb);
    }
    else {
      blk(env, context, frame, runtime, cb);
    }
  }

  addExport(name) {
    this.exported.push(name);
  }

  getExported() {
    var exported = {};
    this.exported.forEach((name) => {
      exported[name] = this.ctx[name];
    });
    return exported;
  }
}

//@todo - class Script

class Template extends Obj {
  init(src, env, path, eagerCompile, asyncMode = false, scriptMode = false) {
    this.env = env || new Environment();
    this.asyncMode = asyncMode;
    this.scriptMode = scriptMode;

    if (lib.isObject(src)) {
      switch (src.type) {
        case 'code':
          this.tmplProps = src.obj;
          break;
        case 'string':
          this.tmplStr = src.obj;
          break;
        default:
          throw new Error(
            `Unexpected template object type ${src.type}; expected 'code', or 'string'`);
      }
    } else if (lib.isString(src)) {
      this.tmplStr = src;
    } else {
      throw new Error('src must be a string or an object describing the source');
    }

    this.path = path;

    if (eagerCompile) {
      try {
        this._compile();
      } catch (err) {
        throw lib._prettifyError(this.path, this.env.opts.dev, err);
      }
    } else {
      this.compiled = false;
    }
  }

  // @todo - return promise if isAsync and no callback is provided
  render(ctx, parentFrame, astate, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
    } else if (typeof parentFrame === 'function') {
      cb = parentFrame;
      parentFrame = null;
    } else if (typeof astate === 'function') {
      cb = astate;
      astate = null;
    }

    // If there is a parent frame, we are being called from internal
    // code of another template, and the internal system
    // depends on the sync/async nature of the parent template
    // to be inherited, so force an async callback
    const forceAsync = !parentFrame;

    // Catch compile errors for async rendering
    try {
      this.compile();
    } catch (e) {
      const err = lib._prettifyError(this.path, this.env.opts.dev, e);
      if (cb) {
        return callbackAsap(cb, err);
      } else {
        throw err;
      }
    }

    const context = new Context(ctx || {}, this.blocks, this.env);
    let frame;
    if (parentFrame) {
      frame = parentFrame.push(true);
    }
    else {
      frame = this.asyncMode ? new AsyncFrame : new Frame();
    }
    frame.topLevel = true;
    let syncResult = null;
    let callbackCalled = false;

    const isAsync = this.env instanceof AsyncEnvironment;

    let didError = false;

    const callback = (err, res) => {
      if (!isAsync) {
        // TODO: this is actually a bug in the compiled template (because waterfall
        // tasks are both not passing errors up the chain of callbacks AND are not
        // causing a return from the top-most render function). But fixing that
        // will require a more substantial change to the compiler.
        if (didError && cb && typeof res !== 'undefined') {
          // the old non-async nunjucks behaviour
          // prevent multiple calls to cb
          return;
        }
      } else {
        if (callbackCalled) {
          //already had success or error
          //ignore all errors after sucess (happens with unused vars throwing an error after template is rendered)
          //see the 'Side effects - template render lifecycle' tests
          return;
        }
        callbackCalled = true;//only allow one callback
      }

      if (err) {
        err = lib._prettifyError(this.path, this.env.opts.dev, err);
        didError = true;
      }

      if (cb) {
        if (forceAsync) {
          callbackAsap(cb, err, res);
        } else {
          cb(err, res);
        }
      } else {
        if (err) {
          throw err;
        }
        syncResult = res;

        if (err) {
          err = lib._prettifyError(this.path, this.env.opts.dev, err);
          didError = true;
        }

        if (cb) {
          if (forceAsync) {
            callbackAsap(cb, err, res);
          } else {
            cb(err, res);
          }
        } else {
          if (err) {
            throw err;
          }
          syncResult = res;
        }
      };
    };

    if (this.asyncMode) {
      this.rootRenderFunc(this.env, context, frame, globalRuntime,
        astate || new AsyncState(), callback);
    } else {
      this.rootRenderFunc(this.env, context, frame, globalRuntime, callback);
    }

    return syncResult;
  }

  getExported(ctx, parentFrame, astate, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
    }

    if (typeof parentFrame === 'function') {
      cb = parentFrame;
      parentFrame = null;
    }

    if (typeof astate === 'function') {
      cb = astate;
      astate = null;
    }

    // Catch compile errors for async rendering
    try {
      this.compile();
    } catch (e) {
      if (cb) {
        return cb(e);
      } else {
        throw e;
      }
    }

    let frame;
    if (parentFrame) {
      frame = parentFrame.push();
    }
    else {
      if (this.asyncMode) {
        frame = new AsyncFrame();
        frame.isIncluded = true;
      }
      else {
        frame = new Frame();
      }
    }
    frame.topLevel = true;

    // Run the rootRenderFunc to populate the context with exported vars
    const context = new Context(ctx || {}, this.blocks, this.env);
    const callback = (err) => {
      if (err) {
        cb(err, null);
      } else {
        cb(null, context.getExported());
      }
    };
    if (this.asyncMode) {
      this.rootRenderFunc(this.env, context, frame, globalRuntime, astate || new AsyncState(), callback);
    } else {
      this.rootRenderFunc(this.env, context, frame, globalRuntime, callback);
    }

    return undefined;
  }

  compile() {
    if (!this.compiled) {
      this._compile();
    }
  }

  _compile() {
    var props;

    if (this.tmplProps) {
      props = this.tmplProps;
    } else {
      const source = compiler.compile(this.tmplStr,
        this.env.asyncFilters,
        this.env.extensionsList,
        this.path,
        Object.assign({scriptMode: this.scriptMode, asyncMode: this.asyncMode}, this.env.opts)
      );

      let func;
      try {
        func = new Function(source);
      } catch (e) {
        /*console.error('Error compiling:\n' + source);

        console.error('Error creating function:');
        console.error('- Name:', e.name);
        console.error('- Message:', e.message);
        console.error('- Stack:', e.stack);

        console.error('Test environment info:');
        if(typeof navigator !== 'undefined') {
          console.error('UserAgent:', navigator.userAgent);
        }

        // Additional properties that might e available
        if (e.lineNumber) console.error('- Line Number:', e.lineNumber);
        if (e.columnNumber) console.error('- Column Number:', e.columnNumber);
        if (e.fileName) console.error('- File Name:', e.fileName);

        // If it's a syntax error, it might have additional properties
        if (e instanceof SyntaxError) {
          console.error('- Is Syntax Error: Yes');
          // Some environments provide these for SyntaxErrors
          if (e.line) console.error('- Line:', e.line);
          if (e.column) console.error('- Column:', e.column);
        }

        // Log the source that caused the error
        console.error('- Problematic source:', source);

        // Log the current environment
        console.error('- Node.js version:', process.version);
        console.error('- V8 version:', process.versions.v8);*/

        throw new Error('Error trying to compile ' + this.path + ' ' + e.message);
      }
      props = func();
    }

    this.blocks = this._getBlocks(props);
    this.rootRenderFunc = props.root;
    this.compiled = true;
  }

  _getBlocks(props) {
    var blocks = {};

    lib.keys(props).forEach((k) => {
      if (k.slice(0, 2) === 'b_') {
        blocks[k.slice(2)] = props[k];
      }
    });

    return blocks;
  }
}

class AsyncTemplate extends Template {
  init(src, env, path, eagerCompile) {
    env = env || new AsyncEnvironment();
    super.init(src, env, path, eagerCompile, true/*async*/, false/*script*/);
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


/**
 * Script class - represents a compiled Cascada script
 */
class Script extends Template {
  init(src, env, path, eagerCompile) {
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      src = scriptToTemplate(src);
    }

    super.init(src, env, path, eagerCompile, false/*async*/, true/*script*/);
  }
}

/**
 * AsyncScript class - represents a compiled async Cascada script
 */
class AsyncScript extends Template {
  init(src, env, path, eagerCompile) {
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      const template = scriptToTemplate(src);
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
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Script,
  AsyncScript
};
