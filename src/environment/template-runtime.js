import {isObject, isString, _prettifyError, keys} from '../lib.js';
import * as globalRuntime from '../runtime/runtime.js';
import {Frame} from '../runtime/frame.js';
import {Obj} from '../object.js';
import {callbackAsap} from './utils.js';
import {Context} from './context.js';
import {markPromiseHandled} from '../runtime/errors.js';
import {createDefaultEnvironment} from './default-environment.js';

class TemplateRuntime extends Obj {
  init(src, env, path, eagerCompile) {
    if (!env) {
      this.env = createDefaultEnvironment(false);
    } else {
      this.env = env;
    }
    this.asyncMode = false;
    this.scriptMode = false;

    if (isObject(src)) {
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
    } else if (isString(src)) {
      this.tmplStr = src;
    } else {
      throw new Error('src must be a string or an object describing the source');
    }

    this.path = path;

    if (eagerCompile) {
      try {
        this._compile();
      } catch (err) {
        throw _prettifyError(this.path, this.env.opts.dev, err);
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
      const err = _prettifyError(this.path, this.env.opts.dev, e);
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
        err = _prettifyError(this.path, this.env.opts.dev, err);
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

    try {
      this.compile();
    } catch (e) {
      const err = _prettifyError(this.path, this.env.opts.dev, e);
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
      if (didError && cb && typeof res !== 'undefined') {
        return;
      }

      if (err) {
        err = _prettifyError(this.path, this.env.opts.dev, err);
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
    this.rootRenderFunc(this.env, context, frame, globalRuntime, (err) => {
      if (err) {
        cb(err, null);
      } else {
        cb(null, this._bindExportedValues(context.getExported()));
      }
    });

    return undefined;
  }

  _createContext(ctx, renderCtx, compositionPayloadVars) {
    return new Context(ctx || {}, this.blocks, this.env, this.path, this.scriptMode, renderCtx, compositionPayloadVars);
  }

  _bindExportedValues(exported) {
    const boundExported = {};
    const macroContext = this._createContext({});

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
      const source = this.compileSource();

      let func;
      try {
        func = new Function('runtime', source);
      } catch (e) {
        throw new Error('Error trying to compile ' + this.path + ' ' + e.message);
      }
      props = func(globalRuntime);
    }

    const blockContracts = props.blockContracts;
    this.blocks = this._getCompiledBlocks(props, blockContracts);
    this.inheritanceSpec = props.inheritanceSpec;
    this.rootRenderFunc = props.root;
    this.compiled = true;
  }

  compileSource() {
    throw new Error('Template source compilation is not available in this environment');
  }

  _compileSource() {
    return this.compileSource();
  }

  _getBlocks(props, blockContracts) {
    var blocks = {};

    keys(props).forEach((k) => {
      if (k.slice(0, 2) === 'b_') {
        const blockName = k.slice(2);
        blocks[blockName] = props[k];
        blocks[blockName].blockContract = (blockContracts && blockContracts[blockName]) || null;
        blocks[blockName].templatePath = this.path == null ? '__anonymous__' : String(this.path);
      }
    });

    return blocks;
  }

  _getCompiledBlocks(props, blockContracts) {
    return this._getBlocks(props, blockContracts);
  }
}

class AsyncTemplateRuntime extends TemplateRuntime {
  init(src, env, path, eagerCompile) {
    if (!env) {
      env = createDefaultEnvironment(true);
    }
    super.init(src, env, path, eagerCompile);
    this.asyncMode = true;
    this.scriptMode = false;
  }

  render(ctx, cb) {
    if (cb) {
      return super._renderAsync(ctx, cb);
    }
    return new Promise((resolve, reject) => {
      super._renderAsync(ctx, (err, res) => {
        if (err) {
          err = _prettifyError(this.path, this.env.opts.dev, err);
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

    const context = this._createContext(ctx, renderCtx, ctx || null);
    let rootError = null;
    const renderCallback = (err) => {
      if (err) {
        rootError = err;
        context.rejectExports(err);
        if (typeof cb === 'function') {
          cb(err);
        }
      }
    };
    const output = this.rootRenderFunc(
      this.env,
      context,
      globalRuntime,
      renderCallback,
      true
    );
    const outputFinished = output && typeof output.getFinishedPromise === 'function'
      ? output.getFinishedPromise()
      : null;
    if (outputFinished) {
      outputFinished.catch((err) => {
        context.rejectExports(err);
      });
    }

    if (rootError) {
      throw rootError;
    }

    const exported = context.getExported();
    const boundExported = {};
    const finalizeExportedValue = (item) => {
      return outputFinished
        ? globalRuntime.resolveAll([item, outputFinished]).then((values) => {
          if (globalRuntime.isPoison(values)) {
            throw new globalRuntime.PoisonError(values.errors);
          }
          return values[0];
        })
        : item;
    };

    for (const name in exported) {
      boundExported[name] = finalizeExportedValue(exported[name]);
    }

    const markedExported = globalRuntime.createObject(boundExported);
    if (markedExported && markedExported[globalRuntime.RESOLVE_MARKER]) {
      markPromiseHandled(markedExported[globalRuntime.RESOLVE_MARKER]);
    }
    return markedExported;
  }

  renderForComposition(ctx, cb, renderCtx) {
    this.compile();
    const context = this._createContext(ctx, renderCtx, ctx || null);
    return this.rootRenderFunc(this.env, context, globalRuntime, cb, true);
  }

  _renderForComposition(ctx, cb, renderCtx) {
    return this.renderForComposition(ctx, cb, renderCtx);
  }

  _getCompiledBlocks() {
    return {};
  }
}

export {TemplateRuntime, AsyncTemplateRuntime};
