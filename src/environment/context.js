
import {extend, keys, indexOf} from '../lib.js';
import {CompileError} from '../errors.js';
import {Obj} from '../object.js';
import {createPoison, isPoison, markPromiseHandled, PoisonError, poisonIfNaN, RuntimePromise} from '../runtime/errors.js';

class ContextExecutionState {
  constructor() {
    this.blocks = {};
    this.exportedNames = new Set();
  }
}

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false, renderCtx, compositionPayloadVars = undefined, executionState = null) {
    // Has to be tied to an environment so we can tap into its globals.
    if (!env) {
      this.env = { globals: {} };
    } else {
      this.env = env;
    }
    this.path = path || null;
    this.scriptMode = !!scriptMode;

    // Preserve the original render context separately from the working context
    // so async composition can expose it explicitly via `with context`
    // without leaking current local vars/chains.
    const initialRenderCtx = renderCtx === undefined ? ctx : (renderCtx || {});
    this.renderCtx = extend({}, initialRenderCtx);
    this.ctx = extend({}, ctx);
    this.compositionContextVars = extend({}, ctx);
    // undefined means no composition payload was supplied; null means an
    // explicit empty payload baseline that should still use payload semantics.
    this.compositionPayloadVars = compositionPayloadVars === undefined ? null : extend({}, compositionPayloadVars);
    this.executionState = executionState || new ContextExecutionState();

    keys(blocks).forEach(name => {
      this.addBlock(name, blocks[name]);
    });
  }

  get blocks() {
    return this.executionState.blocks;
  }

  get exportedNames() {
    return this.executionState.exportedNames;
  }

  //if the variable is not found, returns undefined
  lookup(name, errorContext = null) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    let value;
    if (name in this.env.globals && !(name in this.ctx)) {
      value = this.env.globals[name];
    } else {
      value = this.ctx[name];
    }
    return normalizeContextValue(value, errorContext);
  }

  //if the variable is not found, returns a poison value
  lookupScript(name, errorContext) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return normalizeContextValue(this.env.globals[name], errorContext);
    } else {
      if (name in this.ctx) {
        return normalizeContextValue(this.ctx[name], errorContext);
      } else {
        return createPoison(PoisonError.create(
          `Can not look up unknown variable/function: ${name}`,
          errorContext,
          'UnknownVariable'
        ));
      }
    }
  }

  setVariable(name, val) {
    this.ctx[name] = val;
  }

  getVariables() {
    return this.ctx;
  }

  getRenderContextVariables() {
    return this.renderCtx;
  }

  getCompositionContextVariables() {
    return this.compositionContextVars;
  }

  getCompositionPayloadVariables() {
    return this.compositionPayloadVars;
  }

  addBlock(name, block) {
    this.blocks[name] = this.blocks[name] || [];
    if (this.blocks[name].length > 0) {
      this._validateBlockContractCompatibility(name, this.blocks[name][this.blocks[name].length - 1], block);
    }
    this.blocks[name].push(block);
    return this;
  }

  _validateBlockContractCompatibility(name, overridingBlock, parentBlock) {
    const overridingContract = overridingBlock && overridingBlock.blockContract;
    const parentContract = parentBlock && parentBlock.blockContract;
    if (!overridingContract || !parentContract) {
      return;
    }

    const overridingNames = overridingContract.argNames || [];
    const parentNames = parentContract.argNames || [];
    const sameLength = overridingNames.length === parentNames.length;
    const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
    if (sameNames) {
      return;
    }

    const formatContract = (contract) => {
      const args = (contract.argNames || []).join(', ');
      return `${name}(${args})`;
    };

    throw new CompileError(
      `block "${name}" signature mismatch: overriding block declares ${formatContract(overridingContract)} but parent declares ${formatContract(parentContract)}`
    );
  }

  getBlock(name) {
    if (!this.blocks[name]) {
      throw new Error('unknown block "' + name + '"');
    }

    return this.blocks[name][0];
  }

  getSyncSuper(env, name, block, frame, runtime, cb) {
    var idx = indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    blk(env, context, frame, runtime, cb);
  }

  addResolvedExport(name, value) {
    if (this.exportedNames.has(name)) {
      return;
    }
    this.ctx[name] = value;
    this.exportedNames.add(name);
  }

  addDeferredExport(name, chainName, buffer) {
    if (this.exportedNames.has(name)) {
      return;
    }

    const chain = buffer.getOwnChain(chainName);
    if (!chain) {
      throw new Error(`Deferred export "${name}" could not resolve producer chain "${chainName}"${this.path ? ` in ${this.path}` : ''}`);
    }
    const promise = chain.finalSnapshot();
    // Deferred exports are often internal-only script locals. If such a local
    // resolves to poison and no consumer reads the export promise directly, the
    // chain still owns the error; the export promise should not become a
    // process-level unhandled rejection.
    markPromiseHandled(promise);
    this.exportedNames.add(name);
    this.ctx[name] = promise;
  }

  getExported() {
    var exported = {};
    this.exportedNames.forEach((name) => {
      exported[name] = this.ctx[name];
    });
    return exported;
  }

  forkForPath(newPath) {
    const newContext = new Context({}, {}, this.env, null, this.scriptMode, this.renderCtx, this.compositionPayloadVars, this.executionState);
    newContext.ctx = this.ctx;
    newContext.renderCtx = this.renderCtx;
    newContext.compositionContextVars = this.compositionContextVars;
    newContext.compositionPayloadVars = this.compositionPayloadVars;
    newContext.path = newPath;

    return newContext;
  }

  forkForComposition(newPath, ctx, renderCtx, compositionPayloadVars = undefined) {
    // Fresh composition context that keeps shared structural state such as
    // blocks/exports, but does not share the mutable variable object with the
    // caller. This lets composition boundaries receive explicit inputs without
    // turning them back into ambient shared scope.
    const payloadVars = compositionPayloadVars === undefined ? (ctx || {}) : (compositionPayloadVars || {});
    const newContext = new Context(ctx || {}, {}, this.env, null, this.scriptMode, renderCtx, payloadVars, this.executionState);
    newContext.path = newPath;

    return newContext;
  }

  forkForCompositionPayload(newPath, compositionPayload, renderCtx) {
    return this.forkForComposition(
      newPath,
      compositionPayload.rootContext,
      renderCtx,
      compositionPayload.payloadContext
    );
  }
}

function normalizeContextValue(value, errorContext) {
  if (!errorContext) {
    return value;
  }
  value = poisonIfNaN(value, errorContext);
  if (value && typeof value.then === 'function' && !isPoison(value)) {
    return new RuntimePromise(value, errorContext, 'ValueRejected');
  }
  return value;
}

export { Context };
