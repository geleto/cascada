'use strict';

const nodes = require('../nodes');
const {
  CHANNEL_TYPE_FACTS
} = require('../channel-types');
const {
  validateChannelDeclarationNode,
  validateSinkSnapshotInGuard
} = require('./validation');

class CompileChannel {
  constructor(compiler) {
    this.compiler = compiler;
  }

  getStaticLiteralPathSegments(pathNode) {
    if (!pathNode || !(pathNode instanceof nodes.Array) || !Array.isArray(pathNode.children)) {
      return null;
    }
    const segments = [];
    for (let i = 0; i < pathNode.children.length; i++) {
      const child = pathNode.children[i];
      if (!(child instanceof nodes.Literal)) {
        return null;
      }
      segments.push(child.value);
    }
    return segments;
  }

  getThisSharedSetPathFacts(node, analysisPass = this.compiler.analysis) {
    if (!node || !node.targets || node.targets.length !== 1) {
      return null;
    }
    const segments = this.compiler.scriptMode
      ? this._getScriptThisSharedSetPathSegments(node)
      : this._getTemplateThisSharedSetPathSegments(node);
    if (!segments || segments.length === 0) {
      return null;
    }
    const name = segments[0];
    const declaration = analysisPass.findDeclaration(node._analysis, name);
    if (!declaration || !declaration.shared) {
      return null;
    }
    return {
      name,
      type: declaration.type,
      path: segments.slice(1)
    };
  }

  _getScriptThisSharedSetPathSegments(node) {
    if (!node.path) {
      return null;
    }
    const target = node.targets[0];
    if (!(target instanceof nodes.Symbol) || target.value !== 'this') {
      return null;
    }
    return this.getStaticLiteralPathSegments(node.path);
  }

  _getTemplateThisSharedSetPathSegments(node) {
    const compiler = this.compiler;
    // Template set targets carry the full `this.x.y` path in the target
    // LookupVal; script-mode set_path uses node.path and is handled separately.
    if (compiler.scriptMode || node.path) {
      return null;
    }
    const target = node.targets[0];
    const staticPath = compiler.sequential._extractStaticPath(target);
    if (!staticPath || staticPath.length < 2 || staticPath[0] !== 'this') {
      return null;
    }
    return staticPath.slice(1);
  }

  compileThisSharedSetPath(node, thisSharedPath) {
    const compiler = this.compiler;
    if (node.body) {
      compiler.fail('this.<shared> assignment does not support set blocks.', node.lineno, node.colno, node);
    }
    if (!node.value) {
      compiler.fail('this.<shared> assignment requires a value.', node.lineno, node.colno, node);
    }

    const valueId = compiler._tmpid();
    compiler.emit(`let ${valueId} = `);
    compiler.compileExpression(node.value, null, node.value);
    compiler.emit.line(';');

    if (thisSharedPath.type === 'var') {
      let resultId = valueId;
      if (thisSharedPath.path.length > 0) {
        resultId = compiler._tmpid();
        compiler.emit(`let ${resultId} = runtime.setPath(`);
        compiler.buffer.emitAddRawSnapshot(thisSharedPath.name, node);
        compiler.emit(`, ${JSON.stringify(thisSharedPath.path)}, ${valueId})`);
        compiler.emit.line(';');
      }
      compiler.buffer.emitAddChannelCommandByType({
        channelType: 'var',
        channelName: thisSharedPath.name,
        argsExpr: `[${resultId}]`,
        positionNode: node
      });
      return;
    }

    if (thisSharedPath.type === 'data') {
      const dataPath = thisSharedPath.path.length > 0 ? thisSharedPath.path : [null];
      compiler.buffer.emitAddChannelCommandByType({
        channelType: 'data',
        channelName: thisSharedPath.name,
        command: 'set',
        argsExpr: `[${JSON.stringify(dataPath)}, ${valueId}]`,
        positionNode: node
      });
      return;
    }

    compiler.fail(
      `Channel '${thisSharedPath.name}' cannot be assigned through this.${thisSharedPath.name}.`,
      node.lineno,
      node.colno,
      node
    );
  }

  getThisSharedAccessFacts(node, analysisPass = this.compiler.analysis, analysisNode = null) {
    const compiler = this.compiler;
    if (!node) {
      return null;
    }
    const staticPath = compiler.sequential._extractStaticPath(node);
    if (!staticPath || staticPath.length < 2 || staticPath[0] !== 'this') {
      return null;
    }
    const channelName = staticPath[1];
    const channelDecl = analysisPass.findDeclaration(analysisNode || node._analysis, channelName);
    if (!channelDecl || !channelDecl.shared) {
      return null;
    }
    if (!compiler.scriptMode && channelDecl.type !== 'var') {
      return null;
    }
    const channelPath = [channelName].concat(staticPath.slice(2));
    return {
      channelName,
      channelType: channelDecl.type,
      channelPath,
      pathPrefix: channelPath.length > 2 ? channelPath.slice(1, -1) : [],
      propertyName: channelPath.length >= 2 ? channelPath[channelPath.length - 1] : null
    };
  }

