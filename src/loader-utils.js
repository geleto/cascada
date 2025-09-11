'use strict';

const lib = require('./lib');

// WeakMap to store resource caches for each loader (no mutation of loader objects)
const resourceCaches = new WeakMap();

/**
 * Loads a string from the specified loader with caching.
 * @param {string} key The resource key/name to load
 * @param {ILoaderAny|ILoaderAny[]} loader The loader instance or array of loaders
 * @returns {Promise<string>|string} The loaded string content - Promise for async loaders, string for sync loaders
 */
function loadString(key, loader) {
  const loaders = Array.isArray(loader) ? loader : [loader];

  const results = [];
  let hasAsyncLoader = false;

  for (const candidateLoader of loaders) {
    try {
      const result = loadStringFromNativeLoader(key, candidateLoader);
      if (isPromise(result)) {
        hasAsyncLoader = true;
        results.push(result);
      } else {
        // Found a sync result, return it immediately
        return result;
      }
    } catch (error) {
      // Continue to next loader
      continue;
    }
  }

  if (hasAsyncLoader) {
    // Use the already-started promises and resolve the first successful one
    return resolveFirstSuccessfulPromise(results, key);
  } else {
    // All loaders failed
    throw new Error(`Resource '${key}' not found in any loader`);
  }
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

  if (key) {
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
    resourceCaches.set(loader, new Map());
  }
  const loaderResourceCache = resourceCaches.get(loader);

  // Check if already cached
  if (loaderResourceCache.has(key)) {
    return loaderResourceCache.get(key);
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
          } else if (src) {
            const content = src.src;
            if (!src.noCache) {
              loaderResourceCache.set(key, content);
            }
            resolve(content);
          } else {
            reject(new Error(`Resource '${key}' not found`));
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
    return result.then((content) => {
      if (!content) {
        throw new Error(`Resource '${key}' not found`);
      }

      // content may be a LoaderSource or a string
      if (typeof content === 'object' && typeof content.src === 'string') {
        const finalContent = content.src;
        if (!content.noCache) {
          loaderResourceCache.set(key, finalContent);
        }
        return finalContent;
      } else {
        // string
        const finalContent = content;
        loaderResourceCache.set(key, finalContent);
        return finalContent;
      }
    });
  } else {
    // Synchronous result
    if (!result) {
      throw new Error(`Resource '${key}' not found`);
    }

    if (typeof result === 'object' && typeof result.src === 'string') {
      const content = result.src;
      if (!result.noCache) {
        loaderResourceCache.set(key, content);
      }
      return content;
    } else {
      const content = result; // string
      loaderResourceCache.set(key, content);
      return content;
    }
  }
}


/**
 * Resolves the first successful Promise from an array of Promises
 * @param {Promise[]} promises Array of Promises to race
 * @param {string} key The resource key for error messages
 * @returns {Promise<string>} The first successful result
 * @private
 */
function resolveFirstSuccessfulPromise(promises, key) {
  return new Promise((resolve, reject) => {
    let completedCount = 0;
    let resolved = false;
    const errors = [];

    if (promises.length === 0) {
      reject(new Error(`Resource '${key}' not found in any loader`));
      return;
    }

    promises.forEach((promise, index) => {
      promise
        .then((result) => {
          // First successful result wins - prevent multiple resolves
          if (!resolved) {
            resolved = true;
            resolve(result);
          }
        })
        .catch((error) => {
          errors[index] = error;
          completedCount++;

          // If all promises have completed and none succeeded
          if (completedCount === promises.length && !resolved) {
            reject(new Error(`Resource '${key}' not found in any loader`));
          }
        });
    });
  });
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
 * @param {Function} callback The callback function (err, result)
 */
function callLoaders(loaders, name, resolveFromLoader, callback) {
  // Use the exact same lib.asyncIter call as the original code
  lib.asyncIter(loaders, (loader, i, next, done) => {
    function handle(err, src) {
      if (err) {
        done(err);
      } else if (src) {
        src.loader = loader;
        done(null, src);
      } else {
        next();
      }
    }

    // Resolve name relative to parentName
    const resolvedName = resolveFromLoader(loader, name);

    // Use native loader support instead of checking .async property
    callLoader(loader, resolvedName, handle);
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
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error('raceLoaders requires a non-empty array of loaders.');
  }

  // Return a new loader object that encapsulates the race logic.
  return {
    // Make it an async loader so it's always handled as a promise.
    async: true,

    /**
     * The load method that will be called by the engine.
     * @param {string} name The name of the resource to load.
     * @returns {Promise<Object|null>} A promise that resolves with the source
     * object from the first successful loader.
     */
    load: function(name) {
      const promises = loaders.map(loader => {
        return new Promise((resolve, reject) => {
          // Use the existing, robust `callLoader` utility.
          callLoader(loader, name, (err, result) => {
            if (err) {
              // Reject on error to signal failure for this loader.
              reject(err);
            } else if (result) {
              // Resolve with the result on success.
              resolve(result);
            } else {
              // Reject if not found, so Promise.any can skip it.
              reject(new Error(`Resource '${name}' not found by this loader.`));
            }
          });
        });
      });

      // Race all the promises and return the first one that resolves.
      return resolveFirstSuccessfulPromise(promises, name);
    }
  };
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
              // Convert WebLoader 404 errors to the expected format
              if (typeof err === 'string' && err.includes('404 Not Found')) {
                callback(new Error(`Template not found: ${name}`), null);
              } else {
                callback(err, null);
              }
            } else {
              callback(null, src);
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
    callback(error, null);
    return;
  }

  // Check if result is a Promise
  if (isPromise(result)) {
    result
      .then((content) => {
        if (content) {
          // Handle both {src: string} and string formats
          const src = typeof content === 'string' ? createSourceObject(content, name, false) : content;
          callback(null, src);
        } else {
          callback(null, null);
        }
      })
      .catch((err) => {
        callback(err, null);
      });
  } else {
    // Synchronous result
    if (result) {
      // Handle both {src: string} and string formats
      const src = typeof result === 'string' ? createSourceObject(result, name, false) : result;
      callback(null, src);
    } else {
      callback(null, null);
    }
  }
}


module.exports = {
  loadString,
  clearStringCache,
  loadStringFromNativeLoader,
  callLoaders,
  raceLoaders
};
