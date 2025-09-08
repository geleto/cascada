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

  for (const currentLoader of loaders) {
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


module.exports = {
  loadString,
  clearStringCache
};
