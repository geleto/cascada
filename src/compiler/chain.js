
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPE_FACTS} from '../chain-types.js';
import {validateChainDeclarationNode} from './validation.js';
import {getSharedSourceName, renameSharedName} from '../inheritance/shared-names.js';

class CompileChain {
  constructor(compiler) {
    this.compiler = compiler;
  }

  emitLocalVarChainDeclaration(bufferId, name) {
    this.compiler.emit.line(`runtime.declareBufferChain(${bufferId}, "${name}", "var", context, null);`);
  }

  emitLocalVarChainInit(bufferId, name, emitValueExpression, positionNode = null) {
    this.compiler.emit(`${bufferId}.addCommand(new runtime.VarCommand({ chainName: ${JSON.stringify(name)}, args: [`);
    emitValueExpression();
    this.compiler.emit.line(`], errorContext: ${this.compiler.emitErrorContext(positionNode)} }), ${JSON.stringify(name)});`);
  }

  emitLocalVarChainBindings(bufferId, bindings) {
    bindings.forEach((binding) => {
      this.emitLocalVarChainDeclaration(bufferId, binding.name);
    });
    bindings.forEach((binding) => {
      this.emitLocalVarChainInit(
        bufferId,
        binding.name,
        binding.emitValueExpression,
        binding.positionNode
      );
      this.compiler.emit.line('');
    });
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
    const compiler = this.compiler;
    if (!node || !node.targets || node.targets.length !== 1) {
      return null;
    }
    const segments = compiler.scriptMode
      ? this._getScriptThisSharedSetPathSegments(node)
      : this._getTemplateThisSharedSetPathSegments(node);
    if (!segments || segments.length === 0) {
      return null;
    }
    const name = segments[0];
    const declaration = this._getThisSharedDeclaration(node._analysis, renameSharedName(name), analysisPass, node, 'strict');
    if (!declaration) {
      return null;
    }
    return {
      name: declaration.name,
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
    if (node.path) {
      return null;
    }
    const target = node.targets[0];
    const staticPath = compiler.sequential.extractStaticPathSegments(target);
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
        compiler.emit(`let ${resultId} = runtime.deepAssign(`);
        compiler.buffer.emitAddRawSnapshot(thisSharedPath.name, node);
        compiler.emit(`, ${JSON.stringify(thisSharedPath.path)}, ${valueId})`);
        compiler.emit.line(';');
      }
      compiler.buffer.emitAddChainCommandByType({
        chainType: 'var',
        chainName: thisSharedPath.name,
        argsExpr: `[${resultId}]`,
        positionNode: node
      });
      return;
    }

    if (thisSharedPath.type === 'data') {
      const dataPath = thisSharedPath.path.length > 0 ? thisSharedPath.path : [null];
      compiler.buffer.emitAddChainCommandByType({
        chainType: 'data',
        chainName: thisSharedPath.name,
        operation: 'set',
        argsExpr: `[${JSON.stringify(dataPath)}, ${valueId}]`,
        positionNode: node
      });
      return;
    }

