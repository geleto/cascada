import * as nodes from '../nodes.js';
import {CALLER_SCHED_CHANNEL_NAME} from './macro.js';

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
    node._analysis.sequenceLockLookup = sequenceLockLookup;

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
    const explicitThisDispatchMethodName =
      compiler.inheritance.analyzeExplicitThisDispatchCall(node, analysisPass);
    const specialChannelCall = this._collectSpecialChannelCallUsage(node, analysisPass, uses, mutates);

    return {
      uses,
      mutates,
      specialChannelCall,
      importedCallable,
      directCallerCall: false,
      directMacroCall,
      explicitThisDispatchMethodName,
      // Direct same-scope macro calls reuse the current buffer through
      // runtime.invokeMacro(..., currentBuffer). Imported callable calls need a
      // value boundary, so only those are marked as linked child buffers here.
      createsLinkedChildBuffer: importedCallable
    };
  }

  postAnalyzeFunCall(node) {
    const compiler = this.compiler;
    const thisSharedFacts = node.name
      ? compiler.channel.getThisSharedAccessFacts(node.name, compiler.analysis, node._analysis)
      : null;
    const explicitThisDispatchMethodName =
      compiler.inheritance.postAnalyzeExplicitThisDispatchCall(node, thisSharedFacts);

    return {
      funCallThisSharedAccessFacts: thisSharedFacts,
      componentBindingRoot: node.name ? compiler.component.getBindingRoot(node.name) : null,
      componentBindingFacts: node.name ? compiler.component.getBindingFacts(node.name, { forCall: true }) : null,
      explicitThisDispatchMethodName: explicitThisDispatchMethodName ??
        node._analysis.explicitThisDispatchMethodName ??
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
    if (compiler.channel.compileSpecialChannelFunCall(node)) {
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
    if (compiler.inheritance.compileExplicitThisDispatchCall(node)) {
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
    const thisSharedFacts = compiler.channel.getThisSharedAccessFacts(node.name, analysisPass, node._analysis);
    if (thisSharedFacts) {
      compiler.fail(
        'Sequence marker (!) is only supported on context paths, not this.<shared> channels.',
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
    const funcName = compiler._getNodeName(node.name).replace(/"/g, '\\"');
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));
    compiler.emit('runtime.sequentialCallWrapValue(');
    compiler.compile(node.name, null);
    compiler.emit(`, "${funcName}", context, `);
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit(`, "${sequenceLockKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${compiler.buffer.currentBuffer})`);
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
    const textChannel = analysisPass.getCurrentTextChannel(node._analysis);
    if (textChannel) {
      uses.push(textChannel);
      mutates.push(textChannel);
    }
    // caller() is a reserved macro call-block binding in async mode. Its
    // invocation scheduling uses the macro-local __caller__ lane, so any
    // nested child boundary containing caller() must link that lane.
    uses.push(CALLER_SCHED_CHANNEL_NAME);
    mutates.push(CALLER_SCHED_CHANNEL_NAME);
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
    const macroDecl = analysisPass.findDeclaration(node._analysis, node.name.value);
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
    const importedDecl = importedRoot ? analysisPass.findDeclaration(node._analysis, importedRoot) : null;
    const isImportedCallable =
      (importedDecl && importedDecl.imported) ||
      (!importedDecl && importedRoot && compiler.importedBindings && compiler.importedBindings.has(importedRoot));
    if (!isImportedCallable) {
      return null;
    }

    const importedChannelName = importedDecl && (importedDecl.runtimeName || importedRoot);
    if (importedChannelName) {
      uses.push(importedChannelName);
    }
    const textChannel = analysisPass.getCurrentTextChannel(node._analysis);
    if (textChannel) {
      uses.push(textChannel);
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
    });
    return true;
  }

  _collectSpecialChannelCallUsage(node, analysisPass, uses, mutates) {
    const compiler = this.compiler;
    if (!compiler.scriptMode || !node.name || node._analysis.sequenceLockLookup) {
      return null;
    }

    const callFacts = this._getSpecialChannelCallFacts(node, analysisPass);
    if (!callFacts) {
      return null;
    }
    uses.push(callFacts.channelName);
    if (!callFacts.isObservation) {
      mutates.push(callFacts.channelName);
    }
    return callFacts;
  }

  _getSpecialChannelCallFacts(node, analysisPass) {
    const compiler = this.compiler;
    const thisSharedFacts = compiler.channel.getThisSharedAccessFacts(node.name, analysisPass, node._analysis);
    if (thisSharedFacts) {
      const methodName = thisSharedFacts.channelPath.length >= 2
        ? thisSharedFacts.channelPath[thisSharedFacts.channelPath.length - 1]
        : null;
      return {
        channelName: thisSharedFacts.channelName,
        channelType: thisSharedFacts.channelType,
        shared: true,
        methodName,
        pathPrefix: thisSharedFacts.pathPrefix,
        isObservation:
          thisSharedFacts.channelPath.length === 2 &&
          (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError')
      };
    }

    const sequencePath = compiler.sequential._extractStaticPath(node.name);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const channelName = sequencePath[0];
    const channelDecl = analysisPass.findDeclaration(node._analysis, channelName);
    if (!channelDecl || channelDecl.shared) {
      return null;
    }

    const methodName = sequencePath[sequencePath.length - 1];
    return {
      channelName,
      channelType: channelDecl.type,
      shared: channelDecl.shared,
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

      compiler.component.emitChannelObservation(componentBindingFacts, node);
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
