'use strict';

// Composition compiler helper.
// Owns small shared compiler helpers for explicit composition-context assembly
// used by extends/include/import-style boundaries.

class CompileComposition {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  emitCompositionContextObject({
    targetVar,
    explicitVarsVar,
    explicitNamesVar = null,
    includeRenderContext = false
  }) {
    this.emit.line(`const ${targetVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${targetVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${targetVar}, ${explicitVarsVar});`);
    if (explicitNamesVar) {
      this.emit.line(`const ${explicitNamesVar} = Object.keys(${explicitVarsVar});`);
    }
  }
}

module.exports = CompileComposition;
