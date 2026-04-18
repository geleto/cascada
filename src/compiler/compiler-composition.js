'use strict';

// Composition compiler helper.
// Owns small shared compiler helpers for explicit composition-context assembly
// used by extends/include/import-style boundaries.

class CompileComposition {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  _emitInputAssignments({
    targetVar,
    entries,
    indent = '',
    getTargetName,
    emitValue
  }) {
    const items = Array.isArray(entries) ? entries : [];
    items.forEach((entry) => {
      const targetName = getTargetName(entry);
      this.emit(`${indent}${targetVar}[${JSON.stringify(targetName)}] = `);
      emitValue(entry, targetName);
      this.emit.line(';');
    });
  }

  emitCapturedInputAssignments({
    targetVar,
    entries,
    ownerNode,
    getSourceName,
    getTargetName = getSourceName,
    getPositionNode = (entry) => entry,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    const helperName = this.compiler.scriptMode
      ? 'captureCompositionScriptValue'
      : 'captureCompositionValue';

    this._emitInputAssignments({
      targetVar,
      entries,
      indent,
      getTargetName,
      emitValue: (entry) => {
        const sourceName = getSourceName(entry);
        const positionNode = getPositionNode(entry);
        this.emit(`runtime.${helperName}(${contextExpr}, ${JSON.stringify(sourceName)}, ${bufferExpr}`);
        if (this.compiler.scriptMode) {
          this.emit(
            `, { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, ` +
            `errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(ownerNode || positionNode, positionNode))}, ` +
            `path: ${contextExpr}.path }`
          );
        }
        this.emit(')');
      }
    });
  }

  emitCapturedNameNodeAssignments({
    targetVar,
    nameNodes,
    ownerNode,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    this.emitCapturedInputAssignments({
      targetVar,
      entries: nameNodes,
      ownerNode,
      getSourceName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      getTargetName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      getPositionNode: (nameNode) => nameNode,
      contextExpr,
      bufferExpr,
      indent
    });
  }

  emitCapturedNameAssignments({
    targetVar,
    names,
    ownerNode,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    this.emitCapturedInputAssignments({
      targetVar,
      entries: names,
      ownerNode,
      getSourceName: (name) => name,
      getTargetName: (name) => name,
      getPositionNode: () => ownerNode,
      contextExpr,
      bufferExpr,
      indent
    });
  }

  emitResolvedInputAssignments({
    targetVar,
    entries,
    getTargetName,
    emitExpression,
    indent = ''
  }) {
    this._emitInputAssignments({
      targetVar,
      entries,
      indent,
      getTargetName,
      emitValue: emitExpression
    });
  }

  emitResolvedNameNodeAssignments({
    targetVar,
    nameNodes,
    indent = ''
  }) {
    this.emitResolvedInputAssignments({
      targetVar,
      entries: nameNodes,
      getTargetName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      emitExpression: (nameNode) => this.compiler.compileExpression(nameNode, null, nameNode, true),
      indent
    });
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

  emitExternValidation({
    externSpecExpr,
    operationName,
    explicitInputNamesExpr = null,
    availableValueNamesExpr = null,
    isolated = false,
    indent = ''
  }) {
    if (isolated) {
      this.emit.line(
        `${indent}runtime.validateIsolatedExternSpec(${externSpecExpr}, ${JSON.stringify(operationName)});`
      );
      return;
    }
    this.emit.line(
      `${indent}runtime.validateExternInputs(` +
      `${externSpecExpr}, ${explicitInputNamesExpr}, ${availableValueNamesExpr}, ${JSON.stringify(operationName)});`
    );
  }

  emitExternValidationForContext({
    externSpecExpr,
    explicitInputNamesExpr,
    contextVar,
    operationName,
    indent = ''
  }) {
    this.emitExternValidation({
      externSpecExpr,
      explicitInputNamesExpr,
      availableValueNamesExpr: `Object.keys(${contextVar})`,
      operationName,
      indent
    });
  }
}

module.exports = CompileComposition;
