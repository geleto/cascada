module.exports = {
  /**
   * Appends an element to an array. This is an in-place mutation.
   * Corresponds to the Cascada command: `@push path value`
   *
   * @param {Array<any>} target The array at the specified `path`.
   * @param {any} value The value to append to the array.
   */
  push: (target, value) => {
    if (Array.isArray(target)) {
      target.push(value);
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
  merge: (target, value) => {
    if (typeof target === 'object' && target !== null && !Array.isArray(target) && typeof value === 'object' && value !== null) {
      Object.assign(target, value);
    } else {
      throw new Error('Error: Both target and value for \'merge\' must be non-null objects.');
    }
  },

  /**
   * Removes the last element from an array. This is an in-place mutation.
   * The `value` argument is ignored for this operation.
   * Corresponds to the Cascada command: `@pop path`
   *
   * @param {Array<any>} target The array at the specified `path`.
   */
  pop: (target) => {
    if (Array.isArray(target)) {
      target.pop();
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
  shift: (target) => {
    if (Array.isArray(target)) {
      target.shift();
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
  unshift: (target, value) => {
    if (Array.isArray(target)) {
      target.unshift(value);
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
  reverse: (target) => {
    if (Array.isArray(target)) {
      target.reverse();
    } else {
      throw new Error('Error: Target for \'reverse\' must be an array.');
    }
  },

  /**
   * Appends a value to the content at a path.
   * Corresponds to the Cascada command: `@print path value`
   * - If the target is a string, it returns a new concatenated string. The Cascada
   *   engine must handle this return value to update the data structure, as
   *   JavaScript strings are immutable.
   * - If the target is an array, it pushes the value (in-place mutation).
   *
   * @param {string|Array<any>} target The string or array at the specified `path`.
   * @param {any} value The value to append or push.
   * @returns {string|undefined} The new concatenated string if the target was a string, otherwise undefined.
   */
  print: (target, value) => {
    if (typeof target === 'string') {
      return target + String(value);
    }
    if (Array.isArray(target)) {
      target.push(value);
      return; // Explicitly return undefined for in-place mutation
    }
    throw new Error('Error: Target for \'print\' must be a string or an array.');
  }
};
