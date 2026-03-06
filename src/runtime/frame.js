'use strict';

const {
  checkFrameBalance
} = require('./checks');


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

  push(isolateWrites, _createScope) {
    const newFrame = new Frame(this, isolateWrites);
    if (this._seesRootScope) {
      newFrame._seesRootScope = true;
    }

    newFrame._runtimeDepth = (this._runtimeDepth || 0) + 1;

    return newFrame;
  }

  pop() {
    checkFrameBalance(this, this.parent);
    return this.parent;
  }

  new() {
    return new Frame();
  }

  markOutputBufferScope(buffer) {
    if (buffer && buffer.arrays) {
      const outputArrays = Object.keys(buffer.arrays);
      outputArrays.forEach((name) => {
        const target = buffer.arrays[name];
        if (target && typeof target === 'object') {
          target._outputScopeRoot = true;
        }
      });
      return;
    }

    if (buffer && Array.isArray(buffer.output)) {
      buffer = buffer.output;
    }
    if (buffer && typeof buffer === 'object') {
      buffer._outputScopeRoot = true;
    }
  }
}

class AsyncFrame extends Frame {
  constructor(parent, isolateWrites, createScope = true) {
    super(parent, isolateWrites);
    this.createScope = createScope;

    if (AsyncFrame.inCompilerContext) {
      //holds the names of the variables declared at the frame
      this.declaredVars = undefined;

      //holds the names of outputs declared at this frame
      this.declaredOutputs = undefined;

      //holds the names of outputs used in this frame or its children
      this.usedOutputs = undefined;

      //holds the names of outputs mutated in this frame or its children
      this.mutatedOutputs = undefined;

    } else {
      // Runtime async locals for this frame.
      this.asyncVars = undefined;
    }

  }

  static inCompilerContext = false;

  new() {
    return new AsyncFrame();
  }

  //second parameter to pushAsyncBlock only for recursive frames
  set(name, val, resolveUp) {
    if (resolveUp) {
      this.assign(name, val);
    } else {
      //not for set tags
      super.set(name, val);
    }
  }

  /** Works like set with resolveUp for async frames. */
  assign(name, val) {
    //only set tags and lock variable operations use resolveUp
    //set tags do not have variables with dots, so the name is the whole variable name
    if (name.indexOf('.') !== -1) {
      throw new Error('resolveUp can only be used for variables, not for properties/paths');
    }

    // Find or create the variable scope.
    let scopeFrame = this.resolve(name, true);
    if (!scopeFrame) {
      // If this frame cannot create scope, add it in the nearest parent that can.
      if (!this.createScope) {
        this.parent.set(name, val);
        scopeFrame = this.resolve(name, true);
        if (!scopeFrame) {
          throw new Error('Variable should have been added in a parent frame');
        }
      }
      else {
        scopeFrame = this;
      }
    }

    // go up the chain until we reach the scope frame or an asyncVar with the same name
    // and store the value there (poison values are stored just like any other value)
    // when reaching asyncVars, we set the value and don't go further up
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
    return scopeFrame;
  }

  get(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return this.asyncVars[name];
    }
    return super.get(name);
  }

  lookup(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return this.asyncVars[name];
    }
    if (name in this.variables) {
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

  push(isolateWrites, createScope = true) {
    const newFrame = new AsyncFrame(this, isolateWrites, createScope);
    if (this._seesRootScope) {
      newFrame._seesRootScope = true;
    }

    newFrame._runtimeDepth = (this._runtimeDepth || 0) + 1;

    return newFrame;
  }

  pushAsyncBlock(sequentialLoopBody = false) {
    const asyncBlockFrame = new AsyncFrame(this, false);
    // Async block frames never own inherited buffers by default.

    // Track runtime depth for balance validation
    asyncBlockFrame._runtimeDepth = (this._runtimeDepth || 0) + 1;

    asyncBlockFrame.sequentialLoopBody = sequentialLoopBody;
    return asyncBlockFrame;
  }

  _commitSequentialWrites() {
    if (!this.parent) {
      return;
    }

    if (!this.asyncVars) {
      return;
    }

    for (const varName in this.asyncVars) {
      if (this.parent.asyncVars && varName in this.parent.asyncVars) {
        this.parent.asyncVars[varName] = this.asyncVars[varName];
      } else if (varName in this.parent.variables) {
        this.parent.variables[varName] = this.asyncVars[varName];
      }
    }
  }
}

module.exports = {
  Frame,
  AsyncFrame
};
