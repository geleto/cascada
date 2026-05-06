
class CompileComponent {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeComponent(node) {
    node.target._analysis = { declarationTarget: true };
    return {
      declares: [{
        name: node.target.value,
        type: 'var',
        initializer: null,
        explicit: true,
        componentBinding: true
      }]
    };
  }

  compileComponent(node) {
    if (!this.compiler.scriptMode) {
      this.compiler.fail(
        'component bindings are only supported in script mode',
        node.lineno,
        node.colno,
        node
      );
    }

    const targetName = node.target.value;
    const componentTargetVar = this.compileAsyncResolveComponentTargetFile(node, true, false);
    const componentVarsVar = this.compiler._tmpid();
    const rootContextVar = this.compiler._tmpid();
    const instanceVar = this.compiler._tmpid();
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));

    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${targetName}", "var", context, null);`);
    this.emit.line(`const ${componentVarsVar} = {};`);
    this.emitCompiledPayloadInputs(node, componentVarsVar);
    this.emitCompositionContext(rootContextVar, componentVarsVar, node.withContext);
    this.emit.line(`const ${instanceVar} = runtime.startComponentInstance({`);
    this.emit.line(`  currentBuffer: ${this.compiler.buffer.currentBuffer},`);
    this.emit.line(`  bindingName: "${targetName}",`);
    this.emit.line(`  templateOrPromise: ${componentTargetVar},`);
    this.emit.line(`  payload: ${rootContextVar},`);
    this.emit.line('  ownerContext: context,');
    this.emit.line('  env,');
    this.emit.line('  runtime,');
    this.emit.line('  cb,');
    this.emit.line(`  errorContext: ${errorContextJson}`);
    this.emit.line('});');
    this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: '${targetName}', args: [${instanceVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${targetName}');`);

    if (targetName.charAt(0) !== '_' && this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.emit.line(`context.addDeferredExport("${targetName}", "${targetName}", ${this.compiler.buffer.currentBuffer});`);
    }
  }

  compileAsyncResolveComponentTargetFile(node, eagerCompile, ignoreMissing) {
    const targetVar = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const getTemplateFunc = this.compiler._tmpid();
    const resolvedTargetValue = this.compiler._tmpid();
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';

    this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`const ${resolvedTargetValue} = `);
    this.compiler.compileExpression(node.template, null, node.template || node, true);
    this.emit.line(';');
    this.emit.line(`let ${targetVar} = runtime.resolveSingle(${resolvedTargetValue}).then((resolvedTemplateName) => {`);
    this.emit.line(`  return ${getTemplateFunc}(resolvedTemplateName, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    this.emit.line('});');

    return targetVar;
  }

  emitCompiledPayloadInputs(node, targetVarsVar) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const inputName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(inputName)}] = `);
      this.compiler.compileExpression(nameNode, null, nameNode, true);
      this.emit.line(';');
    });
    if (node.withValue) {
      this.emit(`Object.assign(${targetVarsVar}, `);
      this.compiler.compileExpression(node.withValue, null, node.withValue, true);
      this.emit.line(');');
    }
  }

  emitCompositionContext(targetCtxVar, payloadVarsVar, includeRenderContext) {
    this.emit.line(`const ${targetCtxVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${targetCtxVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${targetCtxVar}, ${payloadVarsVar});`);
  }

  getBindingFacts(node, { forCall = false } = {}) {
    const bindingRoot = this.getBindingRoot(node);
    if (!bindingRoot) {
      return null;
    }
    const bindingName = bindingRoot.bindingName;
    const staticPath = bindingRoot.staticPath;

    if (!forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: 'shared-read',
        channelName: staticPath[1],
        implicitVarRead: true
      };
    }

    if (
      forCall &&
      staticPath.length === 3 &&
      staticPath[2] === 'snapshot'
    ) {
      return {
        bindingName,
        kind: 'shared-observe',
        channelName: staticPath[1],
        mode: staticPath[2],
        implicitVarRead: false
      };
    }

    if (forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: 'method-call',
        methodName: staticPath[1]
      };
    }

    return null;
  }

  getBindingRoot(node) {
    if (!this.compiler.scriptMode || !node) {
      return null;
    }

    const staticPath = this.compiler.sequential._extractStaticPath(node);
    if (!staticPath || staticPath.length < 2) {
      return null;
    }

    const bindingName = staticPath[0];
    const bindingDecl = this.compiler.analysis.findDeclaration(node._analysis, bindingName);
    if (!bindingDecl || !bindingDecl.componentBinding) {
      return null;
    }

    return {
      bindingName,
      staticPath
    };
  }

  failUnsupportedUsage(node, bindingName, usage) {
    this.compiler.fail(
      `component binding '${bindingName}' only supports ${usage}`,
      node.lineno,
      node.colno,
      node
    );
  }

  compileMethodCall(componentBindingFacts, node) {
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    this.emit('runtime.callComponentMethod({ ');
    this.emit(`bindingName: ${JSON.stringify(componentBindingFacts.bindingName)}, `);
    this.emit(`currentBuffer: ${this.compiler.buffer.currentBuffer}, `);
    this.emit(`methodName: ${JSON.stringify(componentBindingFacts.methodName)}, args: `);
    this.compiler._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, runtime, cb, errorContext: ${errorContextJson} })`);
  }

  emitObservationCommand(channelName, node, mode = 'snapshot') {
    const posLiteral = this.compiler.buffer._emitPositionLiteral(node);
    const channelNameJson = JSON.stringify(channelName);
    if (mode === 'snapshot') {
      this.emit(`new runtime.SnapshotCommand({ channelName: ${channelNameJson}, pos: ${posLiteral} })`);
      return;
    }
    if (mode === 'isError') {
      this.emit(`new runtime.IsErrorCommand({ channelName: ${channelNameJson}, pos: ${posLiteral} })`);
      return;
    }
    if (mode === 'getError') {
      this.emit(`new runtime.GetErrorCommand({ channelName: ${channelNameJson}, pos: ${posLiteral} })`);
      return;
    }
    throw new Error(`Unsupported component observation mode '${mode}'`);
  }

  emitChannelObservation(componentBindingFacts, node) {
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    this.emit('runtime.observeComponentChannel({ ');
    this.emit(`bindingName: ${JSON.stringify(componentBindingFacts.bindingName)}, `);
    this.emit(`currentBuffer: ${this.compiler.buffer.currentBuffer}, observationCommand: `);
    this.emitObservationCommand(componentBindingFacts.channelName, node, componentBindingFacts.mode || 'snapshot');
    this.emit(`, errorContext: ${errorContextJson}, implicitVarRead: ${componentBindingFacts.implicitVarRead ? 'true' : 'false'} })`);
  }

  emitSharedVarNestedLookup(componentBindingRoot, node) {
    const staticPath = componentBindingRoot.staticPath;
    const nestedPath = staticPath.slice(2);
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));

    nestedPath.forEach(() => {
      this.emit('runtime.memberLookupScript((');
    });
    this.emitChannelObservation({
      bindingName: componentBindingRoot.bindingName,
      kind: 'shared-read',
      channelName: staticPath[1],
      implicitVarRead: true
    }, node);
    nestedPath.forEach((propertyName) => {
      this.emit(`), ${JSON.stringify(propertyName)}, ${errorContextJson})`);
    });
  }
}

export {CompileComponent};
