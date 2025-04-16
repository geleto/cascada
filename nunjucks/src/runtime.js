'use strict';

var lib = require('./lib');
var arrayFrom = Array.from;
var supportsIterators = (
  typeof Symbol === 'function' && Symbol.iterator && typeof arrayFrom === 'function'
);


// Frames keep track of scoping both at compile-time and run-time so
// we know how to access variables. Block tags can introduce special
// variables, for example.
class Frame {
  //isolateWrites - disables writing to parent frames
  constructor(parent, isolateWrites) {
    this.variables = Object.create(null);
    this.parent = parent;
    this.topLevel = false;
    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;
  }

  set(name, val, resolveUp) {
    // Allow variables with dots by automatically creating the
    // nested structure
    var parts = name.split('.');
    var obj = this.variables;
    var frame = this;

    if (resolveUp) {
      if ((frame = this.resolve(parts[0], true))) {
        frame.set(name, val);
        return;
      }
    }

    for (let i = 0; i < parts.length - 1; i++) {
      const id = parts[i];

      if (!obj[id]) {
        obj[id] = {};
      }
      obj = obj[id];
    }

    obj[parts[parts.length - 1]] = val;
  }

  get(name) {
    var val = this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return null;
  }

  lookup(name) {
    var p = this.parent;
    var val = this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return p && p.lookup(name);
  }

  resolve(name, forWrite) {
    var p = (forWrite && this.isolateWrites) ? undefined : this.parent;
    var val = this.variables[name];
    if (val !== undefined) {
      return this;
    }
    return p && p.resolve(name);
  }

  push(isolateWrites) {
    return new Frame(this, isolateWrites);
  }

  pop() {
    return this.parent;
  }

  new() {
    return new Frame();//undefined, this.isolateWrites);
  }
}

class AsyncFrame extends Frame {
  constructor(parent, isolateWrites, createScope = true) {
    super(parent, isolateWrites);

    this.createScope = createScope;

    if (AsyncFrame.inCompilerContext) {
      //holds the names of the variables declared at the frame
      this.declaredVars = undefined;

      //holds the write counts for each variable that CAN be modified by an async block or its children
      //this includes variables that are modified in branches that are not taken (e.g. count both sides of an if)
      //the counts are propagated upwards before the frame that has declared the variable
      //passed as argument to pushAsyncBlock in the template source
      this.writeCounts = undefined;

      //holds the names of the variables that are read in the frame or its children
      //used when making a snapshot of the frame state when entering an async block
      //passed as argument to pushAsyncBlock in the template source
      this.readVars = undefined;

    } else {
      //when an async block is entered, it creates a promise for all variables that it or it's children modify
      //the value of the variable in the parent(an asyncVar if it's async block, regular var with frame.set otherwise) is changed to the promise
      //the promise is resolved when the block is done modifying the variable and the value is set to the final value
      this.promiseResolves = undefined;

      //holds the write counters for each variable that is modified in an async block or its children
      //the variable name is the key and the value is the number of remaining writes (including missed writes due to branches)
      //once the counter reaches 0, the promise for the variable is resolved and the parent write counter is decremented by 1
      this.writeCounters = undefined;

      //holds the variables that are modified in an async block frame while it is active
      //once the block is done modifying a variable, the promise for the variable is resolved with this value
      //asyncVars[varName] is only used if the variable is not stored in the frame scope
      this.asyncVars = undefined;
    }

    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;

    this.isAsyncBlock = false;//not used
  }

  static inCompilerContext = false;

  new() {
    return new AsyncFrame();//undefined, this.isolateWrites);
  }

