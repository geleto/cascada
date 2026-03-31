'use strict';

const parser = require('../parser');
const transformer = require('../transformer');
const CompilerCommon = require('./compiler-common');
const CompilerBaseAsync = require('./compiler-base-async');
const CompilerBaseSync = require('./compiler-base-sync');
const CompilerAsync = require('./compiler-async');
const CompilerSync = require('./compiler-sync');

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

module.exports = {
  compile,
  CompilerCommon,
  CompilerBaseAsync,
  CompilerBaseSync,
  CompilerAsync,
  CompilerSync,
  Compiler: CompilerSync
};
