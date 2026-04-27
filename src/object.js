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

const __defaultExport = { Obj, EmitterObj };
export { Obj, EmitterObj };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
