'use strict';

const lib = require('../lib');
const compiler = require('../compiler/compiler');
const globalRuntime = require('../runtime/runtime');
const { Frame } = require('../runtime/frame');
const { Obj } = require('../object');
const { callbackAsap } = require('./utils');
const { Context } = require('./context');

// Lazy-loaded environment classes to avoid circular dependencies
let Environment, AsyncEnvironment;

class Template extends Obj {
  init(src, env, path, eagerCompile) {
    if (!env) {
      if (!Environment) {
        const envModule = require('./environment');
        Environment = envModule.Environment;
      }
      this.env = new Environment();
    } else {
      this.env = env;
    }
    this.asyncMode = false;
    this.scriptMode = false;

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

  render(ctx, parentFrame, cb) {
    return this._renderSync(ctx, parentFrame, cb);
  }

  _renderAsync(ctx, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
    }

    try {
      this.compile();
    } catch (e) {
      const err = lib._prettifyError(this.path, this.env.opts.dev, e);
      if (cb) {
        return callbackAsap(cb, err);
      }
      throw err;
    }

    const context = this._createContext(ctx);
    let syncResult = null;
    let callbackCalled = false;

    const callback = (err, res) => {
      if (callbackCalled) {
        return;
      }
      callbackCalled = true;

      if (err) {
        err = lib._prettifyError(this.path, this.env.opts.dev, err);
      }

      if (cb) {
        callbackAsap(cb, err, res);
      } else {
        if (err) {
          throw err;
        }
        syncResult = res;
      }
    };

    this.rootRenderFunc(this.env, context, globalRuntime, callback);
    return syncResult;
  }

  _renderSync(ctx, parentFrame, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
      parentFrame = null;
    } else if (typeof parentFrame === 'function') {
      cb = parentFrame;
      parentFrame = null;
    }

    const forceAsync = !parentFrame;

    // Catch compile errors for sync rendering
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

    const context = this._createContext(ctx);
    const frame = parentFrame ? parentFrame.push(true) : new Frame();
    frame.topLevel = true;

    let didError = false;
    let syncResult = null;
    const callback = (err, res) => {
      // TODO: this is actually a bug in the compiled template (because waterfall
      // tasks are both not passing errors up the chain of callbacks AND are not
      // causing a return from the top-most render function). But fixing that
      // will require a more substantial change to the compiler.
      if (didError && cb && typeof res !== 'undefined') {
        return;
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
      }
    };

    this.rootRenderFunc(this.env, context, frame, globalRuntime, callback);