  //@todo?. - handle reentrant frames, count the writes even if the frame is the scope frame,
  //second parameter to pushAsyncBlock only for recursive frames
  //or maybe reentrant frames should keep vars in the parent scope, at least for loops
  set(name, val, resolveUp) {
    if (resolveUp) {
      //only set tags use resolveUp
      //set tags do not have variables with dots, so the name is the whole variable name
      if (name.indexOf('.') !== -1) {
        throw new Error('resolveUp should not be used for variables with dots');
      }

      //find or create the variable scope:
      let scopeFrame = this.resolve(name, true);
      if (!scopeFrame) {
        //add the variable here unless !createScope in which case try adding in a parent frame that can createScope
        if (!this.createScope) {
          this.parent.set(name, val);//set recursively ti
          scopeFrame = this.resolve(name, true);
          if (!scopeFrame) {
            throw new Error('Variable should have been added in a parent frame');
          }
        }
        else {
          scopeFrame = this;//create the variable in this frame
        }
      }

      //go up the chain until we reach the scope frame or an asyncVar with the same name
      //and store the value there
      let frame = this;
      while (true) {
        if (frame.asyncVars && name in frame.asyncVars) {
          frame.asyncVars[name] = val;
          break;
        }
        if (frame === scopeFrame) {
          scopeFrame.variables[name] = val;
          break;
        }
        frame = frame.parent;
      }

      this._countdownAndResolveAsyncWrites(name, 1, scopeFrame);
    } else {
      //not for set tags
      super.set(name, val);
      //@todo - handle for recursive frames
      //name = name.substring(0, name.indexOf('.'));
    }
  }

  //@todo when we start skipping block promisify - do complete get implementation here to check asyncVars at all levels
  get(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return this.asyncVars[name];
    }
    return super.get(name);
  }

  lookup(name) {
    var val = (this.asyncVars && name in this.asyncVars) ? this.asyncVars[name] : this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return this.parent && this.parent.lookup(name);
  }

  //when all assignments to a variable are done, resolve the promise for that variable
  _countdownAndResolveAsyncWrites(varName, decrementVal = 1, scopeFrame = null) {
    if (!this.writeCounters || !(varName in this.writeCounters)) {
      return false;
    }
    let count = this.writeCounters[varName];
    if (count < decrementVal) {
      throw new Error(`Variable ${varName} write counter ${count === undefined ? 'is undefined' : 'turned negative'} in _trackAsyncWrites`);
    }

    let reachedZero = (count === decrementVal);
    if (reachedZero) {
      //this variable will no longer be modified, time to resolve it
      this._resolveAsyncVar(varName);

      //optional cleanup:
      delete this.writeCounters[varName];
      if (Object.keys(this.writeCounters).length === 0) this.writeCounters = undefined;

      if (!this.sequentialLoopBody && this.parent) {
        // propagate upwards because this frame's work is fully done (counter hit zero)
        // but only if this frame is NOT itself a loop body
        // in which case the writes will be propagated in finalizeLoopWrites once the loop is done

        // Find the declaring frame to ensure we stop propagation there.
        if (!scopeFrame) {
          scopeFrame = this.resolve(varName, true);
        }
        // Only propagate if the parent is not the scope frame (or null)
        if (this.parent !== scopeFrame) {
          // Propagate a single count upwards
          this.parent._countdownAndResolveAsyncWrites(varName, 1, scopeFrame);
        }
      }
      return true;
    } else {
      this.writeCounters[varName] = count - decrementVal;//just decrement, not yet done
      return false;
    }
  }

  skipBranchWrites(varCounts) {
    for (let varName in varCounts) {
      this._countdownAndResolveAsyncWrites(varName, varCounts[varName]);
    }
  }

  _resolveAsyncVar(varName) {
    let value = this.asyncVars[varName];
    let resolveFunc = this.promiseResolves[varName];
    resolveFunc(value);
    //@todo - if the var is the same promise - set it to the value
    //this cleanup may not be needed:
    delete this.promiseResolves[varName];
    if (Object.keys(this.promiseResolves).length === 0) {
      this.promiseResolves = undefined;
    }
  }

  /*_resolveAsyncVar(varName) {
    let value = this.asyncVars[varName];
    let resolveFunc = this.promiseResolves[varName];

    if (!resolveFunc) {
      console.error(`No resolve function for variable ${varName}`);
      return;
    }

    if (value && typeof value.then === 'function') {
      value.then(resolvedValue => {
        resolveFunc(resolvedValue);
      }).catch(err => {
        resolveFunc(Promise.reject(err));
      });
    } else {
      resolveFunc(value);
    }

    //@todo - if the var is the same promise - set it to the value
    //this cleanup may not be needed:
    // Cleanup
    //delete this.asyncVars[varName];
    //if (Object.keys(this.asyncVars).length === 0) {
    //  this.asyncVars = undefined;
    //}
    delete this.promiseResolves[varName];
    if (Object.keys(this.promiseResolves).length === 0) {
      this.promiseResolves = undefined;
    }
  }*/

  push(isolateWrites) {
    return new AsyncFrame(this, isolateWrites);
  }

  /**
   * Called after a loop finishes to decrement parent counters
   * During the loop (this.sequentialLoopBody = true), writes are not propagated upwards, so we need to do it here after the loop.
   */
  finalizeLoopWrites(finalWriteCounts) {
    if (!finalWriteCounts) {
      return; // No parent or nothing to finalize
    }
    for (const varName in finalWriteCounts) {
      if (this.writeCounters && varName in this.writeCounters) {
        // Use the standard countdown on the parent.
        // This will trigger promise resolution if it hits zero there.
        this._countdownAndResolveAsyncWrites(varName, 1);
      } else {
        throw new Error(`Loop finalized write for ${varName}, but parent has no counter.`);
      }
    }
  }

  pushAsyncBlock(reads, writeCounters) {
    let asyncBlockFrame = new AsyncFrame(this, false);//this.isolateWrites);//@todo - should isolateWrites be passed here?
    asyncBlockFrame.isAsyncBlock = true;
    if (reads || writeCounters) {
      asyncBlockFrame.asyncVars = {};
      if (reads) {
        asyncBlockFrame._snapshotVariables(reads);
      }
      if (writeCounters) {
        asyncBlockFrame._promisifyParentVariables(writeCounters);
      }
    }
    return asyncBlockFrame;
  }

  _snapshotVariables(reads) {
    for (const varName of reads) {
      this.asyncVars[varName] = this.lookup(varName);
    }
  }

  //@todo - skip promisify if parent has the same counts
  _promisifyParentVariables(writeCounters) {
    this.writeCounters = writeCounters;
    this.promiseResolves = {};
    let parent = this.parent;
    for (let varName in writeCounters) {
      //snapshot the value
      this.asyncVars[varName] = this.lookup(varName);
      //promisify the variable in the frame (parent of the new async frame)
      //these will be resolved when the async block is done with the variable
      if (parent.asyncVars && parent.asyncVars[varName] !== undefined) {
        this._promisifyParentVar(parent, parent.asyncVars, varName);
      } else if (parent.variables[varName] !== undefined) {
        this._promisifyParentVar(parent, parent.variables, varName);
      }
      else {
        throw new Error('Variable not found in parent frame');
      }
    }
  }

  _promisifyParentVar(parentFrame, parentVars, varName) {
    //use this value while the async block is active, then resolve it:
    this.asyncVars[varName] = parentVars[varName];
    let resolve;
    let promise = new Promise((res) => { resolve = res; });
    this.promiseResolves[varName] = resolve;
    parentVars[varName] = promise;
    if (parentFrame.topLevel) {
      //todo: modify the variable in the context
      //context.setVariable(varName, promise);
    }
  }
}

