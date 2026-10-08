
import {asyncIter} from '../lib.js';
import {EmitterObj} from '../object.js';
import {subscribeLoaderEvent} from './loader-events.js';
import {NotFoundError} from './errors.js';

// WeakMap to store resource caches for each loader (no mutation of loader objects)
const resourceCaches = new WeakMap();

function createRacePathRegistry(owner) {
  // Keep the registry on the race itself: a shared source may outlive many
  // groups, and must not keep their cleanup registrations alive globally.
  return new FinalizationRegistry(entry => {
    const group = owner.deref();
    const paths = entry.deref();
    if (group && paths) group._forgetPaths(paths);
  });
}

function onRaceUpdate(race, loader, name, fullname) {
  for (const entry of race.pathLoaders.values()) {
    if (entry.loader === loader && (entry.names.includes(name) || entry.names.includes(fullname))) {
      race._forgetPaths(entry);
    }
  }
  race.emit('update', name, fullname);
}

function onStringUpdate(cache, loader, name, fullname) {
  for (const [key, source] of cache) {
    if (key === name || source.path === name || (fullname != null && source.path === fullname)) {
      cache.delete(key);
    }
  }
}

/**
 * Loads a string from the specified loader(s) with caching.
 * Tries loaders sequentially.
 * Behaves synchronously and throws on failure if all loaders are synchronous.
 * Returns a Promise if any loader in the chain is asynchronous.
 *
 * @param {string} key The resource key/name to load
 * @param {ILoaderAny|ILoaderAny[]} loader The loader instance or array of loaders
 * @returns {Promise<string>|string} The loaded string content.
 */