    return syncResult;
  }

  // @todo - return a value instead of calling a callback
  getExported(ctx, parentFrame, cb) {
    return this._getExportedSync(ctx, parentFrame, cb);
  }

  _getExportedSync(ctx, parentFrame, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
      parentFrame = null;
    } else if (typeof parentFrame === 'function') {
      cb = parentFrame;
      parentFrame = null;
    }

    // Catch compile errors for sync exported-value retrieval
    try {
      this.compile();
    } catch (e) {
      if (cb) {
        return cb(e);
      } else {
        throw e;
      }
    }

    const frame = parentFrame ? parentFrame.push(false) : new Frame();
    frame.topLevel = true;
    const context = this._createContext(ctx);
    // Sync mode is straightforward.
    this.rootRenderFunc(this.env, context, frame, globalRuntime, (err) => {
      if (err) {
        cb(err, null);
      } else {
        cb(null, this._bindExportedValues(context.getExported()));
      }
    });

    return undefined;
  }

  _createContext(ctx, renderCtx) {
    return new Context(ctx || {}, this.blocks, this.env, this.path, this.scriptMode, renderCtx);
  }

  _bindExportedValues(exported) {
    const macroContext = this._createContext({});
    return this._bindExportedValuesWithContext(exported, macroContext);
  }

  _copyBoundMacroMetadata(sourceMacro, boundMacro) {
    if (Object.prototype.hasOwnProperty.call(sourceMacro, '__callerUsedChannels')) {
      boundMacro.__callerUsedChannels = sourceMacro.__callerUsedChannels;
    }
    return boundMacro;
  }

  _bindExportedMacro(item, macroContext) {
    const boundMacro = function macro(...macroArgs) {
      return item._invoke(macroContext, macroArgs, null);
    };
    boundMacro.isMacro = true;
    boundMacro._invoke = function(_executionContext, macroArgs, currentBuffer) {
      // Imported/exported macros stay bound to the import-source context;
      // caller-provided executionContext must not override that binding.
      return item._invoke(macroContext, macroArgs, currentBuffer);
    };
    return this._copyBoundMacroMetadata(item, boundMacro);
  }

  _bindExportedValuesWithContext(exported, macroContext) {
    const boundExported = {};

    for (const name in exported) {
      const item = exported[name];
      if (typeof item === 'function' && item.isMacro) {
        boundExported[name] = this._bindExportedMacro(item, macroContext);
        continue;
      }
      boundExported[name] = item;
    }

    return boundExported;
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
      const source = this._compileSource();

      let func;
      try {
        func = new Function(source);
      } catch (e) {
        // @todo - CompileError
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

    this.blockContracts = props.blockContracts || {};
    this.blocks = this._getBlocks(props);
    this.methods = this._getMethods(props.methods);
    this.externSpec = props.externSpec || [];
    this.sharedSchema = props.sharedSchema || [];
    this.hasStaticExtends = !!props.hasStaticExtends;
    this.hasDynamicExtends = !!props.hasDynamicExtends;
    this.rootRenderFunc = props.root;
    this.compiled = true;
  }

  _compileSource() {
    return compiler.compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: false, asyncMode: false }, this.env.opts)
    );
  }

  _getBlocks(props) {
    var blocks = {};

    lib.keys(props).forEach((k) => {
      if (k.slice(0, 2) === 'b_') {
        const blockName = k.slice(2);
        blocks[blockName] = props[k];
        blocks[blockName].blockContract = this.blockContracts[blockName] || null;
        blocks[blockName].templatePath = this.path == null ? '__anonymous__' : String(this.path);
      }
    });

    return blocks;
  }

  _getMethods(methods) {
    const resolvedMethods = {};
    const methodEntries = methods && typeof methods === 'object' ? methods : {};
    const templatePath = this.path == null ? '__anonymous__' : String(this.path);

    lib.keys(methodEntries).forEach((name) => {
      const methodEntry = methodEntries[name];
      if (!methodEntry || typeof methodEntry.fn !== 'function') {
        return;
      }
      methodEntry.fn.blockContract = methodEntry.contract || null;
      methodEntry.fn.templatePath = templatePath;
      methodEntry.fn.ownerKey = methodEntry.ownerKey == null ? templatePath : String(methodEntry.ownerKey);
      methodEntry.fn.linkedChannels = Array.isArray(methodEntry.linkedChannels) ? methodEntry.linkedChannels.slice() : [];
      resolvedMethods[name] = {
        fn: methodEntry.fn,
        kind: methodEntry.kind || 'method',
        contract: methodEntry.contract || null,
        ownerKey: methodEntry.fn.ownerKey,
        linkedChannels: methodEntry.fn.linkedChannels
      };
    });

    return resolvedMethods;
  }
}

class AsyncTemplate extends Template {
  init(src, env, path, eagerCompile) {
    if (!env) {
      if (!AsyncEnvironment) {
        const envModule = require('./environment');
        AsyncEnvironment = envModule.AsyncEnvironment;
      }
      env = new AsyncEnvironment();
    }
    super.init(src, env, path, eagerCompile);
    this.asyncMode = true;
    this.scriptMode = false;
  }

  render(ctx, cb) {
    if (cb) {
      return super._renderAsync(ctx, cb);
    }
    // If no callback is provided, return a promise
    return new Promise((resolve, reject) => {
      super._renderAsync(ctx, (err, res) => {
        if (err) {
          err = this.env._prettifyError(this.path, this.env.opts.dev, err);
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  getExported(ctx, renderCtx, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
      renderCtx = null;
    } else if (typeof renderCtx === 'function') {
      cb = renderCtx;
      renderCtx = ctx;
    }

    this.compile();

    const context = this._createContext(ctx, renderCtx);
    const finalizeExported = (exported) => this._bindExportedValuesWithContext(exported, context);

    const readExported = () => {
      const exported = context.getExported();
      const resolvedExported = globalRuntime.resolveObjectProperties(exported);
      if (resolvedExported && typeof resolvedExported.then === 'function') {
        return resolvedExported.then(finalizeExported);
      }
      return finalizeExported(resolvedExported);
    };

    const rendered = this.rootRenderFunc(this.env, context, globalRuntime, cb, true);
    if (rendered && typeof rendered.getFinishedPromise === 'function') {
      return rendered.getFinishedPromise().then(readExported);
    }
    return readExported();
  }

  /**
   * Renders the template for composition, returning the output array synchronously.
   * While the output array may not be ready yet, it will be when the
   * composition buffer finishes.
   * It sets the compositionMode argument of rootRenderFunc to true
   */
  _renderForComposition(ctx, cb, renderCtx) {
    this.compile();
    const context = this._createContext(ctx, renderCtx);
    return this.rootRenderFunc(this.env, context, globalRuntime, cb, true);
  }

  _compileSource() {
    return compiler.compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: false, asyncMode: true }, this.env.opts)
    );
  }
}

module.exports = {
  Template,
  AsyncTemplate
};
