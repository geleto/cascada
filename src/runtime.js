'use strict';

var lib = require('./lib');
var arrayFrom = Array.from;
var supportsIterators = (
  typeof Symbol === 'function' && Symbol.iterator && typeof arrayFrom === 'function'
);

// Symbol for poison detection
const POISON_KEY = typeof Symbol !== 'undefined'
  ? Symbol.for('cascada.poison')
  : '__cascadaPoisonError';

// Symbol for PoisonError detection (more reliable than instanceof after transpilation)
const POISON_ERROR_KEY = typeof Symbol !== 'undefined'
  ? Symbol.for('cascada.poisonError')
  : '__cascadaPoisonErrorMarker';

/**
 * Represents a poisoned value containing one or more errors.
 * Implements thenable protocol to propagate through async chains.
 */
class PoisonedValue {
  constructor(errors) {
    this.errors = Array.isArray(errors) ? errors : [errors];
    this[POISON_KEY] = true;
  }

  then(onFulfilled, onRejected) {
    const error = new PoisonError(this.errors);
    if (onRejected) {
      try {
        return onRejected(error);
      } catch (e) {
        // Handler threw - return new poison with the thrown error
        // This matches Promise behavior: replace error, don't accumulate
        return createPoison(e);
      }
    }
    // No rejection handler - propagate the poison
    return this;
  }

  catch(onRejected) {
    return this.then(null, onRejected);
  }

  finally(onFinally) {
    if (onFinally) {
      try {
        onFinally();
      } catch (e) {
        // Ignore errors in finally, return original poison
      }
    }
    return this;
  }
}

/**
 * Error thrown when one or more operations are poisoned.
 * Contains deduplicated array of original errors.
 */
class PoisonError extends Error {
  constructor(errors) {
    const deduped = deduplicateErrors(errors);
    const message = deduped.length === 1
      ? deduped[0].message
      : `Multiple errors occurred (${deduped.length}):\n` +
        deduped.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');

    super(message);
    this.name = 'PoisonError';
    this.errors = deduped;
    this[POISON_ERROR_KEY] = true; // Marker for reliable detection

    // Preserve stack from first error if available
    if (deduped[0] && deduped[0].stack) {
      this.stack = deduped[0].stack;
    }
  }
}

/**
 * Deduplicate errors by message.
 */
function deduplicateErrors(errors) {
  const seen = new Map();
  const result = [];

  for (const err of errors) {
    const key = err.message || String(err);
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(err);
    }
  }

  return result;
}

/**
 * Create a poison value from one or more errors.
 */
function createPoison(errorOrErrors) {
  const errors = Array.isArray(errorOrErrors)
    ? errorOrErrors
    : [errorOrErrors];
  return new PoisonedValue(errors);
}

/**
 * Check if a value is poisoned.
 */
function isPoison(value) {
  return value != null && value[POISON_KEY] === true;
}

/**
 * Check if an error is a PoisonError.
 * More reliable than instanceof after transpilation.
 */
function isPoisonError(error) {
  return error != null && error[POISON_ERROR_KEY] === true;
}

/**
 * Collect errors from an array of values.
 * Awaits all promises (even after finding errors), catches rejections,
 * extracts poison errors. Returns deduplicated error array.
 */
