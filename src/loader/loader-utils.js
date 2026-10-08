import {EmitterObj} from '../object.js';
import {subscribeLoaderEvent} from './loader-events.js';
import {NotFoundError} from './errors.js';

const resourceCaches = new WeakMap();
const loadAcquisition = Symbol('loadAcquisition');

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
function loadSource(loader, name, parentName) {
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
    this.ownerCaches = new Map();
    this.entries = new Map();
    this.pending = new Map();
    this.generation = 0;
    if (subscribe) subscribeLoaderEvent(loader, 'update', this, onSourceUpdate);
  }

  forOwner(owner) {
    if (owner === this.loader) return this;
    let cache = this.ownerCaches.get(owner);
    if (!cache) {
      cache = new SourceCache(owner, false, this.policyLoader);
      this.ownerCaches.set(owner, cache);
    }
    return cache;
  }

  clear(name, fullname) {
    for (const cache of this.ownerCaches.values()) cache.clear(name, fullname);
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
    const relativeParent = parentName && this.loader.isRelative?.(name) ? parentName : null;
    const cacheKey = JSON.stringify([relativeParent, name]);
    const cacheRequests = this.policyLoader.cachePolicy !== 'reload';
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
    const result = loadSource(this.loader, name, relativeParent);
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
}

function loadStringFromLoader(key, loader) {
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

/** Run loaders concurrently and return the first source, or null if all miss. */
function raceLoaders(loaders) {
  if (!Array.isArray(loaders)) throw new TypeError('raceLoaders requires an array of loaders.');
  return new RaceLoader(loaders);
}

class RaceLoader extends EmitterObj {
  constructor(loaders) {
    super();
    this.async = true;
    this.loaders = loaders;
    for (const loader of loaders) subscribeLoaderEvent(loader, 'update', this, onRaceUpdate);
  }

  get cachePolicy() {
    return this._cachePolicy ?? (this.loaders.some(loader => loader.cachePolicy === 'reload') ? 'reload' : 'cache');
  }

  set cachePolicy(policy) {
    this._cachePolicy = policy;
  }

  isRelative(name) {
    return this.loaders.some(loader => typeof loader.isRelative === 'function' && loader.isRelative(name));
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
          const acquisition = {source: result.source, origin: {
            loader: this, owner: result.origin.owner, path: result.origin.path
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
          const resolvedName = parentName && loader.isRelative?.(name) && loader.resolve
            ? loader.resolve(parentName, name) : name;
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

export {loadString, clearStringCache, raceLoaders, SourceCache};
