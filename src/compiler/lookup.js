import * as nodes from '../language/nodes.js';
import {getSharedSourceName} from '../inheritance/shared-names.js';

class CompileLookup {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeLookupVal(node, analysisPass) {
    const facts = this._createAnalysisFacts();

    this._collectSequenceLockLookup(node, analysisPass, facts);
    if (this._collectThisSharedLookup(node, analysisPass, facts)) {
      return facts;
    }

    const compiler = this.compiler;
    facts.inheritedMethodCallName =
      compiler.inheritance.analyzeInheritedMethodCallTarget(node);
    this._collectComponentBindingLookup(node, facts);
    this._collectScriptSequenceChainLookup(node, analysisPass, facts);

    return facts;
  }

  compileLookupVal(node) {
    this._validateDynamicTemplateThisLookup(node);
    if (this._compileThisSharedLookup(node)) {
      return;
    }

    this.compiler.inheritance.validateBareInheritedMethodLookup(node);

    if (this._compileComponentBindingLookup(node)) {
      return;
    }
    if (this._compileAnalyzedSequenceChainLookup(node)) {
      return;
    }
    if (this._compileSequenceLockedLookup(node)) {
      return;
    }

    this._compileDynamicLookup(node);
  }

  _createAnalysisFacts() {
    return {
      uses: [],
      mutates: [],
      sequenceChainLookup: null,
      thisSharedAccessFacts: null,
      componentBindingRoot: null,
      componentBindingFacts: null,
      inheritedMethodCallName: null
    };
  }

