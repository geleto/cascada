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
  set : function(target, value) {
    return value;
  },

  /**
   * Appends a value to the content at a path.
   * Corresponds to the Cascada command: `@text path value`
   * - If the target is a string, it returns a new concatenated string.
   * - If the target is an array, it pushes the value (in-place mutation).
   *
   * @param {string|Array<any>} target The string or array at the specified `path`.
   * @param {any} value The value to append or push.
   * @returns {string|undefined} The new concatenated string if the target was a string, otherwise just the target.
   */
  text : function(target, value) {
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
    throw new Error('Error: Target for \'text\' must be a string or an array.');
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
  },

  /**
   * Adds values together. If the target is a number, performs arithmetic addition.
   * If the target is a string, appends the value to the string.
   * Corresponds to the Cascada command: `@add path value`
   *
   * @param {number|string} target The number or string at the specified `path`.
   * @param {any} value The value to add or append.
   * @returns {number|string} The result of the addition or concatenation.
   */
  add : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'add\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target + Number(value);
    } else if (typeof target === 'string') {
      return target + String(value);
    } else {
      throw new Error('Error: Target for \'add\' must be a number or string.');
    }
  },

  /**
   * Subtracts a value from the target. Arithmetic-only operation.
   * Corresponds to the Cascada command: `@subtract path value`
   *
   * @param {number} target The number at the specified `path`.
   * @param {any} value The value to subtract from the target.
   * @returns {number} The result of the subtraction.
   */
  subtract : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'subtract\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target - Number(value);
    } else {
      throw new Error('Error: Target for \'subtract\' must be a number.');
    }
  },

  /**
   * Increments the target by 1. Arithmetic-only operation.
   * Corresponds to the Cascada command: `@increment path`
   *
   * @param {number} target The number at the specified `path`.
   * @returns {number} The incremented value.
   */
  increment : function(target) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'increment\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target + 1;
    } else {
      throw new Error('Error: Target for \'increment\' must be a number.');
    }
  },

  /**
   * Decrements the target by 1. Arithmetic-only operation.
   * Corresponds to the Cascada command: `@decrement path`
   *
   * @param {number} target The number at the specified `path`.
   * @returns {number} The decremented value.
   */
  decrement : function(target) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'decrement\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target - 1;
    } else {
      throw new Error('Error: Target for \'decrement\' must be a number.');
    }
  },

  /**
   * Multiplies the target by a value. Arithmetic-only operation.
   * Corresponds to the Cascada command: `@multiply path value`
   *
   * @param {number} target The number at the specified `path`.
   * @param {any} value The value to multiply by.
   * @returns {number} The result of the multiplication.
   */
  multiply : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'multiply\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target * Number(value);
    } else {
      throw new Error('Error: Target for \'multiply\' must be a number.');
    }
  },

  /**
   * Divides the target by a value. Arithmetic-only operation.
   * Corresponds to the Cascada command: `@divide path value`
   *
   * @param {number} target The number at the specified `path`.
   * @param {any} value The value to divide by.
   * @returns {number} The result of the division.
   */
  divide : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'divide\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      const divisor = Number(value);
      if (divisor === 0) {
        throw new Error('Error: Division by zero is not allowed.');
      }
      return target / divisor;
    } else {
      throw new Error('Error: Target for \'divide\' must be a number.');
    }
  },

  /**
   * Performs logical AND operation using JavaScript && operator.
   * Corresponds to the Cascada command: `@and path value`
   *
   * @param {any} target The value at the specified `path`.
   * @param {any} value The value to perform AND operation with.
   * @returns {any} The result of the logical AND operation.
   */
  and : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'and\' cannot be undefined or null.');
    }
    return target && value;
  },

  /**
   * Performs logical OR operation using JavaScript || operator.
   * Corresponds to the Cascada command: `@or path value`
   *
   * @param {any} target The value at the specified `path`.
   * @param {any} value The value to perform OR operation with.
   * @returns {any} The result of the logical OR operation.
   */
  or : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'or\' cannot be undefined or null.');
    }
    return target || value;
  },

  /**
   * Performs bitwise AND operation using JavaScript & operator.
   * Corresponds to the Cascada command: `@bitAnd path value`
   *
   * @param {number} target The number at the specified `path`.
   * @param {any} value The value to perform bitwise AND operation with.
   * @returns {number} The result of the bitwise AND operation.
   */
  bitAnd : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'bitAnd\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target & Number(value);
    } else {
      throw new Error('Error: Target for \'bitAnd\' must be a number.');
    }
  },

  /**
   * Performs bitwise OR operation using JavaScript | operator.
   * Corresponds to the Cascada command: `@bitOr path value`
   *
   * @param {number} target The number at the specified `path`.
   * @param {any} value The value to perform bitwise OR operation with.
   * @returns {number} The result of the bitwise OR operation.
   */
  bitOr : function(target, value) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'bitOr\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return target | Number(value);
    } else {
      throw new Error('Error: Target for \'bitOr\' must be a number.');
    }
  },

  /**
   * Performs bitwise NOT operation using JavaScript ~ operator.
   * Corresponds to the Cascada command: `@bitNot path`
   *
   * @param {number} target The number at the specified `path`.
   * @returns {number} The result of the bitwise NOT operation.
   */
  bitNot : function(target) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'bitNot\' cannot be undefined or null.');
    }
    if (typeof target === 'number') {
      return ~target;
    } else {
      throw new Error('Error: Target for \'bitNot\' must be a number.');
    }
  },

  /**
   * Performs logical NOT operation using JavaScript ! operator.
   * Corresponds to the Cascada command: `@not path`
   *
   * @param {any} target The value at the specified `path`.
   * @returns {boolean} The result of the logical NOT operation.
   */
  not : function(target) {
    if (target === undefined || target === null) {
      throw new Error('Error: Target for \'not\' cannot be undefined or null.');
    }
    return !target;
  },

  /**
   * Returns undefined, effectively deleting the target.
   * Corresponds to the Cascada command: `@delete path`
   *
   * @param {any} target The value at the specified `path` (ignored).
   * @returns {undefined} Always returns undefined.
   */
  delete : function(target) {
    return undefined;
  }
};
