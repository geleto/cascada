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
    }

  }

  static inCompilerContext = false;

  new() {
    return new AsyncFrame();
  }

  lookupAndLocate(name) {
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

  pushAsyncBlock() {
    return this.push(false);
  }

}

module.exports = {
  Frame,
  AsyncFrame
};
