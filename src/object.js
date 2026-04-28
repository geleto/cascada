'use strict';

// A simple class system, more documentation to come
import EventEmitter from 'events';

class Obj {
  constructor(...args) {
    // Unfortunately necessary for backwards compatibility
    this.init(...args);
  }

  init() {}

  get typename() {
    return this.constructor.name;
  }
}

class EmitterObj extends EventEmitter {
  constructor(...args) {
    super();
    // Unfortunately necessary for backwards compatibility
    this.init(...args);
  }

  init() {}

  get typename() {
    return this.constructor.name;
  }
}

export { Obj, EmitterObj };
