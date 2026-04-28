import {compile} from '../compiler/compiler.js';
import {TemplateRuntime, AsyncTemplateRuntime} from './template-runtime.js';

class Template extends TemplateRuntime {
  _compileSource() {
    return compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: false, asyncMode: false }, this.env.opts)
    );
  }
}

class AsyncTemplate extends AsyncTemplateRuntime {
  _compileSource() {
    return compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: false, asyncMode: true }, this.env.opts)
    );
  }
}

export { Template, AsyncTemplate };
