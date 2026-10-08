import {asyncIter} from '../lib.js';
import {EmitterObj} from '../object.js';
import {subscribeLoaderEvent} from './loader-events.js';
import {NotFoundError} from './errors.js';

const resourceCaches = new WeakMap();

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
  if (loader instanceof RaceLoader) return loader._loadSource(name, parentName);
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
  constructor(loader) {
    this.loader = loader;
    this.entries = new Map();
    this.generation = 0;
    subscribeLoaderEvent(loader, 'update', this, onSourceUpdate);
  }

  clear(name, fullname) {
    // Pending acquisitions from an older generation may finish for their
    // original caller, but must never repopulate an invalidated cache.
    this.generation++;
    if (name === undefined) {
      this.entries.clear();
      return;
    }
    for (const [key, acquisition] of this.entries) {
      if (acquisition.name === name || acquisition.origin.path === name ||
          (fullname != null && acquisition.origin.path === fullname)) {
        this.entries.delete(key);
      }
    }
  }

  has(acquisition) {
    return this.entries.get(acquisition.cacheKey) === acquisition;
  }

  load(name, parentName) {
    // A race without a cached parent alias resolves relative names per member.
    // Distinguish those requests from the same name under other parents.
    const relativeParent = this.loader instanceof RaceLoader && parentName && this.loader.isRelative(name)
      ? parentName : null;
    const cacheKey = JSON.stringify([relativeParent, name]);
    const cached = this.entries.get(cacheKey);
    if (cached) return cached;
    const generation = this.generation;
    const remember = acquisition => {
      if (!acquisition) return null;
      acquisition.name = name;
      acquisition.cacheKey = cacheKey;
      if (!acquisition.source.noCache && generation === this.generation) {
        this.entries.set(cacheKey, acquisition);
      }
      return acquisition;
    };
    const result = loadSource(this.loader, name, relativeParent);
    return isPromise(result) ? result.then(remember) : remember(result);
  }
}

/** Load literal text sequentially, falling back after misses or loader errors. */
function loadString(key, loader) {
  return loadStringFromLoaders(key, Array.isArray(loader) ? loader : [loader], 0);
}

function loadStringFromLoaders(key, loaders, start, firstError) {
  for (let i = start; i < loaders.length; i++) {
    try {
      const result = loadStringFromNativeLoader(key, loaders[i]);
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

function loadStringFromNativeLoader(key, loader) {
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

/** Calls loaders sequentially, preserving synchronous results for sync APIs. */
function callLoaders(loaders, name, resolveFromLoader, callback, sourceCaches, parentName) {
  asyncIter(loaders, (loader, i, next, done) => {
    let result;
    try {
      const resolvedName = resolveFromLoader(loader, name);
      result = sourceCaches.get(loader).load(resolvedName, parentName);
    } catch (error) {
      done(error);
      return;
    }
    const handle = acquisition => {
      if (acquisition) done(null, acquisition, acquisition.cacheKey);
      else next();
    };
    if (isPromise(result)) result.then(handle, error => done(error));
    else handle(result);
  }, callback);
}

function createRacePathRegistry(owner) {
  return new FinalizationRegistry(entry => {
    const group = owner.deref();
    const paths = entry.deref();
    if (group && paths) group._forgetPaths(paths);
  });
}

function onRaceUpdate(race, loader, name, fullname) {
  race.generation++;
  for (const entry of race.pathLoaders.values()) {
    if (entry.member === loader && (entry.names.includes(name) || entry.names.includes(fullname))) {
      race._forgetPaths(entry);
    }
  }
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
    this.pathLoaders = new Map();
    this.pathFinalizer = createRacePathRegistry(new WeakRef(this));
    this.generation = 0;
    for (const loader of loaders) subscribeLoaderEvent(loader, 'update', this, onRaceUpdate);
  }

  isRelative(name) {
    return this.loaders.some(loader => typeof loader.isRelative === 'function' && loader.isRelative(name));
  }

  resolve(from, to) {
    const entry = this.pathLoaders.get(from);
    if (!entry) return to;
    if (!entry.source.deref()) {
      this._forgetPaths(entry);
      return to;
    }
    return entry.origin.owner.isRelative(to) ? entry.origin.owner.resolve(entry.origin.path, to) : to;
  }

  _forgetPaths(entry) {
    for (const name of entry.names) {
      if (this.pathLoaders.get(name) === entry) this.pathLoaders.delete(name);
    }
    this.pathFinalizer.unregister(entry);
  }

  _rememberSource(name, acquisition, member) {
    const {source, origin} = acquisition;
    const names = [...new Set([name, origin.path])];
    for (const path of names) {
      const previous = this.pathLoaders.get(path);
      if (previous) this._forgetPaths(previous);
    }
    if (source.noCache || typeof origin.owner.isRelative !== 'function' || typeof origin.owner.resolve !== 'function') return;
    const entry = {member, origin, source: new WeakRef(source), names};
    for (const path of names) this.pathLoaders.set(path, entry);
    this.pathFinalizer.register(source, new WeakRef(entry), entry);
  }

  load(name) {
    return this._loadSource(name).then(acquisition => (acquisition ? acquisition.source : null));
  }

  _loadSource(name, parentName) {
    if (!this.loaders.length) return Promise.resolve(null);
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let remaining = this.loaders.length;
      let settled = false;
      let firstError;
      const complete = (member, error, result) => {
        remaining--;
        if (error) {
          firstError ??= normalizeError(error);
        } else if (result && !settled) {
          settled = true;
          const acquisition = {source: result.source, origin: {
            loader: this, owner: result.origin.owner, path: result.origin.path
          }};
          try {
            if (generation === this.generation) this._rememberSource(name, acquisition, member);
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
          complete(loader, error);
          continue;
        }
        if (isPromise(result)) result.then(value => complete(loader, null, value), error => complete(loader, error));
        else complete(loader, null, result);
      }
    });
  }
}

export {loadString, clearStringCache, loadStringFromNativeLoader, callLoaders, raceLoaders, SourceCache};