function loadString(key, loader) {
  const loaders = Array.isArray(loader) ? loader : [loader];
  return loadStringFromLoaders(key, loaders, 0);
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

/**
 * Clears the string cache for a specific loader
 * @param {ILoaderAny} loader The loader to clear string cache for
 * @param {string} [key] Optional specific resource key to clear
 */
function clearStringCache(loader, key) {
  if (!loader) {
    return;
  }

  const loaderResourceCache = resourceCaches.get(loader);
  if (!loaderResourceCache) {
    return;
  }

  if (key !== undefined) {
    // Clear specific resource
    loaderResourceCache.delete(key);
  } else {
    // Clear all resources for this loader
    loaderResourceCache.clear();
  }
}

/**
 * Detects if a value is a Promise
 * @param {any} value The value to check
 * @returns {boolean} True if the value is a Promise
 * @private
 */
function isPromise(value) {
  return value && typeof value === 'object' && typeof value.then === 'function';
}

/**
 * Loads a string from a native loader (function or object with load method) with caching
 * @param {string} key The resource key/name to load
 * @param {Function|Object} loader The native loader (function or object with load method)
 * @returns {Promise<string>|string} The loaded string content - Promise for async loaders, string for sync loaders
 * @private
 */
function loadStringFromNativeLoader(key, loader) {
  // Get or create resource cache for this loader
  if (!resourceCaches.has(loader)) {
    const cache = new Map();
    resourceCaches.set(loader, cache);
    subscribeLoaderEvent(loader, 'update', cache, onStringUpdate);
  }
  const loaderResourceCache = resourceCaches.get(loader);

  // Check if already cached
  if (loaderResourceCache.has(key)) {
    return loaderResourceCache.get(key).src;
  }

  let result;

  // Function-based loader
  if (typeof loader === 'function') {
    result = loader(key);
  }
  // Object-based loader with load method
  else if (loader && typeof loader === 'object' && typeof loader.load === 'function') {
    result = loader.load(key);
  }
  // Legacy loader with getSource method
  else if (loader && typeof loader === 'object' && typeof loader.getSource === 'function') {
    // Check if it's async by looking at the .async property (legacy)
    if (loader.async) {
      return new Promise((resolve, reject) => {
        loader.getSource(key, (err, src) => {
          if (err) {
            reject(err);
          } else {
            try {
              resolve(cacheStringSource(loaderResourceCache, key, src));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
    } else {
      result = loader.getSource(key);
    }
  } else {
    throw new Error('Invalid loader: must be a function, object with load method, or legacy loader with getSource method');
  }

  // Check if result is a Promise
  if (isPromise(result)) {
    return result.then(source => cacheStringSource(loaderResourceCache, key, source));
  }
  return cacheStringSource(loaderResourceCache, key, result);
}

function cacheStringSource(cache, key, source) {
  if (!source && source !== '') throw new NotFoundError(key);
  const content = typeof source === 'string' ? source : source.src;
  if (typeof content !== 'string') throw new TypeError('Resource is not a string: ' + key);
  if (!source.noCache) {
    cache.set(key, {src: content, path: typeof source === 'string' ? key : source.path});
  }
  return content;
}

/**
 * Validates that a loader is properly implemented
 * @param {any} loader The loader to validate
 * @throws {Error} If the loader is invalid
 */
function validateLoader(loader) {
  if (typeof loader === 'function') return;
  if (loader && typeof loader === 'object' && typeof loader.load === 'function') return;
  if (loader && typeof loader === 'object' && typeof loader.getSource === 'function') return;

  throw new Error('Invalid loader: must be a function, object with load method, or legacy loader with getSource method');
}

/**
 * Creates a standardized source object for loaders
 * @param {string|Object} src The template source content or object
 * @param {string} path The template path/name
 * @param {boolean} noCache Whether to disable caching
 * @returns {Object} Standardized source object
 */
function createSourceObject(src, path, noCache = false) {
  return {
    src: src,
    path: path,
    noCache: noCache
  };
}

/**
 * Calls multiple loaders sequentially and returns the first successful result
 * @param {Array} loaders Array of loaders to try
 * @param {string} name The resource name to load
 * @param {Function} resolveFromLoader Function to resolve name relative to parentName
 * @param {Function} callback The callback function (err, result, resolvedName)
 * @param {WeakMap} [sourceCaches] Environment-local source caches
 */
function callLoaders(loaders, name, resolveFromLoader, callback, sourceCaches) {
  // Preserve the original sequential loader iteration behavior.
  asyncIter(loaders, (loader, i, next, done) => {
    function handle(err, src) {
      if (err) {
        done(err);
      } else if (src) {
        src.loader = loader;
        if (!src.noCache && sourceCaches) {
          sourceCaches.get(loader).set(resolvedName, src);
        }
        done(null, src, resolvedName);
      } else {
        next();
      }
    }

    // Resolve name relative to parentName
    const resolvedName = resolveFromLoader(loader, name);

    // Use native loader support instead of checking .async property
    const cached = sourceCaches?.get(loader).get(resolvedName);
    if (cached) {
      handle(null, cached);
    } else {
      callLoader(loader, resolvedName, handle);
    }
  }, callback);
}

/**
 * Creates a single loader that runs multiple loaders concurrently and
 * returns the result from the first one that succeeds. This is the primary
 * concurrency primitive for Cascada.
 *
 * @param {Array<Object|Function>} loaders An array of loader instances.
 * @returns {Object} A single, standardized loader object with a `load` method.
 */
function raceLoaders(loaders) {
  if (!Array.isArray(loaders)) {
    throw new TypeError('raceLoaders requires an array of loaders.');
  }

  return new RaceLoader(loaders);
}

class RaceLoader extends EmitterObj {
  constructor(loaders) {
    super();
    this.async = true;
    this.loaders = loaders;
    this.pathLoaders = new Map();
    this.pathFinalizer = createRacePathRegistry(new WeakRef(this));
    this.sourceLoaders = new WeakMap();
    for (const loader of loaders) {
      subscribeLoaderEvent(loader, 'update', this, onRaceUpdate);
    }
  }

  isRelative(name) {
    return this.loaders.some(loader => typeof loader.isRelative === 'function' && loader.isRelative(name));
  }

  resolve(from, to) {
    const entry = this.pathLoaders.get(from);
    if (!entry) return to;
    const source = entry.source.deref();
    if (!source) {
      this._forgetPaths(entry);
      return to;
    }
    return this._resolveSource(source, from, to);
  }

  _forgetPaths(entry) {
    for (const name of entry.names) {
      if (this.pathLoaders.get(name) === entry) this.pathLoaders.delete(name);
    }
    this.pathFinalizer.unregister(entry);
  }

  _rememberSource(name, source, loader) {
    this.sourceLoaders.set(source, loader);
    for (const path of [name, source.path]) {
      const previous = this.pathLoaders.get(path);
      if (previous) this._forgetPaths(previous);
    }
    // Rendered sources use sourceLoaders directly, including concurrent noCache
    // sources with identical paths. String-only resolution needs aliases only
    // while a cacheable, relative-capable source is still alive.
    if (source.noCache || typeof loader.isRelative !== 'function' || typeof loader.resolve !== 'function') return;
    const entry = {loader, source: new WeakRef(source), names: [name, source.path]};
    for (const path of entry.names) this.pathLoaders.set(path, entry);
    this.pathFinalizer.register(source, new WeakRef(entry), entry);
  }

  _resolveSource(source, from, to) {
    const loader = this.sourceLoaders.get(source);
    if (!loader?.isRelative?.(to)) return to;
    if (typeof loader._resolveSource === 'function') {
      return loader._resolveSource(source, from, to);
    }
    return loader.resolve ? loader.resolve(from, to) : to;
  }

  load(name) {
    if (!this.loaders.length) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let remaining = this.loaders.length;
      let settled = false;
      let firstError;
      for (const loader of this.loaders) {
        callLoader(loader, name, (error, source) => {
          remaining--;
          if (error) {
            firstError ??= error instanceof Error ? error : new Error(String(error));
          } else if (source && !settled) {
            settled = true;
            this._rememberSource(name, source, loader);
            try {
              this.emit('load', name, source);
            } catch (eventError) {
              reject(eventError instanceof Error ? eventError : new Error(String(eventError)));
              return;
            }
            resolve(source);
          }
          if (!remaining && !settled) {
            if (firstError) {
              reject(firstError);
            } else {
              resolve(null);
            }
          }
        });
      }
    });
  }
}

/**
 * Calls a loader and handles both sync and async cases with callback
 * @param {Object|Function} loader The loader to call
 * @param {string} name The resource name to load
 * @param {Function} callback The callback function (err, result)
 */
function callLoader(loader, name, callback) {
  let result;
  try {
    validateLoader(loader);

    // Function-based loader
    if (typeof loader === 'function') {
      result = loader(name);
    }
    // Object-based loader with load method
    else if (loader && typeof loader === 'object' && typeof loader.load === 'function') {
      result = loader.load(name);
    }
    // Legacy loader with getSource method
    else if (loader && typeof loader === 'object' && typeof loader.getSource === 'function') {
      // Legacy loader with getSource: prefer sync path for sync loaders to preserve sync semantics
      if (loader.async === true) {
        // Async loader: use callback form
        try {
          loader.getSource(name, (err, src) => {
            if (err) {
              callback(err, null);
            } else {
              callback(null, typeof src === 'string' ? createSourceObject(src, name) : src);
            }
          });
          return;
        } catch (e) {
          // Fallback to synchronous usage if calling with a callback throws
          // (some sync loaders may not accept a callback)
        }
      }
      // Synchronous loader or callback form not desired: call without a callback
      result = loader.getSource(name);
    }
  } catch (error) {
    // Handle synchronous errors by passing them to the callback
    callback(error instanceof Error ? error : new Error(String(error)), null);
    return;
  }

  // Check if result is a Promise
  if (isPromise(result)) {
    result
      .then((content) => {
        if (content || content === '') {
          // Handle both {src: string} and string formats
          const src = typeof content === 'string' ? createSourceObject(content, name, false) : content;
          callback(null, src);
        } else {
          callback(null, null);
        }
      })
      .catch((err) => {
        callback(err instanceof Error ? err : new Error(String(err)), null);
      });
  } else {
    // Synchronous result
    if (result || result === '') {
      // Handle both {src: string} and string formats
      const src = typeof result === 'string' ? createSourceObject(result, name, false) : result;
      callback(null, src);
    } else {
      callback(null, null);
    }
  }
}


export { loadString, clearStringCache, loadStringFromNativeLoader, callLoaders, raceLoaders };
