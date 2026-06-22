
import * as nodes from '../language/nodes.js';
import {getSharedSourceName, renameSharedName} from '../inheritance/shared-names.js';
import {CompileInheritanceEmit} from './inheritance-emit.js';

const INLINE_SOURCE_OWNER_PATH = '<inline source>';

/**
 * CompileInheritance - Handles template inheritance operations
 *
 * This module contains inheritance-specific compiler methods for the clean
 * async inheritance rebuild.
 */

class CompileInheritance {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
    this.currentCallableNode = null;
    this.codegen = new CompileInheritanceEmit(this);
  }

  emitSharedChainObservation(chainName, node, mode = 'snapshot', implicitVarRead = false) {
    this.codegen.sharedChainObservation(chainName, node, mode, implicitVarRead);
  }

  compileParticipantRootBody(node) {
    const directMacroBindingsVar = this.compiler._tmpid();
    this.emit.line(`const ${directMacroBindingsVar} = createDirectMacroBindings(ownerState, context);`);
    this.compiler.macro.emitInheritanceRootMacroExports(node, directMacroBindingsVar);
    this.codegen.participantRootRender(node, directMacroBindingsVar);
  }

  compileParticipantRootExport(node, rootCompileResult) {
    this.compiler.macro.emitInheritanceDirectMacroBindingsFactory(node);
    const methodEntries = this.codegen.callableEntriesObject(node, rootCompileResult);
    const sharedSchema = this.codegen.sharedSchemaLiteral(node);
    this.codegen.participantRootExport(node, methodEntries, sharedSchema);
  }

  compileInheritedMethodCall(node) {
    const methodName = node._analysis.inheritedMethodCallName ?? null;
    if (!methodName) {
      return false;
    }
    this.codegen.inheritedMethodInvocation(methodName, node.args, this.compiler.emitErrorContext(node));
    return true;
  }

  compileBlock(node) {
    // Async root compilation emits callable entries before the template body
    // runs. A current callable node means this block is being compiled as part
    // of a callable body rather than as a top-level block declaration.
    const isTopLevelTemplateBlock = !this.compiler.scriptMode && !this.currentCallableNode;
    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution.
    const rootNode = this.compiler.analysis.getRootNode(node._analysis);
    if (isTopLevelTemplateBlock && rootNode._analysis.inheritance.hasExtends) {
      return;
    }

    const id = this.compiler._tmpid();
    const explicitBlockArgNodes = this._getCallableSignature(node).placementArgNodes;
    const explicitBlockArgsNode = new nodes.NodeList(node.lineno, node.colno, explicitBlockArgNodes);
    this.emit.line(`let ${id};`);
    this.codegen.blockTextPlacement(node, id, () => {
      this.codegen.inheritedMethodInvocation(node.name.value, explicitBlockArgsNode, this.compiler.emitErrorContext(node));
    });
  }

  emitRootSharedDeclarations(node) {
    this.codegen.rootSharedDeclarations(node);
  }

  compileConstructorEntry(node) {
    const constructorDefinition = this._getConstructorDefinition(node);
    if (!constructorDefinition) {
      return null;
    }

    this._compileCallableEntry(constructorDefinition, 'b___constructor__', true);
    return constructorDefinition;
  }

  _getOwnerContextPath() {
    return this.compiler.sourcePath ?? INLINE_SOURCE_OWNER_PATH;
  }

  _getScriptMethodContextPath(callableNode) {
    const sourcePath = this._getOwnerContextPath();
    return `${sourcePath}#method:${callableNode.name.value}`;
  }

  _withCallableEntryCompile(callableNode, emitEntry) {
    const savedCallableNode = this.currentCallableNode;
    this.currentCallableNode = callableNode;
    emitEntry();
    this.currentCallableNode = savedCallableNode;
  }

  _compileCallableEntry(callableNode, functionName = `b_${callableNode.name.value}`, isConstructorEntry = false) {
    const isScriptMethod = this.compiler.scriptMode;
    const constructorRootNode = isConstructorEntry
      ? this.compiler.analysis.getRootNode(callableNode._analysis)
      : null;
    const invocationPath = isScriptMethod
      ? JSON.stringify(this._getScriptMethodContextPath(callableNode))
      : (this.compiler.sourcePath == null
        ? 'null'
        : JSON.stringify(this.compiler.sourcePath));
    const callableSignature = this._getCallableSignature(callableNode);
    // This only wires the entry-local command buffer to its immediate parent
    // invocation buffer. Caller-side inherited invocation linking is resolved
    // separately from helper-resolved method metadata at runtime.
    this._withCallableEntryCompile(callableNode, () => {
      this.codegen.inheritedCallableFunction(callableNode, functionName, () => {
        this.codegen.callableEntrySetup(callableNode, isScriptMethod, invocationPath, callableSignature);
        if (constructorRootNode) {
          this.emitRootSharedDeclarations(constructorRootNode);
        }
        this.compiler.compile(callableNode.body, null);
        this.codegen.callableEntryCompletion(callableNode, isScriptMethod, constructorRootNode);
      });
    });
  }

  compileInheritedCallableEntries(node) {
    const callableNames = new Set();
    const callableKind = this.compiler.scriptMode ? 'method' : 'block';
    const callables = this._getCallableDefinitions(node);

    callables.forEach((callableNode) => {
      const name = callableNode.name.value;

      if (callableNames.has(name)) {
        this.compiler.fail(`${callableKind} "${name}" defined more than once.`, callableNode.lineno, callableNode.colno, callableNode);
      }
      callableNames.add(name);
      this._compileCallableEntry(callableNode);
    });

    return callables;
  }

  compileExtends() {
    // Parent selection is emitted once in resolveInheritanceParent.
  }

  compileMethodDefinition() {
    // Method definitions are compiled through metadata and dedicated callable
    // entries, not by inline root-body emission.
  }

  emitDirectMacroReference(declaration, node) {
    if (!this._usesCallableOwnerDirectMacroBinding(declaration)) {
      return false;
    }
    this.emit(`currentInstance.getDirectMacroBinding(methodData, ${JSON.stringify(declaration.name)}, ${this.compiler.emitErrorContext(node)})`);
    return true;
  }

  compileSuper(node) {
    const name = node.blockName.value;
    const positionalArgsNode = this._getPositionalSuperArgsNode(node);
    const args = positionalArgsNode.children;
    const compilingBlock = this.currentCallableNode;
    const knownArgNames = compilingBlock ? this._getCallableSignature(compilingBlock).argNames : [];
    const isScriptMethod = this.compiler.scriptMode;
    const hasAssignmentTarget = !!node.symbol;
    const hasExplicitArgs = args.length > 0;
    const needsSafeTemplateOutput = !isScriptMethod;

    if (args.length > knownArgNames.length) {
      this.compiler.fail(
        `super(...) for ${isScriptMethod ? 'method' : 'block'} "${name}" received too many arguments`,
        node.lineno,
        node.colno,
        node
      );
    }

    this.codegen.superInvocation({
      node,
      positionalArgsNode,
      hasAssignmentTarget,
      hasExplicitArgs,
      needsSafeTemplateOutput
    });
  }

  isStaticExtendsNode(node) {
    return node instanceof nodes.Extends &&
      !node.noParentLiteral &&
      node.template instanceof nodes.Literal &&
      typeof node.template.value === 'string';
  }

  isDynamicExtendsNode(node) {
    return node instanceof nodes.Extends &&
      !node.noParentLiteral &&
      !(node.template instanceof nodes.Literal && typeof node.template.value === 'string');
  }

  ensureImplicitTemplateSharedDeclaration(analysis, name, type, sourceNode) {
    const compiler = this.compiler;
    if (compiler.scriptMode) {
      return null;
    }
    if (!name || name.charAt(0) === '!') {
      return null;
    }

    const declaration = {
      name: renameSharedName(name),
      type,
      initializer: null,
      shared: true,
      implicitTemplateShared: true
    };
    const sharedDeclaration = this._ensureImplicitRootSharedDeclaration(
      analysis,
      declaration,
      sourceNode ? (sourceNode._analysis || analysis) : analysis
    );
    return sharedDeclaration;
  }

  _ensureImplicitRootSharedDeclaration(analysis, declaration, sourceAnalysis) {
    const rootOwner = this.compiler.analysis.getRootScopeOwner(analysis);
    const existingDeclaration = this.findRootSharedDeclaration(rootOwner, declaration.name);
    if (existingDeclaration) {
      return existingDeclaration;
    }

    declaration.shared = true;
    declaration.declarationOrigin = this.compiler.analysis.getTopmostChildAnalysis(sourceAnalysis);
    declaration.declarationOwner = rootOwner;
    const visibleDeclarations = rootOwner.activeVisibleDeclarations;
    if (visibleDeclarations && !visibleDeclarations.has(declaration.name)) {
      visibleDeclarations.set(declaration.name, declaration);
    }
    // The declaration table is rebuilt during finalization, so keep implicit
    // shared declarations in the root declaration list as their source of truth.
    if (!rootOwner.declareOnEnter.includes(declaration)) {
      rootOwner.declareOnEnter.push(declaration);
    }
    this.recordRootSharedDeclaration(rootOwner, declaration);
    return declaration;
  }

  findRootSharedDeclaration(rootAnalysis, name) {
    return rootAnalysis.inheritanceSharedDeclarations.find((declaration) => declaration.name === name) || null;
  }

  recordRootSharedDeclaration(rootAnalysis, declaration) {
    if (!rootAnalysis.inheritanceSharedDeclarations.includes(declaration)) {
      rootAnalysis.inheritanceSharedDeclarations.push(declaration);
    }
  }

  collectRootAnalysis(node) {
    const rootAnalysis = {
      inheritanceCallableDefinitions: [],
      inheritanceComponentOperations: [],
      inheritanceExtendsNodes: [],
      inheritanceSharedDeclarations: []
    };
    node.addAnalysis(rootAnalysis);
    if (this.compiler.scriptMode) {
      node.inheritanceMetadata.methods.children.forEach((methodNode) => {
        this._recordCallableDefinition(methodNode, node._analysis);
      });
    }
    return rootAnalysis;
  }

  _recordCallableDefinition(node, rootAnalysis = null) {
    if (node.isCompilerInternal || this._isInsideCompilerInternalCallable(node)) {
      return;
    }
    rootAnalysis = rootAnalysis || this._getRootAnalysis(node._analysis);
    if (!rootAnalysis.inheritanceCallableDefinitions.includes(node)) {
      rootAnalysis.inheritanceCallableDefinitions.push(node);
    }
  }

  _getCallableDefinitions(node) {
    return node._analysis.inheritanceCallableDefinitions;
  }

  recordComponentOperation(node) {
    const rootAnalysis = this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceComponentOperations.push(node);
  }

  _getComponentOperations(node) {
    return node._analysis.inheritanceComponentOperations;
  }

  analyzeExtends(node) {
    node.template.addAnalysis({ errorContextLabel: this.compiler.scriptMode ? 'Extends.Script' : 'Extends.Template' });
    const rootAnalysis = this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceExtendsNodes.push(node);
    if (node._analysis.parent?.node instanceof nodes.Root) {
      rootAnalysis.inheritanceLocalExtendsNode = rootAnalysis.inheritanceLocalExtendsNode || node;
    }
    if (this.compiler.scriptMode) {
      return { wantsLinkedChildBuffer: true };
    }
    const textChain = this.compiler.analysis.getCurrentTextChain(node._analysis);
    return {
      wantsLinkedChildBuffer: true,
      mutates: textChain ? [textChain] : []
    };
  }

  _isInsideCompilerInternalCallable(node) {
    if (!node._analysis) {
      return false;
    }
    let current = node._analysis.parent;
    while (current) {
      if (current.node instanceof nodes.MethodDefinition && current.node.isCompilerInternal) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  _getConstructorDefinition(node) {
    return node.inheritanceMetadata.constructorDefinition || null;
  }

  hasLocalMethodDefinition(analysis, name) {
    if (!this.compiler.scriptMode) {
      return false;
    }
    const rootNode = this.compiler.analysis.getRootNode(analysis);
    return this._getCallableDefinitions(rootNode).some((method) => method.name.value === name);
  }

  _getSharedDeclarations(node) {
    return node._analysis.inheritanceSharedDeclarations;
  }

  _usesCallableOwnerDirectMacroBinding(declaration) {
    // Callable entries run outside the root JS function. Root-owned macros need
    // the loaded owner entry's direct binding instead of their local jsVar.
    if (!this.currentCallableNode || !declaration.isMacro) {
      return false;
    }
    const rootOwner = this.compiler.analysis.getRootScopeOwner(this.currentCallableNode._analysis);
    return declaration.declarationOwner === rootOwner;
  }

  computeRootInheritanceFacts(node) {
    const allExtendsNodes = node._analysis.inheritanceExtendsNodes;
    const extendsNodes = allExtendsNodes.filter((child) => !child.noParentLiteral);
    // The local syntax may be `extends none`; hasExtends only means a real parent is selected.
    const localExtendsNode = node._analysis.inheritanceLocalExtendsNode || null;
    const hasExtends = extendsNodes.length > 0;
    const callableDefinitions = this._getCallableDefinitions(node);
    const constructorDefinition = this._getConstructorDefinition(node);
    const sharedDeclarations = this._getSharedDeclarations(node);
    const componentOperations = this._getComponentOperations(node);
    this._validateSharedMethodNameCollisions(callableDefinitions, sharedDeclarations);
    const participates = !!(
      allExtendsNodes.length > 0 ||
      constructorDefinition ||
      callableDefinitions.length > 0 ||
      sharedDeclarations.length > 0 ||
      componentOperations.length > 0
    );

    return {
      hasExtends,
      localExtendsNode,
      participates
    };
  }

  _validateSharedMethodNameCollisions(methodDefinitions, sharedDeclarations) {
    if (sharedDeclarations.length === 0 || methodDefinitions.length === 0) {
      return;
    }
    const sharedNames = new Map();
    sharedDeclarations.forEach((declaration) => {
      sharedNames.set(getSharedSourceName(declaration.name), declaration);
    });
    methodDefinitions.forEach((method) => {
      const methodName = method.name.value;
      if (!sharedNames.has(methodName)) {
        return;
      }
      this.compiler.fail(
        `shared chain '${methodName}' conflicts with method '${methodName}' defined in this file`,
        method.name.lineno,
        method.name.colno,
        method,
        sharedNames.get(methodName)
      );
    });
  }

  _getInheritedMethodCallName(node) {
    return node instanceof nodes.LookupVal &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this' &&
      node.val instanceof nodes.Literal &&
      typeof node.val.value === 'string'
      ? node.val.value
      : null;
  }

  findInheritedMethodCallName(nameNode) {
    return this._getInheritedMethodCallName(nameNode);
  }

  findInheritedMethodCallNameForAnalysis(node, analysisPass) {
    const methodName = node && node.name
      ? this.findInheritedMethodCallName(node.name)
      : null;
    if (!methodName) {
      return null;
    }
    const thisSharedAccess = this.compiler.chain.probeThisSharedAccessFacts(
      node.name,
      analysisPass,
      node._analysis
    );
    return thisSharedAccess ? null : methodName;
  }

  recordInheritedMethodCallUsage(node, thisSharedFacts = null) {
    if (thisSharedFacts) {
      return null;
    }
    const methodName = node && node.name
      ? this.findInheritedMethodCallName(node.name)
      : null;
    if (methodName) {
      node.name.addAnalysis({ allowInheritedMethodCall: true });
      this._recordInheritedMethodCall(node, methodName);
    }
    return methodName;
  }

  analyzeSuper(node) {
    const rootAnalysis = this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceHasSuper = true;
    const callableAnalysis = this._getNearestCallableAnalysis(node._analysis);
    if (callableAnalysis) {
      callableAnalysis.callableUsesSuper = true;
      if (callableAnalysis.callableSuperErrorContextIndex === undefined) {
        callableAnalysis.callableSuperErrorContextIndex = this.compiler.getErrorContextIndex(node);
      }
      return;
    }
    rootAnalysis.callableUsesSuper = true;
    if (rootAnalysis.callableSuperErrorContextIndex === undefined) {
      rootAnalysis.callableSuperErrorContextIndex = this.compiler.getErrorContextIndex(node);
    }
  }

  _recordInheritedMethodCall(callNode, methodName) {
    const rootAnalysis = this._getRootAnalysis(callNode._analysis);
    this._recordInheritedMethodDependency(rootAnalysis, 'inheritanceMethodDependencies', methodName, callNode);
    const callableAnalysis = this._getNearestCallableAnalysis(callNode._analysis);
    if (callableAnalysis) {
      this._recordInheritedMethodDependency(callableAnalysis, 'callableInheritedMethodDependencies', methodName, callNode);
    } else {
      this._recordInheritedMethodDependency(rootAnalysis, 'callableInheritedMethodDependencies', methodName, callNode);
    }
  }

  _recordInheritedMethodDependency(analysis, fieldName, methodName, errorContextNode) {
    if (!analysis[fieldName]) {
      analysis[fieldName] = Object.create(null);
    }
    if (!analysis[fieldName][methodName]) {
      analysis[fieldName][methodName] = {
        name: methodName,
        errorContextIndex: this.compiler.getErrorContextIndex(errorContextNode)
      };
    }
  }

  _getRootAnalysis(analysis) {
    let current = analysis;
    while (current.parent) {
      current = current.parent;
    }
    return current;
  }

  _getNearestCallableAnalysis(analysis) {
    let current = analysis;
    while (current) {
      const node = current.node;
      if (node instanceof nodes.Block || node instanceof nodes.MethodDefinition) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  validateBareInheritedMethodLookup(node) {
    const methodName =
      node._analysis.inheritedMethodCallName ||
      this.findInheritedMethodCallName(node);
    if (methodName && !node._analysis.allowInheritedMethodCall) {
      this.compiler.fail(
        `bare inherited-method references are not supported; bare this.${methodName} references are not allowed; use this.${methodName}(...)`,
        node.lineno,
        node.colno,
        node
      );
    }
  }

  analyzeBlock(node) {
    const compiler = this.compiler;
    if (!compiler.scriptMode) {
      this._recordCallableDefinition(node);
    }
    const parentCallableAnalysis = this._getNearestCallableAnalysis(node._analysis.parent);
    if (parentCallableAnalysis) {
      this._recordInheritedMethodDependency(
        parentCallableAnalysis,
        'callableInheritedMethodDependencies',
        node.name.value,
        node
      );
    }
    const signature = this._getCallableSignature(node);
    const bodyDeclares = [];
    const seenBlockArgNames = new Set();
    signature.argNameNodes.forEach((nameNode, index) => {
      nameNode.addAnalysis({ isSymbolTarget: true });
      const canonicalName = signature.argNames[index];
      if (seenBlockArgNames.has(canonicalName)) {
        compiler.fail(
          `block argument '${canonicalName}' is declared more than once`,
          nameNode.lineno,
          nameNode.colno,
          node,
          nameNode
        );
      }
      seenBlockArgNames.add(canonicalName);
      bodyDeclares.push({
        name: canonicalName,
        type: 'var',
        initializer: null,
        explicit: true,
        blockArg: true
      });
    });
    if (bodyDeclares.length > 0 && node.body) {
      const bodyAnalysis = node.body._analysis || {};
      const declareOnEnter = bodyAnalysis.declareOnEnter
        ? bodyAnalysis.declareOnEnter.concat(bodyDeclares)
        : bodyDeclares;
      node.body.addAnalysis({
        declareOnEnter
      });
    }
    const textChain = !compiler.scriptMode
      ? compiler.analysis.getCurrentTextChain(node._analysis)
      : null;
    const declareOnEnter = [];
    if (textChain) {
      declareOnEnter.push({
        name: textChain,
        type: 'text',
        initializer: null
      });
    }
    return {
      createScope: true,
      scopeBoundary: true,
      declareOnEnter,
      mutates: textChain ? [textChain] : [],
      wantsLinkedChildBuffer: true
    };
  }

  analyzeMethodDefinition(node) {
    if (this.compiler.scriptMode) {
      this._recordCallableDefinition(node);
    }
    const analysis = this.analyzeBlock(node);
    analysis.declareOnEnter.push(this.compiler.return.createChainDeclaration());
    return analysis;
  }

  _getPositionalSuperArgsNode(node) {
    const allArgs = node.args && node.args.children ? node.args.children.slice() : [];
    if (allArgs.length === 0) {
      return new nodes.NodeList(node.lineno, node.colno);
    }
    const lastArg = allArgs[allArgs.length - 1];
    if (lastArg instanceof nodes.KeywordArgs) {
      if (lastArg.children.length > 0) {
        this.compiler.fail(
          'super(...) does not support keyword arguments',
          lastArg.lineno,
          lastArg.colno,
          node,
          lastArg
        );
      }
      allArgs.pop();
    }
    return new nodes.NodeList(node.lineno, node.colno, allArgs);
  }

  _getCallableSignature(callableNode) {
    const signatureArgs = callableNode && callableNode.args && callableNode.args.children ? callableNode.args : new nodes.NodeList();
    if (callableNode && callableNode._analysis && callableNode._analysis.callableSignatureFacts) {
      return callableNode._analysis.callableSignatureFacts;
    }
    const label = this.compiler.scriptMode ? 'method signature' : 'block signature';
    const signatureFacts = this.compiler.getCallableSignatureFacts(signatureArgs, {
      allowKeywordArgs: true,
      symbolsOnly: true,
      label,
      ownerNode: callableNode
    });
    if (callableNode && callableNode._analysis) {
      callableNode.addAnalysis({ callableSignatureFacts: signatureFacts });
    }
    return signatureFacts;
  }

}

export {CompileInheritance};

