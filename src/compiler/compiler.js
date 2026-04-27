'use strict';

import parser from '../parser';
import transformer from '../transformer';
import CompilerCommon from './compiler-common';
import CompilerBaseAsync from './compiler-base-async';
import CompilerBaseSync from './compiler-base-sync';
import CompilerAsync from './compiler-async';
import CompilerSync from './compiler-sync';

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

const __defaultExport = {
  compile,
  CompilerCommon,
  CompilerBaseAsync,
  CompilerBaseSync,
  CompilerAsync,
  CompilerSync,
  Compiler: CompilerSync
};
export { compile, CompilerCommon, CompilerBaseAsync, CompilerBaseSync, CompilerAsync, CompilerSync, CompilerSync as Compiler };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