async function collectErrors(values) {
  const errors = [];

  for (const value of values) {
    if (isPoison(value)) {
      errors.push(...value.errors);
    } else if (value && typeof value.then === 'function') {
      try {
        const resolved = await value;
        // Check if resolved to a poison
        if (isPoison(resolved)) {
          errors.push(...resolved.errors);
        }
      } catch (err) {
        // If the error is a PoisonError (from unwrapping a poison),
        // extract its underlying errors
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
      }
    }
  }

  return deduplicateErrors(errors);
}

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
      //and store the value there (poison values are stored just like any other value)
      let frame = this;
      while (true) {
        if (frame.asyncVars && name in frame.asyncVars) {
          frame.asyncVars[name] = val; // Store poison if val is poison
          break;
        }
        if (frame === scopeFrame) {
          scopeFrame.variables[name] = val; // Store poison if val is poison
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

  /**
   * Poison all variables that would be written in branches when condition is poisoned.
   * Used by if/switch/while when the condition evaluation results in poison.
   *
   * @param {PoisonedValue|Error} error - The poison value or error to propagate
   * @param {Object} varCounts - Map of variable names to write counts
   */
  poisonBranchWrites(error, varCounts) {
    const poison = isPoison(error) ? error : createPoison(error);

    for (let varName in varCounts) {
      // Set poison value in the appropriate location
      if (this.asyncVars && varName in this.asyncVars) {
        this.asyncVars[varName] = poison;
      } else {
        // Find the scope frame and set poison there
        const scopeFrame = this.resolve(varName, true);
        if (scopeFrame) {
          if (scopeFrame.asyncVars && varName in scopeFrame.asyncVars) {
            scopeFrame.asyncVars[varName] = poison;
          } else {
            scopeFrame.variables[varName] = poison;
          }
        } else {
          // Variable doesn't exist yet - create it as poisoned
          this.variables[varName] = poison;
        }
      }

      // Trigger countdown with the write count for this variable
      this._countdownAndResolveAsyncWrites(varName, varCounts[varName]);
    }
  }

  _resolveAsyncVar(varName) {
    let value = this.asyncVars[varName];
    let resolveFunc = this.promiseResolves[varName];
    // Resolve with the value (which may be poison - that's ok, it will propagate)
    resolveFunc(value);

    // Cleanup
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
      try {
        let awaitedValue = await currentPromiseToAwait; // Await the tracked promise

        // Check if awaitedValue is poison - STOP LOOP
        if (isPoison(awaitedValue)) {
          parent[containerName][varName] = awaitedValue;
          break; // Stop loop on poison
        }

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
      } catch (err) {
        // Promise was rejected - convert to poison
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        parent[containerName][varName] = poison;
        break;
      }
    }
  }
}

function makeMacro(argNames, kwargNames, func, astate) {
  const macro = function macro(...macroArgs) {
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
  macro.isMacro = true;
  return macro;
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
  // Poison check - return rejected promise synchronously
  if (isPoison(val)) {
    return val;
  }

  // Simple literal value (not array, not promise) - return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Arrays without promises - handle synchronously
  if (Array.isArray(val)) {
    const hasPoison = val.some(isPoison);
    const hasPromises = val.some(item => item && typeof item.then === 'function');

    // If array has no promises and no poison, handle synchronously
    if (!hasPromises && !hasPoison) {
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }

    // Has promises or poison - delegate to async helper
    return _suppressValueAsyncComplex(val, autoescape);
  }

  // Promise - delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape);
}

async function _suppressValueAsyncComplex(val, autoescape) {
  // Handle promise values
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      throw isPoisonError(err) ? err : new PoisonError([err]);
    }

    // Check if resolved to poison
    if (isPoison(val)) {
      throw new PoisonError(val.errors);
    }
  }

  // Handle arrays
  if (Array.isArray(val)) {
    // Collect errors from all items (deterministic)
    const errors = await collectErrors(val);
    if (errors.length > 0) {
      throw new PoisonError(errors);
    }

    const hasPromises = val.some(item => item && typeof item.then === 'function');

    if (hasPromises) {
      try {
        let resolvedArray = await deepResolveArray(val);

        if (resolvedArray.length > 0) {
          resolvedArray = [resolvedArray.join(',')];
        }
        if (autoescape) {
          resolvedArray.push((value) => suppressValue(value, true));
        }
        return resolvedArray;
      } catch (err) {
        throw isPoisonError(err) ? err : new PoisonError([err]);
      }
    } else {
      // No promises in array
      if (val.length > 0) {
        val = [val.join(',')];
      }
      if (autoescape) {
        val.push((value) => suppressValue(value, true));
      }
      return val;
    }
  }

  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno, context) {
  if (val === null || val === undefined) {
    const err = new lib.TemplateError(
      'attempted to output null or undefined value',
      lineno + 1,
      colno + 1
    );
    if (context && context.path) {
      err.Update(context.path);
    }
    throw err;
  }
  return val;
}

