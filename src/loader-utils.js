'use strict';

// Static Map to store resource caches for each loader
const resourceCaches = new Map();

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
      if (content) {
        // Cache the content
        loaderResourceCache.set(key, content);
        return content;
      } else {
        throw new Error(`Resource '${key}' not found`);
      }
    });
  } else {
    // Synchronous result
    if (result) {
      const content = result.src || result; // Handle both {src: string} and string formats
      // Cache the content
      loaderResourceCache.set(key, content);
      return content;
    } else {
      throw new Error(`Resource '${key}' not found`);
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
      // Check if it's async by looking at the .async property (legacy)
      if (loader.async) {
        loader.getSource(name, callback);
        return;
      } else {
        result = loader.getSource(name);
      }
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
  callLoader,
};
