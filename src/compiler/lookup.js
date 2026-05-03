import * as nodes from '../nodes.js';

class CompileLookup {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeLookupVal(node, analysisPass) {
    const compiler = this.compiler;
    const uses = [];
    const mutates = [];
    let sequenceChannelLookup = null;
    let thisSharedAccessFacts = null;
    let componentBindingRoot = null;
    let componentBindingFacts = null;
    const sequenceLockLookup = compiler.sequential.getSequenceLockLookup(node);
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key, analysisPass);
      uses.push(sequenceLockLookup.key);
      if (sequenceLockLookup.repair) {
        mutates.push(sequenceLockLookup.key);
      }
    }

    const thisSharedFacts = compiler.channel.getThisSharedAccessFacts(node, analysisPass);
    if (thisSharedFacts) {
      thisSharedAccessFacts = thisSharedFacts;
      uses.push(thisSharedFacts.channelName);
      if (
        compiler.scriptMode &&
        thisSharedFacts.channelType === 'sequence' &&
        thisSharedFacts.channelPath.length >= 2 &&
        thisSharedFacts.propertyName !== 'snapshot'
      ) {
        sequenceChannelLookup = {
          channelName: thisSharedFacts.channelName,
          propertyName: thisSharedFacts.propertyName,
          subpath: thisSharedFacts.pathPrefix
        };
      }
      return { uses, mutates, sequenceChannelLookup, thisSharedAccessFacts };
    }

    const explicitThisDispatchMethodName =
      compiler.inheritance.analyzeExplicitThisDispatchLookup(node);

    componentBindingRoot = compiler.component.getBindingRoot(node);
    componentBindingFacts = compiler.component.getBindingFacts(node);

    if (compiler.scriptMode) {
      const sequencePath = compiler.sequential._extractStaticPath(node);
      const lookupFacts =
        sequencePath && sequencePath.length >= 2
          ? (() => {
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
          })()
          : null;
      if (lookupFacts) {
        uses.push(lookupFacts.channelName);
        sequenceChannelLookup = lookupFacts;
      }
    }

    return {
      uses,
      mutates,
      sequenceChannelLookup,
      thisSharedAccessFacts,
      componentBindingRoot,
      componentBindingFacts,
      explicitThisDispatchMethodName
    };
  }

  compileLookupVal(node) {
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
    const thisSharedFacts =
      node._analysis.thisSharedAccessFacts ||
      compiler.channel.getThisSharedAccessFacts(node);
    if (thisSharedFacts) {
      const sequenceChannelLookup =
        node._analysis.sequenceChannelLookup;
      if (compiler.scriptMode && sequenceChannelLookup) {
        compiler.buffer.emitAddSequenceGet(
          sequenceChannelLookup.channelName,
          sequenceChannelLookup.propertyName,
          sequenceChannelLookup.subpath,
          node
        );
        return;
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
        return;
      }
      this._emitThisSharedVarNestedLookup(thisSharedFacts, node);
      return;
    }

    compiler.inheritance.validateBareExplicitThisDispatchLookup(node);

    const componentBindingRoot =
      node._analysis.componentBindingRoot ||
      compiler.component.getBindingRoot(node);
    const componentBindingFacts =
      node._analysis.componentBindingFacts ||
      compiler.component.getBindingFacts(node);
    if (componentBindingFacts && componentBindingFacts.kind === 'shared-read') {
      compiler.component.emitChannelObservation(componentBindingFacts, node);
      return;
    }
    if (componentBindingRoot && componentBindingRoot.staticPath.length > 2) {
      compiler.component.emitSharedVarNestedLookup(componentBindingRoot, node);
      return;
    }
    if (componentBindingRoot) {
      compiler.component.failUnsupportedUsage(
        node,
        componentBindingRoot.bindingName,
        '`ns.x` / `ns.x.y` shared-var reads, `ns.x.snapshot()` observations, `ns.x is error`, `ns.x#`, and `ns.method(...)` calls'
      );
    }

    const sequenceChannelLookup =
      node._analysis.sequenceChannelLookup;
    if (compiler.scriptMode && sequenceChannelLookup) {
      compiler.buffer.emitAddSequenceGet(
        sequenceChannelLookup.channelName,
        sequenceChannelLookup.propertyName,
        sequenceChannelLookup.subpath,
        node
      );
      return;
    }

    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (nodeStaticPathKey) {
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
      return;
    }

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