function makeMacro(argNames, kwargNames, func, astate) {
  return function macro(...macroArgs) {
    var argCount = numArgs(macroArgs);
    var args;
    var kwargs = getKeywordArgs(macroArgs);

    if (argCount > argNames.length) {
      args = macroArgs.slice(0, argNames.length);

      // Positional arguments that should be passed in as
      // keyword arguments (essentially default values)
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

        // Keyword arguments that should be passed as
        // positional arguments, i.e. the caller explicitly
        // used the name of a positional arg
        args.push(kwargs[arg]);
        delete kwargs[arg];
      }
      args.push(kwargs);
    } else {
      args = macroArgs;
      if (astate && Object.keys(kwargs).length === 0) {
        args.push({});//kwargs
      }
    }

    if (astate) {
      args.push(astate.new());
    }
    return func.apply(this, args);
  };
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

// A SafeString object indicates that the string should not be
// autoescaped. This happens magically because autoescaping only
// occurs on primitive string objects.
function SafeString(val) {
  if (typeof val !== 'string') {
    return val;
  }

  this.val = val;
  this.length = val.length;
}

function newSafeStringAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return new SafeString(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return new SafeString(await v, lineno, colno);
    })(val);
  }
  return new SafeString(val, lineno, colno);
}

SafeString.prototype = Object.create(String.prototype, {
  length: {
    writable: true,
    configurable: true,
    value: 0
  }
});
SafeString.prototype.valueOf = function valueOf() {
  return this.val;
};
SafeString.prototype.toString = function toString() {
  return this.val;
};

