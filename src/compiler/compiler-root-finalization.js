'use strict';

class CompileRootFinalization {
  constructor(extendsCompiler) {
    this.extendsCompiler = extendsCompiler;
    this.compiler = extendsCompiler.compiler;
    this.emit = this.compiler.emit;
  }

  _emitFinalizationErrorCallback(node, errorExpr = 'err', indent = '') {
    const errorVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${errorVar} = runtime.isPoisonError(${errorExpr}) ? ${errorExpr} : runtime.handleError(${errorExpr}, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line(`${indent}cb(${errorVar});`);
  }

  emitRenderScriptRootReturn(node, resultVar, completionGateVar = null, indent = '') {
    const finishVar = this.compiler._tmpid();
    const deliverVar = this.compiler._tmpid();
    const gatedResultVar = this.compiler._tmpid();
    const normalizedVar = this.compiler._tmpid();
    const effectiveCompletionGateVar = completionGateVar || resultVar;

    this.emit.line(`${indent}const ${finishVar} = () => (${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(), ${resultVar});`);
    this.emit.line(`${indent}const ${deliverVar} = (value) => {`);
    this.emit.line(`${indent}  const ${normalizedVar} = runtime.normalizeFinalPromise(value);`);
    this.emit.line(`${indent}  if (${normalizedVar} && typeof ${normalizedVar}.then === "function") {`);
    this.emit.line(`${indent}    ${normalizedVar}.then((finalValue) => cb(null, finalValue)).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}      `);
    this.emit.line(`${indent}    });`);
    this.emit.line(`${indent}    return;`);
    this.emit.line(`${indent}  }`);
    this.emit.line(`${indent}  cb(null, ${normalizedVar});`);
    this.emit.line(`${indent}};`);
    this.emit.line(`${indent}const ${gatedResultVar} = ${effectiveCompletionGateVar} && typeof ${effectiveCompletionGateVar}.then === "function"`);
    this.emit.line(`${indent}  ? ${effectiveCompletionGateVar}.then(${finishVar}, (err) => { ${finishVar}(); throw err; })`);
    this.emit.line(`${indent}  : ${finishVar}();`);
    this.emit.line(`${indent}if (${gatedResultVar} && typeof ${gatedResultVar}.then === "function") {`);
    this.emit.line(`${indent}  ${gatedResultVar}.then(${deliverVar}).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}    `);
    this.emit.line(`${indent}  });`);
    this.emit.line(`${indent}} else {`);
    this.emit.line(`${indent}  ${deliverVar}(${gatedResultVar});`);
    this.emit.line(`${indent}}`);
  }

  emitRenderTemplateRootReturn(node, completionGateVar = null, indent = '') {
    const finishVar = this.compiler._tmpid();
    const finalizedResultVar = this.compiler._tmpid();

    this.emit.line(`${indent}const ${finishVar} = () => {`);
    this.emit.line(`${indent}  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}  return ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot();`);
    this.emit.line(`${indent}};`);
    this.emit.line(`${indent}const ${finalizedResultVar} = ${completionGateVar} && typeof ${completionGateVar}.then === "function"`);
    this.emit.line(`${indent}  ? ${completionGateVar}.then(${finishVar}, (err) => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); throw err; })`);
    this.emit.line(`${indent}  : ${finishVar}();`);
    this.emit.line(`${indent}${finalizedResultVar}.then((value) => cb(null, value)).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}  `);
    this.emit.line(`${indent}});`);
  }

  emitCompositionRootReturn(node, completionGateVar = null, indent = '') {
    if (completionGateVar) {
      this.emit.line(`${indent}if (${completionGateVar} && typeof ${completionGateVar}.then === "function") {`);
      this.emit.line(`${indent}  ${completionGateVar}.then(() => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); }, (err) => {`);
      this.emit.line(`${indent}    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`${indent}    throw err;`);
      this.emit.line(`${indent}  }).catch((err) => {`);
      this._emitFinalizationErrorCallback(node, 'err', `${indent}    `);
      this.emit.line(`${indent}  });`);
      this.emit.line(`${indent}} else {`);
      this.emit.line(`${indent}  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`${indent}}`);
      this.emit.line(`${indent}return ${this.compiler.buffer.currentBuffer};`);
      return;
    }
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return ${this.compiler.buffer.currentBuffer};`);
  }

  _emitConstructorNullReturn(indent = '') {
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return null;`);
  }

  _emitConstructorReturnChannelSnapshot(node, indent = '') {
    const returnVar = this.compiler._tmpid();
    this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, node, returnVar, false);
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return ${returnVar};`);
  }

  emitRootConstructorAdmission(node, constructorMethod) {
    const constructorAdmissionVar = this.compiler._tmpid();
    const completionVar = `${constructorAdmissionVar}_completion`;
    const result = {
      admissionVar: constructorAdmissionVar,
      completionVar
    };

    this.emit(`const ${constructorAdmissionVar} = runtime.admitConstructorEntry(context, inheritanceState, `);
    this.extendsCompiler.metadata.emitCompiledMethodEntryValue(constructorMethod);
    this.emit.line(`, [], env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${JSON.stringify(this.compiler._createErrorContext(node))});`);
    this.emit.line(`const ${completionVar} = ${constructorAdmissionVar}.completion;`);

    if (this.compiler.scriptMode) {
      result.valueVar = `${constructorAdmissionVar}_value`;
      this.emit.line(`const ${result.valueVar} = ${constructorAdmissionVar}.promise;`);
    }

    return result;
  }

  compileConstructorAdmittedRootBody(node, constructorMethod) {
    const constructorAdmission = this.emitRootConstructorAdmission(node, constructorMethod);

    this.emit.line('if (!compositionMode) {');
    if (this.compiler.scriptMode) {
      this.emitRenderScriptRootReturn(
        node,
        constructorAdmission.valueVar,
        constructorAdmission.completionVar,
        '  '
      );
    } else {
      this.emitRenderTemplateRootReturn(
        node,
        constructorAdmission.completionVar,
        '  '
      );
    }
    this.emit.line('} else {');
    this.emitCompositionRootReturn(
      node,
      this.compiler.scriptMode ? null : constructorAdmission.completionVar,
      '  '
    );
    this.emit.line('}');
  }

  compileAsyncRootBody(node, compiledMethods, rootSharedSchema) {
    const needsRootInheritanceState = this.extendsCompiler.metadata.needsRootInheritanceState(compiledMethods, rootSharedSchema);
    const isDynamicTemplateRoot = !this.compiler.scriptMode && this.compiler.hasDynamicExtends;

    this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
    if (needsRootInheritanceState) {
      this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
    }
    this.extendsCompiler._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);

    if (isDynamicTemplateRoot) {
      this.extendsCompiler.dynamicTemplateRoot.compileDynamicParentRootBody(node);
      return;
    }

    this.compileConstructorAdmittedRootBody(
      node,
      compiledMethods && compiledMethods.__constructor__
    );
  }
}

module.exports = CompileRootFinalization;
