'use strict';

const lib = require('../lib');
const compiler = require('../compiler/compiler');
const globalRuntime = require('../runtime/runtime');
const { Frame, AsyncFrame } = require('../runtime/frame');
const { AsyncState } = globalRuntime;
const { Obj } = require('../object');
const { callbackAsap } = require('./utils');
const { Context } = require('./context');

// Lazy-loaded environment classes to avoid circular dependencies
let Environment, AsyncEnvironment;

class Template extends Obj {
  init(src, env, path, eagerCompile, asyncMode = false, scriptMode = false) {
    if (!env) {
      if (!Environment) {
        const envModule = require('./environment');
        Environment = envModule.Environment;
      }
      this.env = new Environment();
    } else {
      this.env = env;
    }
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

  render(ctx, parentFrame, astate, cb) {
    return this._render(ctx, parentFrame, astate, cb);
  }

  // @todo - return promise if isAsync and no callback is provided
  _render(ctx, parentFrame, astate, cb, receivePartialOutput = false) {
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

    const context = new Context(ctx || {}, this.blocks, this.env, this.path);
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

    if (!AsyncEnvironment) {
      const envModule = require('./environment');
      AsyncEnvironment = envModule.AsyncEnvironment;
    }
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

  // @todo - return a value instead of calling a callback
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

    const frame = parentFrame
      ? parentFrame.push()
      : (this.asyncMode ? new AsyncFrame() : new Frame());
    frame.topLevel = true;

    const context = new Context(ctx || {}, this.blocks, this.env, this.path);
    astate = astate || (this.asyncMode ? new AsyncState() : null);

    if (this.asyncMode) {
      // Run template in composition mode
      this.rootRenderFunc(this.env, context, frame, globalRuntime, astate, cb, true);

      // Immediately export the variables (they may be promises)
      const exported = context.getExported();
      const boundExported = {};
      const macroContext = new Context({}, this.blocks, this.env, this.path);

      for (const name in exported) {
        const item = exported[name];
        if (typeof item === 'function' && item.isMacro) {
          boundExported[name] = item.bind(macroContext);
        } else {
          boundExported[name] = item;
        }
      }

      // Return immediately - async work tracked by astate, errors via cb
      return boundExported;
    } else {
      // Sync mode is straightforward.
      this.rootRenderFunc(this.env, context, frame, globalRuntime, (err) => {
        if (err) {
          cb(err, null);
        } else {
          const exported = context.getExported();
          const boundExported = {};
          const macroContext = new Context({}, this.blocks, this.env, this.path);

          for (const name in exported) {
            const item = exported[name];
            if (typeof item === 'function' && item.isMacro) {
              boundExported[name] = item.bind(macroContext);
            } else {
              boundExported[name] = item;
            }
          }
          cb(null, boundExported);
        }
      });
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
      Object.assign({scriptMode: this.scriptMode, asyncMode: this.asyncMode}, this.env.opts)
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
          err = this.env._prettifyError(this.path, this.env.opts.dev, err);
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  /**
   * Renders the template for composition, returning the output array synchronously.
   * While the output array may not be ready yet, it will be when the astate lifecycle is completed
   * It sets the compositionMode argument of rootRenderFunc to true
   */
  _renderForComposition(ctx, parentFrame, astate, cb) {
    this.compile();

    const context = new Context(ctx || {}, this.blocks, this.env, this.path);
    const frame = parentFrame ? parentFrame.push(true) : new AsyncFrame();
    frame.topLevel = true;

    // Call the root function in composition mode. It will synchronously return
    // the output array, while any async operations it starts will use the
    // provided `astate` to link into the parent's lifecycle.
    return this.rootRenderFunc(this.env, context, frame, globalRuntime, astate, cb, true);
  }
}

module.exports = {
  Template,
  AsyncTemplate
};
