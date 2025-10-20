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
 * PoisonedValue: An inspectable error container that can be detected synchronously
 * and automatically rejects when awaited.
 *
 * Purpose: Enables sync-first error detection (isPoison()) while maintaining
 * compatibility with await/promises. Avoids async overhead for error propagation
 *
 * NOT FULLY PROMISE A+ COMPLIANT
 * - Rejection handlers execute synchronously (not on microtask queue)
 * - Returns `this` when no handler provided (doesn't create new promise)
 *
 * Trade-off: faster for sync-first patterns, but may break code expecting strict async behavior.
 */
class PoisonedValue {
  constructor(errors) {
    this.errors = Array.isArray(errors) ? errors : [errors];
    this[POISON_KEY] = true;
  }

  then(onFulfilled, onRejected) {
    // Optimization: if no rejection handler, propagate poison directly
    if (!onRejected) {
      return this;
    }

    const error = new PoisonError(this.errors);

    // Call the rejection handler
    try {
      const result = onRejected(error);
      // Handler succeeded - need Promise for fulfillment
      // Use Promise.resolve to handle case where result is itself a thenable
      return Promise.resolve(result);
    } catch (err) {
      // Handler threw - return new PoisonedValue (no Promise needed!)
      return createPoison(isPoisonError(err) ? err.errors : [err]);
    }
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
    errors = Array.isArray(errors) ? errors : [errors];
    const deduped = deduplicateAndFlattenErrors(errors);

    super();

    this.name = 'PoisonError';
    this.errors = deduped;
    this[POISON_ERROR_KEY] = true;

    // Determine the appropriate stack trace
    const stacks = deduped.map(e => e.stack).filter(Boolean);
    const allSame = stacks.length > 0 && stacks.every(s => s === stacks[0]);

    if (allSame) {
      // Use the shared stack if all are identical
      this.stack = stacks[0];
    }

    // Ensure correct prototype chain (for Babel/older environments)
    Object.setPrototypeOf?.(this, new.target.prototype);
  }

  get message() {
    const deduped = this.errors;
    return deduped.length === 1
      ? deduped[0].message
      : `Multiple errors occurred (${deduped.length}):\n` +
        deduped.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n');
  }
}

/**
 * Runtime error with position and context information.
 */
class RuntimeError extends Error {
  constructor(message, lineno, colno, errorContextString = null, path = null) {
    let err;
    let cause;
    if (message instanceof Error) {
      cause = message;
      err = new Error(`${cause.name}: ${cause.message}`);
    } else {
      err = new Error(message);
    }

    // Build formatted message with path and position info
    let formattedMessage = err.message;
    if (path) {
      let msg = '(' + (path || 'unknown path') + ')';

      if (lineno && colno) {
        msg += ` [Line ${lineno}, Column ${colno}]`;
      } else if (lineno) {
        msg += ` [Line ${lineno}]`;
      }

      if (errorContextString) {
        msg += ` doing '${errorContextString}'`;
      }

      msg += '\n  ';
      formattedMessage = msg + formattedMessage;
    }

    super(formattedMessage);
    this.name = 'RuntimeError';
    this.lineno = lineno;
    this.colno = colno;
    this.errorContextString = errorContextString;
    this.path = path;
    this.cause = cause;

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}


/**
 * Deduplicate errors by message and flatten any PoisonError objects.
 */
function deduplicateAndFlattenErrors(errors) {
  const seen = new Map();
  const result = [];

  for (const err of errors) {
    // If it's a PoisonError, flatten its underlying errors
    if (isPoisonError(err)) {
      for (const flattenedErr of err.errors) {
        const key = flattenedErr;//.message || String(flattenedErr);
        if (!seen.has(key)) {
          seen.set(key, true);
          result.push(flattenedErr);
        }
      }
    } else {
      const key = err;//err.message || String(err);
      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(err);
      }
    }
  }

  return result;
}

/**
 * Create a poison value from one or more errors, optionally adding position and path info.
 * Preserves existing position info in errors - never overwrites lineno, colno, or path.
 * Only adds position/path to errors that don't already have it.
 *
 * @param {Error|Error[]} errorOrErrors - Single error or array of errors
 * @param {number} lineno - Line number where error occurred (optional)
 * @param {number} colno - Column number where error occurred (optional)
 * @param {string} errorContextString - Context string for error message (optional)
 * @param {string} path - Template path (optional)
 * @returns {PoisonedValue} Poison value containing the error(s)
 */
function createPoison(errorOrErrors, lineno = null, colno = null, errorContextString = null, path = null) {
  let errors = Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors];

  // If position or path info provided, add it to errors that don't already have it
  if (lineno !== null || colno !== null || errorContextString !== null || path !== null) {
    errors = errors.map(err => {
      // If it's a PoisonError, extract its errors and process each one
      if (isPoisonError(err)) {
        return err.errors.map(e => {
          // If error already has position info, preserve it completely (don't update lineno, colno, or path)
          if (e.lineno) {
            return e;
          }
          // Error lacks position info - add it via handleError
          return handleError(e, lineno || 0, colno || 0, errorContextString, path);
        });
      }
      // If error already has position info, preserve it completely
      if (err.lineno) {
        return err;
      }
      // Error lacks position info - add it via handleError
      return handleError(err, lineno || 0, colno || 0, errorContextString, path);
    }).flat();
  }

  return new PoisonedValue(errors);
}

