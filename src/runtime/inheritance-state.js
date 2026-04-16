'use strict';

const { validateCallableContractCompatibility } = require('../callable-contract');

class InheritanceState {
  constructor() {
    this.methods = Object.create(null);
    this.registeredSharedChannelNames = new Set();
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
        validateCallableContractCompatibility('method', name, chain[0].contract || null, methodEntry.contract || null);
      }
      chain.push({
        fn: methodEntry.fn,
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
      // Step 6 keeps the Step 5 bridge temporarily: unresolved inherited
      // dispatch still waits on the legacy extends-block registration promise
      // because parent methods register before that promise resolves. Step 7
      // replaces this with shared-root admission stalling instead of method
      // lookup waiting directly here.
      return context.asyncExtendsBlocksPromise.then(() => {
        const resolved = this.getImmediateInheritedMethodEntry(name);
        if (resolved) {
          return resolved;
        }
        throw new Error(`Inherited method '${name}' was not found in the loaded extends chain`);
      });
    }
    throw new Error(`Inherited method '${name}' was not found in the loaded extends chain`);
  }

  resolveSuperMethodEntry(context, name, ownerKey) {
    const immediate = this.getImmediateSuperMethodEntry(name, ownerKey);
    if (immediate) {
      return immediate;
    }
    if (context && context.asyncExtendsBlocksPromise) {
      // Step 6 keeps the Step 5 bridge temporarily: unresolved super dispatch
      // still waits on the legacy extends-block registration promise because
      // parent methods register before that promise resolves. Step 7 replaces
      // this with shared-root admission stalling instead of super lookup
      // waiting directly here.
      return context.asyncExtendsBlocksPromise.then(() => {
        const resolved = this.getImmediateSuperMethodEntry(name, ownerKey);
        if (resolved) {
          return resolved;
        }
        throw new Error(`No super method is available for '${name}' after owner '${ownerKey}'`);
      });
    }
    throw new Error(`No super method is available for '${name}' after owner '${ownerKey}'`);
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
      }
    });
    return normalized;
  }

  getRegisteredSharedChannelNames() {
    return Array.from(this.registeredSharedChannelNames);
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

module.exports = {
  InheritanceState,
  createInheritanceState
};
