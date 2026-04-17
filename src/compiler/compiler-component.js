'use strict';

class CompileComponent {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  getComponentBindingFacts(pathNode, analysisPass = this.compiler.analysis) {
    if (!this.compiler.scriptMode || !pathNode || !analysisPass || !analysisPass.findDeclaration) {
      return null;
    }
    const staticPath = this.compiler.sequential._extractStaticPath(pathNode);
    if (!staticPath || staticPath.length < 2) {
      return null;
    }
    const bindingName = staticPath[0];
    const bindingDecl = analysisPass.findDeclaration(pathNode._analysis, bindingName);
    const isComponentBinding = !!(
      (bindingDecl && bindingDecl.componentBinding) ||
      (!bindingDecl && this.compiler.componentBindings && this.compiler.componentBindings.has(bindingName))
    );
    if (!isComponentBinding) {
      return null;
    }
    return {
      bindingName,
      segments: staticPath.slice(1)
    };
  }

  emitComponentSharedRead(bindingName, sharedName, node) {
    this.emitComponentCommandPromise(
      bindingName,
      node,
      () => this.emit(`operation: "observe", sharedName: ${JSON.stringify(sharedName)}, observation: "value"`)
    );
  }

  emitComponentObservationCall(bindingName, sharedName, observation, node) {
    this.emitComponentCommandPromise(
      bindingName,
      node,
      () => this.emit(`operation: "observe", sharedName: ${JSON.stringify(sharedName)}, observation: ${JSON.stringify(observation)}`)
    );
  }

  emitComponentMethodCall(bindingName, methodName, node) {
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    this.emitComponentCommandPromise(
      bindingName,
      node,
      () => {
        this.emit(`operation: "method", methodName: ${JSON.stringify(methodName)}, args: `);
        this.compiler._compileAggregate(node.args, null, '[', ']', false, false);
        this.emit(`, env, runtime, cb, errorContext: { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${errorContextJson}, path: context.path }`);
      },
      false
    );
  }

  emitComponentCommandPromise(bindingName, node, emitFields, includePos = true) {
    const posLiteral = `{lineno: ${node.lineno}, colno: ${node.colno}}`;
    this.emit('(() => {');
    const cmdVar = this.compiler._tmpid();
    this.emit(` const ${cmdVar} = new runtime.ComponentOperationCommand({ channelName: "${bindingName}", `);
    emitFields.call(this);
    if (includePos) {
      this.emit(`, pos: ${posLiteral}`);
    }
    this.emit(' });');
    this.emit(` ${this.compiler.buffer.currentBuffer}.add(${cmdVar}, "${bindingName}");`);
    this.emit(` return ${cmdVar}.promise;`);
    this.emit(' })()');
  }

  emitComponentCall(node) {
    const componentCall = node._analysis && node._analysis.componentCall;
    if (!componentCall) {
      return false;
    }
    const segments = componentCall.segments;
    if (segments.length === 1) {
      this.emitComponentMethodCall(componentCall.bindingName, segments[0], node);
      return true;
    }
    if (segments.length === 2) {
      const observation = segments[1];
      if (observation === 'snapshot' || observation === 'isError' || observation === 'getError') {
        this.emitComponentObservationCall(componentCall.bindingName, segments[0], observation, node);
        return true;
      }
    }
    this.compiler.fail(
      'Component operations only support direct ns.method(...), ns.x, or ns.channel.snapshot()/isError()/getError() syntax',
      node.lineno,
      node.colno,
      node
    );
  }

  compileAsyncComponentImport(node) {
    if (node.withContext) {
      this.compiler.fail(
        'script component import does not support "with context"; pass explicit shared values instead',
        node.lineno,
        node.colno,
        node
      );
    }

    const target = node.target.value;
    const importId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, false, false);
    const componentId = this.compiler._tmpid();
    const importVarsVar = this.compiler._tmpid();
    const lifecycleChannelName = `__component_root__${target}`;
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));

    this.emit.line(`let ${importVarsVar} = {};`);
    this.compiler.inheritance._emitExplicitExternInputs(node, importVarsVar);
    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${lifecycleChannelName}", "var", context, null);`);
    this.emit.line(`let ${componentId} = runtime.createComponentInstance(` +
      `${importId}, ${importVarsVar}, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, "${target}", "${lifecycleChannelName}", ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${errorContextJson}, path: context.path }` +
      ');');
    this.compiler.buffer.emitOwnWaitedConcurrencyResolve(componentId, node);
    this.compiler.inheritance._emitValueImportBinding(target, componentId, node);
  }
}

module.exports = CompileComponent;
