'use strict';

const {
  createPoison,
  isPoison,
  isPoisonError
} = require('./errors');

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

module.exports = {
  Frame,
  AsyncFrame
};
