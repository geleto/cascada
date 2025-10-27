'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError,
  collectErrors
} = require('./errors');

// It's ok to use consequitive awaits when promises have been already in progress by the time you start awaiting them,
// Thus using sequential await in a loop does not introduce significant delays compared to Promise.all.
// not so if the promise is cteated right before the await, e.g. await fetch(url)
async function resolveAll(args) {
  // Collect all errors first (awaits all promises)
  const errors = await collectErrors(args);

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - proceed with normal resolution
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];

    if (arg && typeof arg.then === 'function') {
      try {
        arg = await arg;
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }

    if (Array.isArray(arg)) {
      try {
        arg = await deepResolveArray(arg);
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    } else if (isPlainObject(arg)) {
      try {
        arg = await deepResolveObject(arg);
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }

    resolvedArgs.push(arg);
  }

  return resolvedArgs;
}

//@todo - use this much more sparingly
async function deepResolveArray(arr) {
  const errors = [];

  for (let i = 0; i < arr.length; i++) {
    let resolvedItem = arr[i];

    if (isPoison(resolvedItem)) {
      errors.push(...resolvedItem.errors);
      continue; // Continue to collect all errors
    }

    if (resolvedItem && typeof resolvedItem.then === 'function') {
      try {
        resolvedItem = await resolvedItem;
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    }

    if (isPoison(resolvedItem)) {
      errors.push(...resolvedItem.errors);
      continue;
    }

    if (Array.isArray(resolvedItem)) {
      try {
        resolvedItem = await deepResolveArray(resolvedItem);
        // If deepResolveArray returns a poison, awaiting it throws PoisonError
        // So we won't reach this line - the catch below handles it
      } catch (err) {
        // If awaiting a poison value, err is PoisonError with errors array
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    } else if (isPlainObject(resolvedItem)) {
      try {
        resolvedItem = await deepResolveObject(resolvedItem);
        // If deepResolveObject returns a poison, awaiting it throws PoisonError
        // So we won't reach this line - the catch below handles it
      } catch (err) {
        // If awaiting a poison value, err is PoisonError with errors array
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    }

    arr[i] = resolvedItem;
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }

  return arr;
}

// @todo - use this much more sparringly, only for arguments and output
async function deepResolveObject(target) {
  // Await the primary target if it's a promise.
  const obj = target && typeof target.then === 'function' ? await target : target;
  // Primitives and null cannot be resolved further.
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const errors = [];

  if (Array.isArray(obj)) {
    try {
      return await deepResolveArray(obj);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      throw err;
    }
  } else if (isPlainObject(obj)) {
    // --- Plain Object Handling ---
    // Use getOwnPropertyDescriptors to safely inspect properties without
    // triggering getters.
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    const resolutionPromises = [];

    for (const key in descriptors) {
      const descriptor = descriptors[key];

      // We only care about simple data properties.
      // Ignore getters, setters, and non-enumerable properties.
      if ('value' in descriptor) {//@todo - the valie must be an object
        if (descriptor.value && typeof descriptor.value === 'object') {
          const promise = (async () => {
            try {
              const resolvedValue = await deepResolveObject(descriptor.value);

              if (obj[key] !== resolvedValue) {
                obj[key] = resolvedValue;
              }
            } catch (err) {
              if (isPoisonError(err)) {
                errors.push(...err.errors);
              } else {
                errors.push(err);
              }
            }
          })();

          resolutionPromises.push(promise);
        }
      }
    }

    await Promise.all(resolutionPromises);

    if (errors.length > 0) {
      return createPoison(errors);
    }
  }

  return obj;
}

// @todo - instead of this - check for objects or properties created by cascada
// we shall keep track of them, deep resolve has to be less intrusive
function isPlainObject(value) {
  // Basic checks for non-objects and null
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  let proto = Object.getPrototypeOf(value);

  // An object with no prototype (e.g., Object.create(null)) is plain.
  if (proto === null) {
    return true;
  }

  // Find the top-most prototype in the chain.
  let baseProto = proto;
  while (Object.getPrototypeOf(baseProto) !== null) {
    baseProto = Object.getPrototypeOf(baseProto);
  }

  // If the top-most prototype is the one from our original object,
  // it means it's a direct instance of Object.
  // This check correctly identifies objects created via `{...}` or `new Object()`
  // and excludes instances of any other class (e.g., new MyClass(), ReadableStream).
  return baseProto === proto;
}

async function resolveObjectProperties(obj) {
  const errors = await collectErrors(Object.values(obj));

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  for (const key in obj) {
    if (obj[key] && typeof obj[key].then === 'function') {
      try {
        obj[key] = await obj[key];
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }

    // Deep resolve if the value is an array or plain object
    if (Array.isArray(obj[key])) {
      try {
        obj[key] = await deepResolveArray(obj[key]);
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    } else if (isPlainObject(obj[key])) {
      try {
        obj[key] = await deepResolveObject(obj[key]);
      } catch (err) {
        if (isPoisonError(err)) {
          return createPoison(err.errors);
        }
        throw err;
      }
    }
  }

  return obj;
}

async function resolveDuo(...args) {
  return resolveAll(args);
}

async function resolveSingle(value) {
  // Synchronous shortcuts
  if (isPoison(value)) {
    return value; // Propagate poison synchronously
  }

  if (!value || typeof value.then !== 'function') {
    return {
      then(onFulfilled) {
        return onFulfilled ? onFulfilled(value) : value;
      }
    };
  }

  // Await promise, convert rejections to poison
  let resolvedValue;
  try {
    resolvedValue = await value;
  } catch (err) {
    // Note: This is called from various contexts; error position added upstream
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    return createPoison(err);
  }

  // Check if resolved to poison
  if (isPoison(resolvedValue)) {
    return resolvedValue;
  }

  // Deep resolve arrays/objects, collecting any errors
  if (Array.isArray(resolvedValue)) {
    const errors = await collectErrors(resolvedValue);
    if (errors.length > 0) {
      return createPoison(errors); // Errors already have position info from collectErrors
    }
    try {
      resolvedValue = await deepResolveArray(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors); // Errors already have position info
      }
      throw err;
    }
  } else if (isPlainObject(resolvedValue)) {
    const errors = await collectErrors(Object.values(resolvedValue));
    if (errors.length > 0) {
      return createPoison(errors); // Errors already have position info from collectErrors
    }
    try {
      resolvedValue = await deepResolveObject(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors); // Errors already have position info
      }
      throw err;
    }
  }

  return resolvedValue;
}

async function resolveSingleArr(value) {
  try {
    const resolved = await resolveSingle(value);
    return [resolved];
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    throw err;
  }
}

function resolveArguments(fn, skipArguments = 0) {
  return async function (...args) {
    const skippedArgs = args.slice(0, skipArguments);
    const remainingArgs = args.slice(skipArguments);
    await resolveAll(remainingArgs);
    const finalArgs = [...skippedArgs, ...remainingArgs];

    return fn.apply(this, finalArgs);
  };
}

module.exports = {
  resolveAll,
  resolveDuo,
  resolveSingle,
  resolveSingleArr,
  resolveObjectProperties,
  resolveArguments,
  deepResolveArray,
  deepResolveObject,
  isPlainObject
};