/**
 * Check if a value is poisoned.
 */
function isPoison(value) {
  return value != null/*and undefined*/ && value[POISON_KEY] === true;
}

/**
 * Check if an error is a PoisonError.
 * More reliable than instanceof after transpilation.
 */
function isPoisonError(error) {
  return error != null/*and undefined*/ && error[POISON_ERROR_KEY] === true;
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

  return deduplicateAndFlattenErrors(errors);
}

/**
 * Add poison markers to output buffer for handlers that would have been written
 * in a branch that wasn't executed due to poisoned condition.
 *
 * When a condition evaluates to poison (error), branches aren't executed but would
 * have written to output handlers. This function adds markers to the buffer so that
 * flattenBuffer can collect these errors.
 *
 * @param {Array} buffer - The output buffer array to add markers to
 * @param {PoisonedValue|Error} error - The poison value or error from failed condition (should already have position info)
 * @param {Array<string>} handlerNames - Names of handlers (e.g., ['text', 'data'])
 */
function addPoisonMarkersToBuffer(buffer, errorOrErrors, handlerNames) {
  // Note: error parameter should already have position info from condition evaluation
  // No additional position info available in this function's scope
  //const poison = isPoison(errorOrPoison) ? errorOrPoison : createPoison(errorOrPoison);
  const errors = (Array.isArray(errorOrErrors) ? errorOrErrors : [errorOrErrors]);

  // Add one marker per handler that would have been written to
  for (const handlerName of handlerNames) {
    const marker = {
      __cascadaPoisonMarker: true,  // Flag for detection in flattenBuffer
      errors,         // Array of Error objects to collect
      handler: handlerName,          // Which handler was intended (for debugging)
    };

    buffer.push(marker);
  }
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

  has(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return true;
    }
    if (this.variables && name in this.variables) {
      return true;
    }
    return this.parent && this.parent.has(name);
  }

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
  /*finalizeLoopWrites(finalWriteCounts) {
    if (!finalWriteCounts) {
      return; // No parent or nothing to finalize
    }

    // When a sequential loop finishes, it's considered a single unit of work.
    // We must decrement the counter on its *own frame* to signal its completion.
    // This, in turn, will trigger the resolution of its promise and propagate the
    // completion signal upwards to its parent frame via _countdownAndResolveAsyncWrites.
    for (const varName in finalWriteCounts) {
      // The value in finalWriteCounts doesn't matter, just the variable name.
      // We signal that the loop's entire influence on this variable is now complete.
      if (this.writeCounters && varName in this.writeCounters) {
        // Use the standard countdown on the parent.
        // This will trigger promise resolution if it hits zero there.
        this._countdownAndResolveAsyncWrites(varName, 1);
      } else {
        // This path indicates a compiler bug. The compiler generated
        // `bodyWriteCounts` with a variable that it failed to register on the
        // loop's own async frame. We must throw an error, because silently
        // ignoring this would lead to a deadlock.
        throw new Error(`Loop finalized write for "${varName}", but the loop's own frame has no counter for it.`);
      }
    }
  }*/

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
        // Note: error from async variable resolution, position info added upstream if available
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

