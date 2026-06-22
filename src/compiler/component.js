
import {renameSharedName} from '../inheritance/shared-names.js';

const COMPONENT_BINDING_SHARED_READ = 'shared-read';
const COMPONENT_BINDING_SHARED_OBSERVE = 'shared-observe';
const COMPONENT_BINDING_METHOD_CALL = 'method-call';

class CompileComponent {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeComponent(node) {
    node.template.addAnalysis({ errorContextLabel: 'Component.Script' });
    this.compiler.inheritance.recordComponentOperation(node);
    node.target.addAnalysis({ isSymbolTarget: true });
    return {
      declareOnExit: [{
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
    const componentScriptOrTemplateVar = this.compiler.composition.compileAsyncResolveTargetFile(node, true, false, false, 'component');
    const componentVarsVar = this.compiler._tmpid();
    const rootContextVar = this.compiler._tmpid();

    this.emit.line(`runtime.declareBufferChain(${this.compiler.buffer.currentBuffer}, "${targetName}", "var", context, null);`);
    this.emit.line(`const ${componentVarsVar} = {};`);
    this.compiler.compositionPayload.emitCompiledInputs(node, componentVarsVar);
    this.compiler.compositionPayload.emitContext(rootContextVar, componentVarsVar, node.withContext);
    this.emit.line('runtime.startComponentInstance({');
    this.emit.line(`  currentBuffer: ${this.compiler.buffer.currentBuffer},`);
    this.emit.line(`  bindingName: "${targetName}",`);
    this.emit.line(`  componentScriptOrTemplate: ${componentScriptOrTemplateVar},`);
    this.emit.line(`  payload: ${rootContextVar},`);
    this.emit.line('  ownerContext: context,');
    this.emit.line('  ownerState,');
    this.emit.line(`  errorContext: ${this.compiler.emitErrorContext(node)}`);
    this.emit.line('});');

    if (targetName.charAt(0) !== '_' && this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.emit.line(`context.addDeferredExport("${targetName}", "${targetName}", ${this.compiler.buffer.currentBuffer});`);
    }
  }

  findBindingFacts(node, { forCall = false } = {}) {
    const bindingRoot = this.findBindingRoot(node);
    if (!bindingRoot) {
      return null;
    }
    const bindingName = bindingRoot.bindingName;
    const staticPath = bindingRoot.staticPath;

    if (!forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: COMPONENT_BINDING_SHARED_READ,
        chainName: renameSharedName(staticPath[1]),
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
        kind: COMPONENT_BINDING_SHARED_OBSERVE,
        chainName: renameSharedName(staticPath[1]),
        mode: staticPath[2],
        implicitVarRead: false
      };
    }

    if (forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: COMPONENT_BINDING_METHOD_CALL,
        methodName: staticPath[1]
      };
    }

    return null;
  }

  findBindingRoot(node) {
    if (!this.compiler.scriptMode || !node) {
      return null;
    }

    const staticPath = this.compiler.sequential.extractStaticPathSegments(node);
    if (!staticPath || staticPath.length < 2) {
      return null;
    }

    const bindingName = staticPath[0];
    const bindingDecl = this.compiler.analysis.findSourceDeclaration(node._analysis, bindingName);
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
    this.emit('runtime.callComponentMethod({ ');
    this.emit(`bindingName: ${JSON.stringify(componentBindingFacts.bindingName)}, `);
    this.emit(`currentBuffer: ${this.compiler.buffer.currentBuffer}, `);
    this.emit(`methodName: ${JSON.stringify(componentBindingFacts.methodName)}, args: `);
    this.compiler._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, errorContext: ${this.compiler.emitErrorContext(node)} })`);
  }

  emitObservationCommand(chainName, node, mode = 'snapshot') {
    const errorContext = this.compiler.emitErrorContext(node);
    const chainNameJson = JSON.stringify(chainName);
    if (mode === 'snapshot') {
      this.emit(`new runtime.SnapshotCommand({ chainName: ${chainNameJson}, errorContext: ${errorContext} })`);
      return;
    }
    if (mode === 'isError') {
      this.emit(`new runtime.IsErrorCommand({ chainName: ${chainNameJson}, errorContext: ${errorContext} })`);
      return;
    }
    if (mode === 'getError') {
      this.emit(`new runtime.GetErrorCommand({ chainName: ${chainNameJson}, errorContext: ${errorContext} })`);
      return;
    }
    throw new Error(`Unsupported component observation mode '${mode}'`);
  }

  emitChainObservation(componentBindingFacts, node) {
    this.emit('runtime.observeComponentChain({ ');
    this.emit(`bindingName: ${JSON.stringify(componentBindingFacts.bindingName)}, `);
    this.emit(`currentBuffer: ${this.compiler.buffer.currentBuffer}, observationCommand: `);
    this.emitObservationCommand(componentBindingFacts.chainName, node, componentBindingFacts.mode || 'snapshot');
    this.emit(`, errorContext: ${this.compiler.emitErrorContext(node)}, implicitVarRead: ${componentBindingFacts.implicitVarRead ? 'true' : 'false'} })`);
  }

  emitSharedVarNestedLookup(componentBindingRoot, node) {
    const staticPath = componentBindingRoot.staticPath;
    const nestedPath = staticPath.slice(2);

    nestedPath.forEach(() => {
      this.emit('runtime.memberLookupScript((');
    });
    this.emitChainObservation({
      bindingName: componentBindingRoot.bindingName,
      kind: COMPONENT_BINDING_SHARED_READ,
      chainName: renameSharedName(staticPath[1]),
      implicitVarRead: true
    }, node);
    nestedPath.forEach((propertyName) => {
      this.emit(`), ${JSON.stringify(propertyName)}, ${this.compiler.emitErrorContext(node)}, ${this.compiler.buffer.currentBuffer})`);
    });
  }
}

export {
  COMPONENT_BINDING_METHOD_CALL,
  COMPONENT_BINDING_SHARED_READ,
  CompileComponent
};
