'use strict';

const nodes = require('../nodes');
const { RETURN_CHANNEL_NAME } = require('../inheritance-constants');
const {
  validateChannelDeclarationNode,
  validateChannelObservationCall,
  validateSinkSnapshotInGuard
} = require('./validation');
const CHANNEL_COMMAND_CLASS = {
  data: 'DataCommand',
  sink: 'SinkCommand',
  sequence: 'SequenceCallCommand',
  text: 'TextCommand',
  var: 'VarCommand'
};

class CompileChannel {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  analyzeChannelDeclaration(node) {
    // Script syntax normally rejects nested `shared` declarations earlier in the
    // transpiler. Keep this compiler-side guard as defense-in-depth for any
    // non-script/frontend path that can still construct shared declarations.
    if (node.isShared && !this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.compiler.fail(
        'shared declarations are only allowed at the root scope',
        node.lineno,
        node.colno,
        node
      );
    }
    node.name._analysis = { declarationTarget: true };
    const name = node.name.value;
    return {
      declares: [{ name, type: node.channelType, initializer: node.initializer || null, shared: !!node.isShared }],
      uses: [name]
    };
  }

  compileChannelDeclaration(node) {
    const channelType = node.channelType;
    const nameNode = node.name;
    validateChannelDeclarationNode(this.compiler, {
      node,
      nameNode,
      channelType,
      hasInitializer: !!node.initializer,
      isShared: !!node.isShared,
      asyncMode: this.compiler.asyncMode,
      scriptMode: this.compiler.scriptMode,
      isNameSymbol: nameNode instanceof nodes.Symbol
    });
    const name = nameNode.value;
    const declarationHelper = node.isShared ? 'declareSharedBufferChannel' : 'declareBufferChannel';

    this.emit(`runtime.${declarationHelper}(${this.compiler.buffer.currentBuffer}, "${name}", "${channelType}", context, `);
    if ((channelType === 'sink' || channelType === 'sequence') && node.initializer) {
      this.compiler.compile(node.initializer, null);
    } else {
      this.emit('null');
    }
    this.emit.line(');');

    if (channelType === 'var' && node.initializer) {
      const initNode = node.initializer;
      const lineno = initNode.lineno !== undefined ? initNode.lineno : node.lineno;
      const colno = initNode.colno !== undefined ? initNode.colno : node.colno;
      const initValueId = this.compiler._tmpid();
      this.emit(`let ${initValueId} = `);
      this.compiler.compileExpression(initNode, null, initNode);
      this.emit.line(';');
      const initIfNotSet = node.isShared ? 'true' : 'false';
      this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${initValueId}], initializeIfNotSet: ${initIfNotSet}, pos: {lineno: ${lineno}, colno: ${colno}} }), '${name}');`);
      return;
    }

    if ((channelType === 'text' || channelType === 'data') && node.initializer) {
      const initNode = node.initializer;
      const lineno = initNode.lineno !== undefined ? initNode.lineno : node.lineno;
      const colno = initNode.colno !== undefined ? initNode.colno : node.colno;
      const initValueId = this.compiler._tmpid();
      this.emit(`let ${initValueId} = `);
      this.compiler.compileExpression(initNode, null, initNode);
      this.emit.line(';');

      if (channelType === 'text') {
        this.emit.line(
          `${this.compiler.buffer.currentBuffer}.add(` +
          `new runtime.TextCommand({ channelName: '${name}', command: 'set', args: [${initValueId}], normalizeArgs: true, pos: {lineno: ${lineno}, colno: ${colno}} }), ` +
          `'${name}'` +
          ');'
        );
        return;
      }

      this.emit.line(
        `${this.compiler.buffer.currentBuffer}.add(` +
        `new runtime.DataCommand({ channelName: '${name}', command: 'set', args: [null, ${initValueId}], pos: {lineno: ${lineno}, colno: ${colno}} }), ` +
        `'${name}'` +
        ');'
      );
    }
  }

  analyzeChannelCommand(node) {
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = this.compiler.sequential._extractStaticPath(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const channelName = path[0];
    const channelDecl = channelName ? this.compiler.analysis.findDeclaration(node._analysis, channelName) : null;
    const isSequenceGet = !callNode && channelDecl && channelDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 &&
       (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError'));
    return isObservation ? { uses: [channelName] } : { uses: [channelName], mutates: [channelName] };
  }

  compileSpecialChannelFunCall(node) {
    if (!this.compiler.scriptMode) {
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
    return this._compileSequenceChannelFunCall(node, specialChannelCall);
  }

  _compileChannelObservationFunCall(node, specialChannelCall) {
    if (specialChannelCall.subpath.length !== 0) {
      return false;
    }
    validateSinkSnapshotInGuard(this.compiler, {
      node,
      command: specialChannelCall.methodName,
      channelType: specialChannelCall.channelType
    });
    if (specialChannelCall.methodName === 'snapshot') {
      this.compiler.buffer.emitAddSnapshot(specialChannelCall.channelName, node);
      return true;
    }
    if (specialChannelCall.methodName === 'isError') {
      this.compiler.buffer.emitAddIsError(specialChannelCall.channelName, node);
      return true;
    }
    if (specialChannelCall.methodName === 'getError') {
      this.compiler.buffer.emitAddGetError(specialChannelCall.channelName, node);
      return true;
    }
    return false;
  }

  _compileSequenceChannelFunCall(node, specialChannelCall) {
    if (specialChannelCall.channelType !== 'sequence' || specialChannelCall.methodName === 'snapshot') {
      return false;
    }
    this.compiler._compileAggregate(node.args, null, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
        specialChannelCall.channelName,
        specialChannelCall.methodName,
        specialChannelCall.subpath,
        resolvedArgs,
        node
      );
      this.emit(';');
    });
    return true;
  }

  _emitPositionLiteral(positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `{lineno: ${lineno}, colno: ${colno}}`;
  }

  emitChannelCommandConstruction(node) {
    const isCallNode = node.call instanceof nodes.FunCall;
    const staticPath = this.compiler.sequential._extractStaticPath(isCallNode ? node.call.name : node.call);
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is channel(...) or channel.command(...) or channel.subpath.command(...).',
        node.lineno,
        node.colno,
        node
      );
    }

    const channelName = staticPath[0];
    const channelDecl = this.compiler.analysis.findDeclaration(node._analysis, channelName);
    const channelType = node.channelType || (channelDecl ? channelDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;
    const isObservationCall = isCallNode &&
      !subpath &&
      (command === 'snapshot' || command === 'isError' || command === 'getError');

    if (isObservationCall) {
      validateChannelObservationCall(this.compiler, { node, command, channelName, channelType });
      if (command === 'snapshot') {
        this.emit(`new runtime.SnapshotCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      if (command === 'isError') {
        this.emit(`new runtime.IsErrorCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      this.emit(`new runtime.GetErrorCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    if (channelType === 'sequence') {
      if (isCallNode) {
        if (!command) {
          this.compiler.fail('Invalid sequence command syntax: expected sequenceChannel.method(...)', node.lineno, node.colno, node);
        }
        this.emit(`new runtime.SequenceCallCommand({ channelName: '${channelName}', command: '${command}', `);
        if (subpath && subpath.length > 0) {
          this.emit(`subpath: ${JSON.stringify(subpath)}, `);
        }
        this.emit('args: ');
        this.compiler._compileAggregate(node.call.args, null, '[', ']', false, true);
        this.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }

      if (!command) {
        this.compiler.fail('Invalid sequence read syntax: expected sequenceChannel.path', node.lineno, node.colno, node);
      }
      this.emit(`new runtime.SequenceGetCommand({ channelName: '${channelName}', command: '${command}', `);
      if (subpath && subpath.length > 0) {
        this.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }
      this.emit(`pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    const commandClass = CHANNEL_COMMAND_CLASS[channelType];
    if (!commandClass) {
      this.compiler.fail(
        `Compiler error: analysis did not resolve a declared channel target for '${channelName}'.`,
        node.lineno,
        node.colno,
        node
      );
    }
    this.emit(`new runtime.${commandClass}({ channelName: '${channelName}', `);
    if (command) {
      this.emit(`command: '${command}', `);
    }
    if (channelType === 'text') {
      this.emit('normalizeArgs: true, ');
    }
    if (channelType === 'sink' && subpath && subpath.length > 0) {
      this.emit(`subpath: ${JSON.stringify(subpath)}, `);
    }
    let argList = node.call.args;
    if (channelType === 'data') {
      const originalArgs = node.call.args.children;
      if (originalArgs.length === 0) {
        this.compiler.fail(`data command '${command}' requires at least a path argument.`, node.lineno, node.colno, node);
      }

      const pathArg = originalArgs[0];
      const pathNodeList = this.compiler._flattenPathToNodeList(pathArg);
      const dataPathNode = new nodes.Array(pathArg.lineno, pathArg.colno, pathNodeList.children);
      dataPathNode.mustResolve = true;
      const newArgs = [dataPathNode, ...originalArgs.slice(1)];

      argList = new nodes.NodeList(node.call.args.lineno, node.call.args.colno, newArgs);
    }

    this.emit('args: ');
    // Channel commands are constructed with unresolved args; resolution/normalization
    // happens once in runtime right before command.apply().
    this.compiler._compileAggregate(argList, null, '[', ']', false, true);
    this.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
  }

  compileChannelCommand(node) {
    const pathNode = node.call instanceof nodes.FunCall ? node.call.name : node.call;
    const channelName = this.compiler.sequential._extractStaticPathRoot(pathNode);

    this.compiler.buffer.asyncAddValueToBuffer((resultVar) => {
      this.emit(`${resultVar} = `);
      this.emitChannelCommandConstruction(node);
    }, node, channelName);
  }

  emitDeclareReturnChannel(bufferExpr) {
    this.emit.line(
      `runtime.declareBufferChannel(${bufferExpr}, "${RETURN_CHANNEL_NAME}", "var", context, runtime.RETURN_UNSET);`
    );
  }

  emitReturnChannelSnapshot(bufferExpr, positionNode, resultVar, markFinished = true) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    this.emit.line(
      `const ${resultVar}_snapshot = ${bufferExpr}.addSnapshot("${RETURN_CHANNEL_NAME}", {lineno: ${lineno}, colno: ${colno}});`
    );
    if (markFinished) {
      this.emit.line(`${bufferExpr}.markFinishedAndPatchLinks();`);
    }
    this.emit.line(`let ${resultVar} = ${resultVar}_snapshot.then((value) => value === runtime.RETURN_UNSET ? undefined : value);`);
  }

  collectSharedChannelSchema(node) {
    const sharedSchema = [];
    const seenNames = new Set();
    (node.children || []).forEach((child) => {
      if (!(child instanceof nodes.ChannelDeclaration) ||
        !child.isShared ||
        !(child.name instanceof nodes.Symbol) ||
        seenNames.has(child.name.value)) {
        return;
      }
      seenNames.add(child.name.value);
      sharedSchema.push({
        name: child.name.value,
        type: child.channelType
      });
    });
    return sharedSchema;
  }
}

module.exports = CompileChannel;
