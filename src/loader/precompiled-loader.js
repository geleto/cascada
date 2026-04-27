'use strict';

import Loader from './loader';

class PrecompiledLoader extends Loader {
  constructor(compiledTemplates) {
    super();
    this.precompiled = compiledTemplates || {};
  }

  getSource(name) {
    if (this.precompiled[name]) {
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

const __defaultExport = {
  PrecompiledLoader: PrecompiledLoader,
};
export { PrecompiledLoader };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
