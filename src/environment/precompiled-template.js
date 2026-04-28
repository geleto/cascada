import {isObject, isString} from '../lib.js';
import {TemplateRuntime, AsyncTemplateRuntime} from './template-runtime.js';

function assertPrecompiledSource(src) {
  if (isString(src) || (isObject(src) && src.type === 'string')) {
    throw new Error('This environment only supports precompiled sources');
  }
}

class PrecompiledTemplate extends TemplateRuntime {
  init(src, env, path, eagerCompile) {
    assertPrecompiledSource(src);
    super.init(src, env, path, eagerCompile);
  }
}

class AsyncPrecompiledTemplate extends AsyncTemplateRuntime {
  init(src, env, path, eagerCompile) {
    assertPrecompiledSource(src);
    super.init(src, env, path, eagerCompile);
  }
}

class AsyncPrecompiledScript extends AsyncTemplateRuntime {
  init(src, env, path, eagerCompile) {
    assertPrecompiledSource(src);
    super.init(src, env, path, eagerCompile);
    this.scriptMode = true;
  }
}

export {PrecompiledTemplate, AsyncPrecompiledTemplate, AsyncPrecompiledScript};
