'use strict';

// Inheritance runtime state model.
// Owns the data structures for method registration, shared-schema metadata, and
// inheritance-resolution timing used by extends and inheritance dispatch.

const lib = require('../lib');
const { validateCallableContractCompatibility } = require('../callable-contract');
const { RuntimeFatalError } = require('./errors');

class InheritanceResolutionState {
  constructor() {
    this.promise = null;
    this.resolver = null;
    this.pendingCount = 0;
  }

  begin() {
    if (!this.promise) {
      this.pendingCount = 0;
      this.promise = new Promise((resolve) => {
        this.resolver = resolve;
      }).then(() => {
        this.promise = null;
        this.resolver = null;
        this.pendingCount = 0;
      });
    }
    this.pendingCount += 1;
  }

  await() {
    return this.promise || null;
  }

  finish() {
    if (!this.resolver) {
      return;
    }
    if (this.pendingCount > 0) {
      this.pendingCount -= 1;
    }
    if (this.pendingCount === 0) {
      this.resolver();
    }
  }

  resolveWhenCurrent(readImmediate, getNotFoundMessage) {
    const immediate = readImmediate();
    if (immediate) {
      return immediate;
    }
    const registrationWait = this.await();
    if (registrationWait && typeof registrationWait.then === 'function') {
      return registrationWait.then(() => {
        const resolved = readImmediate();
        if (resolved) {
          return resolved;
        }
        throw new RuntimeFatalError(getNotFoundMessage());
      });
    }
    throw new RuntimeFatalError(getNotFoundMessage());
  }
}

class InheritanceMethodRegistry {
  constructor(resolution) {
    this.resolution = resolution;
    this.chains = Object.create(null);
  }

  registerCompiled(methods) {
    const entries = methods && typeof methods === 'object' ? Object.keys(methods) : [];
    entries.forEach((name) => {
      const methodEntry = methods[name];
      if (!methodEntry || typeof methodEntry.fn !== 'function') {
        return;
      }
      const ownerKey = methodEntry.ownerKey == null ? '__anonymous__' : String(methodEntry.ownerKey);
      const chain = this.chains[name] || (this.chains[name] = []);
      const existing = chain.find((entry) => entry.ownerKey === ownerKey);
      if (existing) {
        return;
      }
      if (chain.length > 0) {
        // Constructors use the same compatibility rules as methods today:
        // they are internal callables with method-style override semantics,
        // while blocks remain the only separate callable contract kind here.
        const callableKind = methodEntry.kind === 'block' ? 'block' : 'method';
        validateCallableContractCompatibility(callableKind, name, chain[0].contract || null, methodEntry.contract || null);
      }
      chain.push({
        fn: methodEntry.fn,
        kind: methodEntry.kind || 'method',
        contract: methodEntry.contract || null,
        ownerKey,
        linkedChannels: Array.isArray(methodEntry.linkedChannels) ? methodEntry.linkedChannels.slice() : []
      });
    });
    return this;
  }

  getChain(name) {
    return this.chains[name] || [];
  }

  _findRegisteredEntry(name, ownerKey = null) {
    const chain = this.getChain(name);
    if (ownerKey === null) {
      return chain.length > 0 ? chain[0] : null;
    }
    const ownerKeyString = String(ownerKey);
    const ownerIndex = chain.findIndex((entry) => entry.ownerKey === ownerKeyString);
    if (ownerIndex === -1) {
      return null;
    }
    return chain[ownerIndex + 1] || null;
  }

  getImmediateInherited(name) {
    return this._findRegisteredEntry(name, null);
  }

  getImmediateSuper(name, ownerKey) {
    return this._findRegisteredEntry(name, ownerKey);
  }

  resolveInherited(name) {
    return this.resolution.resolveWhenCurrent(
      () => this.getImmediateInherited(name),
      () => `Inherited method '${name}' was not found in the loaded extends chain`
    );
  }

  resolveSuper(name, ownerKey) {
    return this.resolution.resolveWhenCurrent(
      () => this.getImmediateSuper(name, ownerKey),
      () => `No super method is available for '${name}' after owner '${ownerKey}'`
    );
  }
}

class InheritanceSharedRegistry {
  constructor(resolution) {
    this.resolution = resolution;
    this.names = new Set();
    this.types = new Map();
  }

  registerSchema(sharedSchema) {
    const normalized = Array.isArray(sharedSchema)
      ? sharedSchema.map((entry) => ({ name: entry.name, type: entry.type }))
      : [];
    normalized.forEach((entry) => {
      if (entry && entry.name) {
        this.names.add(entry.name);
        if (entry.type) {
          this.types.set(entry.name, entry.type);
        }
      }
    });
    return normalized;
  }

  getNames() {
    return Array.from(this.names);
  }

  getImmediateType(name) {
    return this.types.has(name)
      ? this.types.get(name)
      : null;
  }

  resolveType(name) {
    return this.resolution.resolveWhenCurrent(
      () => this.getImmediateType(name),
      () => `Shared channel '${name}' was not found in the loaded extends chain`
    );
  }
}

class InheritanceState {
  constructor() {
    this.resolution = new InheritanceResolutionState();
    this.methods = new InheritanceMethodRegistry(this.resolution);
    this.shared = new InheritanceSharedRegistry(this.resolution);
    this.extendsCompositionByParent = new WeakMap();
    this.localsByTemplate = Object.create(null);
  }
}

