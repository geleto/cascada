'use strict';

const { validateCallableContractCompatibility } = require('../callable-contract');
const { RuntimeFatalError } = require('./errors');

class InheritanceState {
  constructor() {
    this.methods = Object.create(null);
    this.registeredSharedChannelNames = new Set();
    this.registeredSharedChannelTypes = new Map();
  }

  registerCompiledMethods(methods) {
    const entries = methods && typeof methods === 'object' ? Object.keys(methods) : [];
    entries.forEach((name) => {
      const methodEntry = methods[name];
      if (!methodEntry || typeof methodEntry.fn !== 'function') {
        return;
      }
      const ownerKey = methodEntry.ownerKey == null ? '__anonymous__' : String(methodEntry.ownerKey);
      const chain = this.methods[name] || (this.methods[name] = []);
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

  _findRegisteredMethodEntry(name, ownerKey = null) {
    const chain = this.getRegisteredMethodChain(name);
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

  getImmediateInheritedMethodEntry(name) {
    return this._findRegisteredMethodEntry(name, null);
  }

  getImmediateSuperMethodEntry(name, ownerKey) {
    return this._findRegisteredMethodEntry(name, ownerKey);
  }

  resolveInheritedMethodEntry(context, name) {
    const immediate = this.getImmediateInheritedMethodEntry(name);
    if (immediate) {
      return immediate;
    }
    if (context && context.asyncExtendsBlocksPromise) {
      // The legacy extends-block registration promise is still the bridge for
      // unresolved method lookup here. Step 7 added shared-root admission
      // stalling, but lookup still waits on this promise until the planned
      // post-Step-9 cleanup removes the old registration lifecycle entirely
      // before Step 10 widens static extends to full template behavior.
      return context.asyncExtendsBlocksPromise.then(() => {
        const resolved = this.getImmediateInheritedMethodEntry(name);
        if (resolved) {
          return resolved;
        }
        throw new RuntimeFatalError(`Inherited method '${name}' was not found in the loaded extends chain`);
      });
    }
    throw new RuntimeFatalError(`Inherited method '${name}' was not found in the loaded extends chain`);
  }

  resolveSuperMethodEntry(context, name, ownerKey) {
    const immediate = this.getImmediateSuperMethodEntry(name, ownerKey);
    if (immediate) {
      return immediate;
    }
    if (context && context.asyncExtendsBlocksPromise) {
      // The legacy extends-block registration promise is still the bridge for
      // unresolved super lookup here. Step 7 added shared-root admission
      // stalling, but lookup still waits on this promise until the planned
      // post-Step-9 cleanup removes the old registration lifecycle entirely
      // before Step 10 widens static extends to full template behavior.
      return context.asyncExtendsBlocksPromise.then(() => {
        const resolved = this.getImmediateSuperMethodEntry(name, ownerKey);
        if (resolved) {
          return resolved;
        }
        throw new RuntimeFatalError(`No super method is available for '${name}' after owner '${ownerKey}'`);
      });
    }
    throw new RuntimeFatalError(`No super method is available for '${name}' after owner '${ownerKey}'`);
  }

  getRegisteredMethodChain(name) {
    return this.methods[name] || [];
  }

  registerSharedSchema(sharedSchema, ownerKey = null) {
    // Keep ownerKey in the API for parity with method registration and for
    // callers/tests that need visibility into which file registered the schema,
    // even though schema storage is hierarchy-wide today.
    const normalized = Array.isArray(sharedSchema)
      ? sharedSchema.map((entry) => ({ name: entry.name, type: entry.type }))
      : [];
    normalized.forEach((entry) => {
      if (entry && entry.name) {
        this.registeredSharedChannelNames.add(entry.name);
        if (entry.type) {
          this.registeredSharedChannelTypes.set(entry.name, entry.type);
        }
      }
    });
    return normalized;
  }

  getRegisteredSharedChannelNames() {
    return Array.from(this.registeredSharedChannelNames);
  }

  getImmediateSharedChannelType(name) {
    return this.registeredSharedChannelTypes.has(name)
      ? this.registeredSharedChannelTypes.get(name)
      : null;
  }

  resolveSharedChannelType(context, name) {
    const immediate = this.getImmediateSharedChannelType(name);
    if (immediate) {
      return immediate;
    }
    if (context && context.asyncExtendsBlocksPromise) {
      return context.asyncExtendsBlocksPromise.then(() => {
        const resolved = this.getImmediateSharedChannelType(name);
        if (resolved) {
          return resolved;
        }
        throw new RuntimeFatalError(`Shared channel '${name}' was not found in the loaded extends chain`);
      });
    }
    throw new RuntimeFatalError(`Shared channel '${name}' was not found in the loaded extends chain`);
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

module.exports = {
  InheritanceState,
  createInheritanceState
};
