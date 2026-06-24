import {DECLARATION_IMPORT_KIND, isStoredDirectly} from './declarations.js';
import {COMPONENT_BINDING_METHOD_CALL} from './component.js';
import * as nodes from '../language/nodes.js';

class CompileCall {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeFunCall(node, analysisPass) {
    if (node._analysis?.operationOwnedPath) {
      return {};
    }
    const compiler = this.compiler;
    const observes = [];
    const mutates = [];

    const sequenceLockLookup = compiler.sequential.recordSequenceLockLookup(node);
    node.addAnalysis({ sequenceLockLookup });
    compiler.sequential.recordFunCallNameLockKey(node);

    if (compiler.return.isUnsetCall(node)) {
      return compiler.return.collectIsUnsetCallFacts(node);
    }

    const sequenceCall = this._collectSequenceCallFacts(node, sequenceLockLookup);
    if (sequenceCall) {
      return sequenceCall;
    }

    const macroCallerInvocation = compiler.macro.collectMacroCallerInvocationFacts(node, analysisPass);
    if (macroCallerInvocation) {
      return macroCallerInvocation;
    }

    const inheritedMethodCallName =
      compiler.inheritance.findInheritedMethodCallNameForAnalysis(node);
    const componentBindingName = this._collectComponentCallUsage(node);
    if (componentBindingName) {
      mutates.push(componentBindingName);
    }
    const chainOperationCall = this._collectChainOperationCallUsage(node, observes, mutates);
    const declareInRootOnEnter = chainOperationCall?.declareInRootOnEnter || [];

    return {
      declareInRootOnEnter,
      observes,
      mutates,
      chainOperationCall,
      macroCallerInvocation: false,
      staticCallableCall: null,
      inheritedMethodCallName,
      wantsLinkedChildBuffer: false
    };
  }

  postAnalyzeFunCall(node) {
    const compiler = this.compiler;
    const thisSharedFacts = node.name
      ? compiler.chain.findThisSharedAccessFacts(node.name, node._analysis)
      : null;
    const inheritedMethodCallName =
      compiler.inheritance.recordInheritedMethodCallUsage(node, thisSharedFacts);

    return {
      componentBindingRoot: node.name ? compiler.component.findBindingRoot(node.name) : null,
      componentBindingFacts: node.name ? compiler.component.findBindingFacts(node.name, { forCall: true }) : null,
      inheritedMethodCallName: inheritedMethodCallName ??
        node._analysis.inheritedMethodCallName ??
        null
    };
  }

  compileFunCall(node) {
    const compiler = this.compiler;
    if (compiler.return.isUnsetCall(node)) {
      compiler.return.emitIsUnsetCall(node);
      return;
    }

    if (this._compileComponentCall(node)) {
      return;
    }
    if (compiler.chain.compileChainOperationFunCall(node)) {
      return;
    }
    if (compiler.macro.compileMacroCallerInvocation(node)) {
      return;
    }
    if (this._compileSequenceCall(node)) {
      return;
    }
    if (this._compileStaticCallableCall(node)) {
      return;
    }
    if (compiler.inheritance.compileInheritedMethodCall(node)) {
      return;
    }
    compiler._emitAsyncDynamicCall(node, compiler.buffer.currentBuffer);
  }

