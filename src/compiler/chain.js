
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPE_FACTS} from '../chain-types.js';
import {validateChainDeclarationNode} from './validation.js';
import {getSharedSourceName, renameSharedName} from '../inheritance/shared-names.js';
import {isStoredDirectly} from './declarations.js';

const OWN_FACTS_OBSERVED_CHAINS = 0;
const OWN_FACTS_MUTATED_CHAINS = 1;

class CompileChain {
  constructor(compiler) {
    this.compiler = compiler;
  }

  getCommandBufferLinkedFacts(node) {
    const analysis = node._analysis;
    return compactChainFactGroups([
      chainSetToArray(analysis.boundaryLinkedObservedChains),
      chainSetToArray(analysis.boundaryLinkedMutatedChains)
    ]);
  }

  getCommandBufferOwnFacts(node, extraMutatedChains = null, extraObservedChains = null) {
    const analysis = node._analysis;
    const observedChains = new Set(analysis.observedChains || []);
    const mutatedChains = new Set(analysis.mutatedChains || []);
    this._addInlineChildCommandFacts(analysis, observedChains, mutatedChains);
    let facts = compactChainFactGroups([
      Array.from(observedChains),
      Array.from(mutatedChains)
    ]);
    facts = addChainFactGroupNames(facts, OWN_FACTS_OBSERVED_CHAINS, extraObservedChains);
    return addChainFactGroupNames(facts, OWN_FACTS_MUTATED_CHAINS, extraMutatedChains);
  }

  _addInlineChildCommandFacts(analysis, observedChains, mutatedChains) {
    analysis.node.fields.forEach((field) => {
      this._addInlineCommandFactsFromValue(
        analysis.node[field],
        observedChains,
        mutatedChains
      );
    });
  }

  _addInlineCommandFactsFromValue(value, observedChains, mutatedChains) {
    if (Array.isArray(value)) {
      value.forEach((child) => this._addInlineCommandFactsFromValue(
        child,
        observedChains,
        mutatedChains
      ));
      return;
    }
    if (!(value instanceof nodes.Node)) {
      return;
    }
    const analysis = value._analysis;
    if (analysis.createsLinkedChildBuffer) {
      return;
    }
    if (analysis.observedChains) {
      analysis.observedChains.forEach((name) => {
        observedChains.add(name);
      });
    }
    if (analysis.mutatedChains) {
      analysis.mutatedChains.forEach((name) => {
        mutatedChains.add(name);
      });
    }
    this._addInlineChildCommandFacts(analysis, observedChains, mutatedChains);
  }

  getCommandBufferFacts(node, extraOwnMutatedChains = null, extraOwnObservedChains = null) {
    return {
      linkedFacts: this.getCommandBufferLinkedFacts(node) || [],
      ownFacts: this.getCommandBufferOwnFacts(node, extraOwnMutatedChains, extraOwnObservedChains) || []
    };
  }

  getCommandBufferFactsArgs(node, extraOwnMutatedChains = null, extraOwnObservedChains = null) {
    const facts = this.getCommandBufferFacts(node, extraOwnMutatedChains, extraOwnObservedChains);
    return {
      linkedFactsArg: JSON.stringify(facts.linkedFacts),
      ownFactsArg: JSON.stringify(facts.ownFacts)
    };
  }

  emitLocalVarChainBinding(bufferId, binding) {
    this.compiler.emit(`runtime.declareBufferChain(${bufferId}, ${JSON.stringify(binding.name)}, "var", context, `);
    binding.emitInitializerExpression();
    this.compiler.emit.line(');');
  }

  emitLocalVarBindings(bufferId, bindings, declarations) {
    bindings.forEach((binding) => {
      const declaration = binding.declaration ||
        declarations?.get(binding.name) ||
        null;
      if (isStoredDirectly(declaration)) {
        this.emitDirectLocalVarBinding(binding, declaration);
        return;
      }
      this.emitLocalVarChainBinding(bufferId, binding);
    });
  }

