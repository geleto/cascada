
import {Loader} from './loader.js';

class PrecompiledLoader extends Loader {
  constructor(compiledTemplates) {
    super();
    this.precompiled = compiledTemplates || {};
  }

  getSource(name) {
    if (Object.hasOwn(this.precompiled, name) && this.precompiled[name]) {
      return {
        src: {
          type: 'code',
          obj: this.precompiled[name]
        },
        path: name
      };
    }
    return null;
  }
}

export { PrecompiledLoader };