function suppressValueAsync(val, autoescape, errorContext) {
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
    return _suppressValueAsyncComplex(val, autoescape, errorContext);
  }

  // Promise - delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape, errorContext);
}

async function _suppressValueAsyncComplex(val, autoescape, errorContext) {
  // Handle promise values
  if (val && typeof val.then === 'function') {
    try {
      val = await val;
    } catch (err) {
      if (isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new PoisonError([contextualError]);
      }
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
        if (isPoisonError(err)) {
          throw err;
        } else {
          const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
          throw new PoisonError([contextualError]);
        }
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
    const err = handleError(
      new Error('attempted to output null or undefined value'),
      lineno + 1,
      colno + 1,
      null,
      context ? context.path : null
    );
    throw err;
  }
  return val;
}

//@todo - remove lineno, colno
function ensureDefinedAsync(val, lineno, colno, context, errorContext) {
  // Poison check - return rejected promise synchronously
  if (isPoison(val)) {
    return val;
  }

  // Simple literal value - validate and return synchronously
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return ensureDefined(val, lineno, colno, context);
  }

  // Complex cases - delegate to async helper
  return _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext);
}

//@todo - remove lineno, colno
async function _ensureDefinedAsyncComplex(val, lineno, colno, context, errorContext) {
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
      if (isPoisonError(err)) {
        throw err;
      } else {
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        throw new PoisonError([contextualError]);
      }
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
    throw new Error('Cannot read properties of null');//@todo - null/undefined
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

function memberLookupAsync(obj, val, errorContext) {
  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupAsyncComplex(obj, val, errorContext);
  }

  // Sync path - collect ALL errors from both sources (never miss any error principle)
  const objPoison = isPoison(obj);
  const valPoison = isPoison(val);

  if (objPoison && valPoison) {
    // Both poisoned - merge errors
    return createPoison([...obj.errors, ...val.errors]);
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  // No errors - proceed with lookup
  return memberLookup(obj, val);
}

async function _memberLookupAsyncComplex(obj, val, errorContext) {
  // Collect errors from both inputs (await all promises)
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve the values
  try {
    const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

    // Collect errors from BOTH resolved values (never miss any error principle)
    const objPoison = isPoison(resolvedObj);
    const valPoison = isPoison(resolvedVal);

    if (objPoison && valPoison) {
      // Both poisoned - merge errors
      return createPoison([...resolvedObj.errors, ...resolvedVal.errors]);
    } else if (objPoison) {
      // Only obj poisoned - return it directly
      return resolvedObj;
    } else if (valPoison) {
      // Only val poisoned - return it directly
      return resolvedVal;
    }

    return memberLookup(resolvedObj, resolvedVal);
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    } else {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      return createPoison(contextualError);
    }
  }
}

function memberLookupScriptAsync(obj, val, errorContext) {
  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const valIsPromise = val && typeof val.then === 'function' && !isPoison(val);

  if (objIsPromise || valIsPromise) {
    // Must delegate to async helper to await all promises
    return _memberLookupScriptAsyncComplex(obj, val, errorContext);
  }

  // Sync path - collect ALL errors from both sources (never miss any error principle)
  const objPoison = isPoison(obj);
  const valPoison = isPoison(val);

  if (objPoison && valPoison) {
    // Both poisoned - merge errors
    return createPoison([...obj.errors, ...val.errors]);
  } else if (objPoison) {
    // Only obj poisoned - return it directly
    return obj;
  } else if (valPoison) {
    // Only val poisoned - return it directly
    return val;
  }

  // No errors - proceed with lookup
  // Let native error throw; it will be caught by the top-level sync try/catch.
  //return memberLookupScript(obj, val);

  // The same implementation as memberLookupScript, but returns a poison value instead of throwing an exception
  if (obj === undefined || obj === null) {
    //unlike in template mode, in script mode we throw an exception 'Cannot read properties of null'
    return createPoison(new Error('Cannot read properties of null'));//@todo - null/undefined
  }

  const value = obj[val];//some APIs (vercel ai result.elementStream) do not like multiple reads
  if (typeof value === 'function') {
    return (...args) => obj[val](...args);//use obj lookup so that 'this' binds correctly
  }

  return value;
}