function getInheritanceTemplateKey(templateName) {
  return templateName == null ? '__anonymous__' : String(templateName);
}

function cloneInheritanceLocalsByTemplate(localsByTemplate) {
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

function createExtendsCompositionPayload(explicitInputValues, explicitInputNames, rootContext, externContext) {
  const normalizedExplicitInputValues = lib.extend({}, explicitInputValues || {});
  return {
    explicitInputValues: normalizedExplicitInputValues,
    explicitInputNames: Array.isArray(explicitInputNames)
      ? explicitInputNames.slice()
      : Object.keys(normalizedExplicitInputValues),
    rootContext: rootContext || {},
    externContext: externContext || {}
  };
}

function setExtendsComposition(inheritanceState, templateObject, compositionPayload) {
  if (!inheritanceState) {
    throw new Error('Extends composition storage requires an active InheritanceState');
  }
  if (!templateObject || typeof templateObject !== 'object') {
    throw new Error('Extends composition requires a resolved parent template/script object');
  }
  inheritanceState.extendsCompositionByParent.set(
    templateObject,
    createExtendsCompositionPayload(
      compositionPayload && compositionPayload.explicitInputValues,
      compositionPayload && compositionPayload.explicitInputNames,
      compositionPayload && compositionPayload.rootContext,
      compositionPayload && compositionPayload.externContext
    )
  );
}

function getExtendsComposition(inheritanceState, templateObject) {
  if (!inheritanceState) {
    throw new Error('Extends composition lookup requires an active InheritanceState');
  }
  if (!templateObject || typeof templateObject !== 'object') {
    throw new Error('Extends composition lookup requires a resolved parent template/script object');
  }
  return inheritanceState.extendsCompositionByParent.get(templateObject) || null;
}

function setTemplateLocalCaptures(inheritanceState, templateName, captures) {
  if (!inheritanceState) {
    throw new Error('Template-local capture storage requires an active InheritanceState');
  }
  const key = getInheritanceTemplateKey(templateName);
  inheritanceState.localsByTemplate[key] = lib.extend({}, captures || {});
}

function getTemplateLocalCaptures(inheritanceState, templateName) {
  if (!inheritanceState) {
    return null;
  }
  const key = getInheritanceTemplateKey(templateName);
  return inheritanceState.localsByTemplate[key] || null;
}

function createInheritancePayload(templateName, args, localCaptures) {
  const argValues = lib.extend({}, args || {});
  const templateKey = getInheritanceTemplateKey(templateName);
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

function createSuperInheritancePayload(currentPayload, nextArgs = null) {
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
    localsByTemplate: cloneInheritanceLocalsByTemplate(payload && payload.localsByTemplate)
  };
}

function prepareInheritancePayloadForBlock(inheritanceState, block, currentPath, payload) {
  const templatePath = getInheritanceTemplateKey(
    block && Object.prototype.hasOwnProperty.call(block, 'templatePath') ? block.templatePath : currentPath
  );
  const storedLocals = getTemplateLocalCaptures(inheritanceState, templatePath);
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
      localsByTemplate: cloneInheritanceLocalsByTemplate(payload.localsByTemplate)
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

function prepareBlockEntryContext(
  context,
  templateName,
  blockPayload,
  blockRenderCtx,
  useCompositionContext = false,
  includeRenderContext = false
) {
  const templateKey = getInheritanceTemplateKey(templateName);
  const originalArgs = blockPayload && blockPayload.originalArgs
    ? blockPayload.originalArgs
    : {};
  const localCaptures = blockPayload && blockPayload.localsByTemplate && blockPayload.localsByTemplate[templateKey]
    ? blockPayload.localsByTemplate[templateKey]
    : {};

  if (!useCompositionContext) {
    return {
      context: context.forkForPath(templateKey),
      originalArgs,
      localCaptures
    };
  }

  const compositionContext = Object.assign(
    {},
    includeRenderContext ? (blockRenderCtx || {}) : {},
    localCaptures,
    originalArgs
  );
  const nextContext =
    blockPayload !== null ||
    blockRenderCtx !== undefined ||
    Object.keys(compositionContext).length > 0
      ? context.forkForComposition(templateKey, compositionContext, blockRenderCtx)
      : context.forkForPath(templateKey);

  return {
    context: nextContext,
    originalArgs,
    localCaptures
  };
}

function beginInheritanceResolution(inheritanceState) {
  if (inheritanceState) {
    inheritanceState.resolution.begin();
  }
}

function awaitInheritanceResolution(inheritanceState) {
  return inheritanceState
    ? inheritanceState.resolution.await()
    : null;
}

function finishInheritanceResolution(inheritanceState) {
  if (inheritanceState) {
    inheritanceState.resolution.finish();
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

module.exports = {
  cloneInheritanceLocalsByTemplate,
  createExtendsCompositionPayload,
  createInheritancePayload,
  awaitInheritanceResolution,
  beginInheritanceResolution,
  finishInheritanceResolution,
  getExtendsComposition,
  getInheritanceTemplateKey,
  getTemplateLocalCaptures,
  InheritanceMethodRegistry,
  InheritanceResolutionState,
  InheritanceSharedRegistry,
  InheritanceState,
  createInheritanceState,
  createSuperInheritancePayload,
  prepareBlockEntryContext,
  prepareInheritancePayloadForBlock,
  setExtendsComposition,
  setTemplateLocalCaptures
};
