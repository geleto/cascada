'use strict';

// Static Map to store resource caches for each loader
const resourceCaches = new Map();

/**
 * Loads a string from the specified loader with caching.
 * @param {string} key The resource key/name to load
 * @param {ILoaderAny|ILoaderAny[]} loader The loader instance or array of loaders
 * @returns {Promise<string>} The loaded string content
 */
async function loadString(key, loader) {
  const loaders = Array.isArray(loader) ? loader : [loader];
  const legacyLoaders = convertToLegacyLoaders(loaders);

  for (const currentLoader of legacyLoaders) {
    // Get or create resource cache for this loader
    if (!resourceCaches.has(currentLoader)) {
      resourceCaches.set(currentLoader, new Map());
    }
    const loaderResourceCache = resourceCaches.get(currentLoader);

    // Check if already cached
    if (loaderResourceCache.has(key)) {
      return loaderResourceCache.get(key);
    }

    try {
      let result;
      // Use Cascada's standard loader pattern
      if (currentLoader.async) {
        result = await new Promise((resolve, reject) => {
          currentLoader.getSource(key, (err, src) => {
            if (err) reject(err);
            else resolve(src);
          });
        });
      } else {
        result = currentLoader.getSource(key);
      }

      if (result) {
        const content = result.src;
        // Cache the content in our resource cache Map
        if (!result.noCache) {
          loaderResourceCache.set(key, content);
        }
        return content;
      }
      // If result is null/undefined, continue to next loader
    } catch (error) {
      // Try next loader on error
      continue;
    }
  }

  // No loader found the resource
  throw new Error(`Resource '${key}' not found in any loader`);
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
 * Detects if a function is async by examining its string representation
 * @param {Function} fn The function to check
 * @returns {boolean} True if the function is async
 * @private
 */
function isAsyncFunction(fn) {
  if (typeof fn !== 'function') return false;

  // Check if it's an async function by looking at the function string
  const fnString = fn.toString();
  return fnString.startsWith('async ') ||
         fnString.includes('async function') ||
         fnString.includes('return new Promise') ||
         fnString.includes('Promise.resolve') ||
         fnString.includes('Promise.reject');
}

/**
 * Detects if a class method is async by examining its string representation
 * @param {Object} obj The object/class instance
 * @param {string} methodName The method name to check
 * @returns {boolean} True if the method is async
 * @private
 */
function isAsyncMethod(obj, methodName) {
  if (!obj || typeof obj[methodName] !== 'function') return false;
  return isAsyncFunction(obj[methodName]);
}

/**
 * Converts modern loaders to legacy ILoader/ILoaderAsync interface
 * @param {Array} loaders Array of loaders (can be mixed modern/legacy)
 * @returns {Array} Array of loaders converted to legacy interface
 * @private
 */
function convertToLegacyLoaders(loaders) {
  return loaders.map(loader => {
    // If it's already a legacy loader, return as-is
    if (loader && typeof loader === 'object' && 'getSource' in loader) {
      return loader;
    }

    // Function-based loader
    if (typeof loader === 'function') {
      const isAsync = isAsyncFunction(loader);

      if (isAsync) {
        // Convert to ILoaderAsync
        return {
          async: true,
          getSource: (name, callback) => {
            if (callback) {
              // Callback version
              loader(name)
                .then(result => {
                  callback(null, result ? { src: result, path: name, noCache: false } : null);
                })
                .catch(err => callback(err, null));
            } else {
              // Promise version
              return loader(name).then((result) => {
                return result ? { src: result, path: name, noCache: false } : null;
              });
            }
          }
        };
      } else {
        // Convert to ILoader (sync)
        return {
          async: false,
          getSource: (name) => {
            const result = loader(name);
            return result ? { src: result, path: name, noCache: false } : null;
          }
        };
      }
    }

    // Class-based loader with load method
    if (loader && typeof loader === 'object' && typeof loader.load === 'function') {
      const isAsync = isAsyncMethod(loader, 'load');

      if (isAsync) {
        // Convert to ILoaderAsync
        return {
          async: true,
          getSource: (name, callback) => {
            if (callback) {
              // Callback version
              loader.load(name)
                .then(result => {
                  callback(null, result ? { src: result, path: name, noCache: false } : null);
                })
                .catch(err => callback(err, null));
            } else {
              // Promise version
              return loader.load(name).then((result) => {
                return result ? { src: result, path: name, noCache: false } : null;
              });
            }
          }
        };
      } else {
        // Convert to ILoader (sync)
        return {
          async: false,
          getSource: (name) => {
            const result = loader.load(name);
            return result ? { src: result, path: name, noCache: false } : null;
          }
        };
      }
    }

    // If we can't convert it, return as-is (might be legacy or invalid)
    return loader;
  });
}


module.exports = {
  loadString,
  clearStringCache,
  convertToLegacyLoaders
};
