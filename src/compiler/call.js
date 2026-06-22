import * as nodes from '../language/nodes.js';
import {CALLER_CHAIN_NAME} from './reserved.js';
import {isStoredDirectly} from './declarations.js';
import {COMPONENT_BINDING_METHOD_CALL} from './component.js';

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

    const sequenceCall = this._collectSequenceCallFacts(node, analysisPass, sequenceLockLookup);
    if (sequenceCall) {
      return sequenceCall;
    }

    const callerCall = this._collectCallerCallFacts(node, analysisPass);
    if (callerCall) {
      return callerCall;
    }

    const directMacroCall = this._collectDirectMacroCallFacts(node, analysisPass);
    const importedCallable = this._collectImportedCallableUsage(node, analysisPass, observes);
    const inheritedMethodCallName =
      compiler.inheritance.findInheritedMethodCallNameForAnalysis(node, analysisPass);
    const componentBindingName = this._collectComponentCallUsage(node);
    if (componentBindingName) {
      mutates.push(componentBindingName);
    }
    const chainOperationCall = this._collectChainOperationCallUsage(node, analysisPass, observes, mutates);

    return {
      observes,
      mutates,
      chainOperationCall,
      importedCallable,
      directCallerCall: false,
      directMacroCall,
      inheritedMethodCallName,
      // Direct same-scope macro calls reuse the current buffer through
      // runtime.invokeMacro(..., currentBuffer). Imported callable calls need a
      // value boundary, so only those are marked as linked child buffers here.
      wantsLinkedChildBuffer: !!importedCallable
    };
  }

  postAnalyzeFunCall(node) {
    const compiler = this.compiler;
    const thisSharedFacts = node.name
      ? compiler.chain.probeThisSharedAccessFacts(node.name, compiler.analysis, node._analysis)
      : null;
    const inheritedMethodCallName =
      compiler.inheritance.recordInheritedMethodCallUsage(node, thisSharedFacts);

    return {
      funCallThisSharedAccessFacts: thisSharedFacts,
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
    if (this._compileCallerCall(node)) {
      return;
    }
    if (this._compileSequenceCall(node)) {
      return;
    }
    if (this._compileDirectMacroCall(node)) {
      return;
    }
    if (this._compileImportedCallableCall(node)) {
      return;
    }
    if (compiler.inheritance.compileInheritedMethodCall(node)) {
      return;
    }
    compiler._emitAsyncDynamicCall(node, compiler.buffer.currentBuffer);
  }

  _collectSequenceCallFacts(node, analysisPass, sequenceLockLookup) {
    if (!sequenceLockLookup) {
      return null;
    }

    const compiler = this.compiler;
    // Sequence calls always have a callable target; the sequence marker lives
    // on the static call path, not on a nameless expression.
    const thisSharedFacts = compiler.chain.probeThisSharedAccessFacts(
      node.name,
      analysisPass,
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
    compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key, analysisPass);
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

  _collectCallerCallFacts(node, analysisPass) {
    const compiler = this.compiler;
    const isCallerCall = node.name &&
      (
        (node.name instanceof nodes.Symbol && node.name.value === 'caller') ||
        compiler.sequential.extractStaticPathRoot(node.name) === 'caller'
      );
    if (!isCallerCall) {
      return null;
    }

    const mutates = [];
    const textChain = analysisPass.getCurrentTextChain(node._analysis);
    if (textChain) {
      mutates.push(textChain);
    }
    // caller() is a reserved macro call-block binding in async mode. Its
    // invocation ordering uses the macro-local __caller__ lane, so any
    // nested child boundary containing caller() must link that lane.
    mutates.push(CALLER_CHAIN_NAME);
    compiler.macro.recordCallerCall(node);
    return { mutates, directCallerCall: true };
  }

  _compileCallerCall(node) {
    const compiler = this.compiler;
    if (!compiler.macro || !compiler.macro.isDirectCallerCall(node)) {
      return false;
    }
    compiler.macro._emitCallerCallDispatch({
      bufferId: compiler.buffer.currentBuffer,
      node
    });
    return true;
  }

  _collectDirectMacroCallFacts(node, analysisPass) {
    if (!(node.name instanceof nodes.Symbol) || !analysisPass.findSourceDeclaration) {
      return null;
    }
    const macroDecl = analysisPass.recordSourceLookupDeclaration(node.name, node.name.value, node._analysis);
    return macroDecl && macroDecl.isMacro
      ? { declaration: macroDecl }
      : null;
  }

  _compileDirectMacroCall(node) {
    const directMacroCall = node._analysis.directMacroCall;
    if (!directMacroCall) {
      return false;
    }

    const compiler = this.compiler;
    compiler.emit('runtime.invokeMacro(');
    if (directMacroCall.declaration) {
      compiler._compileDirectDeclarationLookup(node.name, node.name.value, directMacroCall.declaration);
    } else {
      compiler.compile(node.name, null);
    }
    compiler.emit(', context, ');
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit(`, ${compiler.buffer.currentBuffer})`);
    return true;
  }

  _collectImportedCallableUsage(node, analysisPass, observes) {
    const compiler = this.compiler;
    if (!node.name || !analysisPass.findSourceDeclaration) {
      return null;
    }

    const importedRoot = compiler.sequential.extractStaticPathRoot(node.name);
    const importedDecl = importedRoot ? analysisPass.recordSourceLookupDeclaration(node.name, importedRoot, node._analysis) : null;
    const isImportedCallable =
      (importedDecl && importedDecl.imported) ||
      (!importedDecl && importedRoot && compiler.importedBindings && compiler.importedBindings.has(importedRoot));
    if (!isImportedCallable) {
      return null;
    }

    const importedChainName = importedDecl && (importedDecl.runtimeName || importedRoot);
    if (importedChainName && !isStoredDirectly(importedDecl)) {
      observes.push(importedChainName);
    }
    const textChain = analysisPass.getCurrentTextChain(node._analysis);
    if (textChain) {
      observes.push(textChain);
    }
    return true;
  }

  _compileImportedCallableCall(node) {
    if (!node._analysis.importedCallable) {
      return false;
    }

    const compiler = this.compiler;
    const stackFields = {
      callableName: compiler._describeCallableTarget(node.name),
      callSignature: compiler._describeCallSignature(node.name, node.args)
    };
    compiler.boundaries.compileValueBoundary(compiler.buffer, node, (n) => {
      compiler._emitAsyncDynamicCall(n, 'currentBuffer');
    }, node, stackFields);
    return true;
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

  _collectChainOperationCallUsage(node, analysisPass, observes, mutates) {
    const compiler = this.compiler;
    if (!node.name || node._analysis.sequenceLockLookup) {
      return null;
    }

    const callFacts = this._getChainOperationCallFacts(node, analysisPass);
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

  _getChainOperationCallFacts(node, analysisPass) {
    const compiler = this.compiler;
    const thisSharedFacts = compiler.chain.probeThisSharedAccessFacts(
      node.name,
      analysisPass,
      node._analysis
    );
    if (thisSharedFacts) {
      const methodName = thisSharedFacts.chainPath.length >= 2
        ? thisSharedFacts.chainPath[thisSharedFacts.chainPath.length - 1]
        : null;
      return {
        chainName: thisSharedFacts.chainName,
        chainType: thisSharedFacts.chainType,
        shared: true,
        methodName,
        pathPrefix: thisSharedFacts.pathPrefix,
        isObservation:
          thisSharedFacts.chainPath.length === 2 &&
          (methodName === 'isError' || methodName === 'getError' ||
            (methodName === 'snapshot' && thisSharedFacts.chainType !== 'sequence'))
      };
    }

    if (!compiler.scriptMode) {
      return null;
    }

    const sequencePath = compiler.sequential.extractStaticPathSegments(node.name);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const chainName = sequencePath[0];
    const chainDecl = analysisPass.recordSourceLookupDeclaration(node.name, chainName, node._analysis);
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
      shared: chainDecl.shared,
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
