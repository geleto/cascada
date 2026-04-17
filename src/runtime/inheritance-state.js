'use strict';

const { validateCallableContractCompatibility } = require('../callable-contract');
const { RuntimeFatalError } = require('./errors');

class InheritanceState {
  constructor() {
    this.methods = Object.create(null);
    this.registeredSharedChannelNames = new Set();
    this.registeredSharedChannelTypes = new Map();
    this.inheritanceResolutionPromise = null;
    this.inheritanceResolutionResolver = null;
    this.inheritanceResolutionPendingCount = 0;
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

  beginInheritanceResolution() {
    if (!this.inheritanceResolutionPromise) {
      this.inheritanceResolutionPendingCount = 0;
      this.inheritanceResolutionPromise = new Promise((resolve) => {
        this.inheritanceResolutionResolver = resolve;
      }).then(() => {
        this.inheritanceResolutionPromise = null;
        this.inheritanceResolutionResolver = null;
        this.inheritanceResolutionPendingCount = 0;
      });
    }
    this.inheritanceResolutionPendingCount += 1;
  }

  awaitInheritanceResolution() {
    return this.inheritanceResolutionPromise || null;
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

  _resolveWithInheritanceResolution(readImmediate, getNotFoundMessage) {
    const immediate = readImmediate();
    if (immediate) {
      return immediate;
    }
    const registrationWait = this.awaitInheritanceResolution();
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

  resolveInheritedMethodEntry(name) {
    return this._resolveWithInheritanceResolution(
      () => this.getImmediateInheritedMethodEntry(name),
      () => `Inherited method '${name}' was not found in the loaded extends chain`
    );
  }

  resolveSuperMethodEntry(name, ownerKey) {
    return this._resolveWithInheritanceResolution(
      () => this.getImmediateSuperMethodEntry(name, ownerKey),
      () => `No super method is available for '${name}' after owner '${ownerKey}'`
    );
  }

  getRegisteredMethodChain(name) {
    return this.methods[name] || [];
  }

  registerSharedSchema(sharedSchema) {
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

  resolveSharedChannelType(name) {
    return this._resolveWithInheritanceResolution(
      () => this.getImmediateSharedChannelType(name),
      () => `Shared channel '${name}' was not found in the loaded extends chain`
    );
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

module.exports = {
  InheritanceState,
  createInheritanceState
};
