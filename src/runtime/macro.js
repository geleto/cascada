'use strict';

function makeMacro(argNames, kwargNames, func, useAsyncMacroSignature = false) {
  const invokeCompiledMacro = function invokeCompiledMacro(executionContext, macroArgs, currentBuffer = null) {
    var argCount = numArgs(macroArgs);
    var args;
    var kwargs = getKeywordArgs(macroArgs);

    if (argCount > argNames.length) {
      args = macroArgs.slice(0, argNames.length);

      // Positional arguments that should be passed in as keyword arguments.
      macroArgs.slice(args.length, argCount).forEach((val, i) => {
        if (i < kwargNames.length) {
          kwargs[kwargNames[i]] = val;
        }
      });
      args.push(kwargs);
    } else if (argCount < argNames.length) {
      args = macroArgs.slice(0, argCount);

      for (let i = argCount; i < argNames.length; i++) {
        const arg = argNames[i];

        args.push(kwargs[arg]);
        delete kwargs[arg];
      }
      args.push(kwargs);
    } else {
      args = macroArgs;
      if (useAsyncMacroSignature && Object.keys(kwargs).length === 0) {
        args.push({});
      }
    }

    if (useAsyncMacroSignature) {
      args.push(currentBuffer);
    }
    return func.apply(executionContext, args);
  };

  const macro = function macro(...macroArgs) {
    return invokeCompiledMacro(this, macroArgs, null);
  };
  macro.isMacro = true;
  macro._invoke = invokeCompiledMacro;
  return macro;
}

function invokeMacro(macro, executionContext, args, currentBuffer = null) {
  if (macro && typeof macro._invoke === 'function') {
    return macro._invoke(executionContext, args, currentBuffer);
  }
  return macro.apply(executionContext, args);
}

function withPath(context, path, func) {
  const executionContext = (path && context.path !== path) ? context.forkForPath(path) : context;
  return func.call(executionContext);
}

function makeKeywordArgs(obj) {
  obj.__keywords = true;
  return obj;
}

function isKeywordArgs(obj) {
  return obj && Object.prototype.hasOwnProperty.call(obj, '__keywords');
}

function getKeywordArgs(args) {
  var len = args.length;
  if (len) {
    const lastArg = args[len - 1];
    if (isKeywordArgs(lastArg)) {
      return lastArg;
    }
  }
  return {};
}

function numArgs(args) {
  var len = args.length;
  if (len === 0) {
    return 0;
  }

  const lastArg = args[len - 1];
  if (isKeywordArgs(lastArg)) {
    return len - 1;
  } else {
    return len;
  }
}

export { makeMacro, invokeMacro, withPath, makeKeywordArgs, numArgs };