function ensureDefinedAsync(val, lineno, colno, context) {
  // Poison check - return rejected promise synchronously
  if (isPoison(val)) {
    return val;
  }

  // Simple literal value - validate and return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return ensureDefined(val, lineno, colno, context);
  }

  // Complex cases - delegate to async helper
  return _ensureDefinedAsyncComplex(val, lineno, colno, context);
}

async function _ensureDefinedAsyncComplex(val, lineno, colno, context) {
  // Handle arrays with possible poison values
  if (Array.isArray(val)) {
    const errors = await collectErrors(val);
    if (errors.length > 0) {
      throw new PoisonError(errors);
    }

    // Append validation function
    val.push((v) => ensureDefined(v, lineno, colno, context));
    return val;
  }

  // Handle promises
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      throw isPoisonError(err) ? err : new PoisonError([err]);
    }

    if (isPoison(val)) {
      throw new PoisonError(val.errors);
    }
  }

  return ensureDefined(val, lineno, colno, context);
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
  // Collect all errors first (awaits all promises)
  const errors = await collectErrors(args);

  if (errors.length > 0) {
    return createPoison(errors);
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
    return createPoison(errors);
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
      return createPoison(errors);
    }
    try {
      resolvedValue = await deepResolveArray(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      throw err;
    }
  } else if (isPlainObject(resolvedValue)) {
    const errors = await collectErrors(Object.values(resolvedValue));
    if (errors.length > 0) {
      return createPoison(errors);
    }
    try {
      resolvedValue = await deepResolveObject(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
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

function flattenBuffer(arr, context = null, focusOutput = null) {
  // FAST PATH: If no context, it's a simple template. Concatenate strings and arrays.
  if (!context) {
    if (!Array.isArray(arr)) {
      return arr || '';
    }
    return arr.reduce((acc, item) => {
      if (Array.isArray(item)) {
        // The `null` context indicates a recursive call for a simple sub-array.
        return acc + flattenBuffer(item, null, null);
      }
      // A post-processing function, e.g. for SafeString
      if (typeof item === 'function') {
        return (item(acc) || '');
      }
      return acc + ((item !== null && item !== undefined) ? item : '');
    }, '');
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
    if (item === null || item === undefined) return;

    // Check for poison - collect errors and continue processing
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
              pos.colno
            );
            if (context && context.path) {
              err1.Update(context.path);
            }
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
                  pos.colno
                );
                if (context && context.path) {
                  err2.Update(context.path);
                }
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
                pos.colno
              );
              if (context && context.path) {
                err3.Update(context.path);
              }
              collectedErrors.push(err3);
            }
          } else {
            const err5 = handleError(
              new Error(`Handler '${handlerName}'${subpath ? '.' + subpath.join('.') : ''} has no method '${commandName}'`),
              pos.lineno,
              pos.colno
            );
            if (context && context.path) {
              err5.Update(context.path);
            }
            collectedErrors.push(err5);
          }
        } catch (err) {
          const wrappedErr = handleError(err, pos.lineno, pos.colno);
          if (context && context.path) {
            wrappedErr.Update(context.path);
          }
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
    const deduped = deduplicateErrors(collectedErrors);
    throw new PoisonError(deduped);
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

function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

function memberLookupScript(obj, val) {
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception 'Cannot read properties of null'
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

function memberLookupAsync(obj, val) {
  // Check for poison in inputs - return poison directly (it's a thenable)
  if (isPoison(obj)) {
    return obj;
  }
  if (isPoison(val)) {
    return val;
  }

  // Check if we have any promises
  const objIsPromise = obj && typeof obj.then === 'function';
  const valIsPromise = val && typeof val.then === 'function';

  if (!objIsPromise && !valIsPromise) {
    // Synchronous path - no promises to await
    return memberLookup(obj, val);
  }

  // Has promises - delegate to async helper
  return _memberLookupAsyncComplex(obj, val);
}

async function _memberLookupAsyncComplex(obj, val) {
  // Collect errors from both inputs (await all promises)
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors);
  }

  // Resolve the values
  const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

  // Check if resolved values are poison
  if (isPoison(resolvedObj)) {
    return resolvedObj;
  }
  if (isPoison(resolvedVal)) {
    return resolvedVal;
  }

  return memberLookup(resolvedObj, resolvedVal);
}

