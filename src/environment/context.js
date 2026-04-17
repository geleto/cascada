'use strict';

const lib = require('../lib');
const { Obj } = require('../object');
const { createPoison } = require('../runtime/errors');
const { validateCallableContractCompatibility } = require('../callable-contract');

class Context extends Obj {
  init(ctx, blocks, env, path, scriptMode = false, renderCtx, externCtx = undefined) {
    // Has to be tied to an environment so we can tap into its globals.
    if (!env) {
      // Lazy load Environment to avoid circular dependency
      const { Environment } = require('./environment');
      this.env = new Environment();
    } else {
      this.env = env;
    }
    this.path = path || null;
    this.scriptMode = !!scriptMode;

    // Preserve the original render context separately from the working context
    // so async composition can expose it explicitly via `with context`
    // without leaking current local vars/channels.
    const initialRenderCtx = renderCtx === undefined ? ctx : (renderCtx || {});
    this.renderCtx = lib.extend({}, initialRenderCtx);
    this.ctx = lib.extend({}, ctx);
    this.externCtx = externCtx === undefined ? null : lib.extend({}, externCtx);

    this.blocks = {};
    this.exportResolveFunctions = Object.create(null);
    this.exportChannels = Object.create(null);
    this.extendsCompositionByParent = new WeakMap();
    this.inheritanceLocalCapturesByTemplate = Object.create(null);

    lib.keys(blocks).forEach(name => {
      this.addBlock(name, blocks[name]);
    });
  }