  emitDirectLocalVarBinding(binding, declaration) {
    if (declaration.jsVar === binding.initializerJsVarName) {
      this.compiler.emit.line(`${declaration.jsVar} = runtime.normalizeVarValue(${declaration.jsVar});`);
      return;
    }

    if (binding.reservedJsVarName === declaration.jsVar) {
      declaration.jsVar = this.compiler._tmpid();
    }
    this.compiler.emit(`const ${declaration.jsVar} = runtime.normalizeVarValue(`);
    binding.emitInitializerExpression();
    this.compiler.emit.line(');');
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

  analyzeThisSharedAssignment(node) {
    const target = this._getThisSharedAssignmentTarget(node);
    if (!target) {
      return null;
    }
    let declaration = node._analysis.visibleDeclarations?.get(target.sharedName) || null;
    let declareInRootOnEnter = null;
    if (!declaration && !this.compiler.scriptMode) {
      // Template this.<name> first use is inferred as a root declaration fact;
      // the generic declaration publisher installs it from declareInRootOnEnter.
      declaration = this._createImplicitTemplateSharedDeclaration(target.sharedName);
      declareInRootOnEnter = [declaration];
    }
    const facts = {
      name: target.sharedName,
      type: declaration ? declaration.type : null,
      path: target.path,
      ...(declareInRootOnEnter ? { declareInRootOnEnter } : {})
    };
    return facts;
  }

  _getThisSharedAssignmentTarget(node) {
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
    const sharedName = renameSharedName(name);
    return {
      sharedName,
      path: segments.slice(1)
    };
  }

  analyzeThisSharedAccess(node, analysisNode = null) {
    const access = this._getThisSharedAccess(node, analysisNode);
    if (!access) {
      return null;
    }
    const visibleDeclaration = access.analysis.visibleDeclarations?.get(access.sharedName) || null;
    let declaration = visibleDeclaration;
    let declareInRootOnEnter = null;
    if (!declaration && !this.compiler.scriptMode) {
      // Template this.<name> first use is inferred as a root declaration fact;
      // the generic declaration publisher installs it from declareInRootOnEnter.
      declaration = this._createImplicitTemplateSharedDeclaration(access.sharedName);
      declareInRootOnEnter = [declaration];
    }
    const facts = this._createThisSharedAccessFacts(access, declaration);
    if (declareInRootOnEnter) {
      facts.declareInRootOnEnter = declareInRootOnEnter;
    }
    return facts;
  }

  _createImplicitTemplateSharedDeclaration(name) {
    return {
      name,
      type: getSharedSourceName(name) === this.compiler.buffer.currentTextChainName ? 'text' : 'var',
      initializer: null,
      shared: true,
      explicit: false,
      implicitTemplateShared: true
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

  compileThisSharedAssignment(node, assignment) {
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

    if (assignment.type === 'var') {
      let resultId = valueId;
      if (assignment.path.length > 0) {
        resultId = compiler._tmpid();
        compiler.emit(`let ${resultId} = runtime.deepAssign(`);
        compiler.buffer.emitAddRawSnapshot(assignment.name, node);
        compiler.emit(`, ${JSON.stringify(assignment.path)}, ${valueId})`);
        compiler.emit.line(';');
      }
      compiler.buffer.emitAddChainCommandByType({
        chainType: 'var',
        chainName: assignment.name,
        argsExpr: `[${resultId}]`,
        positionNode: node
      });
      return;
    }

    if (assignment.type === 'data') {
      const dataPath = assignment.path.length > 0 ? assignment.path : [null];
      compiler.buffer.emitAddChainCommandByType({
        chainType: 'data',
        chainName: assignment.name,
        operation: 'set',
        argsExpr: `[${JSON.stringify(dataPath)}, ${valueId}]`,
        positionNode: node
      });
      return;
    }

    compiler.fail(
      `Chain '${assignment.name}' cannot be assigned through this.${assignment.name}.`,
      node.lineno,
      node.colno,
      node
    );
  }

  // Some compound expressions are already classified by a higher-level
  // analyzer as exactly one chain/component lane effect. Suppress ordinary
  // per-segment lookup facts on the static target path so the path root is not
  // double-counted as an observation. Dynamic lookup keys remain ordinary
  // expression inputs and must keep their own analysis facts.
  markOperationOwnedPath(node) {
    node.addAnalysis({ operationOwnedPath: true });
    if (node instanceof nodes.FunCall) {
      this.markOperationOwnedPath(node.name);
      return;
    }
    if (node instanceof nodes.LookupVal) {
      this.markOperationOwnedPath(node.target);
    }
  }

  findThisSharedAccessFacts(node, analysisNode = null) {
    // Read-only classification for disambiguation and compile fallbacks. This
    // never creates implicit declarations or reports missing script shared vars.
    const access = this._getThisSharedAccess(node, analysisNode);
    if (!access) {
      return null;
    }
    const declaration = access.analysis.visibleDeclarations?.get(access.sharedName) ||
      access.analysis.producedDeclarations?.get(access.sharedName) ||
      null;
    return declaration ? this._createThisSharedAccessFacts(access, declaration) : null;
  }

  _getThisSharedAccess(node, analysisNode) {
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
    const declaration = activeAnalysis.visibleDeclarations?.get(sharedName) || null;
    const parentNode = node._analysis?.parent?.node ||
      (analysisNode?.node instanceof nodes.FunCall && analysisNode.node.name === node
        ? analysisNode.node
        : null);
    const isCallableRoot = staticPath.length === 2 &&
      parentNode instanceof nodes.FunCall &&
      parentNode.name === node;
    if (
      isCallableRoot &&
      (!compiler.scriptMode || !declaration)
    ) {
      return null;
    }
    if (
      compiler.scriptMode &&
      !declaration &&
      staticPath.length === 2 &&
      compiler.inheritance.hasLocalMethodDefinition(activeAnalysis, chainName)
    ) {
      return null;
    }
    return {
      analysis: activeAnalysis,
      chainName,
      sharedName,
      staticPath
    };
  }

  _createThisSharedAccessFacts(access, declaration = null) {
    const chainPath = [access.chainName].concat(access.staticPath.slice(2));
    const chainName = declaration ? declaration.name : access.sharedName;
    return {
      chainName,
      chainType: declaration ? declaration.type : null,
      chainPath: [chainName].concat(access.staticPath.slice(2)),
      pathPrefix: chainPath.length > 2 ? chainPath.slice(1, -1) : [],
      propertyName: chainPath.length >= 2 ? chainPath[chainPath.length - 1] : null
    };
  }

  analyzeChainDeclaration(node) {
    node.name.addAnalysis({ isSymbolTarget: true });
    validateChainDeclarationNode(this.compiler, node);
    const name = node.name.value;
    const result = {
      declareOnExit: [{
        name,
        type: node.chainType,
        initializer: node.initializer || null,
        shared: !!node.isShared
      }]
    };
    const chainFacts = CHAIN_TYPE_FACTS[node.chainType];
    if (
      node.initializer &&
      (
        node.isShared ||
        !chainFacts ||
        !chainFacts.requiresInitializer
      )
    ) {
      result.mutates = [name];
    }
    return result;
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
    const chainDecl = chainName ? node._analysis.visibleDeclarations?.get(chainName) || null : null;
    const chainType = node.chainType || (chainDecl ? chainDecl.type : null);
    const command = path.length >= 2 ? path[path.length - 1] : null;
    if (callNode && path.length === 2 && command === 'snapshot' && chainDecl && chainDecl.type === 'var') {
      this.compiler.fail(
        `Variable '${chainName}' does not support snapshot(). Use '${chainName}' directly.`,
        callNode.lineno,
        callNode.colno,
        node,
        callNode
      );
    }
    if (callNode && path.length >= 2 && chainDecl && (chainDecl.type === 'var' || isStoredDirectly(chainDecl))) {
      return {};
    }
    this.markOperationOwnedPath(node.call);
    const isSequenceGet = !callNode && chainDecl && chainDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 && this.isChainObservationCommand(path[1], chainDecl?.type));
    if (chainType === 'data' && callNode && !isObservation && callNode.args.children.length > 0) {
      this._recordDataCommandPath(callNode.args.children[0]);
    }
    const result = isObservation ? { observes: [chainName] } : { mutates: [chainName] };
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

  _recordDataCommandPath(node) {
    node.addAnalysis({ isDataCommandPath: true });
  }

  recordDataPathLookup(node) {
    if (node._analysis.isDataCommandPath) {
      this._recordDataCommandPath(node.target);
    }
  }

  postAnalyzeLiteral(node) {
    return this.collectDataPathSegmentFacts(node);
  }

  postAnalyzeArray(node) {
    return this._collectDataPathArrayFacts(node);
  }

  collectDataPathSegmentFacts(node) {
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

  _collectDataPathArrayFacts(node) {
    if (!node._analysis.isDataCommandPath) {
      return {};
    }
    return {
      dataPathSegments: node.children
    };
  }

  collectDataPathLookupFacts(node) {
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
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = callNode ? this.compiler.sequential.extractStaticPathSegments(callNode.name) : null;
    const declaration = path?.length >= 2
      ? node._analysis.visibleDeclarations?.get(path[0]) || null
      : null;
    if (declaration && (declaration.type === 'var' || isStoredDirectly(declaration))) {
      this.compiler.emit('runtime.observeDiscardedExpression(');
      this.compiler.compileExpression(node.call, null, node.call);
      this.compiler.emit.line(`, ${this.compiler.emitErrorContext(node.call)});`);
      return;
    }
    this.compiler.buffer.compileChainCommand(node);
  }

  compileChainOperationFunCall(node) {
    const chainOperationCall = node._analysis.chainOperationCall;
    if (!chainOperationCall) {
      return false;
    }
    if (chainOperationCall.chainType === 'var') {
      return false;
    }
    if (this._compileChainObservationFunCall(node, chainOperationCall)) {
      return true;
    }
    if (this._compileSequenceChainFunCall(node, chainOperationCall)) {
      return true;
    }
    return this._compileSharedChainStatementFunCall(node, chainOperationCall);
  }

  isSharedChainOperationCall(node, chainOperationCall = node?._analysis?.chainOperationCall) {
    if (!chainOperationCall) {
      return false;
    }
    const declaration = node._analysis.visibleDeclarations?.get(chainOperationCall.chainName) ||
      node._analysis.producedDeclarations?.get(chainOperationCall.chainName) ||
      null;
    return !!declaration?.shared;
  }

  isChainObservationMode(mode) {
    return mode === 'snapshot' || mode === 'isError' || mode === 'getError';
  }

  isChainObservationCommand(command, chainType) {
    return this.isChainObservationMode(command) &&
      !(command === 'snapshot' && chainType === 'sequence');
  }

  emitChainObservation(chainName, node, mode = 'snapshot', shared = false, implicitVarRead = false) {
    if (!this.isChainObservationMode(mode)) {
      return false;
    }
    const compiler = this.compiler;
    if (shared) {
      compiler.inheritance.emitSharedChainObservation(chainName, node, mode, implicitVarRead);
      return true;
    }
    if (mode === 'snapshot') {
      compiler.buffer.emitAddSnapshot(chainName, node);
      return true;
    }
    if (mode === 'isError') {
      compiler.buffer.emitAddIsError(chainName, node);
      return true;
    }
    if (mode === 'getError') {
      compiler.buffer.emitAddGetError(chainName, node);
      return true;
    }
    return false;
  }

  _compileChainObservationFunCall(node, chainOperationCall) {
    if (chainOperationCall.pathPrefix.length !== 0) {
      return false;
    }
    if (!this.isChainObservationCommand(chainOperationCall.methodName, chainOperationCall.chainType)) {
      return false;
    }
    const shared = this.isSharedChainOperationCall(node, chainOperationCall);
    return this.emitChainObservation(
      chainOperationCall.chainName,
      node,
      chainOperationCall.methodName,
      shared
    );
  }

  _compileSequenceChainFunCall(node, chainOperationCall) {
    const compiler = this.compiler;
    if (chainOperationCall.chainType !== 'sequence') {
      return false;
    }
    compiler._compileAggregate(node.args, null, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
        chainOperationCall.chainName,
        chainOperationCall.methodName,
        chainOperationCall.pathPrefix,
        resolvedArgs,
        node
      );
      this.emit(';');
    });
    return true;
  }

  _compileSharedChainStatementFunCall(node, chainOperationCall) {
    const compiler = this.compiler;
    if (!this.isSharedChainOperationCall(node, chainOperationCall)) {
      return false;
    }
    if (chainOperationCall.chainType === 'text') {
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.TextCommand({ chainName: ${JSON.stringify(chainOperationCall.chainName)}, `);
        if (chainOperationCall.methodName) {
          compiler.emit(`operation: ${JSON.stringify(chainOperationCall.methodName)}, `);
        }
        compiler.emit('normalizeArgs: true, args: ');
        compiler._compileAggregate(node.args, null, '[', ']', false, true);
        compiler.emit(`, errorContext: ${compiler.emitErrorContext(node)} })`);
      }, node, chainOperationCall.chainName);
      return true;
    }
    if (chainOperationCall.chainType === 'data') {
      if (!chainOperationCall.methodName) {
        compiler.fail('Invalid data command syntax: expected this.dataChain.command(...)', node.lineno, node.colno, node);
      }
      compiler.buffer.asyncAddValueToBuffer((resultVar) => {
        compiler.emit(`${resultVar} = new runtime.DataCommand({ chainName: ${JSON.stringify(chainOperationCall.chainName)}, operation: ${JSON.stringify(chainOperationCall.methodName)}, args: `);
        const pathArg = chainOperationCall.pathPrefix && chainOperationCall.pathPrefix.length > 0
          ? JSON.stringify(chainOperationCall.pathPrefix)
          : 'null';
        compiler.emit(`[${pathArg}`);
        if (node.args && node.args.children && node.args.children.length > 0) {
          compiler.emit(', ');
          compiler._compileAggregate(node.args, null, '', '', false, true);
        }
        compiler.emit(']');
        compiler.emit(`, errorContext: ${compiler.emitErrorContext(node)} })`);
      }, node, chainOperationCall.chainName);
      return true;
    }
    return false;
  }

}

function compactChainFactGroups(groups) {
  let end = groups.length;
  while (end > 0 && groups[end - 1] === null) {
    end--;
  }
  return end > 0 ? groups.slice(0, end) : null;
}

function chainSetToArray(chains) {
  return chains ? Array.from(chains) : null;
}

function addChainFactGroupNames(groups, index, names) {
  if (!names || names.length === 0) {
    return groups;
  }
  const nextGroups = groups ? groups.slice() : [];
  while (nextGroups.length <= index) {
    nextGroups.push(null);
  }
  const group = new Set(nextGroups[index] || []);
  names.forEach((name) => group.add(name));
  nextGroups[index] = Array.from(group);
  return compactChainFactGroups(nextGroups);
}

export {CompileChain};