function copySafeness(dest, target) {
  if (dest instanceof SafeString) {
    return new SafeString(target);
  }
  return target.toString();
}

function markSafe(val) {
  var type = typeof val;

  if (type === 'string') {
    return new SafeString(val);
  } else if (type !== 'function') {
    return val;
  } else if (type === 'object' && val.then && typeof val.then === 'function') {
    return (async (v) => {
      return markSafe(await v);
    })(val);
  }
  else {
    return function wrapSafe(args) {
      var ret = val.apply(this, arguments);

      if (typeof ret === 'string') {
        return new SafeString(ret);
      }

      return ret;
    };
  }
}

function suppressValue(val, autoescape) {
  val = (val !== undefined && val !== null) ? val : '';

  if (autoescape && !(val instanceof SafeString)) {
    val = lib.escape(val.toString());
  }

  return val;
}

function suppressValueAsync(val, autoescape) {
  if (val && typeof val.then === 'function') {
    return val.then((v) => {
      return suppressValueAsync(v, autoescape);
    });
  }
  if (Array.isArray(val)) {
    // Check if the array contains any promises
    const hasPromises = val.some(item => item && typeof item.then === 'function');

    if (hasPromises) {
      // If the array contains promises, use deepResolveArray to resolve them
      return (async () => {
        let resolvedArray = await deepResolveArray(val);
        resolvedArray = [resolvedArray.join(',')];
        if (autoescape) {
          // append the function to the array, so it will be
          // called after the elements before it are joined
          resolvedArray.push((value) => {
            return suppressValue(value, true);
          });
        }
        return resolvedArray;
      })();
    } else {
      // No promises in the array, handle as before
      val = [val.join(',')];
      if (autoescape) {
        // append the function to the array, so it will be
        // called after the elements before it are joined
        val.push((value) => {
          return suppressValue(value, true);
        });
      }
      return val;
    }
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return suppressValue(await v, autoescape);
    })(val);
  }
  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno) {
  if (val === null || val === undefined) {
    throw new lib.TemplateError(
      'attempted to output null or undefined value',
      lineno + 1,
      colno + 1
    );
  }
  return val;
}

function ensureDefinedAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return ensureDefined(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return ensureDefined(await v, lineno, colno);
    })(val);
  }
  return ensureDefined(val, lineno, colno);
}

function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      const callback = (error, ...results) => {
        if (error) {
          reject(error);
        } else {
          resolve(results.length === 1 ? results[0] : results);
        }
      };

      fn(...args, callback);
    });
  };
}

// It's ok to use consequitive awaits when promises have been already in progress by the time you start awaiting them,
// Thus using sequential await in a loop does not introduce significant delays compared to Promise.all.
// not so if the promise is cteated right before the await, e.g. await fetch(url)
async function resolveAll(args) {
  const resolvedArgs = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    while (arg && typeof arg.then === 'function') {
      arg = await arg; // Resolve promise chain
    }
    // Deep resolve if it's an array or object
    if (Array.isArray(arg)) {
      // Recursively resolve elements or use a helper
      arg = await deepResolveArray(arg);
    } else if (isPlainObject(arg)) { // Need a robust isPlainObject check
      // Recursively resolve properties or use a helper
      arg = await deepResolveObject(arg);
    }
    resolvedArgs.push(arg);
  }
  return resolvedArgs;
}

async function deepResolveArray(arr) {
  const result = [];
  for (const item of arr) {
    let resolvedItem = item;
    if (resolvedItem && typeof resolvedItem.then === 'function') {
      resolvedItem = await resolvedItem;
    }
    if (Array.isArray(resolvedItem)) {
      resolvedItem = await deepResolveArray(resolvedItem);
    } else if (isPlainObject(resolvedItem)) {
      resolvedItem = await deepResolveObject(resolvedItem);
    }
    result.push(resolvedItem);
  }
  return result;
}

