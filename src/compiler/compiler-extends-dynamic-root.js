'use strict';

// Dynamic extends root specialization.
// Owns the dynamic-parent-template root family: storing/resolving the dynamic
// parent, finishing dynamic root startup, and handing off into parent startup.

class CompileExtendsDynamicRoot {
  constructor(extendsCompiler) {
    this.extendsCompiler = extendsCompiler;
    this.compiler = extendsCompiler.compiler;
    this.emit = this.compiler.emit;
  }

  _emitDynamicParentTemplateResolution(bufferExpr, parentVar, indent = '') {
    this.emit.line(`${indent}runtime.resolveDynamicParentTemplate(${bufferExpr}).then((${parentVar}) => {`);
  }

  emitDynamicParentTemplateStore(node, parentTemplateExpr, bufferExpr = null, indent = '') {
    const targetBufferExpr = bufferExpr || this.compiler.buffer.currentBuffer;
    const channelName = this.extendsCompiler.getDynamicParentTemplateChannelName();
    this.emit.line(`${indent}${targetBufferExpr}.add(new runtime.VarCommand({ channelName: '${channelName}', args: [${parentTemplateExpr}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${channelName}');`);
  }

  emitDynamicParentTemplateStoreWait(storeVar, parentTemplateExpr, indent = '') {
    this.emit.line(`${indent}let ${storeVar} = runtime.bridgeDynamicParentTemplate(inheritanceState, ${parentTemplateExpr});`);
  }

  emitDynamicTopLevelBlockResolution(node, resultVar, blockPayloadExpr, blockRenderCtxExpr, indent = '') {
    this.emit.line(
      `${indent}${resultVar} = runtime.renderDynamicTopLevelBlock(` +
      `${JSON.stringify(node.name.value)}, context, ${this.compiler.buffer.currentBuffer}, env, runtime, cb, inheritanceState, ${blockPayloadExpr}, ${blockRenderCtxExpr});`
    );
  }

  _emitParentCompositionPayload(parentTemplateVar, compositionPayloadVar, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const contextExpr = options && options.contextExpr ? options.contextExpr : 'context';
    this.emit.line(`${indent}const ${compositionPayloadVar} = runtime.getExtendsComposition(inheritanceState, ${parentTemplateVar});`);
  }

  _emitDynamicRootStartupCompletion(node, options = null) {
    const opts = options || {};
    const indent = opts.indent || '';
    const completionVar = opts.completionVar || this.compiler._tmpid();
    const parentVar = opts.parentVar || this.compiler._tmpid();
    const compositionPayloadVar = this.compiler._tmpid();

    this.emit(`${indent}const ${completionVar} = `);
    this._emitDynamicParentTemplateResolution(this.compiler.buffer.currentBuffer, parentVar, '');
    this.emit.line(`${indent}  if (${parentVar}) {`);
    if (opts.captureInheritanceLocals) {
      this.extendsCompiler.emitInheritanceLocalCaptureSnapshot(node, {
        indent: `${indent}    `,
        contextExpr: 'context',
        bufferExpr: this.compiler.buffer.currentBuffer
      });
    }
    this._emitParentCompositionPayload(parentVar, compositionPayloadVar, {
      indent: `${indent}    `,
      contextExpr: 'context'
    });
    this.extendsCompiler._emitParentConstructorHandoff(
      node,
      parentVar,
      compositionPayloadVar,
      this.compiler.buffer.currentBuffer,
      {
        indent: `${indent}    `,
        dynamicRootMode: 'await_completion',
        returnConstructorCompletion: true
      }
    );
    this.emit.line(`${indent}  }`);
    this.emit.line(`${indent}  return null;`);
    this.emit.line(`${indent}});`);

    return completionVar;
  }

  _emitRenderDynamicTemplateRootCompletion(node, indent = '') {
    const completionVar = this._emitDynamicRootStartupCompletion(node, {
      indent,
      captureInheritanceLocals: true
    });
    this.extendsCompiler.rootFinalization.emitRenderTemplateRootReturn(node, completionVar, indent);
  }

  _emitCompositionDynamicTemplateRootCompletion(node, indent = '') {
    const completionVar = this._emitDynamicRootStartupCompletion(node, {
      indent,
      captureInheritanceLocals: false
    });
    this.extendsCompiler.rootFinalization.emitCompositionRootReturn(node, completionVar, indent);
  }

  _emitDynamicParentRootFinalization(node) {
    if (this.compiler.scriptMode || !this.compiler.hasDynamicExtends) {
      throw new Error('Compiler invariant: dynamic parent root finalization is only valid for dynamic template roots');
    }

    this.emit.line('if (!compositionMode) {');
    this._emitRenderDynamicTemplateRootCompletion(node, '  ');
    this.emit.line('} else {');
    this._emitCompositionDynamicTemplateRootCompletion(node, '  ');
    this.emit.line('}');
  }

  compileDynamicParentRootBody(node) {
    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${this.extendsCompiler.getDynamicParentTemplateChannelName()}", "var", context, null);`);
    this.compiler._emitRootSequenceLockDeclarations(node);
    this.compiler._emitRootExternInitialization(node);
    this.compiler._compileChildren(node, null);
    this.emit.line('context.resolveExports();');
    this._emitDynamicParentRootFinalization(node);
  }

  compileAsyncDynamicTemplateExtends(node) {
    const k = this.compiler._tmpid();
    const explicitInputVarsVar = this.compiler._tmpid();
    const compositionPayloadVar = this.compiler._tmpid();

    this.emit.line('runtime.beginInheritanceResolution(inheritanceState);');
    this.extendsCompiler._emitExtendsCompositionPayloadSetup(
      node,
      explicitInputVarsVar,
      compositionPayloadVar
    );
    const parentTemplateId = this.compiler.composition._compileAsyncGetTemplateOrScript(node, true, false);

    if (node.dynamicParentStoreVar) {
      this.emitDynamicParentTemplateStoreWait(node.dynamicParentStoreVar, parentTemplateId);
    }
    this.compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const templateVar = this.compiler._tmpid();
      this.emit.line('try {');
      if (!node.dynamicParentStoreVar) {
        this.emitDynamicParentTemplateStore(node, parentTemplateId, this.compiler.buffer.currentBuffer, '  ');
      }
      this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
      this.emit.line(`  ${templateVar}.compile();`);
      if (this.compiler.scriptMode) {
        this.emit.line(`  runtime.bootstrapInheritanceMetadata(inheritanceState, ${templateVar}.methods || {}, ${templateVar}.sharedSchema || [], ${this.compiler.buffer.currentBuffer}, context);`);
      }
      this.compiler.composition.emitExternValidation({
        externSpecExpr: `${templateVar}.externSpec || []`,
        explicitInputNamesExpr: `${compositionPayloadVar}.explicitInputNames`,
        availableValueNamesExpr: `Object.keys(${compositionPayloadVar}.explicitInputValues)`,
        operationName: 'extends',
        indent: '  '
      });
      this.emit.line(`  runtime.setExtendsComposition(inheritanceState, ${templateVar}, ${compositionPayloadVar});`);
      this.emit.line(`  for(let ${k} in ${templateVar}.blocks) {`);
        this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
      this.emit.line('  }');
      this.emit.line('} finally {');
      this.emit.line('  runtime.finishInheritanceResolution(inheritanceState);');
      this.emit.line('}');
    });
    if (node.dynamicParentStoreVar) {
      this.emitDynamicParentTemplateStore(node, node.dynamicParentStoreVar, this.compiler.buffer.currentBuffer);
    }
  }
}

module.exports = CompileExtendsDynamicRoot;
