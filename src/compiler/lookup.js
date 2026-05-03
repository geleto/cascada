import * as nodes from '../nodes.js';

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
    facts.explicitThisDispatchMethodName =
      compiler.inheritance.analyzeExplicitThisDispatchLookup(node);
    this._collectComponentBindingLookup(node, facts);
    this._collectScriptSequenceChannelLookup(node, analysisPass, facts);

    return facts;
  }

  compileLookupVal(node) {
    this._validateDynamicTemplateThisLookup(node);
    if (this._compileThisSharedLookup(node)) {
      return;
    }

    this.compiler.inheritance.validateBareExplicitThisDispatchLookup(node);

    if (this._compileComponentBindingLookup(node)) {
      return;
    }
    if (this._compileAnalyzedSequenceChannelLookup(node)) {
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
      sequenceChannelLookup: null,
      thisSharedAccessFacts: null,
      componentBindingRoot: null,
      componentBindingFacts: null,
      explicitThisDispatchMethodName: null
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
    const thisSharedFacts = compiler.channel.getThisSharedAccessFacts(node, analysisPass);
    if (!thisSharedFacts) {
      return false;
    }

    facts.thisSharedAccessFacts = thisSharedFacts;
    facts.uses.push(thisSharedFacts.channelName);
    if (
      compiler.scriptMode &&
      thisSharedFacts.channelType === 'sequence' &&
      thisSharedFacts.channelPath.length >= 2 &&
      thisSharedFacts.propertyName !== 'snapshot'
    ) {
      facts.sequenceChannelLookup = {
        channelName: thisSharedFacts.channelName,
        propertyName: thisSharedFacts.propertyName,
        subpath: thisSharedFacts.pathPrefix
      };
    }
    return true;
  }

  _collectComponentBindingLookup(node, facts) {
    const compiler = this.compiler;
    facts.componentBindingRoot = compiler.component.getBindingRoot(node);
    facts.componentBindingFacts = compiler.component.getBindingFacts(node);
  }

  _collectScriptSequenceChannelLookup(node, analysisPass, facts) {
    const compiler = this.compiler;
    if (!compiler.scriptMode) {
      return;
    }

    const lookupFacts = this._analyzeSequenceChannelLookup(node, analysisPass);
    if (lookupFacts) {
      facts.uses.push(lookupFacts.channelName);
      facts.sequenceChannelLookup = lookupFacts;
    }
  }

  _analyzeSequenceChannelLookup(node, analysisPass) {
    const compiler = this.compiler;
    const sequencePath = compiler.sequential._extractStaticPath(node);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const channelName = sequencePath[0];
    const channelDecl = analysisPass.findDeclaration(node._analysis, channelName);
    const propertyName = sequencePath[sequencePath.length - 1];
    if (!channelDecl || channelDecl.shared || channelDecl.type !== 'sequence' || propertyName === 'snapshot') {
      return null;
    }
    return {
      channelName,
      propertyName,
      subpath: sequencePath.slice(1, -1)
    };
  }

  _validateDynamicTemplateThisLookup(node) {
    const compiler = this.compiler;
    if (
      !compiler.scriptMode &&
      compiler.templateUsesInheritanceSurface &&
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
      compiler.channel.getThisSharedAccessFacts(node);
    if (!thisSharedFacts) {
      return false;
    }

    if (this._compileAnalyzedSequenceChannelLookup(node)) {
      return true;
    }
    if (thisSharedFacts.channelType !== 'var') {
      compiler.fail(
        `Channel '${thisSharedFacts.channelName}' cannot be used as a bare symbol. Use '${thisSharedFacts.channelName}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
    if (thisSharedFacts.channelPath.length === 1) {
      compiler.channel.emitSharedChannelObservation(thisSharedFacts.channelName, node, 'snapshot', true);
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
      compiler.component.emitChannelObservation(componentBindingFacts, node);
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

  _compileAnalyzedSequenceChannelLookup(node) {
    const compiler = this.compiler;
    const sequenceChannelLookup =
      node._analysis.sequenceChannelLookup;
    if (compiler.scriptMode && sequenceChannelLookup) {
      compiler.buffer.emitAddSequenceGet(
        sequenceChannelLookup.channelName,
        sequenceChannelLookup.propertyName,
        sequenceChannelLookup.subpath,
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
    const nestedPath = thisSharedFacts.channelPath.slice(1);
    const errorContextJson = JSON.stringify(compiler._createErrorContext(node));
    const memberLookupHelper = compiler.scriptMode ? 'memberLookupScript' : 'memberLookupAsync';

    nestedPath.forEach(() => {
      this.emit(`runtime.${memberLookupHelper}((`);
    });
    compiler.channel.emitSharedChannelObservation(thisSharedFacts.channelName, node, 'snapshot', true);
    nestedPath.forEach((propertyName) => {
      this.emit(`), ${JSON.stringify(propertyName)}, ${errorContextJson})`);
    });
  }
}

export {CompileLookup};