async function deepResolveObject(obj) {
  const result = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      let value = obj[key];
      if (value && typeof value.then === 'function') {
        value = await value;
      }
      if (Array.isArray(value)) {
        value = await deepResolveArray(value);
      } else if (isPlainObject(value)) {
        value = await deepResolveObject(value);
      }
      result[key] = value;
    }
  }
  return result;
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || value === undefined) {
    return false;
  }
  // Add checks to exclude class instances, etc., if necessary
  // A simple check might be:
  return Object.prototype.toString.call(value) === '[object Object]' && Object.getPrototypeOf(value) === Object.prototype;
}

async function resolveObjectProperties(obj) {
  for (const key in obj) {
    if (obj[key] && typeof obj[key].then === 'function') {
      obj[key] = await obj[key];
    }
  }
  return obj;
}

async function resolveDuo(...args) {
  return resolveAll(args);
}

async function resolveSingle(value) {
  // Sortcut for non-promise values, return a fake promise
  if (!value || typeof value.then !== 'function') {
    return {
      then(onFulfilled) {
        return onFulfilled ? onFulfilled(value) : value;
      }
    };
  }

  // For promises, resolve them like resolveAll does
  let resolvedValue = value;
  while (resolvedValue && typeof resolvedValue.then === 'function') {
    resolvedValue = await resolvedValue; // Resolve promise chain
  }

  // Deep resolve if it's an array or object
  if (Array.isArray(resolvedValue)) {
    resolvedValue = await deepResolveArray(resolvedValue);
  } else if (isPlainObject(resolvedValue)) {
    resolvedValue = await deepResolveObject(resolvedValue);
  }

  return resolvedValue;
}

async function resolveSingleArr(value) {
  // Shortcut for non-promise values
  if (!value || typeof value.then !== 'function') {
    return [value];
  }

  // For promises, resolve them like resolveAll does
  let resolvedValue = value;
  while (resolvedValue && typeof resolvedValue.then === 'function') {
    resolvedValue = await resolvedValue; // Resolve promise chain
  }

  // Deep resolve if it's an array or object
  if (Array.isArray(resolvedValue)) {
    resolvedValue = await deepResolveArray(resolvedValue);
  } else if (isPlainObject(resolvedValue)) {
    resolvedValue = await deepResolveObject(resolvedValue);
  }

  return [resolvedValue];
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

function flattentBuffer(arr) {
  const result = arr.reduce((acc, item) => {
    if (Array.isArray(item)) {
      return acc + flattentBuffer(item);
    }
    if (typeof item === 'function') {
      return (item(acc) || '');
    }
    if (item && typeof item.then === 'function') {
      // Handle promises in the buffer by awaiting them
      return (async () => {
        const resolvedItem = await item;
        return acc + (resolvedItem || '');
      })();
    }
    return acc + (item || '');
  }, '');
  return result;
}

function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  if (typeof obj[val] === 'function') {
    return (...args) => obj[val](...args);
  }

  return obj[val];
}

function memberLookupAsync(obj, val) {
  return resolveDuo(obj, val).then(([resolvedOb, resolvedVal]) => {
    return memberLookup(resolvedOb, resolvedVal);
  });
}

function callWrap(obj, name, context, args) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  return obj.apply(context, args);
}

function contextOrFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

function handleError(error, lineno, colno) {
  if (error.lineno) {
    return error;
  } else {
    return new lib.TemplateError(error, lineno, colno);
  }
}

function asyncEach(arr, dimen, iter, cb) {
  if (lib.isArray(arr)) {
    const len = arr.length;

    lib.asyncIter(arr, function iterCallback(item, i, next) {
      switch (dimen) {
        case 1:
          iter(item, i, len, next);
          break;
        case 2:
          iter(item[0], item[1], i, len, next);
          break;
        case 3:
          iter(item[0], item[1], item[2], i, len, next);
          break;
        default:
          item.push(i, len, next);
          iter.apply(this, item);
      }
    }, cb);
  } else {
    lib.asyncFor(arr, function iterCallback(key, val, i, len, next) {
      iter(key, val, i, len, next);
    }, cb);
  }
}

