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

  // @todo - fix when this.variables[name] exists but is undefined
  lookup(name) {
    var p = this.parent;
    var val = this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return p && p.lookup(name);
  }

  getRoot() {
    let root = this;
    while (root.parent) {
      root = root.parent;
    }
    return root;
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

    //this.sequenceLockFrame = (parent && parent.sequenceLockFrame) ? parent.sequenceLockFrame : this;

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
    //no parent but keep track of sequenceLockFrame
    const nf = new AsyncFrame();//undefined, this.isolateWrites);
    //nf.sequenceLockFrame = this.sequenceLockFrame;
    return nf;
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

  //@todo - fix when this.variables[name] exists but is undefined
  /*lookup(name) {
    let val = (this.asyncVars && name in this.asyncVars) ? this.asyncVars[name] : this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return this.parent && this.parent.lookup(name);
  }*/

  lookup(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return this.asyncVars[name];
    }
    if (this.variables && name in this.variables) {
      return this.variables[name];
    }
    return this.parent && this.parent.lookup(name);
  }

  lookupAndLocate(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return { value: this.asyncVars[name], frame: this };
    }

    if (name in this.variables) {
      return { value: this.variables[name], frame: this };
    }

    if (this.parent) {
      return this.parent.lookupAndLocate(name);
    }

    return { value: undefined, frame: null };
  }

  resolve(name, forWrite) {
    /*if (name.startsWith('!')) {
      // Sequence keys conceptually resolve to the root frame
      return this.sequenceLockFrame;
    }*/
    return super.resolve(name, forWrite);
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
      if (Object.keys(this.writeCounters).length === 0) {
        this.writeCounters = undefined;
      }

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
      let {value, frame} = parent.lookupAndLocate(varName);
      if (!frame) {
        if (!varName.startsWith('!')) {
          //all non-sequence lock variables should have been declared
          throw new Error(`Promisified variable ${varName} not found`);
        }
        //for sequential keys, create a default value in root if none found
        //e.g. declare the lock the first time it is used
        const sequenceLockFrame = this.getRoot();//this.sequenceLockFrame;
        value = undefined;//not yet locked
        sequenceLockFrame.variables = sequenceLockFrame.variables || {};
        sequenceLockFrame.variables[varName] = value;
        frame = sequenceLockFrame;
      }
      this.asyncVars[varName] = value;//local snapshot of the value
      //promisify the variable in the frame (parent of the new async frame)
      //these will be resolved when the async block is done with the variable
      if (frame.asyncVars && varName in frame.asyncVars) {
        this._promisifyParentVar(frame, 'asyncVars', varName);
      } else if (frame.variables && varName in frame.variables) {
        this._promisifyParentVar(frame, 'variables', varName);
      }
      else {
        throw new Error('Variable not found in parent frame');
      }
    }
  }

  async _promisifyParentVar(parent, containerName, varName) {
    // Snapshot the current value from the parent frame for local use by this block.
    this.asyncVars[varName] = parent[containerName][varName];
    let resolve;
    // Create the initial lock Promise, referenced by the 'promise' variable.
    let currentPromiseToAwait = new Promise((res) => { resolve = res; });
    // Store the resolver function in this frame, tied to the variable name.
    this.promiseResolves[varName] = resolve;
    // Place the lock Promise into the parent frame's variable slot.
    parent[containerName][varName] = currentPromiseToAwait;

    while (true) {
      let awaitedValue = await currentPromiseToAwait; // Await the tracked promise

      // Now, check the parent slot state *after* the await
      if (parent[containerName][varName] === currentPromiseToAwait) {
        // The promise we awaited is still in the slot.
        // Update the slot with the resolved value.
        parent[containerName][varName] = awaitedValue;

        // Is the value we just placed ALSO a promise?
        if (awaitedValue && typeof awaitedValue.then === 'function') {
          // Yes, track this new promise and loop again
          currentPromiseToAwait = awaitedValue;
          continue;
        } else {
          // Not a promise, we are done
          break;
        }
      } else {
        // The slot was overwritten while we awaited.
        // Give up responsibility. The block that overwrote it is now in charge.
        break;
      }
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
        if (resolvedArray.length > 0) {
          resolvedArray = [resolvedArray.join(',')];
        }
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
      if (val.length > 0) {
        val = [val.join(',')];
      }
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
    if (arg && typeof arg.then === 'function') {
      arg = await arg;
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

//@todo - use this much more sparingly
async function deepResolveArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    let resolvedItem = arr[i];
    if (resolvedItem && typeof resolvedItem.then === 'function') {
      resolvedItem = await resolvedItem;
    }
    if (Array.isArray(resolvedItem)) {
      resolvedItem = await deepResolveArray(resolvedItem);
    } else if (isPlainObject(resolvedItem)) {
      resolvedItem = await deepResolveObject(resolvedItem);
    }
    arr[i] = resolvedItem;
  }
  return arr;
}

// @todo - use this much more sparringly, only for arguments and output
async function deepResolveObject(target) {
  // Await the primary target if it's a promise.
  const obj = await target;

  // Primitives and null cannot be resolved further.
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    // --- Array Handling ---
    // Create an array of promises, where each promise resolves one element.
    const resolutionPromises = obj.map(
      (item, index) => deepResolveObject(item)
        .then(resolvedItem => {
          // Mutate the original array at the specific index.
          obj[index] = resolvedItem;
        })
    );

    // Wait for all elements to be resolved and mutated.
    await Promise.all(resolutionPromises);
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
      if ('value' in descriptor) {
        // Create a promise that resolves the property and then mutates the object.
        const promise = deepResolveObject(descriptor.value)
          .then(resolvedValue => {
            // Only mutate if the value has actually changed to avoid
            // triggering unnecessary setter logic if it exists.
            if (obj[key] !== resolvedValue) {
              obj[key] = resolvedValue;
            }
          });

        resolutionPromises.push(promise);
      }
    }

    // Wait for all properties to be resolved and mutated.
    await Promise.all(resolutionPromises);
  }
  // For non-plain objects (class instances, etc.), we don't recurse

  // Return the original, now fully mutated, object.
  return obj;
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  // Check if it's the right type
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }

  // If it has no prototype (Object.create(null)), it's still a plain object
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

