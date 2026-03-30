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
    this.syncTopLevel = false;
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
    const newFrame = new Frame(this, isolateWrites);
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

}

function markChannelBufferScope(buffer) {
  if (buffer && buffer.arrays) {
    const channelArrays = Object.keys(buffer.arrays);
    channelArrays.forEach((name) => {
      const target = buffer.arrays[name];
      if (target && typeof target === 'object') {
        target._channelScopeRoot = true;
      }
    });
    return;
  }

  if (buffer && Array.isArray(buffer.output)) {
    buffer = buffer.output;
  }
  if (buffer && typeof buffer === 'object') {
    buffer._channelScopeRoot = true;
  }
}

module.exports = {
  Frame,
  markChannelBufferScope
};