function asyncAll(arr, dimen, func, cb) {
  var finished = 0;
  var len;
  var outputArr;

  function done(i, output) {
    finished++;
    outputArr[i] = output;

    if (finished === len) {
      cb(null, outputArr.join(''));
    }
  }

  if (lib.isArray(arr)) {
    len = arr.length;
    outputArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];

        switch (dimen) {
          case 1:
            func(item, i, len, done);
            break;
          case 2:
            func(item[0], item[1], i, len, done);
            break;
          case 3:
            func(item[0], item[1], item[2], i, len, done);
            break;
          default:
            item.push(i, len, done);
            func.apply(this, item);
        }
      }
    }
  } else {
    const keys = lib.keys(arr || {});
    len = keys.length;
    outputArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        func(k, arr[k], i, len, done);
      }
    }
  }
}

function fromIterator(arr) {
  if (typeof arr !== 'object' || arr === null || lib.isArray(arr)) {
    return arr;
  } else if (supportsIterators && Symbol.iterator in arr) {
    return arrayFrom(arr);
  } else {
    return arr;
  }
}

function setLoopBindings(frame, index, len, last) {
  // Set the loop variables that depend only on index directly
  frame.set('loop.index', index + 1);
  frame.set('loop.index0', index);
  frame.set('loop.first', index === 0);
  frame.set('loop.length', len);
  frame.set('loop.last', last);

  if (len && typeof len.then === 'function') {
    // Set the remaining loop variables that depend on len as promises
    frame.set('loop.revindex', len.then(l => l - index));
    frame.set('loop.revindex0', len.then(l => l - index - 1));
  } else {
    // Set the remaining loop variables that depend on len directly
    frame.set('loop.revindex', len - index);
    frame.set('loop.revindex0', len - index - 1);
  }
}

async function iterate(arr, loopBody, loopElse, loopFrame, bodyWriteCounts, loopVars = [], sequential = false, isAsync = false) {
  let didIterate = false;
  if (arr) {
    if (isAsync && typeof arr[Symbol.asyncIterator] === 'function') {
      const iterator = arr[Symbol.asyncIterator]();
      let result;
      let i = 0;

      let lastPromiseResolve;
      let lastPromise = new Promise(resolve => {
        lastPromiseResolve = resolve;
      });

      let lenPromise = new Promise(resolve => {
        const values = [];
        (async () => {
          try {
            while ((result = await iterator.next()), !result.done) {
              values.push(result.value);
              didIterate = true;
              const value = result.value;

              // If a new iteration starts, the previous one wasn't the last
              if (lastPromiseResolve) {
                lastPromiseResolve(false);
                // Create a new lastPromise for this iteration
                lastPromise = new Promise(resolveNew => {
                  lastPromiseResolve = resolveNew;
                });
              }

              let res;
              if (loopVars.length === 1) {
                res = loopBody(value, i, lenPromise, lastPromise);
              } else {
                if (!Array.isArray(value)) {
                  throw new Error('Expected an array for destructuring');
                }
                res = loopBody(...value.slice(0, loopVars.length), i, lenPromise, lastPromise);
              }
              if (sequential) {
                await res;
              }
              i++;
            }

            // When loop ends, resolve the lastPromise to true if it exists
            if (lastPromiseResolve) {
              lastPromiseResolve(true);
            }

            resolve(values.length);
          } catch (error) {
            // Make sure to resolve the lastPromise in case of error
            if (lastPromiseResolve) {
              lastPromiseResolve(true);
            }
            throw error;
          }
        })();
      });

      // Wait for all iterations to complete
      await lenPromise;//why is this needed, some tests fail without it?
    } else {
      arr = fromIterator(arr);

      if (Array.isArray(arr)) {
        const len = arr.length;

        for (let i = 0; i < arr.length; i++) {
          didIterate = true;
          const value = arr[i];
          const isLast = i === arr.length - 1;

          let res;
          if (loopVars.length === 1) {
            res = loopBody(value, i, len, isLast);
          } else {
            if (!Array.isArray(value)) {
              throw new Error('Expected an array for destructuring');
            }
            res = loopBody(...value.slice(0, loopVars.length), i, len, isLast);
          }

          if (sequential) {
            await res;
          }
        }
      } else {
        const keys = Object.keys(arr);
        const len = keys.length;

        for (let i = 0; i < keys.length; i++) {
          didIterate = true;
          const key = keys[i];
          const value = arr[key];
          const isLast = i === keys.length - 1;

          if (loopVars.length === 2) {
            const res = loopBody(key, value, i, len, isLast);
            if (sequential) {
              await res;
            }
          } else {
            throw new Error('Expected two variables for key/value iteration');
          }
        }
      }
    }
  }

  if (bodyWriteCounts && sequential) {
    // for nested loops, only the outer loop should finalize the writes
    loopFrame.finalizeLoopWrites(bodyWriteCounts);
  }

  if (!didIterate && loopElse) {
    await loopElse();//just in case
  }
}

