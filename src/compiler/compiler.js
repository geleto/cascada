'use strict';

import parser from '../parser.js';
import transformer from '../transformer.js';
import CompilerCommon from './compiler-common.js';
import CompilerBaseAsync from './compiler-base-async.js';
import CompilerBaseSync from './compiler-base-sync.js';
import CompilerAsync from './compiler-async.js';
import CompilerSync from './compiler-sync.js';

function createIdPool() {
  return {
    value: 0,
    next() {
      this.value += 1;
      return this.value;
    }
  };
}

function compile(src, asyncFilters, extensions, name, opts = {}) {
  const compileOptions = Object.assign({}, opts, { idPool: createIdPool() });
  const CompilerClass = compileOptions.asyncMode ? CompilerAsync : CompilerSync;
  const compiler = new CompilerClass(name, compileOptions);

  const preprocessors = (extensions || []).map(ext => ext.preprocess).filter(Boolean);
  const processedSrc = preprocessors.reduce((currentSrc, processor) => processor(currentSrc), src);
  const ast = transformer.transform(
    parser.parse(processedSrc, extensions, opts),
    asyncFilters,
    name,
    compileOptions
  );

  if (compiler.asyncMode) {
    compiler.analysis.run(ast);
    compiler.rename.run(ast);
  }

  compiler.compile(ast);
  return compiler.getCode();
}

export default {
  compile,
  CompilerCommon,
  CompilerBaseAsync,
  CompilerBaseSync,
  CompilerAsync,
  CompilerSync,
  Compiler: CompilerSync
};
export { compile, CompilerCommon, CompilerBaseAsync, CompilerBaseSync, CompilerAsync, CompilerSync, CompilerSync as Compiler };