  analyzeChannelDeclaration(node) {
    node.name._analysis = { declarationTarget: true };
    validateChannelDeclarationNode(this.compiler, node);
    const name = node.name.value;
    return {
      declares: [{ name, type: node.channelType, initializer: node.initializer || null, shared: !!node.isShared }],
      uses: [name]
    };
  }

  compileChannelDeclaration(node) {
    const compiler = this.compiler;
    const channelType = node.channelType;
    const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
    const name = node.name.value;
    const declareHelperName = node.isShared ? 'declareInheritanceSharedChannel' : 'declareBufferChannel';
    const targetBufferExpr = node.isShared
      ? `runtime.getInheritanceSharedBuffer(${compiler.buffer.currentBuffer}, inheritanceState)`
      : compiler.buffer.currentBuffer;

    compiler.emit(`runtime.${declareHelperName}(${targetBufferExpr}, "${name}", "${channelType}", context`);
    if (!node.isShared && channelFacts && channelFacts.requiresInitializer && node.initializer) {
      compiler.emit(', ');
      compiler.compile(node.initializer, null);
    }
    compiler.emit.line(');');

    this._emitChannelDeclarationInitializer(node, targetBufferExpr);
  }

  _emitChannelDeclarationInitializer(node, targetBufferExpr) {
    if (!node.initializer) {
      return;
    }
    const compiler = this.compiler;
    const channelType = node.channelType;
    const channelFacts = CHANNEL_TYPE_FACTS[channelType] || null;
    const name = node.name.value;

    if (!node.isShared && channelFacts && channelFacts.requiresInitializer) {
      return;
    }

    const emitInitializer = () => {
      if (channelFacts && channelFacts.usesInitializerAsTarget) {
        compiler.emit(`runtime.initializeInheritanceSharedChannelDefault(${targetBufferExpr}, "${name}", "${channelType}", context, `);
        compiler.compile(node.initializer, null);
        compiler.emit.line(');');
        return;
      }

      const initNode = node.initializer;
      const initValueId = compiler._tmpid();

      compiler.emit(`let ${initValueId} = `);
      compiler.compileExpression(initNode, null, initNode);
      compiler.emit.line(';');
      compiler.buffer.emitAddChannelCommandByType({
        bufferExpr: targetBufferExpr,
        channelType,
        channelName: name,
        valueExpr: initValueId,
        positionNode: initNode,
        initializeIfNotSet: !!node.isShared
      });
    };

    if (!node.isShared) {
      emitInitializer();
      return;
    }

    compiler.emit.line(`if (runtime.claimInheritanceSharedDefault(${targetBufferExpr}, "${name}")) {`);
    emitInitializer();
    compiler.emit.line('}');
  }