    compiler.fail(
      `Chain '${thisSharedPath.name}' cannot be assigned through this.${thisSharedPath.name}.`,
      node.lineno,
      node.colno,
      node
    );
  }

  getThisSharedAccessFacts(node, analysisPass = this.compiler.analysis, analysisNode = null) {
    return this._getThisSharedAccessFacts(node, analysisPass, analysisNode, 'strict');
  }

  probeThisSharedAccessFacts(node, analysisPass = this.compiler.analysis, analysisNode = null) {
    return this._getThisSharedAccessFacts(node, analysisPass, analysisNode, 'probe');
  }

  _getThisSharedAccessFacts(node, analysisPass, analysisNode, mode) {
    const compiler = this.compiler;
    if (!node) {
      return null;
    }
    const staticPath = compiler.sequential.extractStaticPathSegments(node);
    if (!staticPath || staticPath.length < 2 || staticPath[0] !== 'this') {
      return null;
    }
    const chainName = staticPath[1];
    const activeAnalysis = analysisNode || node._analysis;
    const sharedName = renameSharedName(chainName);
    const chainDecl = compiler.inheritance.findRootSharedDeclaration(
      compiler.analysis.getRootScopeOwner(activeAnalysis),
      sharedName
    );
    const parentNode = node._analysis?.parent?.node || null;
    const isCallableRoot = staticPath.length === 2 &&
      parentNode instanceof nodes.FunCall &&
      parentNode.name === node;
    if (
      isCallableRoot &&
      (!compiler.scriptMode || !chainDecl)
    ) {
      return null;
    }
    if (
      compiler.scriptMode &&
      !chainDecl &&
      staticPath.length === 2 &&
      compiler.inheritance.hasLocalMethodDefinition(activeAnalysis, chainName)
    ) {
      return null;
    }
    const declaration = this._getThisSharedDeclaration(
      activeAnalysis,
      sharedName,
      analysisPass,
      node,
      mode
    );
    if (!declaration) {
      return null;
    }
    const chainPath = [chainName].concat(staticPath.slice(2));
    return {
      chainName: declaration.name,
      chainType: declaration.type,
      chainPath: [declaration.name].concat(staticPath.slice(2)),
      pathPrefix: chainPath.length > 2 ? chainPath.slice(1, -1) : [],
      propertyName: chainPath.length >= 2 ? chainPath[chainPath.length - 1] : null
    };
  }

  _getThisSharedDeclaration(analysis, name, analysisPass, originNode, mode) {
    const compiler = this.compiler;
    const rootAnalysis = compiler.analysis.getRootScopeOwner(analysis);
    let declaration = compiler.inheritance.findRootSharedDeclaration(rootAnalysis, name);
    let type = declaration ? declaration.type : null;
    if (!compiler.scriptMode) {
      type = type || (name === compiler.buffer.currentTextChainName ? 'text' : 'var');
      if (type !== 'var' && name !== compiler.buffer.currentTextChainName) {
        return null;
      }
      if (!declaration || !declaration.shared) {
        if (mode === 'probe') {
          return null;
        }
        declaration = compiler.inheritance.ensureImplicitTemplateSharedDeclaration(
          analysis,
          name,
          type,
          originNode
        );
      }
    }
    if (!declaration || !declaration.shared) {
      if (compiler.scriptMode && mode === 'strict') {
        const sourceName = getSharedSourceName(name);
        compiler.fail(
          `this.${sourceName} requires a root shared declaration`,
          originNode.lineno,
          originNode.colno,
          originNode
        );
      }
      return null;
    }
    return declaration;
  }

  analyzeChainDeclaration(node) {
    node.name.addAnalysis({ declarationTarget: true });
    validateChainDeclarationNode(this.compiler, node);
    const name = node.name.value;
    return {
      declares: [{
        name,
        type: node.chainType,
        initializer: node.initializer || null,
        shared: !!node.isShared
      }],
      uses: [name]
    };
  }

  compileChainDeclaration(node) {
    const compiler = this.compiler;
    const chainType = node.chainType;
    const chainFacts = CHAIN_TYPE_FACTS[chainType] || null;
    const name = node.name.value;
    const declareHelperName = node.isShared ? 'declareInheritanceSharedChain' : 'declareBufferChain';
    const targetBufferExpr = node.isShared ? 'currentInstance.sharedRootBuffer' : compiler.buffer.currentBuffer;

    compiler.emit(`runtime.${declareHelperName}(${targetBufferExpr}, "${name}", "${chainType}", context`);
    if (!node.isShared && chainFacts && chainFacts.requiresInitializer && node.initializer) {
      compiler.emit(', ');
      compiler.compile(node.initializer, null);
    } else if (node.isShared) {
      compiler.emit(`, undefined, ${compiler.emitErrorContext(node)}`);
    }
    compiler.emit.line(');');

    if (
      !node.isShared &&
      name.charAt(0) !== '_' &&
      compiler.analysis.isRootScopeOwner(node._analysis)
    ) {
      compiler.emit.line(`context.addDeferredExport("${name}", "${name}", ${targetBufferExpr});`);
    }

    this._emitChainDeclarationInitializer(node, targetBufferExpr);
  }

  _emitChainDeclarationInitializer(node, targetBufferExpr) {
    if (!node.initializer) {
      return;
    }
    const compiler = this.compiler;
    const chainType = node.chainType;
    const chainFacts = CHAIN_TYPE_FACTS[chainType] || null;
    const name = node.name.value;

    if (!node.isShared && chainFacts && chainFacts.requiresInitializer) {
      return;
    }

    const emitInitializer = () => {
      if (chainType === 'sequence') {
        compiler.emit(`runtime.declareInheritanceSharedChain(${targetBufferExpr}, "${name}", "${chainType}", context, `);
        compiler.compile(node.initializer, null);
        compiler.emit.line(`, ${compiler.emitErrorContext(node)});`);
        return;
      }

      const initNode = node.initializer;
      const initValueId = compiler._tmpid();

      compiler.emit(`let ${initValueId} = `);
      compiler.compileExpression(initNode, null, initNode);
      compiler.emit.line(';');
      compiler.buffer.emitAddChainCommandByType({
        bufferExpr: targetBufferExpr,
        chainType,
        chainName: name,
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

  analyzeChainCommand(node) {
    const compiler = this.compiler;
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = compiler.sequential.extractStaticPathSegments(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const chainName = path[0];
    const chainDecl = chainName ? compiler.analysis.markLookupDeclaration(node, chainName) : null;
    const chainType = node.chainType || (chainDecl ? chainDecl.type : null);
    const command = path.length >= 2 ? path[path.length - 1] : null;
    const isSequenceGet = !callNode && chainDecl && chainDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 &&
       (path[1] === 'isError' || path[1] === 'getError' ||
        (path[1] === 'snapshot' && (!chainDecl || chainDecl.type !== 'sequence'))));
    if (chainType === 'data' && callNode && !isObservation && callNode.args.children.length > 0) {
      this.markDataCommandPath(callNode.args.children[0]);
    }
    const result = isObservation ? { uses: [chainName] } : { uses: [chainName], mutates: [chainName] };
    result.chainCommandFacts = {
      callNode,
      chainType,
      command,
      isObservation
    };
    return result;
  }

  postAnalyzeChainCommand(node) {
    const facts = node._analysis.chainCommandFacts;
    if (!facts || facts.chainType !== 'data' || facts.isObservation) {
      return {};
    }
    if (!facts.callNode) {
      return {};
    }
    const originalArgs = facts.callNode.args.children;
    if (originalArgs.length === 0) {
      this.compiler.fail(`data command '${facts.command}' requires at least a path argument.`, node.lineno, node.colno, node);
    }
    const pathArg = originalArgs[0];
    const pathSegments = pathArg._analysis.dataPathSegments;
    if (!pathSegments) {
      this.compiler.fail(
        'Invalid node type in path for data command. Only symbols, lookups, null, or array-literals are allowed.',
        pathArg.lineno,
        pathArg.colno,
        pathArg
      );
    }

    const dataPathNode = new nodes.Array(pathArg.lineno, pathArg.colno, pathSegments);
    dataPathNode.mustResolve = true;
    return {
      dataCommandArgs: new nodes.NodeList(
        facts.callNode.args.lineno,
        facts.callNode.args.colno,
        [dataPathNode, ...originalArgs.slice(1)]
      )
    };
  }

  markDataCommandPath(node) {
    node.addAnalysis({ isDataCommandPath: true });
  }

  analyzeDataPathLookup(node) {
    if (node._analysis.isDataCommandPath) {
      this.markDataCommandPath(node.target);
    }
  }

  postAnalyzeLiteral(node) {
    return this.postAnalyzeDataPathSegment(node);
  }

  postAnalyzeArray(node) {
    return this.postAnalyzeDataPathArray(node);
  }

  postAnalyzeDataPathSegment(node) {
    if (!node._analysis.isDataCommandPath) {
      return {};
    }
    return {
      dataPathSegments: [
        node instanceof nodes.Symbol
          ? new nodes.Literal(node.lineno, node.colno, node.value)
          : node
      ]
    };
  }

  postAnalyzeDataPathArray(node) {
    if (!node._analysis.isDataCommandPath) {
      return {};
    }
    return {
      dataPathSegments: node.children
    };
  }

  postAnalyzeDataPathLookup(node) {
    if (!node._analysis.isDataCommandPath || node.target instanceof nodes.Array) {
      return {};
    }
    const targetSegments = node.target._analysis.dataPathSegments;
    if (!targetSegments) {
      return {};
    }
    const segmentNode = node.val === null
      ? new nodes.Literal(node.lineno, node.colno, '[]')
      : node.val;
    return {
      dataPathSegments: targetSegments.concat(segmentNode)
    };
  }

  compileChainCommand(node) {
    this.compiler.buffer.compileChainCommand(node);
  }

  compileSpecialChainFunCall(node) {
    const specialChainCall = node._analysis.specialChainCall;
    if (!specialChainCall) {
      return false;
    }
    if (specialChainCall.chainType === 'var') {
      return false;
    }
    if (this._compileChainObservationFunCall(node, specialChainCall)) {
      return true;
    }
    if (this._compileSequenceChainFunCall(node, specialChainCall)) {
      return true;
    }
    return this._compileSharedChainStatementFunCall(node, specialChainCall);
  }

  _compileChainObservationFunCall(node, specialChainCall) {
    const compiler = this.compiler;
    if (specialChainCall.pathPrefix.length !== 0) {
      return false;
    }
    if (specialChainCall.chainType === 'sequence' && specialChainCall.methodName === 'snapshot') {
      return false;
    }
    if (specialChainCall.methodName === 'snapshot') {
      if (specialChainCall.shared) {
        compiler.inheritance.emitSharedChainObservation(specialChainCall.chainName, node, 'snapshot');
      } else {
        compiler.buffer.emitAddSnapshot(specialChainCall.chainName, node);
      }
      return true;
    }
    if (specialChainCall.methodName === 'isError') {
      if (specialChainCall.shared) {
        compiler.inheritance.emitSharedChainObservation(specialChainCall.chainName, node, 'isError');
      } else {
        compiler.buffer.emitAddIsError(specialChainCall.chainName, node);
      }
      return true;
    }
    if (specialChainCall.methodName === 'getError') {
      if (specialChainCall.shared) {
        compiler.inheritance.emitSharedChainObservation(specialChainCall.chainName, node, 'getError');
      } else {
        compiler.buffer.emitAddGetError(specialChainCall.chainName, node);
      }
      return true;
    }
    return false;
  }

  _compileSequenceChainFunCall(node, specialChainCall) {
    const compiler = this.compiler;
    if (specialChainCall.chainType !== 'sequence') {
      return false;
    }
    compiler._compileAggregate(node.args, null, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
        specialChainCall.chainName,
        specialChainCall.methodName,
        specialChainCall.pathPrefix,
        resolvedArgs,
        node
      );
      this.emit(';');
    });
    return true;
  }

  _compileSharedChainStatementFunCall(node, specialChainCall) {
    const compiler = this.compiler;
    if (!specialChainCall.shared) {
      return false;
    }
    if (specialChainCall.chainType === 'text') {
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.TextCommand({ chainName: ${JSON.stringify(specialChainCall.chainName)}, `);
        if (specialChainCall.methodName) {
          compiler.emit(`operation: ${JSON.stringify(specialChainCall.methodName)}, `);
        }
        compiler.emit('normalizeArgs: true, args: ');
        compiler._compileAggregate(node.args, null, '[', ']', false, true);
        compiler.emit(`, errorContext: ${compiler.emitErrorContext(node)} })`);
      }, node, specialChainCall.chainName);
      return true;
    }
    if (specialChainCall.chainType === 'data') {
      if (!specialChainCall.methodName) {
        compiler.fail('Invalid data command syntax: expected this.dataChain.command(...)', node.lineno, node.colno, node);
      }
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.DataCommand({ chainName: ${JSON.stringify(specialChainCall.chainName)}, operation: ${JSON.stringify(specialChainCall.methodName)}, args: `);
        const pathArg = specialChainCall.pathPrefix && specialChainCall.pathPrefix.length > 0
          ? JSON.stringify(specialChainCall.pathPrefix)
          : 'null';
        compiler.emit(`[${pathArg}`);
        if (node.args && node.args.children && node.args.children.length > 0) {
          compiler.emit(', ');
          compiler._compileAggregate(node.args, null, '', '', false, true);
        }
        compiler.emit(']');
        compiler.emit(`, errorContext: ${compiler.emitErrorContext(node)} })`);
      }, node, specialChainCall.chainName);
      return true;
    }
    return false;
  }

}

export {CompileChain};
