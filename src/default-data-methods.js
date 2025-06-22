module.exports = {
  /**
   * Appends an element to an array. This is an in-place mutation.
   * Corresponds to the Cascada command: `@push path value`
   *
   * @param {Array<any>} target The array at the specified `path`.
   * @param {any} value The value to append to the array.
   */
  push : function(target, value) {
    if (target === undefined) {
      target = [];
    }
    if (Array.isArray(target)) {
      target.push(value);
      return target;
    } else {
      throw new Error('Error: Target for \'push\' must be an array.');
    }
  },

  /**
   * Merges properties from a source object into a target object. This is an in-place mutation.
   * Corresponds to the Cascada command: `@merge path value`
   *
   * @param {Object} target The target object at the specified `path`.
   * @param {Object} value The source object whose properties will be merged.
   */
  merge : function(target, value) {
    if (target === undefined) {
      return value;
    }
    if (typeof target === 'object' && target !== null && !Array.isArray(target) && typeof value === 'object' && value !== null) {
      Object.assign(target, value);
      return target;
    } else {
      throw new Error('Error: Both target and value for \'merge\' must be non-null objects.');
    }
  },

  /**
   * Recursively merges properties from a source object into a target object. This is an in-place mutation.
   * If a key exists in both objects and both values are objects, it will merge them recursively.
   * Otherwise, the value from the source will overwrite the value in the target.
   * Arrays from the source will replace arrays in the target.
   * Corresponds to the Cascada command: `@deepMerge path value`
   *
   * @param {Object} target The target object at the specified `path` that will be mutated.
   * @param {Object} value The source object whose properties will be merged.
   */
  deepMerge : function(target, value) {
    if (target === undefined) {
      return value;
    }
    const isObject = (item) => {
      return (item && typeof item === 'object' && !Array.isArray(item));
    };

    if (!value) {
      throw new Error('Error: Value for \'deepMerge\' must be a non-null object.');
    }
    if (!isObject(value)) {
      throw new Error(`Error: Value for \'deepMerge\' can not be ${typeof value}.`);
    }
    if (!isObject(target)) {
      throw new Error(`Error: Target for \'deepMerge\' can not be ${typeof target}.`);
    }

    for (const key in value) {
      // We only want to merge own properties from the source
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const targetValue = target[key];
        const sourceValue = value[key];

        // If both the target and source values for this key are objects, recurse
        if (isObject(targetValue) && isObject(sourceValue)) {
          // 'this' refers to the module.exports object, allowing the recursive call
          this.deepMerge(targetValue, sourceValue);
        } else {
          // Otherwise, just assign the source value to the target.
          // This will overwrite primitives or arrays, or set new properties.
          target[key] = sourceValue;
        }
      }
    }
    return target;
  },

  /**
   * Removes the last element from an array. This is an in-place mutation.
   * The `value` argument is ignored for this operation.
   * Corresponds to the Cascada command: `@pop path`
   *
   * @param {Array<any>} target The array at the specified `path`.
   */
  pop : function(target) {
    if (target === undefined) {
      return [];
    }
    if (Array.isArray(target)) {
      target.pop();
      return target;
    } else {
      throw new Error('Error: Target for \'pop\' must be an array.');
    }
  },

  /**
   * Removes the first element from an array. This is an in-place mutation.
   * The `value` argument is ignored for this operation.
   * Corresponds to the Cascada command: `@shift path`
   *
   * @param {Array<any>} target The array at the specified `path`.
   */
  shift : function(target) {
    if (target === undefined) {
      return [];
    }
    if (Array.isArray(target)) {
      target.shift();
      return target;
    } else {
      throw new Error('Error: Target for \'shift\' must be an array.');
    }
  },

  /**
   * Adds an element to the beginning of an array. This is an in-place mutation.
   * Corresponds to the Cascada command: `@unshift path value`
   *
   * @param {Array<any>} target The array at the specified `path`.
   * @param {any} value The value to add to the beginning of the array.
   */
  unshift : function(target, value) {
    if (target === undefined) {
      target = [];
    }
    if (Array.isArray(target)) {
      target.unshift(value);
      return target;
    } else {
      throw new Error('Error: Target for \'unshift\' must be an array.');
    }
  },

  /**
   * Reverses the order of the elements in an array. This is an in-place mutation.
   * The `value` argument is ignored for this operation.
   * Corresponds to the Cascada command: `@reverse path`
   *
   * @param {Array<any>} target The array at the specified `path`.
   */
  reverse : function(target) {
    if (target === undefined) {
      return [];
    }
    if (Array.isArray(target)) {
      target.reverse();
      return target;
    } else {
      throw new Error('Error: Target for \'reverse\' must be an array.');
    }
  },

  /**
   * Replaces target with value
   * @param {Object | Array | string} target The target object at the specified `path`.
   * @param {Object | Array |string} value The source object to replace the target.
   * @returns {Object | Array | string} The target
   */
  put : function(target, value) {
    return value;
  },

  /**
   * Appends a value to the content at a path.
   * Corresponds to the Cascada command: `@print path value`
   * - If the target is a string, it returns a new concatenated string.
   * - If the target is an array, it pushes the value (in-place mutation).
   *
   * @param {string|Array<any>} target The string or array at the specified `path`.
   * @param {any} value The value to append or push.
   * @returns {string|undefined} The new concatenated string if the target was a string, otherwise just the target.
   */
  print : function(target, value) {
    if (target === undefined) {
      target = '';
    }
    if (typeof target === 'string') {
      return target + String(value);
    }
    if (Array.isArray(target)) {
      target.push(value);
      return target;
    }
    throw new Error('Error: Target for \'print\' must be a string or an array.');
  },

  /**
   * Appends a value to a string. Returns a new concatenated string.
   * Corresponds to the Cascada command: `@append path value`
   *
   * @param {string} target The string at the specified `path`.
   * @param {any} value The value to append to the string.
   * @returns {string} The new concatenated string.
   */
  append : function(target, value) {
    if (target === undefined) {
      target = '';
    }
    if (typeof target === 'string') {
      return target + String(value);
    } else {
      throw new Error('Error: Target for \'append\' must be a string.');
    }
  }
};