function memberLookupScriptAsync(obj, val) {
  // Check for poison in inputs
  if (isPoison(obj)) {
    return obj;
  }
  if (isPoison(val)) {
    return val;
  }

  // Check if we have any promises
  const objIsPromise = obj && typeof obj.then === 'function';
  const valIsPromise = val && typeof val.then === 'function';

  if (!objIsPromise && !valIsPromise) {
    // Synchronous path
    return memberLookupScript(obj, val);
  }

  // Has promises - delegate to async helper
  return _memberLookupScriptAsyncComplex(obj, val);
}

async function _memberLookupScriptAsyncComplex(obj, val) {
  // Collect errors from both inputs
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors);
  }

  // Resolve the values
  const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

  // Check if resolved values are poison
  if (isPoison(resolvedObj)) {
    return resolvedObj;
  }
  if (isPoison(resolvedVal)) {
    return resolvedVal;
  }

  return memberLookupScript(resolvedObj, resolvedVal);
}

function callWrap(obj, name, context, args) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                 !Object.prototype.hasOwnProperty.call(context.ctx, name);

  return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, args);
}

function callWrapAsync(obj, name, context, args) {
  // Check if we need async path: obj or any arg is a promise
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasArgPromises = args.some(arg => arg && typeof arg.then === 'function' && !isPoison(arg));

  if (objIsPromise || hasArgPromises) {
    // Must use async path to await all promises before making decisions
    // _callWrapAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _callWrapAsyncComplex(obj, name, context, args);
  }

  // All values are non-promises - collect all errors synchronously
  const errors = [];

  if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  // Collect errors from all poisoned args
  for (const arg of args) {
    if (isPoison(arg)) {
      errors.push(...arg.errors);
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }

  // No errors - validate and call
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey')
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function')
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, args);
  } catch (err) {
    return createPoison(err);
  }
}

async function _callWrapAsyncComplex(obj, name, context, args) {
  const errors = [];

  // Await obj if it's a promise and check for poison
  if (obj && typeof obj.then === 'function' && !isPoison(obj)) {
    try {
      obj = await obj;
      if (isPoison(obj)) {
        errors.push(...obj.errors);
      }
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  // Await ALL args to collect all errors (never miss any error principle)
  const argErrors = await collectErrors(args);
  errors.push(...argErrors);

  if (errors.length > 0) {
    return createPoison(errors);
  }

  // Resolve all arg promises
  const resolvedArgs = [];
  for (const arg of args) {
    if (arg && typeof arg.then === 'function') {
      try {
        resolvedArgs.push(await arg);
      } catch (err) {
        // Should not happen as collectErrors already caught errors
        return createPoison(isPoisonError(err) ? err.errors : [err]);
      }
    } else {
      resolvedArgs.push(arg);
    }
  }

  // All resolved successfully - validate and call the function
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey')
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function')
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, resolvedArgs);
  } catch (err) {
    return createPoison(err);
  }
}

