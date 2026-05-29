import * as nodes from '../language/nodes.js';
import {CALLER_SCHED_CHAIN_NAME} from './macro.js';

class CompileCall {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeFunCall(node, analysisPass) {
    const compiler = this.compiler;
    const uses = [];
    const mutates = [];

    const sequenceLockLookup = compiler.sequential.getSequenceLockLookup(node);
    node.addAnalysis({ sequenceLockLookup });

    if (compiler.return.isUnsetCall(node)) {
      return compiler.return.analyzeIsUnsetCall(node);
    }

    const sequenceCall = this._analyzeSequenceCall(node, analysisPass, sequenceLockLookup);
    if (sequenceCall) {
      return sequenceCall;
    }

    const callerCall = this._analyzeCallerCall(node, analysisPass);
    if (callerCall) {
      return callerCall;
    }

    const directMacroCall = this._analyzeDirectMacroCall(node, analysisPass);
    const importedCallable = this._collectImportedCallableUsage(node, analysisPass, uses);
    const inheritedMethodCallName =
      compiler.inheritance.analyzeInheritedMethodCall(node, analysisPass);
    const specialChainCall = this._collectSpecialChainCallUsage(node, analysisPass, uses, mutates);

    return {
      uses,
      mutates,
      specialChainCall,
      importedCallable,
      directCallerCall: false,
      directMacroCall,
      inheritedMethodCallName,
      // Direct same-scope macro calls reuse the current buffer through
      // runtime.invokeMacro(..., currentBuffer). Imported callable calls need a
      // value boundary, so only those are marked as linked child buffers here.
      createsLinkedChildBuffer: importedCallable
    };
  }

  postAnalyzeFunCall(node) {
    const compiler = this.compiler;
    const thisSharedFacts = node.name
      ? compiler.chain.probeThisSharedAccessFacts(node.name, compiler.analysis, node._analysis)
      : null;
    const inheritedMethodCallName =
      compiler.inheritance.postAnalyzeInheritedMethodCall(node, thisSharedFacts);

    return {
      funCallThisSharedAccessFacts: thisSharedFacts,
      componentBindingRoot: node.name ? compiler.component.getBindingRoot(node.name) : null,
      componentBindingFacts: node.name ? compiler.component.getBindingFacts(node.name, { forCall: true }) : null,
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
    if (compiler.chain.compileSpecialChainFunCall(node)) {
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

  _analyzeSequenceCall(node, analysisPass, sequenceLockLookup) {
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
      uses: [sequenceLockLookup.key],
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

  _analyzeCallerCall(node, analysisPass) {
    const compiler = this.compiler;
    const isCallerCall = node.name &&
      (
        (node.name instanceof nodes.Symbol && node.name.value === 'caller') ||
        compiler.sequential._extractStaticPathRoot(node.name) === 'caller'
      );
    if (!isCallerCall) {
      return null;
    }

    const uses = [];
    const mutates = [];
    const textChain = analysisPass.getCurrentTextChain(node._analysis);
    if (textChain) {
      uses.push(textChain);
      mutates.push(textChain);
    }
    // caller() is a reserved macro call-block binding in async mode. Its
    // invocation scheduling uses the macro-local __caller__ lane, so any
    // nested child boundary containing caller() must link that lane.
    uses.push(CALLER_SCHED_CHAIN_NAME);
    mutates.push(CALLER_SCHED_CHAIN_NAME);
    return { uses, mutates, directCallerCall: true };
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

  _analyzeDirectMacroCall(node, analysisPass) {
    if (!(node.name instanceof nodes.Symbol) || !analysisPass.findDeclaration) {
      return null;
    }
    const macroDecl = analysisPass.markLookupDeclaration(node.name, node.name.value, node._analysis);
    return macroDecl && macroDecl.isMacro
      ? { binding: macroDecl.declarationOrigin?.compiledMacroFuncId ?? null }
      : null;
  }

  _compileDirectMacroCall(node) {
    const directMacroCall = node._analysis.directMacroCall;
    if (!directMacroCall) {
      return false;
    }

    const compiler = this.compiler;
    const directMacroBinding = directMacroCall.binding ?? null;
    compiler.emit('runtime.invokeMacro(');
    if (directMacroBinding) {
      compiler.emit(directMacroBinding);
    } else {
      compiler.compile(node.name, null);
    }
    compiler.emit(', context, ');
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit(`, ${compiler.buffer.currentBuffer})`);
    return true;
  }

  _collectImportedCallableUsage(node, analysisPass, uses) {
    const compiler = this.compiler;
    if (!node.name || !analysisPass.findDeclaration) {
      return null;
    }

    const importedRoot = compiler.sequential._extractStaticPathRoot(node.name);
    const importedDecl = importedRoot ? analysisPass.markLookupDeclaration(node.name, importedRoot, node._analysis) : null;
    const isImportedCallable =
      (importedDecl && importedDecl.imported) ||
      (!importedDecl && importedRoot && compiler.importedBindings && compiler.importedBindings.has(importedRoot));
    if (!isImportedCallable) {
      return null;
    }

    const importedChainName = importedDecl && (importedDecl.runtimeName || importedRoot);
    if (importedChainName) {
      uses.push(importedChainName);
    }
    const textChain = analysisPass.getCurrentTextChain(node._analysis);
    if (textChain) {
      uses.push(textChain);
    }
    return true;
  }

  _compileImportedCallableCall(node) {
    if (!node._analysis.importedCallable) {
      return false;
    }

    const compiler = this.compiler;
    compiler.boundaries.compileValueBoundary(compiler.buffer, node, (n) => {
      compiler._emitAsyncDynamicCall(n, 'currentBuffer');
    }, node, { callableName: compiler._describeCallableTarget(node.name) });
    return true;
  }

  _collectSpecialChainCallUsage(node, analysisPass, uses, mutates) {
    const compiler = this.compiler;
    if (!node.name || node._analysis.sequenceLockLookup) {
      return null;
    }

    const callFacts = this._getSpecialChainCallFacts(node, analysisPass);
    if (!callFacts) {
      return null;
    }
    if (!compiler.scriptMode && callFacts.chainType === 'var') {
      return null;
    }
    uses.push(callFacts.chainName);
    if (!callFacts.isObservation) {
      mutates.push(callFacts.chainName);
    }
    return callFacts;
  }

  _getSpecialChainCallFacts(node, analysisPass) {
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
          (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError')
      };
    }

    if (!compiler.scriptMode) {
      return null;
    }

    const sequencePath = compiler.sequential._extractStaticPath(node.name);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const chainName = sequencePath[0];
    const chainDecl = analysisPass.markLookupDeclaration(node.name, chainName, node._analysis);
    if (!chainDecl || chainDecl.shared) {
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
        (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError')
    };
  }

  _compileComponentCall(node) {
    const compiler = this.compiler;
    const componentBindingRoot =
      node._analysis.componentBindingRoot ??
      compiler.component.getBindingRoot(node.name);
    const componentBindingFacts =
      node._analysis.componentBindingFacts ??
      compiler.component.getBindingFacts(node.name, { forCall: true });

    if (componentBindingFacts) {
      if (componentBindingFacts.kind === 'method-call') {
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
