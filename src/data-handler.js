/**
 * DataHandler class manages the assembly of the script's data object.
 * It encapsulates all data-assembly logic and path traversal for output commands.
 */
class DataHandler {
  /**
   * Creates a new DataHandler instance.
   * @param {Object} _context - The context object containing the script variables
   * @param {AsyncEnvironment} env - The AsyncEnvironment instance containing custom data methods.
   */
  constructor(_context, env) {
    // Initialize empty data store
    // @todo - add the default methods to the prototype
    this.data = {};

    // Load default data methods
    const methods = require('./default-data-methods');

    // Register default methods
    Object.keys(methods).forEach(methodName => {
      this.addMethod(methodName, methods[methodName]);
    });

    // Register custom methods from the environment
    if (env && env.customDataMethods) {
      Object.keys(env.customDataMethods).forEach(methodName => {
        this.addMethod(methodName, env.customDataMethods[methodName]);
      });
    }
  }

  /**
   * Adds a method to the handler instance.
   * @param {string} name - The method name.
   * @param {Function} func - The function to register.
   */
  addMethod(name, func) {
    // Create a wrapper that handles path traversal and argument conversion
    this[name] = function (path, ...args) {

      // Special case: null path or [null] means we're working on the root object itself
      if (path === null || (Array.isArray(path) && path.length === 1 && path[0] === null)) {
        // Replace this data with the return
        this.data = func.apply(this.methods, [this.data, ...args]);
        return this.data;
      }

      // Find the target location in the data object
      const { target, key } = this._findPathTarget(this.data, path);

      // Get the current value at the target location
      const currentValue = target[key];

      // Call the original method with the correct context and arguments
      const result = func.apply(this.methods, [currentValue, ...args]);

      // Update the target with the result, delete if undefined
      if (result !== undefined) {
        target[key] = result;
      } else {
        delete target[key];
      }

      return result;
    };

    // Store the original methods object for context
    if (!this.methods) {
      this.methods = {};
    }
    this.methods[name] = func;
  }

  /**
   * Traverses the data object using the provided path and returns the target location.
   * Creates intermediate objects/arrays as needed.
   * @param {Object} root - The root object to traverse.
   * @param {Array} path - The path array to traverse. An empty array or [null] represents the root.
   * @returns {Object} Object containing { target, key } for the final location.
   */
  _findPathTarget(root, path) {
    // Special case: empty path or [null] means we're working on the root object itself
    if (path.length === 0 || (path.length === 1 && path[0] === null)) {
      return { target: root, key: null };
    }

    let parent = null;
    let current = root;
    let key = path[0];

    for (let i = 0; i < path.length; i++) {
      key = path[i];

      if (key === '[]') {
        if (!Array.isArray(current)) {
          throw new Error(`Path target for '[]' is not an array.`);
        }
        key = current.length - 1;
        if (key === -1) {
          throw new Error(`Cannot set last element ('[]') on empty array.`);
        }
      }

      const keyType = typeof key;
      if (keyType !== 'string' && keyType !== 'number') {
        const pathString = path.slice(0, i).join('.');
        throw new Error(
          `Invalid path segment for Output Command. Expected a string or number but got a ${keyType} ([${key}]) in path '${pathString}[...]'`
        );
      }

      parent = current;

      if (current === null || typeof current === 'undefined') {
        throw new Error(`Cannot set property '${key}' on null or undefined path segment.`);
      }

      // If we're not at the end of the path and the next key doesn't exist, create it.
      if (typeof current[key] === 'undefined' && i < path.length - 1) {
        // If the next path segment looks like an array index, create an array.
        // Otherwise, create an object.
        const nextKey = path[i + 1];
        if (nextKey === '[]') {
          throw new Error(`Cannot set last element ('[]') on null or undefined path segment.`);
        }
        current[key] = (typeof nextKey === 'number' || nextKey === '[]') ? [] : {};
      }
      current = current[key];
    }
    return { target: parent, key };
  }

  /**
   * Returns the assembled data object.
   * @returns {Object} The final data structure.
   */
  getReturnValue() {
    return this.data;
  }
}

module.exports = DataHandler;
