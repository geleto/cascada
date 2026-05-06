class CompileCompositionPayload {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  emitCompiledInputs(node, targetVarsVar) {
    this.emitInputVariables(node, targetVarsVar, (nameNode) => {
      this.compiler.compileExpression(nameNode, null, nameNode, true);
    });
    this.emitObjectInput(node, targetVarsVar);
  }

  emitCurrentPositionInputs(node, targetVarsVar) {
    this.emitInputVariables(node, targetVarsVar, (nameNode, inputName) => {
      const declaration = this.compiler.analysis.findDeclaration(nameNode._analysis, inputName);
      if (declaration && declaration.type === 'var' && !declaration.shared) {
        this.emit(`runtime.channelLookup(${JSON.stringify(inputName)}, ${this.compiler.buffer.currentBuffer})`);
      } else {
        this.emit(`context.lookup(${JSON.stringify(inputName)})`);
      }
    });
    this.emitObjectInput(node, targetVarsVar);
  }

  emitInputVariables(node, targetVarsVar, emitValue) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const inputName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(inputName)}] = `);
      emitValue(nameNode, inputName);
      this.emit.line(';');
    });
  }

  emitObjectInput(node, targetVarsVar) {
    if (node.withValue) {
      this.emit(`Object.assign(${targetVarsVar}, `);
      this.compiler.compileExpression(node.withValue, null, node.withValue, true);
      this.emit.line(');');
    }
  }

  emitContext(targetCtxVar, payloadVarsVar, includeRenderContext) {
    this.emit.line(`const ${targetCtxVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${targetCtxVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${targetCtxVar}, ${payloadVarsVar});`);
  }
}

export {CompileCompositionPayload};
