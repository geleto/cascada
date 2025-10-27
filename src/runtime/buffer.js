'use strict';

const {
  PoisonError,
  isPoison,
  isPoisonError,
  handleError
} = require('./errors');

/**
 * Add poison markers to output buffer for handlers that would have been written
 * in a branch that wasn't executed due to poisoned condition.
 *
 * When a condition evaluates to poison (error), branches aren't executed but would
 * have written to output handlers. This function adds markers to the buffer so that
 * flattenBuffer can collect these errors.
 *
 * @param {Array} buffer - The output buffer array to add markers to
 * @param {PoisonedValue|Error} error - The poison value or error from failed condition
 * @param {Array<string>} handlerNames - Names of handlers (e.g., ['text', 'data'])
 * @param {Object} errorContext - Context object with lineno, colno, errorContextString, and path
 */
function addPoisonMarkersToBuffer(buffer, errorOrErrors, handlerNames, errorContext = null) {
  const errors = (Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors]);

  // Process errors with proper context if available
  const processedErrors = errorContext ?
    errors.map(err => handleError(err, errorContext.lineno, errorContext.colno,
      errorContext.errorContextString, errorContext.path)) :
    errors;

  // Add one marker per handler that would have been written to
  for (const handlerName of handlerNames) {
    const marker = {
      __cascadaPoisonMarker: true,  // Flag for detection in flattenBuffer
      errors: processedErrors,       // Array of Error objects to collect (now with proper context)
      handler: handlerName,        // Which handler was intended (for debugging)
    };

    buffer.push(marker);
  }
}

