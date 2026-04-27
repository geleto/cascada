'use strict';

import lib from '../lib';
import scriptTranspiler from '../script/script-transpiler';
import {Template, AsyncTemplate} from './template';

/**
 * Script class - represents a compiled Cascada script.
 */
class Script extends Template {
  init(src, env, path, eagerCompile) {
    // Convert script to template if it's a string
    if (lib.isString(src)) {
      const template = scriptTranspiler.scriptToTemplate(src);
      src = template;
    }

    super.init(src, env, path, eagerCompile);
    this.asyncMode = true;
    this.scriptMode = true;
  }

  render(ctx, cb) {
    if (cb) {
      return super._renderAsync(ctx, cb);
    }
    // If no callback is provided, return a promise
    return new Promise((resolve, reject) => {
      super._renderAsync(ctx, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  getExported(ctx, renderCtx, cb) {
    return AsyncTemplate.prototype.getExported.call(this, ctx, renderCtx, cb);
  }

  _compileSource() {
    const compiler = require('../compiler/compiler');
    return compiler.compile(this.tmplStr,
      this.env.asyncFilters,
      this.env.extensionsList,
      this.path,
      Object.assign({ scriptMode: true, asyncMode: true }, this.env.opts)
    );
  }
}

const __defaultExport = {
  Script
};
export { Script };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