  _collectSequenceLockLookup(node, analysisPass, facts) {
    const compiler = this.compiler;
    const sequenceLockLookup = compiler.sequential.getSequenceLockLookup(node);
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key, analysisPass);
      facts.uses.push(sequenceLockLookup.key);
      if (sequenceLockLookup.repair) {
        facts.mutates.push(sequenceLockLookup.key);
      }
    }
  }

  _collectThisSharedLookup(node, analysisPass, facts) {
    const compiler = this.compiler;
    const thisSharedFacts = compiler.chain.getThisSharedAccessFacts(node, analysisPass);
    if (!thisSharedFacts) {
      return false;
    }

    facts.thisSharedAccessFacts = thisSharedFacts;
    facts.uses.push(thisSharedFacts.chainName);
    if (
      compiler.scriptMode &&
      thisSharedFacts.chainType === 'sequence' &&
      thisSharedFacts.chainPath.length >= 2 &&
      thisSharedFacts.propertyName !== 'snapshot'
    ) {
      facts.sequenceChainLookup = {
        chainName: thisSharedFacts.chainName,
        path: thisSharedFacts.chainPath.slice(1)
      };
    }
    return true;
  }

  _collectComponentBindingLookup(node, facts) {
    const compiler = this.compiler;
    facts.componentBindingRoot = compiler.component.getBindingRoot(node);
    facts.componentBindingFacts = compiler.component.getBindingFacts(node);
  }

  _collectScriptSequenceChainLookup(node, analysisPass, facts) {
    const compiler = this.compiler;
    if (!compiler.scriptMode) {
      return;
    }

    const lookupFacts = this._analyzeSequenceChainLookup(node, analysisPass);
    if (lookupFacts) {
      facts.uses.push(lookupFacts.chainName);
      facts.sequenceChainLookup = lookupFacts;
    }
  }

  _analyzeSequenceChainLookup(node, analysisPass) {
    const compiler = this.compiler;
    const sequencePath = compiler.sequential._extractStaticPath(node);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const chainName = sequencePath[0];
    const chainDecl = analysisPass.markLookupDeclaration(node, chainName);
    const path = sequencePath.slice(1);
    if (!chainDecl || chainDecl.shared || chainDecl.type !== 'sequence' || path[path.length - 1] === 'snapshot') {
      return null;
    }
    return {
      chainName,
      path
    };
  }

  _validateDynamicTemplateThisLookup(node) {
    const compiler = this.compiler;
    if (
      !compiler.scriptMode &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this' &&
      !(node.val instanceof nodes.Literal && typeof node.val.value === 'string')
    ) {
      // Analysis rejects this first for inheritance templates; this keeps
      // direct compile calls on the same structural-error path.
      compiler.fail(
        'Dynamic this[...] shared access is not supported in templates.',
        node.lineno,
        node.colno,
        node
      );
    }
  }

  _compileThisSharedLookup(node) {
    const compiler = this.compiler;
    const thisSharedFacts =
      node._analysis.thisSharedAccessFacts ||
      compiler.chain.probeThisSharedAccessFacts(node, compiler.analysis);
    if (!thisSharedFacts) {
      return false;
    }

    if (this._compileAnalyzedSequenceChainLookup(node)) {
      return true;
    }
    if (thisSharedFacts.chainType !== 'var') {
      const sourceName = getSharedSourceName(thisSharedFacts.chainName);
      compiler.fail(
        `Chain 'this.${sourceName}' cannot be used as a bare symbol. Use 'this.${sourceName}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
    if (thisSharedFacts.chainPath.length === 1) {
      compiler.inheritance.emitSharedChainObservation(thisSharedFacts.chainName, node, 'snapshot', true);
      return true;
    }
    this._emitThisSharedVarNestedLookup(thisSharedFacts, node);
    return true;
  }

  _compileComponentBindingLookup(node) {
    const compiler = this.compiler;
    const componentBindingRoot =
      node._analysis.componentBindingRoot ||
      compiler.component.getBindingRoot(node);
    const componentBindingFacts =
      node._analysis.componentBindingFacts ||
      compiler.component.getBindingFacts(node);
    if (componentBindingFacts && componentBindingFacts.kind === 'shared-read') {
      compiler.component.emitChainObservation(componentBindingFacts, node);
      return true;
    }
    if (componentBindingRoot && componentBindingRoot.staticPath.length > 2) {
      compiler.component.emitSharedVarNestedLookup(componentBindingRoot, node);
      return true;
    }
    if (componentBindingRoot) {
      compiler.component.failUnsupportedUsage(
        node,
        componentBindingRoot.bindingName,
        '`ns.x` / `ns.x.y` shared-var reads, `ns.x.snapshot()` observations, `ns.x is error`, `ns.x#`, and `ns.method(...)` calls'
      );
    }
    return false;
  }

  _compileAnalyzedSequenceChainLookup(node) {
    const compiler = this.compiler;
    const sequenceChainLookup =
      node._analysis.sequenceChainLookup;
    if (compiler.scriptMode && sequenceChainLookup) {
      compiler.buffer.emitAddSequenceGet(
        sequenceChainLookup.chainName,
        sequenceChainLookup.path,
        node
      );
      return true;
    }
    return false;
  }

  _compileSequenceLockedLookup(node) {
    const compiler = this.compiler;
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (!nodeStaticPathKey) {
      return false;
    }

    compiler._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));
    if (compiler.scriptMode) {
      this.emit('runtime.sequentialMemberLookupScriptValue((');
    } else {
      this.emit('runtime.sequentialMemberLookupAsyncValue((');
    }
    compiler.compile(node.target, null);
    this.emit('),');
    compiler.compile(node.val, null);
    this.emit(`, "${nodeStaticPathKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${compiler.buffer.currentBuffer})`);
    return true;
  }

  _compileDynamicLookup(node) {
    const compiler = this.compiler;
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));
    if (compiler.scriptMode) {
      this.emit('runtime.memberLookupScript((');
    } else {
      this.emit('runtime.memberLookupAsync((');
    }
    compiler.compile(node.target, null);
    this.emit('),');
    compiler.compile(node.val, null);
    this.emit(`, ${errorContextJson})`);
  }

  _emitThisSharedVarNestedLookup(thisSharedFacts, node) {
    const compiler = this.compiler;
    const nestedPath = thisSharedFacts.chainPath.slice(1);
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));
    const memberLookupHelper = compiler.scriptMode ? 'memberLookupScript' : 'memberLookupAsync';

    nestedPath.forEach(() => {
      this.emit(`runtime.${memberLookupHelper}((`);
    });
    compiler.inheritance.emitSharedChainObservation(thisSharedFacts.chainName, node, 'snapshot', true);
    nestedPath.forEach((propertyName) => {
      this.emit(`), ${JSON.stringify(propertyName)}, ${errorContextJson})`);
    });
  }
}

export {CompileLookup};