  _collectSequenceCallFacts(node, sequenceLockLookup) {
    if (!sequenceLockLookup) {
      return null;
    }

    const compiler = this.compiler;
    // Sequence calls always have a callable target; the sequence marker lives
    // on the static call path, not on a nameless expression.
    const thisSharedFacts = compiler.chain.analyzeThisSharedAccess(
      node.name,
      node._analysis
    );
    if (thisSharedFacts) {
      compiler.fail(
        'Sequence marker (!) is only supported on context paths, not this.<shared> chains.',
        node.lineno,
        node.colno,
        node
      );
    }
    compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key);
    return {
      mutates: [sequenceLockLookup.key]
    };
  }

  _compileSequenceCall(node) {
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const sequenceLockKey = sequenceLockLookup?.key;
    if (!sequenceLockKey) {
      return false;
    }

    const compiler = this.compiler;
    const funcName = compiler._describeCallableTarget(node.name).replace(/"/g, '\\"');
    compiler.emit('runtime.sequentialCallWrapValue(');
    compiler.compile(node.name, null);
    compiler.emit(`, "${funcName}", context, `);
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit(`, "${sequenceLockKey}", ${compiler.emitErrorContext(node)}, ${!!sequenceLockLookup.repair}, ${compiler.buffer.currentBuffer})`);
    return true;
  }

  classifyStaticCallableCall(node) {
    if (!(node instanceof nodes.FunCall) ||
      node._analysis?.operationOwnedPath ||
      node._analysis?.sequenceLockLookup ||
      node._analysis?.macroCallerInvocation ||
      this.compiler.return.isUnsetCall(node)) {
      return;
    }
    const staticCallableCall = this._collectStaticCallableCallFacts(node);
    if (!staticCallableCall) {
      return;
    }
    node.addAnalysis({
      staticCallableCall,
      wantsLinkedChildBuffer: staticCallableCall.kind !== 'local-macro'
    });
  }

  _findNearestCallableAnalysis(analysis) {
    let current = analysis;
    while (current) {
      if (
        current.node instanceof nodes.Macro ||
        current.node instanceof nodes.Block ||
        current.node instanceof nodes.MethodDefinition
      ) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  validateCallableValueUse(analysis) {
    const node = analysis.node;
    // A valid static callable call target is still a symbol/lookup read with
    // declaration facts. Call classification marks it so this validation only
    // rejects value uses.
    if (
      this.compiler.scriptMode ||
      analysis.isSymbolTarget ||
      analysis.operationOwnedPath ||
      analysis.isStaticCallableCallTarget ||
      node.isCompilerInternal
    ) {
      return;
    }

    if (node instanceof nodes.Symbol) {
      this._validateSymbolCallableValueUse(analysis, node);
      return;
    }

    if (node instanceof nodes.LookupVal) {
      this._validateImportedNamespaceCallableValueUse(analysis, node);
    }
  }

  _validateSymbolCallableValueUse(analysis, node) {
    const declaration = analysis.visibleCallableDeclarations?.get(node.value) || null;
    if (!declaration) {
      return;
    }
    if (declaration.isMacro) {
      this._failCallableValueUse(node, node.value);
      return;
    }
    if (declaration.imported && declaration.importKind === DECLARATION_IMPORT_KIND.FROM && declaration.requiredCallable) {
      this._failImportedCallableValueUse(node, declaration.requiredCallableLocalPath || node.value);
    }
  }

  _validateImportedNamespaceCallableValueUse(analysis, node) {
    const path = this.compiler.sequential.extractStaticPathSegments(node);
    if (!path || path.length < 2) {
      return;
    }
    const declaration = analysis.visibleCallableDeclarations?.get(path[0]) || null;
    if (!declaration?.imported || declaration.importKind !== DECLARATION_IMPORT_KIND.NAMESPACE) {
      return;
    }
    const callablePath = declaration.requiredCallableExports?.get(path[1]) || null;
    if (!callablePath) {
      return;
    }
    this._failImportedCallableValueUse(node, callablePath);
  }

  _failCallableValueUse(node, name) {
    this.compiler.fail(
      `Callable '${name}' cannot be used as a value in an async template. Call it directly.`,
      node.lineno,
      node.colno,
      node
    );
  }

  _failImportedCallableValueUse(node, path) {
    this.compiler.fail(
      `Imported callable '${path}' cannot be used as a value in an async template. Call it directly.`,
      node.lineno,
      node.colno,
      node
    );
  }

  _collectStaticCallableCallFacts(node) {
    if (!node.name) {
      return null;
    }

    const path = this.compiler.sequential.extractStaticPathSegments(node.name);
    if (!path || path.length === 0) {
      return null;
    }

    const rootName = path[0];
    const declaration = node._analysis.visibleCallableDeclarations?.get(rootName) || null;

    if (declaration?.isMacro) {
      if (!(node.name instanceof nodes.Symbol) || path.length !== 1) {
        return null;
      }
      node.name.addAnalysis({
        isStaticCallableCallTarget: true
      });
      return {
        kind: 'local-macro',
        declaration,
        localName: rootName,
        localPath: rootName
      };
    }

    if (!declaration?.imported) {
      return null;
    }

    const importedCallableCall = this._classifyImportedCallableCall(node, path, declaration, rootName);
    if (!importedCallableCall) {
      return null;
    }

    this._recordImportedCallableUse(importedCallableCall, node._analysis);
    node.name.addAnalysis({ isStaticCallableCallTarget: true });
    return importedCallableCall;
  }

  _classifyImportedCallableCall(node, path, declaration, rootName) {
    if (declaration.importKind === DECLARATION_IMPORT_KIND.NAMESPACE) {
      if (path.length === 1) {
        this.compiler.fail(
          `Import namespace '${rootName}' is not callable; call a named export such as ${rootName}.name(...).`,
          node.name.lineno,
          node.name.colno,
          node.name
        );
      }
      if (path.length !== 2) {
        return null;
      }
      const exportedName = this._getStaticNamespaceCallableExportName(node.name, rootName);
      if (!exportedName) {
        return null;
      }
      return {
        kind: DECLARATION_IMPORT_KIND.NAMESPACE,
        declaration,
        namespaceName: rootName,
        exportedName,
        localPath: `${rootName}.${exportedName}`
      };
    }
    if (declaration.importKind === DECLARATION_IMPORT_KIND.FROM && path.length === 1) {
      return {
        kind: DECLARATION_IMPORT_KIND.FROM,
        declaration,
        localName: rootName,
        exportedName: declaration.exportedName,
        localPath: rootName
      };
    }
    return null;
  }

  _getStaticNamespaceCallableExportName(targetNode, namespaceName) {
    if (!(targetNode instanceof nodes.LookupVal)) {
      return null;
    }
    if (!(targetNode.target instanceof nodes.Symbol) || targetNode.target.value !== namespaceName) {
      return null;
    }
    if (!(targetNode.val instanceof nodes.Literal) || typeof targetNode.val.value !== 'string') {
      return null;
    }
    return targetNode.val.value;
  }

  _recordImportedCallableUse(importedCallableCall, analysis) {
    const declaration = importedCallableCall.declaration;
    if (this._needsCleanScopeCallableBinding(analysis)) {
      declaration.requiresCleanScopeBinding = true;
    }
    if (importedCallableCall.kind === DECLARATION_IMPORT_KIND.FROM) {
      declaration.requiredCallable = true;
      declaration.requiredCallableLocalPath = importedCallableCall.localPath;
      return;
    }
    declaration.requiredCallableExports ||= new Map();
    declaration.requiredCallableExports.set(importedCallableCall.exportedName, importedCallableCall.localPath);
  }

  _needsCleanScopeCallableBinding(analysis) {
    const callableAnalysis = this._findNearestCallableAnalysis(analysis);
    return !!(
      callableAnalysis &&
      !(callableAnalysis.node instanceof nodes.MethodDefinition && callableAnalysis.node.isCompilerInternal)
    );
  }

  _compileStaticCallableCall(node) {
    const staticCallableCall = node._analysis.staticCallableCall;
    if (!staticCallableCall) {
      return false;
    }

    if (staticCallableCall.kind === 'local-macro') {
      this._emitLocalMacroInvocation(node, staticCallableCall);
      return true;
    }

    const compiler = this.compiler;
    const stackFields = {
      callableName: compiler._describeCallableTarget(node.name),
      callSignature: compiler._describeCallSignature(node.name, node.args)
    };
    compiler.boundaries.compileValueBoundary(compiler.buffer, node, (n) => {
      this._emitImportedCallableInvocation(n, staticCallableCall);
    }, node, stackFields);
    return true;
  }

  _emitLocalMacroInvocation(node, staticCallableCall) {
    const compiler = this.compiler;
    compiler.emit('runtime.invokeMacro(');
    compiler._compileDirectDeclarationLookup(node.name, staticCallableCall.localName, staticCallableCall.declaration);
    compiler.emit(', context, ');
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit(`, ${compiler.buffer.currentBuffer})`);
  }

  _emitImportedCallableInvocation(node, importedCallableCall) {
    const compiler = this.compiler;
    const callableId = compiler._tmpid();
    const argsId = compiler._tmpid();
    const callableName = compiler._describeCallableTarget(node.name).replace(/"/g, '\\"');

    compiler.emit('(() => {');
    compiler.emit(`const ${callableId} = `);
    this._emitImportedCallableValue(node, importedCallableCall);
    compiler.emit.line(';');
    compiler.emit(`const ${argsId} = `);
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit.line(';');
    compiler.emit(`return runtime.callWrapStaticCallableAsync(${callableId}, "${callableName}", context, ${argsId}, ${compiler.emitErrorContext(node)}, currentBuffer);`);
    compiler.emit('})()');
  }

  _emitImportedCallableValue(node, importedCallableCall) {
    const compiler = this.compiler;
    if (importedCallableCall.kind === DECLARATION_IMPORT_KIND.FROM) {
      compiler._compileDirectDeclarationLookup(node.name, importedCallableCall.localName, importedCallableCall.declaration);
      return;
    }

    compiler.emit('runtime.thenValue(');
    compiler._compileDirectDeclarationLookup(node.name, importedCallableCall.namespaceName, importedCallableCall.declaration);
    compiler.emit(`, (exported) => runtime.getImportedExport(exported, ${JSON.stringify(importedCallableCall.exportedName)}, ${compiler.emitErrorContext(node.name)}))`);
  }

  _collectComponentCallUsage(node) {
    const componentBindingFacts = node.name
      ? this.compiler.component.findBindingFacts(node.name, { forCall: true })
      : null;
    if (componentBindingFacts) {
      this.compiler.chain.markOperationOwnedPath(node.name);
    }
    return componentBindingFacts
      ? componentBindingFacts.bindingName
      : null;
  }

  _collectChainOperationCallUsage(node, observes, mutates) {
    const compiler = this.compiler;
    if (!node.name || node._analysis.sequenceLockLookup) {
      return null;
    }

    const callFacts = this._getChainOperationCallFacts(node);
    if (!callFacts) {
      return null;
    }
    if (callFacts.chainType === 'var') {
      return null;
    }
    compiler.chain.markOperationOwnedPath(node.name);
    const target = callFacts.isObservation ? observes : mutates;
    target.push(callFacts.chainName);
    return callFacts;
  }

  _getChainOperationCallFacts(node) {
    const compiler = this.compiler;
    const thisSharedFacts = compiler.chain.analyzeThisSharedAccess(
      node.name,
      node._analysis
    );
    if (thisSharedFacts) {
      const methodName = thisSharedFacts.chainPath.length >= 2
        ? thisSharedFacts.chainPath[thisSharedFacts.chainPath.length - 1]
        : null;
      const facts = {
        chainName: thisSharedFacts.chainName,
        chainType: thisSharedFacts.chainType,
        methodName,
        pathPrefix: thisSharedFacts.pathPrefix,
        isObservation:
          thisSharedFacts.chainPath.length === 2 &&
          (methodName === 'isError' || methodName === 'getError' ||
            (methodName === 'snapshot' && thisSharedFacts.chainType !== 'sequence'))
      };
      if (thisSharedFacts.declareInRootOnEnter) {
        facts.declareInRootOnEnter = thisSharedFacts.declareInRootOnEnter;
      }
      return facts;
    }

    if (!compiler.scriptMode) {
      return null;
    }

    const sequencePath = compiler.sequential.extractStaticPathSegments(node.name);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const chainName = sequencePath[0];
    const chainDecl = node._analysis.visibleDeclarations?.get(chainName) || null;
    if (!chainDecl || chainDecl.shared) {
      return null;
    }
    if (isStoredDirectly(chainDecl)) {
      return null;
    }

    const methodName = sequencePath[sequencePath.length - 1];
    return {
      chainName,
      chainType: chainDecl.type,
      methodName,
      pathPrefix: sequencePath.slice(1, -1),
      isObservation:
        sequencePath.length === 2 &&
        (methodName === 'isError' || methodName === 'getError' ||
          (methodName === 'snapshot' && chainDecl.type !== 'sequence'))
    };
  }

  _compileComponentCall(node) {
    const compiler = this.compiler;
    const componentBindingRoot =
      node._analysis.componentBindingRoot ??
      compiler.component.findBindingRoot(node.name);
    const componentBindingFacts =
      node._analysis.componentBindingFacts ??
      compiler.component.findBindingFacts(node.name, { forCall: true });

    if (componentBindingFacts) {
      if (componentBindingFacts.kind === COMPONENT_BINDING_METHOD_CALL) {
        compiler.component.compileMethodCall(componentBindingFacts, node);
        return true;
      }

      compiler.component.emitChainObservation(componentBindingFacts, node);
      return true;
    }
    if (componentBindingRoot) {
      compiler.component.failUnsupportedUsage(
        node.name,
        componentBindingRoot.bindingName,
        '`ns.method(...)` calls, `ns.x.snapshot()` observations, and `ns.x is error` / `ns.x#` error observations'
      );
    }
    return false;
  }
}

export {CompileCall};
