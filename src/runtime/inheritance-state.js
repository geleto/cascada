'use strict';

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
  }

  // Thin compatibility delegates keep older tests/helpers stable while the
  // runtime owners move to the explicit domain presentation.
  registerCompiledMethods(methods) {
    return this.methods.registerCompiled(methods);
  }

  getRegisteredMethodChain(name) {
    return this.methods.getChain(name);
  }

  getImmediateInheritedMethodEntry(name) {
    return this.methods.getImmediateInherited(name);
  }

  getImmediateSuperMethodEntry(name, ownerKey) {
    return this.methods.getImmediateSuper(name, ownerKey);
  }

  resolveInheritedMethodEntry(name) {
    return this.methods.resolveInherited(name);
  }

  resolveSuperMethodEntry(name, ownerKey) {
    return this.methods.resolveSuper(name, ownerKey);
  }

  registerSharedSchema(sharedSchema) {
    return this.shared.registerSchema(sharedSchema);
  }

  getRegisteredSharedChannelNames() {
    return this.shared.getNames();
  }

  getImmediateSharedChannelType(name) {
    return this.shared.getImmediateType(name);
  }

  resolveSharedChannelType(name) {
    return this.shared.resolveType(name);
  }

  beginInheritanceResolution() {
    this.resolution.begin();
  }

  awaitInheritanceResolution() {
    return this.resolution.await();
  }

  finishInheritanceResolution() {
    this.resolution.finish();
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

module.exports = {
  InheritanceMethodRegistry,
  InheritanceResolutionState,
  InheritanceSharedRegistry,
  InheritanceState,
  createInheritanceState
};