  analyzeChannelCommand(node) {
    const compiler = this.compiler;
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = compiler.sequential._extractStaticPath(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const channelName = path[0];
    const channelDecl = channelName ? compiler.analysis.findDeclaration(node._analysis, channelName) : null;
    const isSequenceGet = !callNode && channelDecl && channelDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 &&
       (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError'));
    return isObservation ? { uses: [channelName] } : { uses: [channelName], mutates: [channelName] };
  }

  compileChannelCommand(node) {
    this.compiler.buffer.compileChannelCommand(node);
  }

  compileSpecialChannelFunCall(node) {
    const compiler = this.compiler;
    if (!compiler.scriptMode) {
      return false;
    }
    const specialChannelCall = node._analysis && node._analysis.specialChannelCall;
    if (!specialChannelCall) {
      return false;
    }
    if (specialChannelCall.channelType === 'var') {
      return false;
    }
    if (this._compileChannelObservationFunCall(node, specialChannelCall)) {
      return true;
    }
    if (this._compileSequenceChannelFunCall(node, specialChannelCall)) {
      return true;
    }
    return this._compileSharedChannelStatementFunCall(node, specialChannelCall);
  }

  _compileChannelObservationFunCall(node, specialChannelCall) {
    const compiler = this.compiler;
    if (specialChannelCall.pathPrefix.length !== 0) {
      return false;
    }
    validateSinkSnapshotInGuard(compiler, {
      node,
      command: specialChannelCall.methodName,
      channelType: specialChannelCall.channelType
    });
    if (specialChannelCall.methodName === 'snapshot') {
      if (specialChannelCall.shared) {
        this.emitSharedChannelObservation(specialChannelCall.channelName, node, 'snapshot');
      } else {
        compiler.buffer.emitAddSnapshot(specialChannelCall.channelName, node);
      }
      return true;
    }
    if (specialChannelCall.methodName === 'isError') {
      if (specialChannelCall.shared) {
        this.emitSharedChannelObservation(specialChannelCall.channelName, node, 'isError');
      } else {
        compiler.buffer.emitAddIsError(specialChannelCall.channelName, node);
      }
      return true;
    }
    if (specialChannelCall.methodName === 'getError') {
      if (specialChannelCall.shared) {
        this.emitSharedChannelObservation(specialChannelCall.channelName, node, 'getError');
      } else {
        compiler.buffer.emitAddGetError(specialChannelCall.channelName, node);
      }
      return true;
    }
    return false;
  }

  _emitInheritanceStateReference() {
    return '(typeof inheritanceState === "undefined" ? null : inheritanceState)';
  }

  emitSharedChannelObservation(channelName, node, mode = 'snapshot', implicitVarRead = false) {
    const compiler = this.compiler;
    compiler.emit(
      `runtime.observeInheritanceSharedChannel(${JSON.stringify(channelName)}, ${compiler.buffer.currentBuffer}, ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(compiler._generateErrorContext(node))}, path: context.path }, ` +
      `${this._emitInheritanceStateReference()}, ${JSON.stringify(mode)}, ${implicitVarRead})`
    );
  }

  _compileSequenceChannelFunCall(node, specialChannelCall) {
    const compiler = this.compiler;
    if (specialChannelCall.channelType !== 'sequence' || specialChannelCall.methodName === 'snapshot') {
      return false;
    }
    compiler._compileAggregate(node.args, null, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
        specialChannelCall.channelName,
        specialChannelCall.methodName,
        specialChannelCall.pathPrefix,
        resolvedArgs,
        node
      );
      this.emit(';');
    });
    return true;
  }

  _compileSharedChannelStatementFunCall(node, specialChannelCall) {
    const compiler = this.compiler;
    if (!specialChannelCall.shared) {
      return false;
    }
    if (specialChannelCall.channelType === 'text') {
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.TextCommand({ channelName: ${JSON.stringify(specialChannelCall.channelName)}, `);
        if (specialChannelCall.methodName) {
          compiler.emit(`command: ${JSON.stringify(specialChannelCall.methodName)}, `);
        }
        compiler.emit('normalizeArgs: true, args: ');
        compiler._compileAggregate(node.args, null, '[', ']', false, true);
        compiler.emit(`, pos: ${compiler.buffer._emitPositionLiteral(node)} })`);
      }, node, specialChannelCall.channelName);
      return true;
    }
    if (specialChannelCall.channelType === 'data') {
      if (!specialChannelCall.methodName) {
        compiler.fail('Invalid data command syntax: expected this.dataChannel.command(...)', node.lineno, node.colno, node);
      }
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.DataCommand({ channelName: ${JSON.stringify(specialChannelCall.channelName)}, command: ${JSON.stringify(specialChannelCall.methodName)}, args: `);
        const pathArg = specialChannelCall.pathPrefix && specialChannelCall.pathPrefix.length > 0
          ? JSON.stringify(specialChannelCall.pathPrefix)
          : 'null';
        compiler.emit(`[${pathArg}`);
        if (node.args && node.args.children && node.args.children.length > 0) {
          compiler.emit(', ');
          compiler._compileAggregate(node.args, null, '', '', false, true);
        }
        compiler.emit(']');
        compiler.emit(`, pos: ${compiler.buffer._emitPositionLiteral(node)} })`);
      }, node, specialChannelCall.channelName);
      return true;
    }
    if (specialChannelCall.channelType === 'sink') {
      if (!specialChannelCall.methodName) {
        compiler.fail('Invalid sink command syntax: expected this.sinkChannel.method(...)', node.lineno, node.colno, node);
      }
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.SinkCommand({ channelName: ${JSON.stringify(specialChannelCall.channelName)}, command: ${JSON.stringify(specialChannelCall.methodName)}, `);
        if (specialChannelCall.pathPrefix && specialChannelCall.pathPrefix.length > 0) {
          compiler.emit(`subpath: ${JSON.stringify(specialChannelCall.pathPrefix)}, `);
        }
        compiler.emit('args: ');
        compiler._compileAggregate(node.args, null, '[', ']', false, true);
        compiler.emit(`, pos: ${compiler.buffer._emitPositionLiteral(node)} })`);
      }, node, specialChannelCall.channelName);
      return true;
    }
    return false;
  }
}

module.exports = CompileChannel;
