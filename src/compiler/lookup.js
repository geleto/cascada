import * as nodes from '../language/nodes.js';
import {getSharedSourceName} from '../inheritance/shared-names.js';
import {COMPONENT_BINDING_SHARED_READ} from './component.js';

class CompileLookup {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeLookupVal(node) {
    if (node._analysis?.operationOwnedPath) {
      return {};
    }
    const facts = this._createAnalysisFacts();
    this.compiler.chain.recordDataPathLookup(node);

    this._collectSequenceLockLookup(node, facts);
    if (this._collectThisSharedLookup(node, facts)) {
      return facts;
    }

    const compiler = this.compiler;
    facts.inheritedMethodCallName =
      compiler.inheritance.findInheritedMethodCallName(node);
    this._collectComponentBindingLookup(node, facts);
    this._collectScriptSequenceChainLookup(node, facts);

    return facts;
  }

  postAnalyzeLookupVal(node) {
    if (node._analysis?.operationOwnedPath) {
      return {};
    }
    const sequenceLockFacts = this.compiler.sequential.collectBareSequenceLockLookupFacts(node);
    this.compiler.call.validateCallableValueUse(node._analysis);
    return {
      ...(sequenceLockFacts || {}),
      ...this.compiler.chain.collectDataPathLookupFacts(node)
    };
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
      observes: [],
      mutates: [],
      inheritedMethodCallName: null
    };
  }

  _collectSequenceLockLookup(node, facts) {
    const compiler = this.compiler;
    const sequenceLockLookup = compiler.sequential.recordSequenceLockLookup(node);
    node.addAnalysis({ sequenceLockLookup });
    if (sequenceLockLookup) {
      compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key);
      const target = sequenceLockLookup.repair ? facts.mutates : facts.observes;
      target.push(sequenceLockLookup.key);
    }
  }

  _collectThisSharedLookup(node, facts) {
    const compiler = this.compiler;
    const thisSharedFacts = compiler.chain.analyzeThisSharedAccess(node);
    if (!thisSharedFacts) {
      return false;
    }

    if (thisSharedFacts.declareInRootOnEnter) {
      facts.declareInRootOnEnter = thisSharedFacts.declareInRootOnEnter;
    }
    facts.observes.push(thisSharedFacts.chainName);
    return true;
  }

  _collectComponentBindingLookup(node, facts) {
    const compiler = this.compiler;
    const componentBindingRoot = compiler.component.findBindingRoot(node);
    if (componentBindingRoot) {
      compiler.chain.markOperationOwnedPath(node);
      facts.mutates.push(componentBindingRoot.bindingName);
    }
  }

  _collectScriptSequenceChainLookup(node, facts) {
    const compiler = this.compiler;
    if (!compiler.scriptMode) {
      return;
    }

    const lookupFacts = this._collectSequenceChainLookupFacts(node);
    if (lookupFacts) {
      facts.observes.push(lookupFacts.chainName);
    }
  }

  _collectSequenceChainLookupFacts(node) {
    const compiler = this.compiler;
    const sequencePath = compiler.sequential.extractStaticPathSegments(node);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const chainName = sequencePath[0];
    const chainDecl = node._analysis.visibleDeclarations?.get(chainName) || null;
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
    const thisSharedFacts = compiler.chain.findThisSharedAccessFacts(node);
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
      compiler.chain.emitChainObservation(thisSharedFacts.chainName, node, 'snapshot', true, true);
      return true;
    }
    this._emitThisSharedVarNestedLookup(thisSharedFacts, node);
    return true;
  }

  _compileComponentBindingLookup(node) {
    const compiler = this.compiler;
    const componentBindingRoot = compiler.component.findBindingRoot(node);
    const componentBindingFacts = compiler.component.findBindingFacts(node);
    if (componentBindingFacts && componentBindingFacts.kind === COMPONENT_BINDING_SHARED_READ) {
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
    const sequenceChainLookup = this._getSequenceChainLookup(node);
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

  _getSequenceChainLookup(node) {
    const thisSharedFacts = this.compiler.chain.findThisSharedAccessFacts(node);
    if (
      this.compiler.scriptMode &&
      thisSharedFacts &&
      thisSharedFacts.chainType === 'sequence' &&
      thisSharedFacts.chainPath.length >= 2 &&
      thisSharedFacts.propertyName !== 'snapshot'
    ) {
      return {
        chainName: thisSharedFacts.chainName,
        path: thisSharedFacts.chainPath.slice(1)
      };
    }
    return this._collectSequenceChainLookupFacts(node);
  }

  _compileSequenceLockedLookup(node) {
    const compiler = this.compiler;
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (!nodeStaticPathKey) {
      return false;
    }

    compiler._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
    if (compiler.scriptMode) {
      this.emit('runtime.sequentialMemberLookupScriptValue((');
    } else {
      this.emit('runtime.sequentialMemberLookupAsyncValue((');
    }
    compiler.compile(node.target, null);
    this.emit('),');
    compiler.compile(node.val, null);
    this.emit(`, "${nodeStaticPathKey}", ${compiler.emitErrorContext(node)}, ${!!sequenceLockLookup.repair}, ${compiler.buffer.currentBuffer})`);
    return true;
  }

  _compileDynamicLookup(node) {
    const compiler = this.compiler;
    if (compiler.scriptMode) {
      this.emit('runtime.memberLookupScript((');
    } else {
      this.emit('runtime.memberLookupAsync((');
    }
    compiler.compile(node.target, null);
    this.emit('),');
    compiler.compile(node.val, null);
    this.emit(`, ${compiler.emitErrorContext(node)}, ${compiler.buffer.currentBuffer})`);
  }

  _emitThisSharedVarNestedLookup(thisSharedFacts, node) {
    const compiler = this.compiler;
    const nestedPath = thisSharedFacts.chainPath.slice(1);
    const memberLookupHelper = compiler.scriptMode ? 'memberLookupScript' : 'memberLookupAsync';

    nestedPath.forEach(() => {
      this.emit(`runtime.${memberLookupHelper}((`);
    });
    compiler.chain.emitChainObservation(thisSharedFacts.chainName, node, 'snapshot', true, true);
    nestedPath.forEach((propertyName) => {
      this.emit(`), ${JSON.stringify(propertyName)}, ${compiler.emitErrorContext(node)}, ${compiler.buffer.currentBuffer})`);
    });
  }
}

export {CompileLookup};
