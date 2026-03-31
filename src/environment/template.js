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

  render(ctx, parentSyncFrame, cb) {
    return this._renderSync(ctx, parentSyncFrame, cb);
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

    const context = this._createAsyncContext(ctx);
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

  _renderSync(ctx, parentSyncFrame, cb) {
    const normalized = this._normalizeSyncRenderArgs(ctx, parentSyncFrame, cb);
    ctx = normalized.ctx;
    parentSyncFrame = normalized.parentSyncFrame;
    cb = normalized.cb;

    const forceAsync = !parentSyncFrame;

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

    const context = new Context(ctx || {}, this.blocks, this.env, this.path, false);
    const frame = this._createTopLevelFrame(parentSyncFrame, true);

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
  getExported(ctx, parentSyncFrame, cb) {
    return this._getExportedSync(ctx, parentSyncFrame, cb);
  }

  _getExportedSync(ctx, parentSyncFrame, cb) {
    const normalized = this._normalizeSyncRenderArgs(ctx, parentSyncFrame, cb);
    ctx = normalized.ctx;
    parentSyncFrame = normalized.parentSyncFrame;
    cb = normalized.cb;

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

    const frame = this._createTopLevelFrame(parentSyncFrame, false);

    const context = new Context(ctx || {}, this.blocks, this.env, this.path, false);
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

  _normalizeSyncRenderArgs(ctx, parentSyncFrame, cb) {
    if (typeof ctx === 'function') {
      return {
        ctx: {},
        parentSyncFrame: null,
        cb: ctx
      };
    }
    if (typeof parentSyncFrame === 'function') {
      return {
        ctx,
        parentSyncFrame: null,
        cb: parentSyncFrame
      };
    }
    return { ctx, parentSyncFrame, cb };
  }

  _createTopLevelFrame(parentSyncFrame, isolateWrites) {
    const frame = parentSyncFrame ? parentSyncFrame.push(isolateWrites) : new Frame();
    frame.topLevel = true;
    return frame;
  }

  _createAsyncContext(ctx) {
    return new Context(ctx || {}, this.blocks, this.env, this.path, false);
  }

  _createAsyncMacroContext() {
    return new Context({}, this.blocks, this.env, this.path, false);
  }

  _bindExportedValues(exported) {
    const boundExported = {};
    const macroContext = new Context({}, this.blocks, this.env, this.path, false);

    for (const name in exported) {
      const item = exported[name];
      boundExported[name] = (typeof item === 'function' && item.isMacro)
        ? item.bind(macroContext)
        : item;
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

    this.blocks = this._getBlocks(props);
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
        blocks[k.slice(2)] = props[k];
      }
    });

    return blocks;
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

  getExported(ctx, cb) {
    if (typeof ctx === 'function') {
      cb = ctx;
      ctx = {};
    }

    this.compile();

    const context = this._createAsyncContext(ctx);
    this.rootRenderFunc(this.env, context, globalRuntime, cb, true);

    const exported = context.getExported();
    const boundExported = {};
    const macroContext = this._createAsyncMacroContext();

    for (const name in exported) {
      const item = exported[name];
      if (typeof item === 'function' && item.isMacro) {
        boundExported[name] = item.bind(macroContext);
      } else {
        boundExported[name] = item;
      }
    }

    return boundExported;
  }

  /**
   * Renders the template for composition, returning the output array synchronously.
   * While the output array may not be ready yet, it will be when the
   * composition buffer finishes.
   * It sets the compositionMode argument of rootRenderFunc to true
   */
  _renderForComposition(ctx, cb) {
    this.compile();
    const context = this._createAsyncContext(ctx);
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