  //if the variable is not found, returns undefined
  lookup(name) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      return this.ctx[name];
    }
  }

  //if the variable is not found, returns a poison value
  lookupScript(name, errorContext = null) {
    // This is one of the most called functions, so optimize for
    // the typical case where the name isn't in the globals
    if (name in this.env.globals && !(name in this.ctx)) {
      return this.env.globals[name];
    } else {
      if (name in this.ctx) {
        return this.ctx[name];
      } else {
        return createPoison(
          new Error(`Can not look up unknown variable/function: ${name}`),
          errorContext?.lineno ?? 0,
          errorContext?.colno ?? 0,
          errorContext?.errorContextString ?? null,
          errorContext?.path ?? this.path ?? null
        );
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

  getExternContextVariables() {
    return this.externCtx || this.ctx;
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
    validateCallableContractCompatibility('block', name, overridingContract, parentContract);
  }

  getBlock(name) {
    if (!this.blocks[name]) {
      throw new Error('unknown block "' + name + '"');
    }

    return this.blocks[name][0];
  }

  beginInheritanceResolution() {
    if (!this.inheritanceResolutionPromise) {
      this.inheritanceResolutionPendingCount = 0;
      this.inheritanceResolutionPromise = new Promise((resolve) => {
        this.inheritanceResolutionResolver = resolve;
      }).then(() => {
        delete this.inheritanceResolutionPromise;
        delete this.inheritanceResolutionResolver;
        delete this.inheritanceResolutionPendingCount;
      });
    }
    this.inheritanceResolutionPendingCount = (this.inheritanceResolutionPendingCount || 0) + 1;
  }

  awaitInheritanceResolution() {
    return this.inheritanceResolutionPromise || null;
  }

  resolveAfterInheritanceResolution(value) {
    const registrationWait = this.awaitInheritanceResolution();
    if (!registrationWait) {
      return value;
    }
    return registrationWait.then(() => value);
  }

  async getAsyncBlock(name) {
    const registrationWait = this.awaitInheritanceResolution();
    if (registrationWait && typeof registrationWait.then === 'function') {
      await registrationWait;
    }
    return this.getBlock(name);
  }

  finishInheritanceResolution() {
    if (!this.inheritanceResolutionResolver) {
      return;
    }
    if (this.inheritanceResolutionPendingCount > 0) {
      this.inheritanceResolutionPendingCount -= 1;
    }
    if (this.inheritanceResolutionPendingCount === 0) {
      this.inheritanceResolutionResolver();
    }
  }

  getAsyncSuper(env, name, block, runtime, cb, parentBuffer = null, inheritanceState = null, blockPayload = null, blockRenderCtx = undefined) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    return blk(env, context, runtime, cb, parentBuffer, inheritanceState, context.prepareInheritancePayloadForBlock(blk, blockPayload), blockRenderCtx);
  }

  getSyncSuper(env, name, block, frame, runtime, cb) {
    var idx = lib.indexOf(this.blocks[name] || [], block);
    var blk = this.blocks[name][idx + 1];
    var context = this;

    if (idx === -1 || !blk) {
      throw new Error('no super block available for "' + name + '"');
    }

    blk(env, context, frame, runtime, cb);
  }

  addResolvedExport(name, value) {
    if (this.exportResolveFunctions[name] !== undefined) {
      return;
    }
    this.ctx[name] = value;
    this.exportResolveFunctions[name] = null;
  }

  addDeferredExport(name, channelName, buffer) {
    if (this.exportResolveFunctions[name] !== undefined) {
      return;
    }

    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    this.exportResolveFunctions[name] = resolve;
    this.exportChannels[name] = { channelName, buffer };
    this.ctx[name] = promise;
  }

  resolveExports() {
    const names = Object.keys(this.exportResolveFunctions);
    for (const name of names) {
      const resolve = this.exportResolveFunctions[name];
      if (!resolve) {
        continue;
      }
      const exportChannel = this.exportChannels[name];
      if (!exportChannel || !exportChannel.buffer || !exportChannel.channelName) {
        throw new Error(`Deferred export "${name}" is missing an explicit producer record${this.path ? ` in ${this.path}` : ''}`);
      }
      const channel = exportChannel.buffer.getOwnChannel(exportChannel.channelName);
      if (!channel) {
        throw new Error(`Deferred export "${name}" could not resolve producer channel "${exportChannel.channelName}"${this.path ? ` in ${this.path}` : ''}`);
      }
      resolve(channel.finalSnapshot());
      this.exportResolveFunctions[name] = null;
    }
  }

  getExported() {
    var exported = {};
    const exportNames = Object.keys(this.exportResolveFunctions);
    exportNames.forEach((name) => {
      exported[name] = this.ctx[name];
    });
    return exported;
  }

  _getInheritanceTemplateKey(templateName) {
    return templateName == null ? '__anonymous__' : String(templateName);
  }

  setExtendsComposition(templateObject, rootContext, externContext) {
    if (!templateObject || typeof templateObject !== 'object') {
      throw new Error('Extends composition requires a resolved parent template/script object');
    }
    this.extendsCompositionByParent.set(templateObject, {
      // forkForComposition() copies these again into the new child Context, so
      // keep only a single stored snapshot here.
      rootContext: rootContext || {},
      externContext: externContext || {}
    });
  }

  getExtendsComposition(templateObject) {
    if (!templateObject || typeof templateObject !== 'object') {
      throw new Error('Extends composition lookup requires a resolved parent template/script object');
    }
    return this.extendsCompositionByParent.get(templateObject) || null;
  }

  setTemplateLocalCaptures(templateName, captures) {
    const key = this._getInheritanceTemplateKey(templateName);
    this.inheritanceLocalCapturesByTemplate[key] = lib.extend({}, captures || {});
  }

  getTemplateLocalCaptures(templateName) {
    const key = this._getInheritanceTemplateKey(templateName);
    return this.inheritanceLocalCapturesByTemplate[key] || null;
  }

  _cloneInheritanceLocalsByTemplate(localsByTemplate) {
    const cloned = Object.create(null);
    if (!localsByTemplate || typeof localsByTemplate !== 'object') {
      return cloned;
    }
    const templateNames = Object.keys(localsByTemplate);
    for (let i = 0; i < templateNames.length; i++) {
      const templateName = templateNames[i];
      cloned[templateName] = lib.extend({}, localsByTemplate[templateName] || {});
    }
    return cloned;
  }

  createInheritancePayload(templateName, args, localCaptures) {
    const argValues = lib.extend({}, args || {});
    const templateKey = this._getInheritanceTemplateKey(templateName);
    const payload = {
      originalArgs: argValues,
      localsByTemplate: Object.create(null)
    };
    if (localCaptures && typeof localCaptures === 'object') {
      const localValues = lib.extend({}, localCaptures);
      if (Object.keys(localValues).length > 0) {
        payload.localsByTemplate[templateKey] = localValues;
      }
    }
    return payload;
  }

  createSuperInheritancePayload(currentPayload, nextArgs = null) {
    const payload = currentPayload && typeof currentPayload === 'object' ? currentPayload : null;
    if (!payload && !nextArgs) {
      return null;
    }
    const sourceArgs = lib.extend({}, (payload && payload.originalArgs) || {});
    if (nextArgs && typeof nextArgs === 'object') {
      lib.extend(sourceArgs, nextArgs);
    }
    return {
      originalArgs: sourceArgs,
      localsByTemplate: this._cloneInheritanceLocalsByTemplate(payload && payload.localsByTemplate)
    };
  }

  prepareInheritancePayloadForBlock(block, payload) {
    const templatePath = this._getInheritanceTemplateKey(
      block && Object.prototype.hasOwnProperty.call(block, 'templatePath') ? block.templatePath : this.path
    );
    const storedLocals = this.getTemplateLocalCaptures(templatePath);
    const hasPayload = !!(payload && typeof payload === 'object');
    if (!hasPayload && !storedLocals) {
      return null;
    }
    if (hasPayload && !storedLocals) {
      return payload;
    }
    const basePayload = hasPayload
      ? {
        originalArgs: lib.extend({}, payload.originalArgs || {}),
        localsByTemplate: this._cloneInheritanceLocalsByTemplate(payload.localsByTemplate)
      }
      : {
        originalArgs: {},
        localsByTemplate: Object.create(null)
      };
    if (storedLocals) {
      basePayload.localsByTemplate[templatePath] = lib.extend(
        lib.extend({}, storedLocals),
        basePayload.localsByTemplate[templatePath] || {}
      );
    }
    return basePayload;
  }

  // Shared structural state that still lives on Context after Step 6. The
  // explicit inheritance-state object now threads separately through root and
  // block/method entrypoints instead of being copied here.
  _copySharedStructuralState(newContext) {
    newContext.blocks = this.blocks;
    newContext.exportResolveFunctions = this.exportResolveFunctions;
    newContext.exportChannels = this.exportChannels;
    newContext.extendsCompositionByParent = this.extendsCompositionByParent;
    newContext.inheritanceLocalCapturesByTemplate = this.inheritanceLocalCapturesByTemplate;
    newContext.inheritanceResolutionPromise = this.inheritanceResolutionPromise;
    newContext.inheritanceResolutionResolver = this.inheritanceResolutionResolver;
    newContext.inheritanceResolutionPendingCount = this.inheritanceResolutionPendingCount;
    return newContext;
  }

  forkForPath(newPath) {
    // Create a new, empty context object.
    // It will inherit the correct `env` from `this`.
    const newContext = new Context({}, {}, this.env, null, this.scriptMode, this.renderCtx, this.externCtx);

    // Share critical state objects by REFERENCE. Do NOT copy them.
    newContext.ctx = this.ctx;           // Share the variable store.
    newContext.renderCtx = this.renderCtx;
    this._copySharedStructuralState(newContext);

    // Set the ONLY property that should be different.
    newContext.path = newPath;

    return newContext;
  }

  forkForComposition(newPath, ctx, renderCtx, externCtx = undefined) {
    // Fresh composition context that keeps shared structural state such as
    // blocks/exports, but does not share the mutable variable object with the
    // caller. This lets composition boundaries receive explicit inputs without
    // turning them back into ambient shared scope.
    const newContext = new Context(ctx || {}, {}, this.env, null, this.scriptMode, renderCtx, externCtx);

    this._copySharedStructuralState(newContext);
    newContext.path = newPath;

    return newContext;
  }
}

module.exports = {
  Context
};