function flattenBuffer(arr, context = null, focusOutput = null) {
  // FAST PATH: If no context, it's a simple template. Concatenate strings and arrays.
  if (!context) {
    if (!Array.isArray(arr)) {
      return arr || '';
    }

    // Collect errors during fast path processing
    const errors = [];

    const result = arr.reduce((acc, item) => {
      // Check for poison marker first
      if (item && typeof item === 'object' && item.__cascadaPoisonMarker === true) {
        if (item.errors && Array.isArray(item.errors)) {
          errors.push(...item.errors);
        }
        return acc; // Marker consumed, don't add to output
      }

      // Check for regular PoisonedValue
      if (isPoison(item)) {
        errors.push(...item.errors);
        return acc; // Don't add poison to output
      }

      // Handle nested arrays (recursive call)
      if (Array.isArray(item)) {
        try {
          return acc + flattenBuffer(item, null, null);
        } catch (err) {
          // Child array had poison errors
          if (isPoisonError(err)) {
            errors.push(...err.errors);
          } else {
            errors.push(err);
          }
          return acc;
        }
      }

      // Handle post-processing functions (e.g., SafeString wrapper)
      if (typeof item === 'function') {
        return (item(acc) || '');
      }

      // Regular value
      return acc + ((item !== null && item !== undefined) ? item : '');
    }, '');

    // If any errors collected, throw them
    if (errors.length > 0) {
      throw new PoisonError(errors);
    }

    return result;
  }

  // Script processing path with poison detection
  const env = context.env;
  const textOutput = [];
  const handlerInstances = {};
  const collectedErrors = []; // Collect ALL errors from poison values

  // Validate focusOutput handler exists if specified
  if (focusOutput) {
    const handlerExists = focusOutput === 'text' ||
                         env.commandHandlerInstances[focusOutput] ||
                         env.commandHandlerClasses[focusOutput];
    if (!handlerExists) {
      throw new Error(`Data output focus target not found: '${focusOutput}'`);
    }
  }

  function getOrInstantiateHandler(handlerName) {
    if (handlerInstances[handlerName]) {
      return handlerInstances[handlerName];
    }
    if (env.commandHandlerInstances[handlerName]) {
      const instance = env.commandHandlerInstances[handlerName];
      if (typeof instance._init === 'function') {
        instance._init(context.getVariables());
      }
      handlerInstances[handlerName] = instance;
      return instance;
    }
    if (env.commandHandlerClasses[handlerName]) {
      const HandlerClass = env.commandHandlerClasses[handlerName];
      // For DataHandler, pass the environment; for other handlers, pass context variables
      const instance = new HandlerClass(context.getVariables(), env);
      handlerInstances[handlerName] = instance;
      return instance;
    }
    return null;
  }

  // Helper to safely get position info
  function getPosition(item) {
    if (item && item.pos) {
      return { lineno: item.pos.lineno || 0, colno: item.pos.colno || 0 };
    }
    return { lineno: 0, colno: 0 };
  }

  function processItem(item) {
    // Check for poison marker FIRST (before any other processing)
    // Markers are objects with a special flag indicating poisoned handler output
    if (item && typeof item === 'object' && item.__cascadaPoisonMarker === true) {
      // This marker indicates a handler would have been written to if condition succeeded
      // Collect the errors from the marker
      if (item.errors && Array.isArray(item.errors)) {
        collectedErrors.push(...item.errors);
      }
      return; // Marker is consumed, don't process further
    }

    if (item === null || item === undefined) return;

    // Check for regular poison value
    if (isPoison(item)) {
      collectedErrors.push(...item.errors);
      return; // Continue to find all errors
    }

    if (Array.isArray(item)) {
      const last = item.length > 0 ? item[item.length - 1] : null;

      // Handle arrays with a post-processing function (e.g., from auto-escaping).
      if (typeof last === 'function') {
        const subArray = item.slice(0, -1);

        // This helper function flattens an array of stringifiable items.
        // It's a simplified version of the main buffer flattening and assumes
        // no command objects are present in such arrays.
        function _flattenStringifiable(subArr) {
          const subErrors = [];
          const result = subArr.reduce((acc, current) => {
            // Check for poison in sub-arrays
            if (isPoison(current)) {
              subErrors.push(...current.errors);
              return acc;
            }
            if (Array.isArray(current)) {
              return acc + _flattenStringifiable(current);
            }
            return acc + ((current !== null && current !== undefined) ? current : '');
          }, '');

          if (subErrors.length > 0) {
            collectedErrors.push(...subErrors);
          }

          return result;
        }

        const subResult = _flattenStringifiable(subArray);
        const finalResult = last(subResult);
        // The result of the function (e.g., a SafeString) needs to be processed.
        processItem(finalResult);
      } else {
        // Standard array: process each item.
        item.forEach(processItem);
      }
      return;
    }

    // Process command object from compiler
    if (typeof item === 'object' && (item.method || item.handler !== undefined)) {
      // Function Command: @handler.cmd(), @callableHandler()
      const handlerName = item.handler;
      const commandName = item.command;
      const subpath = item.subpath;
      const args = item.arguments;
      const pos = getPosition(item);

      if (!handlerName || handlerName === 'text') {
        // Check args for poison before adding to output
        for (const arg of args) {
          if (isPoison(arg)) {
            collectedErrors.push(...arg.errors);
            return; // Don't add poisoned output
          }
        }
        textOutput.push(...args);
      } else {
        // Check args for poison
        for (const arg of args) {
          if (isPoison(arg)) {
            collectedErrors.push(...arg.errors);
            return; // Don't call handler with poisoned args
          }
        }

        try {
          const handlerInstance = getOrInstantiateHandler(handlerName);

          if (!handlerInstance) {
            const err1 = handleError(
              new Error(`Unknown command handler: ${handlerName}`),
              pos.lineno,
              pos.colno,
              `@${handlerName}`,
              context ? context.path : null
            );
            collectedErrors.push(err1);
            return;
          }

          // Navigate through subpath properties to reach the final target
          let targetObject = handlerInstance;
          if (subpath && subpath.length > 0) {
            for (const pathSegment of subpath) {
              if (targetObject && typeof targetObject === 'object' && targetObject !== null) {
                targetObject = targetObject[pathSegment];
              } else {
                const err2 = handleError(
                  new Error(`Cannot access property '${pathSegment}' on ${typeof targetObject} in handler '${handlerName}'`),
                  pos.lineno,
                  pos.colno,
                  `@${handlerName}${subpath ? '.' + subpath.slice(0, subpath.indexOf(pathSegment) + 1).join('.') : ''}`,
                  context ? context.path : null
                );
                collectedErrors.push(err2);
                return;
              }
            }
          }

          const commandFunc = commandName ? targetObject[commandName] : targetObject;

          // if no command name is provided, use the handler itself as the command
          if (typeof commandFunc === 'function') {
            // Found a method on the handler: @turtle.forward() or the handler itself is a function @log()
            commandFunc.apply(targetObject, args);
          } else if (!commandName) {
            // The handler may be a Proxy
            try {
              //the handler may be a Proxy
              commandFunc(...args);
            } catch (e) {
              const err3 = handleError(
                new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} is not callable`),
                pos.lineno,
                pos.colno,
                `@${handlerName}${subpath ? '.' + subpath.join('.') : ''}`,
                context ? context.path : null
              );
              collectedErrors.push(err3);
            }
          } else {
            const err5 = handleError(
              new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}'`),
              pos.lineno,
              pos.colno,
              `@${handlerName}${subpath ? '.' + subpath.join('.') : ''}${commandName ? '.' + commandName : ''}`,
              context ? context.path : null
            );
            collectedErrors.push(err5);
          }
        } catch (err) {
          const wrappedErr = handleError(err, pos.lineno, pos.colno, `@${handlerName}${subpath ? '.' + subpath.join('.') : ''}${commandName ? '.' + commandName : ''}`, context ? context.path : null);
          collectedErrors.push(wrappedErr);
        }
      }
      return;
    }

    // Default: literal value for text output
    textOutput.push(item);
  }

  // Process all items (don't short-circuit on errors)
  arr.forEach(processItem);

  // Check if any errors were collected
  if (collectedErrors.length > 0) {
    throw new PoisonError(collectedErrors);
  }

  // Assemble the final result object
  const finalResult = {};

  const textResult = textOutput.join('');
  if (textResult) finalResult.text = textResult;

  // Add handler return values to the result
  Object.keys(handlerInstances).forEach(handlerName => {
    const handler = handlerInstances[handlerName];
    if (typeof handler.getReturnValue === 'function') {
      finalResult[handlerName] = handler.getReturnValue();
    } else {
      finalResult[handlerName] = handler;
    }
  });

  // Handle focused output
  if (focusOutput) {
    return finalResult[focusOutput];
  }

  return finalResult;
}

module.exports = {
  addPoisonMarkersToBuffer,
  flattenBuffer
};