async function resolveObjectProperties(obj) {
  for (const key in obj) {
    if (obj[key] && typeof obj[key].then === 'function') {
      obj[key] = await obj[key];
    }
  }
  return obj;
}

// todo - optimize
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
  if (resolvedValue && typeof resolvedValue.then === 'function') {
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
  if (resolvedValue && typeof resolvedValue.then === 'function') {
    resolvedValue = await resolvedValue;
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

function flattenBuffer(arr, context = null, focusOutput = null) {
  // FAST PATH: If no context, it's a simple template. Concatenate strings and arrays.
  if (!context) {
    if (!Array.isArray(arr)) {
      return arr || '';
    }
    return arr.reduce((acc, item) => {
      if (Array.isArray(item)) {
        // The `null` context indicates a recursive call for a simple sub-array.
        return acc + flattenBuffer(item, null, null, null);
      }
      // A post-processing function, e.g. for SafeString
      if (typeof item === 'function') {
        return (item(acc) || '');
      }
      return acc + ((item !== null && item !== undefined) ? item : '');
    }, '');
  }

  // Script processing path
  const env = context.env;
  const textOutput = [];
  const handlerInstances = {}; // Cache instantiated handlers for this run.

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

  function processItem(item) {
    if (item === null || item === undefined) return;
    if (Array.isArray(item)) {
      const last = item.length > 0 ? item[item.length - 1] : null;

      // Handle arrays with a post-processing function (e.g., from auto-escaping).
      if (typeof last === 'function') {
        const subArray = item.slice(0, -1);

        // This helper function flattens an array of stringifiable items.
        // It's a simplified version of the main buffer flattening and assumes
        // no command objects are present in such arrays.
        function _flattenStringifiable(subArr) {
          return subArr.reduce((acc, current) => {
            if (Array.isArray(current)) {
              return acc + _flattenStringifiable(current);
            }
            return acc + ((current !== null && current !== undefined) ? current : '');
          }, '');
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

    // Process a command object from the compiler
    if (typeof item === 'object' && (item.method || item.handler !== undefined)) {
      // Function Command: @handler.cmd(), @callableHandler()
      const handlerName = item.handler;
      const commandName = item.command;
      const subpath = item.subpath;
      const args = item.arguments;

      if (!handlerName || handlerName === 'text') {
        textOutput.push(...args);
      } else {
        const handlerInstance = getOrInstantiateHandler(handlerName);

        if (!handlerInstance) {
          throw handleError(new Error(`Unknown command handler: ${handlerName}`), item.pos.lineno, item.pos.colno);
        }

        // Navigate through subpath properties to reach the final target
        let targetObject = handlerInstance;
        if (subpath && subpath.length > 0) {
          for (const pathSegment of subpath) {
            if (targetObject && typeof targetObject === 'object' && targetObject !== null) {
              targetObject = targetObject[pathSegment];
            } else {
              throw handleError(new Error(`Cannot access property '${pathSegment}' on ${typeof targetObject} in handler '${handlerName}'`), item.pos.lineno, item.pos.colno);
            }
          }
        }

        const commandFunc = commandName ? targetObject[commandName] : targetObject;

        // if no command name is provided, use the handler itself as the command
        if (typeof commandFunc === 'function') {
          // Found a method on the handler: @turtle.forward() or the handler itself is a function @log()
          commandFunc.apply(targetObject, args);
        } else if (!commandName) {
          // The handler may be a proxy
          try {
            //the handler may be a Proxy
            commandFunc(...args);
          } catch (e) {
            if (!commandName) {
              throw handleError(new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} is not callable (use Proxy or constructor function return)`), item.pos.lineno, item.pos.colno);
            } else {
              throw handleError(new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}' and is not callable`), item.pos.lineno, item.pos.colno);
            }
          }
        } else {
          throw handleError(new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}'`), item.pos.lineno, item.pos.colno);
        }
      }
      return;
    }
    // Default: treat as literal value for text output.
    textOutput.push(item);
  }

  arr.forEach(processItem);

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

function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  if (typeof obj[val] === 'function') {
    return (...args) => obj[val](...args);
  }

  return obj[val];
}

function memberLookupScript(obj, val) {
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception 'Cannot read properties of null'
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

function memberLookupScriptAsync(obj, val) {
  return resolveDuo(obj, val).then(([resolvedOb, resolvedVal]) => {
    return memberLookupScript(resolvedOb, resolvedVal);
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

//@todo - deprecate, the sequencedMemberLookupAsync of the FunCall path lookupVal/symbol should handle the frame lock release
async function sequencedCallWrap(func, funcName, context, args, frame, sequenceLockKey) {
  await awaitSequenceLock(frame, sequenceLockKey);// acquire lock
  try {
    return await callWrap(func, funcName, context, args);
  } finally {
    //release the lock associated with this specific sequence key
    frame.set(sequenceLockKey, true, true); // This will set the lock writeCount to 0 and release the lock
  }
}

function contextOrFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

function handleError(error, lineno, colno, errorContextString = null) {
  if (error.lineno) {
    return error;
  } else {
    return new lib.TemplateError(error, lineno, colno, errorContextString);
  }
}

// Make sure the promise is caught and handled (so we don't get unhandled exception)
// The error is properly reported to the callback
function handlePromise(promise, cb, lineno, colno, errorContextString = null) {
  // Attach a catch handler that performs the error handling and callback
  promise.catch(err => {
    // Use the provided arguments to handle and report the error
    try {
      const handledError = handleError(err, lineno, colno, errorContextString);
      cb(handledError);
    } catch (cbError) {
      // Uh oh, the callback or error handler itself failed.
      console.error('FATAL: Error during Nunjucks error handling or callback:', cbError);
      console.error('Original error was:', err);
      throw cbError;
    }
  });
  return promise;//the original promise
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

async function iterateAsyncSequential(arr, loopBody, loopVars) {
  let didIterate = false;
  let i = 0;
  for await (const value of arr) {
    didIterate = true;

    let res;
    if (loopVars.length === 1) {
      // `while` loops pass `undefined` for len/last, which is correct.
      res = loopBody(value, i, undefined, false);
    } else {
      if (!Array.isArray(value)) {
        throw new Error('Expected an array for destructuring');
      }
      res = loopBody(...value.slice(0, loopVars.length), i, undefined, false);
    }

    // In sequential mode, we MUST await the body before the next iteration.
    await res;
    i++;
  }
  return didIterate;
}

async function iterateAsyncParallel(arr, loopBody, loopVars) {
  let didIterate = false;
  // PARALLEL PATH
  // This complex logic allows for `loop.length` and `loop.last` to work
  // by resolving promises only after the entire iterator is consumed. This
  // only works when loop bodies are fired in parallel (sequential=false)
  const iterator = arr[Symbol.asyncIterator]();
  let result;
  let i = 0;

  let lastPromiseResolve;
  let lastPromise = new Promise(resolve => {
    lastPromiseResolve = resolve;
  });

  // This promise will be resolved with the total length when the loop is done.
  const lenPromise = new Promise(resolve => {
    const values = [];
    // This IIFE runs "in the background" to exhaust the iterator
    (async () => {
      try {
        while ((result = await iterator.next()), !result.done) {
          values.push(result.value);
          didIterate = true;
          const value = result.value;

          // Resolve the previous iteration's `lastPromise` to `false`.
          if (lastPromiseResolve) {
            lastPromiseResolve(false);
            // Create a new promise for the current iteration.
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
            // eslint-disable-next-line no-unused-vars
            res = loopBody(...value.slice(0, loopVars.length), i, lenPromise, lastPromise);
          }
          // `await res` is NOT here, allowing parallel execution.
          i++;
        }

        // The loop has finished, so the last `lastPromise` can be resolved to `true`.
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        // The loop is done, so we now know the length.
        resolve(values.length);
      } catch (error) {
        if (lastPromiseResolve) {
          lastPromiseResolve(true); // Resolve on error to prevent deadlocks.
        }
        throw error;
      }
    })();
  });

  // The main function waits for the background IIFE to finish.
  await lenPromise;
  return didIterate;
}

async function iterate(arr, loopBody, loopElse, loopFrame, bodyWriteCounts, loopVars = [], sequential = false, isAsync = false) {
  let didIterate = false;

  if (isAsync && arr && typeof arr[Symbol.asyncIterator] === 'function') {
    // We must have two separate code paths. The `lenPromise` and `lastPromise`
    // mechanism is fundamentally incompatible with sequential execution, as it
    // would create a deadlock.

    if (sequential) {
      // Used for `while` and `each` loops and
      // any `for` loop marked as sequential. It does NOT support `loop.length`
      // or `loop.last` for async iterators, as that is impossible to know
      // without first consuming the entire iterator.
      didIterate = await iterateAsyncSequential(arr, loopBody, loopVars);
    } else {
      // PARALLEL PATH
      // This complex logic allows for `loop.length` and `loop.last` to work
      // by resolving promises only after the entire iterator is consumed. This
      // only works when loop bodies are fired in parallel (sequential=false)
      didIterate = await iterateAsyncParallel(arr, loopBody, loopVars);
    }
  }
  else if (arr) {
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

function awaitSequenceLock(frame, lockKeyToAwait) {
  if (!lockKeyToAwait) {
    return undefined;
  }

  const lockState = frame.lookup(lockKeyToAwait);

  if (lockState && typeof lockState.then === 'function') {
    return lockState; // JavaScript will automatically unwrap any nested promises
  } else {
    return undefined;
  }
}

// Called in place of contextOrFrameLookup when the path has a sequence lock on it
async function sequencedContextLookup(context, frame, name, nodeLockKey) {
  await awaitSequenceLock(frame, nodeLockKey);// acquire lock
  try {
    return contextOrFrameLookup(context, frame, name);// perform lookup
  } finally {
    frame.set(nodeLockKey, true, true);// release lock
  }
}

// Called in place of memberLookupAsync when the path has a sequence lock on it
async function sequencedMemberLookupAsync(frame, target, key, nodeLockKey) {
  await awaitSequenceLock(frame, nodeLockKey);// acquire lock
  try {
    let resolvedTarget = target;
    if (target && typeof target.then === 'function') {
      resolvedTarget = await target;
    }
    return memberLookup(resolvedTarget, key);// perform lookup
  } finally {
    frame.set(nodeLockKey, true, true);// release lock
  }
}

// Called in place of memberLookupAsync when the path has a sequence lock on it
async function sequencedMemberLookupScriptAsync(frame, target, key, nodeLockKey) {
  await awaitSequenceLock(frame, nodeLockKey);// acquire lock
  try {
    let resolvedTarget = target;
    if (target && typeof target.then === 'function') {
      resolvedTarget = await target;
    }
    return memberLookupScript(resolvedTarget, key);// perform lookup
  } finally {
    frame.set(nodeLockKey, true, true);// release lock
  }
}

module.exports = {
  Frame,
  AsyncFrame,
  AsyncState,
  makeMacro,
  makeKeywordArgs,
  numArgs,
  suppressValue,
  suppressValueAsync,
  ensureDefined,
  ensureDefinedAsync,
  promisify,
  resolveAll,
  resolveDuo,
  resolveSingle,
  resolveSingleArr,
  resolveObjectProperties,
  resolveArguments,
  flattenBuffer,

  memberLookup,
  memberLookupAsync,
  sequencedMemberLookupAsync,

  memberLookupScript,
  memberLookupScriptAsync,
  sequencedMemberLookupScriptAsync,

  contextOrFrameLookup,
  callWrap,
  sequencedCallWrap,
  handleError,
  handlePromise,
  isArray: lib.isArray,
  keys: lib.keys,
  SafeString,
  newSafeStringAsync,
  copySafeness,
  markSafe,
  asyncEach,
  asyncAll,
  inOperator: lib.inOperator,
  fromIterator,
  iterate,
  setLoopBindings,
  awaitSequenceLock,
  sequencedContextLookup
};