//@todo - deprecate, the sequencedMemberLookupAsync of the FunCall path lookupVal/symbol should handle the frame lock release
async function sequencedCallWrap(func, funcName, context, args, frame, sequenceLockKey) {
  const lockValue = await awaitSequenceLock(frame, sequenceLockKey);

  // Check if lock itself is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Collect ALL errors from func and args (never miss any error principle)
    const errors = [];

    // Check func for poison or await if promise
    if (isPoison(func)) {
      errors.push(...func.errors);
    } else if (func && typeof func.then === 'function') {
      try {
        func = await func;
        if (isPoison(func)) {
          errors.push(...func.errors);
        }
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
      }
    }

    // Collect errors from args (await all promises for determinism)
    const argErrors = await collectErrors(args);
    errors.push(...argErrors);

    if (errors.length > 0) {
      const poison = createPoison(errors);
      frame.set(sequenceLockKey, poison, true);
      throw new PoisonError(errors);
    }

    // Call the function (callWrapAsync may return poison synchronously or a promise)
    const result = callWrapAsync(func, funcName, context, args);

    // Check if result is poison (from callWrapAsync's return)
    if (isPoison(result)) {
      frame.set(sequenceLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    // If result is a promise, await it
    if (result && typeof result.then === 'function') {
      try {
        const resolved = await result;
        return resolved;
      } catch (err) {
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        frame.set(sequenceLockKey, poison, true);
        throw err; // Re-throw original error
      }
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const poison = createPoison(err);
      frame.set(sequenceLockKey, poison, true);
      throw new PoisonError([err]);
    }
    const poison = createPoison(err.errors);
    frame.set(sequenceLockKey, poison, true);
    throw err;
  } finally {
    // Only release lock if not poisoned
    const currentLock = frame.lookup(sequenceLockKey);
    if (!isPoison(currentLock)) {
      frame.set(sequenceLockKey, true, true);
    }
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

function executeAsyncBlock(asyncFunc, astate, frame, cb, lineno, colno, context, errorContextString = null) {
  try {
    // 1. Invoke the async function to get the promise.
    const promise = asyncFunc(astate, frame);

    // 2. Attach our lifecycle handlers.
    promise.catch(err => {
      // This .catch() will now reliably run before the .finally() below.
      try {
        const handledError = handleError(err, lineno, colno, errorContextString);
        if (context) {
          handledError.Update(context.path);
        }
        cb(handledError);
      } catch (cbError) {
        console.error('FATAL: Error during Nunjucks error handling or callback:', cbError);
        console.error('Original error was:', err);
        throw cbError;
      }
      throw err;// maybe no need for this, as the return promise is never awaited, it's fire and forget
    }).finally(() => {
      // 3. This is guaranteed to run *after* the .catch() handler has completed.
      astate.leaveAsyncBlock();
    });

    return promise;
  } catch (syncError) {
    // This catches synchronous errors that might happen before the promise is even created.
    // This can happen mostly due to compiler error, may remove it in the future
    const handledError = handleError(syncError, lineno, colno, errorContextString);
    if (context) {
      handledError.Update(context.path);
    }
    cb(handledError);
    astate.leaveAsyncBlock(); // Ensure cleanup even on sync failure.
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

async function iterateAsyncSequential(arr, loopBody, loopVars, errorContext) {
  let didIterate = false;
  let i = 0;
  const errors = []; // Collect all errors, don't stop on first

  for await (const value of arr) {
    didIterate = true;

    // Check if yielded value is poison
    if (isPoison(value)) {
      errors.push(...value.errors);
      i++;
      continue; // Continue to collect all errors
    }

    let res;
    if (loopVars.length === 1) {
      // `while` loops pass `undefined` for len/last, which is correct.
      res = loopBody(value, i, undefined, false, errorContext);
    } else {
      if (!Array.isArray(value)) {
        throw new Error('Expected an array for destructuring');
      }
      res = loopBody(...value.slice(0, loopVars.length), i, undefined, false, errorContext);
    }

    // In sequential mode, we MUST await the body before the next iteration
    try {
      await res;

      // Check if result is poison (loop body may have returned poison)
      if (isPoison(res)) {
        errors.push(...res.errors);
      }
    } catch (err) {
      // Collect error and continue
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }

    i++;
  }

  // If any errors collected, throw them all
  if (errors.length > 0) {
    const deduped = deduplicateErrors(errors);
    throw new PoisonError(deduped);
  }

  return didIterate;
}

async function iterateAsyncParallel(arr, loopBody, loopVars, errorContext) {
  let didIterate = false;
  // PARALLEL PATH
  // This logic allows for `loop.length` and `loop.last` to work
  // by resolving promises only after the entire iterator is consumed. This
  // only works when loop bodies are fired in parallel (sequential=false)
  const iterator = arr[Symbol.asyncIterator]();
  let result;
  let i = 0;

  let lastPromiseResolve;
  let lastPromise = new Promise(resolve => {
    lastPromiseResolve = resolve;
  });

  const allErrors = []; // Collect ALL errors, not just first
  let firstError = null; // Track first for early stopping of iterator consumption

  const lenPromise = new Promise(resolve => {
    let length = 0;
    // This IIFE runs "in the background" to exhaust the iterator
    (async () => {
      try {
        // Continue iterating even after finding errors to collect ALL
        while (result = await iterator.next(), !result.done) {
          length++;
          didIterate = true;
          const value = result.value;

          // Check if yielded value is poison
          if (isPoison(value)) {
            allErrors.push(...value.errors);
            if (!firstError) {
              firstError = new PoisonError(value.errors);
            }
            i++;

            // Still resolve promises for loop variables
            if (lastPromiseResolve) {
              lastPromiseResolve(false);
              lastPromise = new Promise(resolveNew => {
                lastPromiseResolve = resolveNew;
              });
            }

            continue; // Continue to collect all errors
          }

          // Resolve the previous iteration's lastPromise
          if (lastPromiseResolve) {
            lastPromiseResolve(false);
            lastPromise = new Promise(resolveNew => {
              lastPromiseResolve = resolveNew;
            });
          }

          let res;
          if (loopVars.length === 1) {
            res = loopBody(value, i, lenPromise, lastPromise, errorContext);
          } else {
            if (!Array.isArray(value)) {
              throw new Error('Expected an array for destructuring');
            }
            res = loopBody(...value.slice(0, loopVars.length), i, lenPromise, lastPromise);
          }

          // Attach error handler (don't await - parallel execution)
          if (res && typeof res.then === 'function') {
            res.catch(err => {
              if (isPoisonError(err)) {
                allErrors.push(...err.errors);
              } else {
                allErrors.push(err);
              }
              if (!firstError) {
                firstError = err;
              }
            });
          }

          i++;
        }

        // Resolve final lastPromise
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        resolve(length);

        // Throw if any errors collected
        if (allErrors.length > 0) {
          const deduped = deduplicateErrors(allErrors);
          throw new PoisonError(deduped);
        }
      } catch (error) {
        if (lastPromiseResolve) {
          if (!firstError) {
            firstError = error;
          }
          resolve(length);
          lastPromiseResolve(true);
        }
        throw error;
      }
    })();
  });

  // Wait for iteration to complete
  await lenPromise;

  if (firstError) {
    const err = handleError(firstError, errorContext.lineno, errorContext.colno, errorContext.errorContextString);
    err.Update(errorContext.path);
    throw err;
  }

  return didIterate;
}

async function iterate(arr, loopBody, loopElse, loopFrame, bodyWriteCounts, loopVars = [], sequential = false, isAsync = false, errorContext) {
  let didIterate = false;

  // Check if iterable itself is poisoned
  if (isPoison(arr)) {
    // Poison all variables that would be written by the loop body
    if (bodyWriteCounts && loopFrame) {
      loopFrame.poisonBranchWrites(arr, bodyWriteCounts);
    }

    // Execute else branch if provided
    if (loopElse) {
      await loopElse();
    }

    return false;
  }

  if (isAsync && arr && typeof arr[Symbol.asyncIterator] === 'function') {
    // We must have two separate code paths. The `lenPromise` and `lastPromise`
    // mechanism is fundamentally incompatible with sequential execution, as it
    // would create a deadlock.

    if (sequential) {
      // Used for `while` and `each` loops and
      // any `for` loop marked as sequential. It does NOT support `loop.length`
      // or `loop.last` for async iterators, as that is impossible to know
      // without first consuming the entire iterator.
      didIterate = await iterateAsyncSequential(arr, loopBody, loopVars, errorContext);
    } else {
      // PARALLEL PATH
      // This complex logic allows for `loop.length` and `loop.last` to work
      // by resolving promises only after the entire iterator is consumed. This
      // only works when loop bodies are fired in parallel (sequential=false)
      didIterate = await iterateAsyncParallel(arr, loopBody, loopVars, errorContext);
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
          throw new Error(`Expected two variables for key/value iteration, got ${loopVars.length} : ${loopVars.join(', ')}`);
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
  const lockValue = await awaitSequenceLock(frame, nodeLockKey);

  // Check if lock is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Perform lookup
    const result = contextOrFrameLookup(context, frame, name);

    // Check if result is poison
    if (isPoison(result)) {
      frame.set(nodeLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const poison = createPoison(err);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError([err]);
    }
    const poison = createPoison(err.errors);
    frame.set(nodeLockKey, poison, true);
    throw err;
  } finally {
    // Only release lock if not poisoned
    const currentLock = frame.lookup(nodeLockKey);
    if (!isPoison(currentLock)) {
      frame.set(nodeLockKey, true, true);
    }
  }
}

// Called in place of memberLookupAsync when the path has a sequence lock on it
async function sequencedMemberLookupAsync(frame, target, key, nodeLockKey) {
  const lockValue = await awaitSequenceLock(frame, nodeLockKey);

  // Check if lock is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Check target for poison before resolving
    if (isPoison(target)) {
      throw new PoisonError(target.errors);
    }

    // Resolve target if it's a promise
    let resolvedTarget = target;
    if (target && typeof target.then === 'function') {
      try {
        resolvedTarget = await target;
      } catch (err) {
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        frame.set(nodeLockKey, poison, true);
        throw err;
      }

      // Check if resolved to poison
      if (isPoison(resolvedTarget)) {
        frame.set(nodeLockKey, resolvedTarget, true);
        throw new PoisonError(resolvedTarget.errors);
      }
    }

    // Perform lookup
    const result = memberLookup(resolvedTarget, key);

    // Check if result is poison
    if (isPoison(result)) {
      frame.set(nodeLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const poison = createPoison(err);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError([err]);
    }
    const poison = createPoison(err.errors);
    frame.set(nodeLockKey, poison, true);
    throw err;
  } finally {
    // Only release lock if not poisoned
    const currentLock = frame.lookup(nodeLockKey);
    if (!isPoison(currentLock)) {
      frame.set(nodeLockKey, true, true);
    }
  }
}

// Called in place of memberLookupAsync when the path has a sequence lock on it
async function sequencedMemberLookupScriptAsync(frame, target, key, nodeLockKey) {
  const lockValue = await awaitSequenceLock(frame, nodeLockKey);

  // Check if lock is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Check target for poison
    if (isPoison(target)) {
      throw new PoisonError(target.errors);
    }

    // Resolve target if it's a promise
    let resolvedTarget = target;
    if (target && typeof target.then === 'function') {
      try {
        resolvedTarget = await target;
      } catch (err) {
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        frame.set(nodeLockKey, poison, true);
        throw err;
      }

      // Check if resolved to poison
      if (isPoison(resolvedTarget)) {
        frame.set(nodeLockKey, resolvedTarget, true);
        throw new PoisonError(resolvedTarget.errors);
      }
    }

    // Perform lookup
    const result = memberLookupScript(resolvedTarget, key);

    // Check if result is poison
    if (isPoison(result)) {
      frame.set(nodeLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const poison = createPoison(err);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError([err]);
    }
    const poison = createPoison(err.errors);
    frame.set(nodeLockKey, poison, true);
    throw err;
  } finally {
    // Only release lock if not poisoned
    const currentLock = frame.lookup(nodeLockKey);
    if (!isPoison(currentLock)) {
      frame.set(nodeLockKey, true, true);
    }
  }
}

module.exports = {
  Frame,
  AsyncFrame,
  AsyncState,

  // Poison value infrastructure
  PoisonedValue,
  PoisonError: PoisonError,
  createPoison,
  isPoison,
  isPoisonError,
  collectErrors,

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
  deepResolveArray,
  deepResolveObject,
  flattenBuffer,
  withPath,

  memberLookup,
  memberLookupAsync,
  sequencedMemberLookupAsync,

  memberLookupScript,
  memberLookupScriptAsync,
  sequencedMemberLookupScriptAsync,

  contextOrFrameLookup,
  callWrap,
  callWrapAsync,
  sequencedCallWrap,
  handleError,
  executeAsyncBlock,
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