async function _memberLookupScriptAsyncComplex(obj, val, errorContext) {
  // Collect errors from both inputs
  const errors = await collectErrors([obj, val]);
  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve the values
  try {
    const [resolvedObj, resolvedVal] = await resolveDuo(obj, val);

    // Collect errors from BOTH resolved values (never miss any error principle)
    const objPoison = isPoison(resolvedObj);
    const valPoison = isPoison(resolvedVal);

    if (objPoison && valPoison) {
      // Both poisoned - merge errors
      return createPoison([...resolvedObj.errors, ...resolvedVal.errors]);
    } else if (objPoison) {
      // Only obj poisoned - return it directly
      return resolvedObj;
    } else if (valPoison) {
      // Only val poisoned - return it directly
      return resolvedVal;
    }

    // The call to memberLookupScript can throw a native TypeError if resolvedObj is null/undefined.
    // This try/catch block will handle it and enrich the error with context.
    return memberLookupScript(resolvedObj, resolvedVal);
  } catch (err) {
    // If the error is already a PoisonError, propagate it.
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    } else {
      // Otherwise, it's a native error. Enrich it with template context.
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      return createPoison(contextualError);
    }
  }
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

function callWrapAsync(obj, name, context, args, errorContext) {
  // Check if we need async path: obj or any arg is a promise
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasArgPromises = args.some(arg => arg && typeof arg.then === 'function' && !isPoison(arg));

  if (objIsPromise || hasArgPromises) {
    // Must use async path to await all promises before making decisions
    // _callWrapAsyncComplex is async and returns poison when errors occur
    // When awaited, poison values throw PoisonError due to thenable protocol (by design)
    return _callWrapAsyncComplex(obj, name, context, args, errorContext);
  }

  // All values are non-promises - collect all errors synchronously
  const objPoison = isPoison(obj);
  const poisonedArgs = args.filter(isPoison);

  // Optimize: avoid creating new poison if only one source is poisoned
  if (objPoison && poisonedArgs.length === 0) {
    return obj; // Only obj is poisoned - return it directly
  } else if (!objPoison && poisonedArgs.length === 1) {
    return poisonedArgs[0]; // Only one arg is poisoned - return it directly
  } else if (objPoison || poisonedArgs.length > 0) {
    // Multiple sources poisoned - merge all errors
    const errors = [
      ...(objPoison ? obj.errors : []),
      ...poisonedArgs.flatMap(p => p.errors)
    ];
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // No errors - validate and call
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, args);
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

async function _callWrapAsyncComplex(obj, name, context, args, errorContext) {
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
        // Add context to the error when catching from await
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        errors.push(contextualError);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  // Await ALL args to collect all errors (never miss any error principle)
  const argErrors = await collectErrors(args);
  errors.push(...argErrors);

  if (errors.length > 0) {
    return createPoison(errors); // Errors already have position info from collectErrors
  }

  // Resolve all arg promises
  const resolvedArgs = [];
  for (const arg of args) {
    if (arg && typeof arg.then === 'function') {
      try {
        resolvedArgs.push(await arg);
      } catch (err) {
        // Should not happen as collectErrors already caught errors
        const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        return createPoison(isPoisonError(err) ? err.errors : [contextualError]);
      }
    } else {
      resolvedArgs.push(arg);
    }
  }

  // All resolved successfully - validate and call the function
  if (!obj) {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is undefined or falsey'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  } else if (typeof obj !== 'function') {
    return createPoison(
      new Error('Unable to call `' + name + '`, which is not a function'),
      errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path
    );
  }

  try {
    const isGlobal = Object.prototype.hasOwnProperty.call(context.env.globals, name) &&
                   !Object.prototype.hasOwnProperty.call(context.ctx, name);

    return obj.apply((obj.isMacro || isGlobal) ? context : context.ctx, resolvedArgs);
  } catch (err) {
    return createPoison(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
  }
}

//@todo - deprecate, the sequencedMemberLookupAsync of the FunCall path lookupVal/symbol should handle the frame lock release
async function sequencedCallWrap(func, funcName, context, args, frame, sequenceLockKey, errorContext) {
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
          const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
          errors.push(contextualError);
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
    const result = callWrapAsync(func, funcName, context, args, errorContext);

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
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path));
        frame.set(sequenceLockKey, poison, true);
        throw err; // Re-throw original error
      }
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      const poison = createPoison(contextualError);
      frame.set(sequenceLockKey, poison, true);
      throw new PoisonError([contextualError]);
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

