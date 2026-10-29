import {EmitterObj} from '../object.js';
import {subscribeLoaderEvent} from './loader-events.js';
import {NotFoundError} from './errors.js';
import {posix} from 'path';

const resourceCaches = new WeakMap();
const loadAcquisition = Symbol('loadAcquisition');
const ownerCacheRegistry = new FinalizationRegistry(({references, reference}) => references.delete(reference));

function isPromise(value) {
  return value != null && typeof value.then === 'function';
}

function normalizeError(error) {
  return Error.isError(error) ? error : new Error(String(error));
}

function acquiredSource(loader, name, value) {
  if (!value && value !== '') return null;
  const source = typeof value === 'string' ? {src: value, path: name, noCache: false} : value;
  return {source, origin: {loader, owner: loader, path: source.path ?? name}};
}

// All entry points share the loader protocol and preserve the original source
// object. Ownership belongs to this acquisition, not to a mutable source object.
function isRelativeName(name) {
  return name.startsWith('./') || name.startsWith('../');
}

function resolveLoaderName(loader, parentName, name) {
  if (!parentName) return name;
  if (Array.isArray(loader)) {
    if (!isRelativeName(name)) return name;
    return parentName.includes('://') ? new URL(name, parentName).href : posix.join(posix.dirname(parentName), name);
  }
  return loader.isRelative?.(name) && loader.resolve ? loader.resolve(parentName, name) : name;
}

function loadChain(loaders, name, parentName, cache, start = 0) {
  for (let index = start; index < loaders.length; index++) {
    const loader = loaders[index];
    const resolvedName = resolveLoaderName(loader, parentName, name);
    const policy = cache && !Array.isArray(cache.policyLoader) ? cache.policyLoader : loader;
    const result = cache ? cache.forOwner(loader, policy).load(resolvedName, parentName)
      : loadSource(loader, resolvedName, parentName);
    const complete = acquisition => {
      if (!acquisition) return loadChain(loaders, name, parentName, cache, index + 1);
      if (loaders.length === 1) return acquisition;
      // Keep the chain's logical namespace, replacing a selected race with its
      // winning scope. Other competitors never become relative fallbacks.
      // Stable acquisition identity also retains the cached compiled form.
      let scoped = cache?.scopedSources.get(acquisition);
      if (!scoped) {
        const selected = acquisition.origin.scope ?? loader;
        const scope = selected === loader ? loaders : loaders.with(index, selected);
        scoped = {source: acquisition.source, origin: {...acquisition.origin, loader: loaders, scope, name}};
        cache?.scopedSources.set(acquisition, scoped);
      }
      return scoped;
    };
    if (isPromise(result)) return result.then(complete);
    if (result) return complete(result);
  }
  return null;
}

function loadSource(loader, name, parentName, cache) {
  if (Array.isArray(loader)) return loadChain(loader, name, parentName, cache);
  if (loader?.[loadAcquisition]) return loader[loadAcquisition](name, parentName);
  let result;
  try {
    if (typeof loader === 'function') {
      result = loader(name);
    } else if (loader && typeof loader.load === 'function') {
      result = loader.load(name);
    } else if (loader && typeof loader.getSource === 'function') {
      if (loader.async === true) {
        return new Promise((resolve, reject) => {
          try {
            loader.getSource(name, (error, value) => {
              if (error) reject(normalizeError(error));
              else resolve(acquiredSource(loader, name, value));
            });
          } catch (error) {
            reject(normalizeError(error));
          }
        });
      }
      result = loader.getSource(name);
    } else {
      throw new TypeError('Invalid loader: must be a function, object with load method, or legacy loader with getSource method');
    }
  } catch (error) {
    throw normalizeError(error);
  }
  if (isPromise(result)) {
    return Promise.resolve(result).then(value => acquiredSource(loader, name, value), error => {
      throw normalizeError(error);
    });
  }
  return acquiredSource(loader, name, result);
}

function onSourceUpdate(cache, loader, name, fullname) {
  cache.clear(name, fullname);
}

class SourceCache {
  constructor(loader, subscribe = true, policyLoader = loader) {
    this.loader = loader;
    this.policyLoader = policyLoader;
    // Relative scopes can be temporary; enumerate weak references for invalidation.
    this.ownerCaches = new WeakMap();
    this.ownerReferences = new Set();
    this.entries = new Map();
    this.pending = new Map();
    this.generation = 0;
    this.scopedSources = new WeakMap();
    if (subscribe) subscribeLoaderEvent(loader, 'update', this, onSourceUpdate);
  }

  forOwner(owner, policyLoader = this.policyLoader) {
    if (owner === this.loader && policyLoader === this.policyLoader) return this;
    let cache = this.ownerCaches.get(owner);
    if (!cache) {
      cache = new SourceCache(owner, false, policyLoader);
      this.ownerCaches.set(owner, cache);
      const reference = new WeakRef(cache);
      this.ownerReferences.add(reference);
      ownerCacheRegistry.register(cache, {references: this.ownerReferences, reference});
    }
    return cache;
  }

  clear(name, fullname) {
    for (const reference of this.ownerReferences) {
      const cache = reference.deref();
      if (cache) cache.clear(name, fullname);
      else this.ownerReferences.delete(reference);
    }
    // Pending acquisitions from an older generation may finish for their
    // original caller, but must never repopulate an invalidated cache.
    this.generation++;
    this.pending.clear();
    if (name === undefined) {
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      if (!entry.acquisition || entry.name === name || entry.acquisition.origin.path === name ||
          (fullname != null && entry.acquisition.origin.path === fullname)) {
        this.entries.delete(key);
      }
    }
  }