class AsyncState {
  constructor(parent = null) {
    this.activeClosures = 0;
    this.waitClosuresCount = 0;
    this.parent = parent;
    this.completionPromise = null;
    this.completionResolver = null;
    this.asyncBlockFrame = null;//@todo - remove
  }

  enterAsyncBlock(asyncBlockFrame) {
    const newState = new AsyncState(this);
    newState.asyncBlockFrame = asyncBlockFrame;
    newState._incrementClosures();

    // Create a new completion promise for this specific closure chain
    /*this.waitAllClosures().then(() => {
      asyncBlockFrame.dispose();// - todo - why does it succeed and then fail?
    });*/

    return newState;
  }

  leaveAsyncBlock() {
    this.activeClosures--;

    if (this.activeClosures === this.waitClosuresCount) {
      if (this.completionResolver) {
        this.completionResolver();
        // Reset both promise and resolver
        this.completionPromise = null;
        this.completionResolver = null;
      }
    } else if (this.activeClosures < 0) {
      throw new Error('Negative activeClosures count detected');
    }

    if (this.parent) {
      return this.parent.leaveAsyncBlock();
    }

    return this.parent;
  }

  _incrementClosures() {
    this.activeClosures++;
    if (this.parent) {
      this.parent._incrementClosures();
    }
  }

  // can use only one closureCount value at a time
  async waitAllClosures(closureCount = 0) {
    this.waitClosuresCount = closureCount;
    if (this.activeClosures === closureCount) {
      return Promise.resolve();
    }

    // Reuse existing promise if it exists
    if (this.completionPromise) {
      return this.completionPromise;
    }

    // Create new promise and store it
    this.completionPromise = new Promise(resolve => {
      this.completionResolver = resolve;
    });

    return this.completionPromise;
  }

  new() {
    return new AsyncState();
  }
}

module.exports = {
  Frame: Frame,
  AsyncFrame: AsyncFrame,
  AsyncState: AsyncState,
  makeMacro: makeMacro,
  makeKeywordArgs: makeKeywordArgs,
  numArgs: numArgs,
  suppressValue: suppressValue,
  suppressValueAsync: suppressValueAsync,
  ensureDefined: ensureDefined,
  ensureDefinedAsync: ensureDefinedAsync,
  promisify: promisify,
  resolveAll: resolveAll,
  resolveDuo: resolveDuo,
  resolveSingle: resolveSingle,
  resolveSingleArr: resolveSingleArr,
  resolveObjectProperties: resolveObjectProperties,
  resolveArguments: resolveArguments,
  flattentBuffer: flattentBuffer,
  memberLookup: memberLookup,
  memberLookupAsync: memberLookupAsync,
  contextOrFrameLookup: contextOrFrameLookup,
  callWrap: callWrap,
  handleError: handleError,
  isArray: lib.isArray,
  keys: lib.keys,
  SafeString: SafeString,
  newSafeStringAsync: newSafeStringAsync,
  copySafeness: copySafeness,
  markSafe: markSafe,
  asyncEach: asyncEach,
  asyncAll: asyncAll,
  inOperator: lib.inOperator,
  fromIterator: fromIterator,
  iterate: iterate,
  setLoopBindings
};