//returns undefined if the variable is not found
function contextOrFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

//throws an error if the variable is not found
function contextOrFrameLookupScript(context, frame, name) {
  let {value: val, frame: f} = frame.lookupAndLocate(name);
  // use the above to avoid variable set to undefined triggering an error
  // scripts, unlike temlates throw at non-existing variables
  return f ? val : context.lookupScriptMode(name);
}

//returns a poison error if the variable is not found
function contextOrFrameLookupScriptAsync(context, frame, name) {
  let {value: val, frame: f} = frame.lookupAndLocate(name);
  // use the above to avoid variable set to undefined triggering an error
  // scripts, unlike temlates throw at non-existing variables
  return f ? val : context.lookupScriptModeAsync(name);
}

/**
 * Handle errors by adding template position information and path context.
 * Preserves PoisonError with multiple errors, adding path to each contained error.
 *
 * @param {Error} error - The error to handle
 * @param {number} lineno - Line number where error occurred
 * @param {number} colno - Column number where error occurred
 * @param {string} errorContextString - Context string for error message
 * @param {string} path - Template path (e.g., 'template.njk')
 * @returns {Error} Processed error with position and path information
 * @todo - merge TemplateError and PoisonError
 */
function handleError(error, lineno, colno, errorContextString = null, path = null) {
  // Special handling for PoisonError - preserve multiple errors
  if (isPoisonError(error)) {
    // Add path information to each contained error
    if (lineno || path) {
      // @todo - we probably shall not do this if there are multiple errors
      error.errors = error.errors.map(err => {
        return handleError(err, lineno, colno, errorContextString, path);
      });
    }
    return error; // Return PoisonError with updated errors
  }

  // Regular error handling
  if ('lineno' in error && error.lineno !== undefined) {
    // Already has position info
    /*if (path && !error.path && typeof error.Update === 'function') {
      //does this happen?
      error.Update(path);
    }*/
    return error;
  } else {
    // Wrap in RuntimeError
    const wrappedError = new RuntimeError(error, lineno, colno, errorContextString, path);
    return wrappedError;
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
        const handledError = handleError(err, lineno, colno, errorContextString, context ? context.path : null);
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
    const handledError = handleError(syncError, lineno, colno, errorContextString, context ? context.path : null);
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

  try {
    for await (let value of arr) { // value is now mutable
      didIterate = true;

      if (value instanceof Error) {
        // Soft error: generator yielded an error. Add context and poison it.
        value = handleError(value, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        value = createPoison(value);
      }

      let res;
      if (loopVars.length === 1) {
        // `while` loops pass `undefined` for len/last, which is correct.
        res = loopBody(value, i, undefined, false, errorContext);
      } else {
        if (isPoison(value)) {
          const args = Array(loopVars.length);
          args[0] = value;
          res = loopBody(...args, i, undefined, false, errorContext);
        } else if (!Array.isArray(value)) {
          throw new Error('Expected an array for destructuring');
        } else {
          res = loopBody(...value.slice(0, loopVars.length), i, undefined, false, errorContext);
        }
      }

      // In sequential mode, we MUST await the body before the next iteration.
      // If it throws, the outer catch will handle it and stop iteration.
      await res;

      i++;
    }
  } catch (err) {
    // Hard error: generator threw OR the loopBody threw.
    // Add error context and re-throw immediately (stop iteration)
    const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
    contextualError.didIterate = didIterate;
    throw contextualError;
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

  const loopBodyPromises = []; // Track all loop body promises

  // This promise is used for the completion and error propagation
  let iterationComplete;
  const lenPromise = new Promise((resolve, reject) => {
    let length = 0;
    // This IIFE runs "in the background" to exhaust the iterator
    iterationComplete = (async () => {
      try {
        while (true) {
          // Async generators await yielded values. If a generator yields a thenable that rejects,
          // iterator.next() will throw. We catch PoisonErrors as soft errors and continue iteration.
          // Non-PoisonErrors from the generator are treated as hard errors.
          result = await iterator.next();

          // Check if iterator is done
          if (result.done) {
            break;
          }

          length++;
          didIterate = true;
          let value = result.value;
          if (value instanceof Error) {
            // Soft error: generator yielded an error
            value = handleError(value, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
            value = createPoison(value);
          }

          // Resolve the previous iteration's lastPromise
          if (lastPromiseResolve) {
            lastPromiseResolve(false);
            lastPromise = new Promise(resolveNew => {
              lastPromiseResolve = resolveNew;
            });
          }

          if (loopVars.length === 1) {
            loopBody(value, i, lenPromise, lastPromise, errorContext);
          } else {
            if (!Array.isArray(value)) {
              throw new Error('Expected an array for destructuring');
            }
            loopBody(...value.slice(0, loopVars.length), i, lenPromise, lastPromise);
          }
          i++;
        }

        // Resolve final lastPromise
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        // Resolve length to unblock any loop bodies waiting for loop.length
        resolve(length);

        // Wait for all loop body promises to complete before checking errors
        await Promise.allSettled(loopBodyPromises);

      } catch (error) {
        // Hard error from iterator.next() or loop body
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        // Add error context and re-throw, it will be caught by the outer catch block
        // where all write variables and handlers are poisoned
        const contextualError =  handleError(error, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
        contextualError.didIterate = didIterate;

        //resolve(length);//Ensure length is resolved even on error
        reject(new PoisonError(new PoisonError(contextualError)));//the length is a poison


        //throw contextualError;//re-thrown by iterationComplete
      }
    })();
  });

  // Wait for iteration to complete (including loop bodies)
  // lenPromise resolves with length, iterationComplete handles errors
  await lenPromise;
  await iterationComplete;

  return didIterate;
}

async function iterate(arr, loopBody, loopElse, loopFrame, buffer, loopVars = [], asyncOptions = null) {
  // Handle poison detection if in async mode
  if (asyncOptions) {
    // Check for synchronous poison first
    if (isPoison(arr)) {
      // Array expression evaluated to poison - poison both body and else
      poisonLoopEffects(loopFrame, buffer, asyncOptions, arr.errors);
      return; // Early return, else doesn't run
    }

    // Check for promise that might reject with poison
    if (arr && typeof arr.then === 'function') {
      try {
        arr = await arr;
      } catch (err) {
        // Promise rejected - poison both body and else
        //const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        const errors = isPoisonError(err) ? err.errors : [err];
        poisonLoopEffects(loopFrame, buffer, asyncOptions, errors);
        throw err; // Re-throw for upstream handling
      }
    }

    // Note: After await, arr cannot be poison (await converts poison to PoisonError)
  }

  const sequential = asyncOptions ? asyncOptions.sequential : false;
  const isAsync = asyncOptions !== null;
  const bodyWriteCounts = asyncOptions ? asyncOptions.bodyWriteCounts : null;
  const elseWriteCounts = asyncOptions ? asyncOptions.elseWriteCounts : null;
  const errorContext = asyncOptions ? asyncOptions.errorContext : null;

  let didIterate = false;

  try {
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

        didIterate = len > 0;
        for (let i = 0; i < arr.length; i++) {
          let value = arr[i];
          const isLast = i === arr.length - 1;

          // Convert Error objects to poison for consistency with async iterators
          // (Poison values and rejecting promises pass through as-is)
          if (value instanceof Error && !isPoison(value)) {
            value = handleError(value, errorContext.lineno, errorContext.colno,
              errorContext.errorContextString, errorContext.path);
            value = createPoison(value);
          }

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
        didIterate = len > 0;

        for (let i = 0; i < len; i++) {
          const key = keys[i];
          let value = arr[key];
          const isLast = i === keys.length - 1;

          // Convert Error objects to poison for consistency
          if (value instanceof Error && !isPoison(value)) {
            value = handleError(value, errorContext.lineno, errorContext.colno,
              errorContext.errorContextString, errorContext.path);
            value = createPoison(value);
          }

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
  } catch (err) {
    const errors = isPoisonError(err) ? err.errors : [err];
    didIterate = errors[errors.length - 1]?.didIterate || false;
    // if we had at least one iteration, we won't poison the else side-effects
    poisonLoopEffects(loopFrame, buffer, asyncOptions, errors, didIterate);
  }

  // Implement mutual exclusion between body and else execution
  // This follows our plan: always skip body, conditionally handle else

  // Step 3: Always skip body write counters (regardless of didIterate)
  // Body writes are suppressed during execution via sequentialLoopBody,
  // this skip signals their completion to the loop frame
  if (bodyWriteCounts && Object.keys(bodyWriteCounts).length > 0) {
    loopFrame.skipBranchWrites(bodyWriteCounts);
  }

  // Step 4-5: Handle else execution and write counting
  if (!didIterate && loopElse) {
    // Step 4: Else block runs - let it propagate normally to loop frame
    await loopElse();
  } else if (elseWriteCounts && Object.keys(elseWriteCounts).length > 0) {
    // Step 5: Else block doesn't run - skip its write counters
    loopFrame.skipBranchWrites(elseWriteCounts);
  }

  // Note: No finalizeLoopWrites needed - the skipBranchWrites calls above
  // handle the completion signaling for the mutual exclusion pattern
}

/**
 * Poison both body and else effects when loop array is poisoned before iteration.
 * We poison both branches because we don't know if the underlying value would have
 * been empty (else runs) or non-empty (body runs).
 *
 * @param {AsyncFrame} frame - The loop frame
 * @param {Array} buffer - The output buffer array
 * @param {Object} asyncOptions - Options containing write counts and handlers
 * @param {PoisonedValue|Error} poisonValue - The poison value to propagate
 */
function poisonLoopEffects(frame, buffer, asyncOptions, errors, didIterate = false) {
  //const poison = isPoison(poisonValue) ? poisonValue : createPoison(poisonValue);

  // Poison body effects
  if (asyncOptions.bodyWriteCounts && Object.keys(asyncOptions.bodyWriteCounts).length > 0) {
    frame.poisonBranchWrites(errors, asyncOptions.bodyWriteCounts);
  }
  if (asyncOptions.bodyHandlers && asyncOptions.bodyHandlers.length > 0) {
    addPoisonMarkersToBuffer(buffer, errors, asyncOptions.bodyHandlers);
  }

  if (didIterate) {
    return;// we don't poison the else side-effects if we had at least one iteration
  }

  // Poison else effects
  if (asyncOptions.elseWriteCounts && Object.keys(asyncOptions.elseWriteCounts).length > 0) {
    frame.poisonBranchWrites(errors, asyncOptions.elseWriteCounts);
  }
  if (asyncOptions.elseHandlers && asyncOptions.elseHandlers.length > 0) {
    addPoisonMarkersToBuffer(buffer, errors, asyncOptions.elseHandlers);
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
    // Note: context not available in this function signature, so path cannot be added
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
async function sequencedMemberLookupAsync(frame, target, key, nodeLockKey, errorContext) {
  const lockValue = await awaitSequenceLock(frame, nodeLockKey);

  // Check if lock is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Collect errors from BOTH target and key (never miss any error principle)
    const errors = await collectErrors([target, key]);
    if (errors.length > 0) {
      const poison = createPoison(errors);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError(errors);
    }

    // Resolve both if needed
    const [resolvedTarget, resolvedKey] = await resolveDuo(target, key);

    // Check if BOTH resolved values are poison (collect all errors)
    const targetPoison = isPoison(resolvedTarget);
    const keyPoison = isPoison(resolvedKey);

    if (targetPoison || keyPoison) {
      let poison;
      if (targetPoison && keyPoison) {
        // Both poisoned - merge errors
        poison = createPoison([...resolvedTarget.errors, ...resolvedKey.errors]);
      } else if (targetPoison) {
        // Only target poisoned - use it directly
        poison = resolvedTarget;
      } else {
        // Only key poisoned - use it directly
        poison = resolvedKey;
      }
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError(poison.errors);
    }

    // Perform lookup
    const result = memberLookup(resolvedTarget, resolvedKey);

    // Check if result is poison
    if (isPoison(result)) {
      frame.set(nodeLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      const poison = createPoison(contextualError);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError([contextualError]);
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
async function sequencedMemberLookupScriptAsync(frame, target, key, nodeLockKey, errorContext) {
  const lockValue = await awaitSequenceLock(frame, nodeLockKey);

  // Check if lock is poisoned
  if (isPoison(lockValue)) {
    throw new PoisonError(lockValue.errors);
  }

  try {
    // Collect errors from BOTH target and key (never miss any error principle)
    const errors = await collectErrors([target, key]);
    if (errors.length > 0) {
      const poison = createPoison(errors);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError(errors);
    }

    // Resolve both if needed
    const [resolvedTarget, resolvedKey] = await resolveDuo(target, key);

    // Check if BOTH resolved values are poison (collect all errors)
    const targetPoison = isPoison(resolvedTarget);
    const keyPoison = isPoison(resolvedKey);

    if (targetPoison || keyPoison) {
      let poison;
      if (targetPoison && keyPoison) {
        // Both poisoned - merge errors
        poison = createPoison([...resolvedTarget.errors, ...resolvedKey.errors]);
      } else if (targetPoison) {
        // Only target poisoned - use it directly
        poison = resolvedTarget;
      } else {
        // Only key poisoned - use it directly
        poison = resolvedKey;
      }
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError(poison.errors);
    }

    // Perform lookup
    const result = memberLookupScript(resolvedTarget, resolvedKey);

    // Check if result is poison
    if (isPoison(result)) {
      frame.set(nodeLockKey, result, true);
      throw new PoisonError(result.errors);
    }

    return result;
  } catch (err) {
    // Ensure lock is poisoned on any error
    if (!isPoisonError(err)) {
      const contextualError = handleError(err, errorContext.lineno, errorContext.colno, errorContext.errorContextString, errorContext.path);
      const poison = createPoison(contextualError);
      frame.set(nodeLockKey, poison, true);
      throw new PoisonError([contextualError]);
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

/**
 * Create an async iterator for while loop conditions that handles poison and errors gracefully.
 * Yields Error/PoisonError objects instead of PoisonedValue to keep generator alive.
 *
 * @param {AsyncFrame} frame - The loop frame
 * @param {Function} conditionEvaluator - Async function that evaluates the condition
 * @returns {AsyncGenerator} Async generator that yields iteration counts or errors
 */
async function* whileConditionIterator(frame, conditionEvaluator) {
  // Push a frame to trap any writes from the condition expression
  frame = frame.push();
  frame.sequentialLoopBody = true;

  let iterationCount = 0;

  while (true) {
    try {
      // Evaluate the condition
      const conditionResult = await conditionEvaluator(frame);

      // Check if condition evaluated to poison (soft error)
      if (isPoison(conditionResult)) {
        yield new PoisonError(conditionResult.errors);
        frame.pop();
        return;
      }

      // Normal condition evaluation - check if we should continue
      if (!conditionResult) {
        break;
      }

      // Yield the iteration count for this iteration
      yield iterationCount;
      iterationCount++;

    } catch (err) {
      // Condition threw an error (soft error)
      // Yield the error as-is (Error or PoisonError)
      // Don't yield PoisonedValue - it's thenable and would terminate the generator
      yield (isPoisonError(err) ? err : err);
      frame.pop();
      return;
    }
  }

  frame.pop();
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
  addPoisonMarkersToBuffer,

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
  contextOrFrameLookupScript,
  contextOrFrameLookupScriptAsync,

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
  iterateAsyncSequential,
  iterateAsyncParallel,
  whileConditionIterator,
  setLoopBindings,
  awaitSequenceLock,
  sequencedContextLookup
};