  load(name, parentName) {
    const relativeParent = parentName && (Array.isArray(this.loader) ? isRelativeName(name) : this.loader.isRelative?.(name)) ? parentName : null;
    const cacheKey = JSON.stringify([relativeParent, name]);
    const cacheRequests = !reloads(this.policyLoader);
    const cached = this.entries.get(cacheKey);
    if (cacheRequests && cached) return cached.acquisition;
    if (cacheRequests && this.pending.has(cacheKey)) return this.pending.get(cacheKey);
    const generation = this.generation;
    const remember = acquisition => {
      if (acquisition && this.policyLoader !== this.loader) {
        // Pin resolution to the source owner while retaining the group's policy
        // for this source and its subsequent relative dependencies.
        acquisition = {source: acquisition.source, origin: {...acquisition.origin, loader: this.policyLoader}};
      }
      if (cacheRequests && generation === this.generation && (!acquisition || !acquisition.source.noCache)) {
        this.entries.set(cacheKey, {name, acquisition});
      }
      return acquisition;
    };
    const result = loadSource(this.loader, name, relativeParent, this);
    if (!isPromise(result)) return remember(result);
    const pending = result.then(remember).finally(() => {
      if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey);
    });
    if (cacheRequests && generation === this.generation) this.pending.set(cacheKey, pending);
    return pending;
  }
}

/** Load literal text sequentially, falling back after misses or loader errors. */
function loadString(key, loader) {
  return loadStringFromLoaders(key, Array.isArray(loader) ? loader : [loader], 0);
}

function loadStringFromLoaders(key, loaders, start, firstError) {
  for (let i = start; i < loaders.length; i++) {
    try {
      const result = loadStringFromLoader(key, loaders[i]);
      if (isPromise(result)) {
        return result.catch(error => {
          const failure = error instanceof NotFoundError ? firstError : (firstError ?? error);
          return loadStringFromLoaders(key, loaders, i + 1, failure);
        });
      }
      return result;
    } catch (error) {
      if (!(error instanceof NotFoundError)) firstError ??= error;
    }
  }
  throw firstError ?? new NotFoundError(key);
}

function clearStringCache(loader, key) {
  resourceCaches.get(loader)?.clear(key);
  if (Array.isArray(loader)) for (const member of loader) clearStringCache(member, key);
}

function loadStringFromLoader(key, loader) {
  if (Array.isArray(loader)) return loadStringFromLoaders(key, loader, 0);
  let cache = resourceCaches.get(loader);
  if (!cache) {
    cache = new SourceCache(loader);
    resourceCaches.set(loader, cache);
  }
  const text = acquisition => {
    if (!acquisition) throw new NotFoundError(key);
    if (typeof acquisition.source.src !== 'string') throw new TypeError('Resource is not a string: ' + key);
    return acquisition.source.src;
  };
  const result = cache.load(key);
  return isPromise(result) ? result.then(text) : text(result);
}

function onRaceUpdate(race, loader, name, fullname) {
  race.emit('update', name, fullname);
}

function reloads(loader) {
  return Array.isArray(loader) ? loader.some(reloads) : loader.cachePolicy === 'reload';
}

/** Run loaders concurrently and return the first source, or null if all miss. */
function raceLoaders(loaders) {
  if (!Array.isArray(loaders)) throw new TypeError('raceLoaders requires an array of loaders.');
  validateLoaders(loaders);
  return new RaceLoader(loaders);
}

function validateLoaders(loaders) {
  for (const loader of loaders) {
    if (Array.isArray(loader)) validateLoaders(loader);
    else if (typeof loader !== 'function' && typeof loader?.load !== 'function' && typeof loader?.getSource !== 'function') {
      throw new TypeError('Invalid loader: expected a loader or an ordered array of loaders.');
    }
  }
}

class RaceLoader extends EmitterObj {
  constructor(loaders) {
    super();
    this.async = true;
    this.loaders = loaders;
    for (const loader of loaders) subscribeLoaderEvent(loader, 'update', this, onRaceUpdate);
  }

  get cachePolicy() {
    return this._cachePolicy ?? (this.loaders.some(reloads) ? 'reload' : 'cache');
  }

  set cachePolicy(policy) {
    this._cachePolicy = policy;
  }

  isRelative(name) {
    return this.loaders.some(loader => (Array.isArray(loader) ? isRelativeName(name) : loader.isRelative?.(name)));
  }

  resolve(from, to) {
    // String parents have no ownership token. Resolve them independently in
    // each member when loading, regardless of previous loads or cache state.
    return to;
  }

  load(name) {
    return this[loadAcquisition](name).then(acquisition => (acquisition ? acquisition.source : null));
  }

  [loadAcquisition](name, parentName) {
    if (!this.loaders.length) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let remaining = this.loaders.length;
      let settled = false;
      let firstError;
      const complete = (error, result) => {
        remaining--;
        if (error) {
          firstError ??= normalizeError(error);
        } else if (result && !settled) {
          settled = true;
          const acquisition = {source: result.source, origin: {...result.origin,
            loader: this, scope: result.origin.scope ?? result.origin.owner
          }};
          try {
            this.emit('load', name, acquisition.source);
            resolve(acquisition);
          } catch (eventError) {
            reject(normalizeError(eventError));
          }
        }
        if (!remaining && !settled) {
          if (firstError) reject(firstError);
          else resolve(null);
        }
      };
      for (const loader of this.loaders) {
        let result;
        try {
          const resolvedName = resolveLoaderName(loader, parentName, name);
          result = loadSource(loader, resolvedName, parentName);
        } catch (error) {
          complete(error);
          continue;
        }
        if (isPromise(result)) result.then(value => complete(null, value), error => complete(error));
        else complete(null, result);
      }
    });
  }
}

export {loadString, clearStringCache, raceLoaders, SourceCache, isRelativeName, resolveLoaderName};
