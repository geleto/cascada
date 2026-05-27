
import * as nodes from '../language/nodes.js';
import {getSharedSourceName, renameSharedName} from '../inheritance/shared-names.js';

const COMPILED_METHOD_ENTRIES_VAR = '__compiledMethodEntries';
const COMPILED_SHARED_SCHEMA_VAR = '__compiledSharedSchema';
const INLINE_SOURCE_OWNER_PATH = '<inline source>';
const INHERITED_CALLABLE_EXTRA_PARAMS = [
  'blockPayload = null',
  'blockRenderCtx = undefined',
  'methodData',
  'currentInstance'
];

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
  }

  emitSharedChainObservation(chainName, node, mode = 'snapshot', implicitVarRead = false) {
    const compiler = this.compiler;
    compiler.emit(
      `runtime.observeInheritanceSharedChain(${JSON.stringify(chainName)}, ${compiler.buffer.currentBuffer}, ` +
      `${compiler.emitErrorContext(node)}, ` +
      `currentInstance, ${JSON.stringify(mode)}, ${implicitVarRead})`
    );
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
    rootOwner.declaredChains = rootOwner.declaredChains || new Map();
    if (!rootOwner.declaredChains.has(declaration.name)) {
      rootOwner.declaredChains.set(declaration.name, declaration);
    }
    // The declaration table is rebuilt during finalization, so keep implicit
    // shared declarations in the root declaration list as their source of truth.
    rootOwner.declares.push(declaration);
    this.registerRootSharedDeclaration(rootOwner, declaration);
    return declaration;
  }

  findRootSharedDeclaration(rootAnalysis, name) {
    const sharedDeclarations = rootAnalysis.inheritanceSharedDeclarations ?? [];
    return sharedDeclarations.find((declaration) => declaration.name === name) || null;
  }

  registerRootSharedDeclaration(rootAnalysis, declaration) {
    rootAnalysis.inheritanceSharedDeclarations = rootAnalysis.inheritanceSharedDeclarations || [];
    if (!rootAnalysis.inheritanceSharedDeclarations.includes(declaration)) {
      rootAnalysis.inheritanceSharedDeclarations.push(declaration);
    }
  }

  postAnalyzeCallableDefinition(node) {
    // Blocks contribute template text output; script methods contribute return output.
    return this._getCallableChainFootprint(node);
  }

  analyzeRoot(node) {
    node.addAnalysis({
      inheritanceCallableDefinitions: node._analysis.inheritanceCallableDefinitions ?? [],
      inheritanceComponentOperations: node._analysis.inheritanceComponentOperations ?? [],
      inheritanceExtendsNodes: node._analysis.inheritanceExtendsNodes ?? [],
    });
    if (this.compiler.scriptMode) {
      node.inheritanceMetadata.methods.children.forEach((methodNode) => {
        this._recordCallableDefinition(methodNode, node._analysis);
      });
    }
    return {};
  }

  _recordCallableDefinition(node, rootAnalysis = null) {
    if (node.isCompilerInternal || this._isInsideCompilerInternalCallable(node)) {
      return;
    }
    rootAnalysis = rootAnalysis || this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceCallableDefinitions = rootAnalysis.inheritanceCallableDefinitions || [];
    if (!rootAnalysis.inheritanceCallableDefinitions.includes(node)) {
      rootAnalysis.inheritanceCallableDefinitions.push(node);
    }
  }

  _getCallableDefinitions(node) {
    return node._analysis.inheritanceCallableDefinitions ?? [];
  }

  recordComponentOperation(node) {
    const rootAnalysis = this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceComponentOperations = rootAnalysis.inheritanceComponentOperations || [];
    rootAnalysis.inheritanceComponentOperations.push(node);
  }

  _getComponentOperations(node) {
    return node._analysis.inheritanceComponentOperations ?? [];
  }

  analyzeExtends(node) {
    const rootAnalysis = this._getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceExtendsNodes = rootAnalysis.inheritanceExtendsNodes || [];
    rootAnalysis.inheritanceExtendsNodes.push(node);
    if (node._analysis.parent?.node instanceof nodes.Root) {
      rootAnalysis.inheritanceLocalExtendsNode = rootAnalysis.inheritanceLocalExtendsNode || node;
    }
    return { createsLinkedChildBuffer: true };
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
    return node._analysis.inheritanceSharedDeclarations ?? [];
  }

  _getParticipantRootDeclarations(node) {
    return node.children.filter((child) => child instanceof nodes.Macro);
  }

  _compileParticipantRootDeclarations(node) {
    // Macros are root declarations: the transformer keeps them out of
    // __constructor__, but participant roots bypass normal child compilation.
    // Runtime bindings such as imports/from-imports stay constructor work.
    this._getParticipantRootDeclarations(node).forEach((child) => {
      this.compiler.compileMacro(child);
    });
  }

  compileParticipantRootBody(node) {
    this._compileParticipantRootDeclarations(node);
    this.emit.line('return runtime.renderInheritanceParticipantRoot({');
    this.emit.line('    entryTemplateOrScript: this,');
    this.emit.line('    env,');
    this.emit.line('    context,');
    this.emit.line('    runtime,');
    this.emit.line('    reportError,');
    this.emit.line('    rootBuffer: output,');
    this.emit.line(`    errorContext: ${this.compiler.emitErrorContext(node)}`);
    this.emit.line('}).catch((e) => {');
    this.emit.line(`  reportError(runtime.contextualizeError(e, ${this.compiler.emitErrorContext(node)}, output));`);
    this.emit.line('  throw e;');
    this.emit.line('});');
  }

  compileParticipantRootExport(node, rootCompileResult) {
    const methodEntries = this._compileCallableEntriesObject(node, rootCompileResult);
    this.emit.line(`const ${COMPILED_METHOD_ENTRIES_VAR} = ${methodEntries};`);
    this.emit.line(`const ${COMPILED_SHARED_SCHEMA_VAR} = ${this._compileSharedSchemaLiteral(node)};`);
    this._compileExtendsParentResolver(node);
    this.compiler.emitErrorContextHelper();
    this.emit.line('return {');
    this.emit.line('root,');
    this.emit.line('inheritanceSpec: {');
    this.emit.line(`  methodEntries: ${COMPILED_METHOD_ENTRIES_VAR},`);
    this.emit.line(`  sharedSchema: ${COMPILED_SHARED_SCHEMA_VAR},`);
    this.emit.line(`  hasExtends: ${node._analysis.inheritance.hasExtends ? 'true' : 'false'}`);
    this.emit.line('},');
    this.emit.line('resolveInheritanceParent,');
    this.emit.line('getErrorContexts');
    this.emit.line('};');
  }

  computeRootInheritanceFacts(node) {
    const allExtendsNodes = node._analysis.inheritanceExtendsNodes ?? [];
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

  analyzeInheritedMethodCallTarget(nameNode) {
    return this._getInheritedMethodCallName(nameNode);
  }

  analyzeInheritedMethodCall(node, analysisPass) {
    const methodName = node && node.name
      ? this.analyzeInheritedMethodCallTarget(node.name)
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

  postAnalyzeInheritedMethodCall(node, thisSharedFacts = null) {
    if (thisSharedFacts) {
      return null;
    }
    const methodName = node && node.name
      ? this.analyzeInheritedMethodCallTarget(node.name)
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
      this.analyzeInheritedMethodCallTarget(node);
    if (methodName && !node._analysis.allowInheritedMethodCall) {
      this.compiler.fail(
        `bare inherited-method references are not supported; bare this.${methodName} references are not allowed; use this.${methodName}(...)`,
        node.lineno,
        node.colno,
        node
      );
    }
  }

  compileInheritedMethodCall(node) {
    const methodName = node._analysis.inheritedMethodCallName ?? null;
    if (!methodName) {
      return false;
    }
    this._emitInheritedMethodInvocation(methodName, node.args, this.compiler.emitErrorContext(node));
    return true;
  }

  _emitInheritedMethodInvocation(methodName, argsNode, errorContextJson) {
    if (!this.compiler.scriptMode) {
      this.emit('runtime.markSafe(');
    }
    this.emit(`currentInstance.invokeFromCurrentBuffer("${methodName}", `);
    this.compiler._compileAggregate(argsNode, null, '[', ']', false, false);
    this.emit(`, context, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    if (!this.compiler.scriptMode) {
      this.emit(')');
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
    const declares = [];
    const seenBlockArgNames = new Set();
    signature.argNameNodes.forEach((nameNode, index) => {
      nameNode.addAnalysis({ skipDeclarationOwner: node._analysis });
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
      declares.push({
        name: canonicalName,
        type: 'var',
        initializer: null,
        explicit: true,
        blockArg: true
      });
    });
    if (declares.length > 0 && node.body) {
      const bodyAnalysis = node.body._analysis || {};
      const bodyDeclares = bodyAnalysis.declares
        ? bodyAnalysis.declares.concat(declares)
        : declares;
      node.body.addAnalysis({
        declares: bodyDeclares
      });
    }
    const textChain = !compiler.scriptMode
      ? compiler.analysis.getCurrentTextChain(node._analysis)
      : null;
    return {
      createScope: true,
      scopeBoundary: true,
      parentReadOnly: true,
      uses: textChain ? [textChain] : [],
      mutates: textChain ? [textChain] : [],
      createsLinkedChildBuffer: true
    };
  }

  analyzeMethodDefinition(node) {
    if (this.compiler.scriptMode) {
      this._recordCallableDefinition(node);
    }
    const analysis = this.analyzeBlock(node);
    analysis.declares = [this.compiler.return.createChainDeclaration()];
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

  _emitBlockTextPlacement(node, id, emitValue) {
    this.emit(`${id} = `);
    emitValue();
    this.emit.line(';');
    const textCmdExpr = this.compiler.buffer._emitTemplateTextCommandExpression(id, node, true);
    this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.compiler.buffer.currentTextChainName}");`);
    this.compiler.buffer.emitLimitedLoopCompletion(id, node);
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
    this._emitBlockTextPlacement(node, id, () => {
      this._emitInheritedMethodInvocation(node.name.value, explicitBlockArgsNode, this.compiler.emitErrorContext(node));
    });
  }

  emitRootSharedDeclarations(node) {
    const sharedDeclarations = this._getSharedDeclarations(node);
    sharedDeclarations.forEach((declaration) => {
      this._emitSharedDeclaration(declaration, node);
    });
  }

  _emitSharedDeclaration(declaration, rootNode) {
    const targetBufferExpr = 'currentInstance.sharedRootBuffer';
    const errorContextNode = declaration.declarationOrigin ? declaration.declarationOrigin.node : rootNode;
    const errorContext = this.compiler.emitErrorContext(errorContextNode);
    this.emit(
      `runtime.declareInheritanceSharedChain(${targetBufferExpr}, ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context, undefined, ${errorContext}`
    );
    this.emit.line(');');
    if (!declaration.initializer) {
      return;
    }

    this.emit.line(`if (runtime.claimInheritanceSharedDefault(${targetBufferExpr}, ${JSON.stringify(declaration.name)})) {`);
    if (declaration.type === 'sequence' || declaration.type === 'var') {
      this.emit(
        `runtime.declareInheritanceSharedChain(${targetBufferExpr}, ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context, `
      );
      this.compiler.compile(declaration.initializer, null);
      this.emit.line(`, ${errorContext});`);
      this.emit.line('}');
      return;
    }

    const initValueId = this.compiler._tmpid();
    this.emit(`let ${initValueId} = `);
    this.compiler.compileExpression(declaration.initializer, null, declaration.initializer);
    this.emit.line(';');
    this.compiler.buffer.emitAddChainCommandByType({
      bufferExpr: targetBufferExpr,
      chainType: declaration.type,
      chainName: declaration.name,
      valueExpr: initValueId,
      positionNode: declaration.initializer,
      initializeIfNotSet: true
    });
    this.emit.line('}');
  }

  _compileExtendsParentResolver(node) {
    this.emit.line('async function resolveInheritanceParent(env, context, runtime, errorContext, reportError) {');
    this.emit.line('  const __ec = getErrorContexts(runtime, this.path, reportError);');
    const inheritanceFacts = node._analysis.inheritance;
    if (!inheritanceFacts.localExtendsNode || inheritanceFacts.localExtendsNode.noParentLiteral) {
      this.emit.line('  return runtime.noInheritanceParent();');
      this.emit.line('}');
      return;
    }

    const extendsNode = inheritanceFacts.localExtendsNode;
    const errorContextIndex = this.compiler.getErrorContextIndex(extendsNode);
    this.emit.line(`  const parentErrorContext = errorContext ?? __ec[${errorContextIndex}];`);
    if (this.isStaticExtendsNode(extendsNode)) {
      // Static targets are known non-null here, so null-target error context is
      // only needed by the dynamic branch.
      this.emit.line(`  return runtime.resolveInheritanceParent(env, ${this.compiler.scriptMode ? 'true' : 'false'}, ${JSON.stringify(extendsNode.template.value)}, parentErrorContext, context);`);
    } else {
      this.emit('  const parentSelection = ');
      this.compiler.compileExpression(extendsNode.template, null, extendsNode.template, true);
      this.emit.line(';');
      this.emit.line(`  return runtime.resolveInheritanceParent(env, ${this.compiler.scriptMode ? 'true' : 'false'}, parentSelection, parentErrorContext, context, __ec[${errorContextIndex}]);`);
    }
    this.emit.line('}');
  }

  _getOwnerContextPath() {
    return this.compiler.sourcePath ?? INLINE_SOURCE_OWNER_PATH;
  }

  _getScriptMethodContextPath(callableNode) {
    const sourcePath = this._getOwnerContextPath();
    return `${sourcePath}#method:${callableNode.name.value}`;
  }

  compileConstructorEntry(node) {
    const constructorDefinition = this._getConstructorDefinition(node);
    if (!constructorDefinition) {
      return null;
    }

    this._compileCallableEntry(constructorDefinition, 'b___constructor__', true);
    return constructorDefinition;
  }

  _emitTemplateConstructorEntryReturn(hasExtends, constructorDefinition) {
    if (!hasExtends) {
      this._emitCallableEntryReturn(false);
      return;
    }
    this._emitConstructorSuperReturn(constructorDefinition);
  }

  _emitConstructorSuperReturn(constructorDefinition) {
    this.emit.line(`return runtime.resolveSingle(currentInstance.invokeSuper(methodData, [], context, ${this.compiler.buffer.currentBuffer}, ${this.compiler.emitErrorContext(constructorDefinition)})).then((parentResult) => {`);
    this.emit.line(`  ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line('  return parentResult;');
    this.emit.line('});');
  }

  _emitScriptSharedDefaultConstructorEntryReturn(hasExtends, constructorDefinition) {
    // Shared defaults still run through constructor execution. This helper is
    // for scripts with shared default initializers but no user constructor body.
    if (!hasExtends) {
      this._emitCallableEntryReturn(true);
      return;
    }
    this._emitConstructorSuperReturn(constructorDefinition);
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

  _emitCallableArgumentValue(payloadOriginalArgsVar, name, defaultValueNode) {
    const nameJson = JSON.stringify(name);
    this.emit(`Object.prototype.hasOwnProperty.call(${payloadOriginalArgsVar}, ${nameJson}) ? ${payloadOriginalArgsVar}[${nameJson}] : `);
    if (defaultValueNode) {
      this.compiler._compileExpression(defaultValueNode, null);
    } else {
      this.emit('undefined');
    }
  }

  _emitCallableArgumentChains(callableNode, callableSignature, payloadOriginalArgsVar) {
    this.compiler.chain.emitLocalVarChainBindings(
      this.compiler.buffer.currentBuffer,
      this.compiler.createCallableArgumentChainBindings(
        callableSignature,
        (name, defaultValueNode) => {
          this._emitCallableArgumentValue(payloadOriginalArgsVar, name, defaultValueNode);
        },
        () => callableNode
      )
    );
  }

  _emitCallableContextSetup(callableNode, isScriptMethod, invocationPath) {
    this.emit.line(
      `context = runtime.createInheritanceCallableContext(` +
      `context, ${isScriptMethod ? 'true' : 'false'}, ${invocationPath}, blockPayload, blockRenderCtx` +
      `);`
    );
  }

  _emitCallableEntryParentLinks(callableNode, isScriptMethod) {
    this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
    this.emit.line(
      `runtime.linkInheritanceCallableFootprintChains(` +
      `parentBuffer, ${this.compiler.buffer.currentBuffer}, ` +
      `methodData.mergedLinkedChains, ` +
      `methodData.mergedMutatedChains, ` +
      `${this.compiler.emitErrorContext(callableNode)}` +
      `);`
    );
    if (!isScriptMethod) {
      this.emit.line(`${this.compiler.buffer.currentTextChainVar}._context = context;`);
    }
  }

  _withCallableBodyCompile(callableNode, emitBody) {
    const savedCallableNode = this.currentCallableNode;
    this.currentCallableNode = callableNode;
    emitBody();
    this.currentCallableNode = savedCallableNode;
  }

  _emitCallableEntryReturn(isScriptMethod) {
    if (isScriptMethod) {
      const resultVar = this.compiler._tmpid();
      this.compiler.return.emitFinalSnapshot(this.compiler.buffer.currentBuffer, resultVar);
      // Script methods still own their entry-local command-buffer lifetime.
      // The invocation command waits on the per-call invocation buffer after
      // this local buffer closes, so caller-visible completion still covers the
      // full inherited call.
      this.emit.line(`return ${resultVar};`);
      return;
    }

    this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`return ${this.compiler.buffer.currentTextChainVar}.finalSnapshot();`);
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
    this.emit.entryFunction(callableNode, functionName, () => {
      if (isScriptMethod) {
        this.compiler.return.emitDeclareChain(this.compiler.buffer.currentBuffer);
      }
      const payloadOriginalArgsVar = this.compiler._tmpid();
      this.emit.line(`const ${payloadOriginalArgsVar} = runtime.getInheritanceCallableOriginalArgs(blockPayload);`);
      this._emitCallableContextSetup(callableNode, isScriptMethod, invocationPath);
      this._emitCallableEntryParentLinks(callableNode, isScriptMethod);
      this._emitCallableArgumentChains(callableNode, callableSignature, payloadOriginalArgsVar);
      if (constructorRootNode) {
        this.emitRootSharedDeclarations(constructorRootNode);
      }
      this._withCallableBodyCompile(callableNode, () => {
        this.compiler.compile(callableNode.body, null);
      });
      if (constructorRootNode && !isScriptMethod) {
        this._emitTemplateConstructorEntryReturn(constructorRootNode._analysis.inheritance.hasExtends, callableNode);
      } else if (constructorRootNode && callableNode.isSharedDefaultOnlyConstructor) {
        this._emitScriptSharedDefaultConstructorEntryReturn(constructorRootNode._analysis.inheritance.hasExtends, callableNode);
      } else {
        this._emitCallableEntryReturn(isScriptMethod);
      }
    }, {
      extraParams: INHERITED_CALLABLE_EXTRA_PARAMS,
      noReturn: true
    });
  }

  _compileInheritedCallableEntry(callableNode) {
    this._compileCallableEntry(callableNode);
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
      this._compileInheritedCallableEntry(callableNode);
    });

    return callables;
  }

  _compileCallableEntriesObject(node, rootCompileResult) {
    const callables = rootCompileResult.blocks;
    const constructorEntry = rootCompileResult.constructorEntry;
    const methodEntries = callables.map((callableNode) =>
      this._compileMethodEntryObject(this._createMethodEntryDescriptor(callableNode))
    );

    if (constructorEntry) {
      const constructorUsesSuper = (!this.compiler.scriptMode && node._analysis.inheritance.hasExtends) ||
        (this.compiler.scriptMode && constructorEntry.isSharedDefaultOnlyConstructor && node._analysis.inheritance.hasExtends) ||
        constructorEntry._analysis.callableUsesSuper;
      methodEntries.push(this._compileMethodEntryObject(this._createMethodEntryDescriptor(constructorEntry, {
        name: '__constructor__',
        fnExpr: 'b___constructor__',
        isConstructor: true,
        usesSuper: constructorUsesSuper,
        signature: { argNames: [] }
      })));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  _createMethodEntryDescriptor(callableNode, overrides = {}) {
    const name = overrides.name ?? callableNode.name.value;
    return {
      name,
      fnExpr: overrides.fnExpr ?? `b_${name}`,
      ownerNode: callableNode,
      errorContextNode: overrides.errorContextNode ?? callableNode,
      isConstructor: !!overrides.isConstructor,
      usesSuper: overrides.usesSuper ?? !!callableNode._analysis.callableUsesSuper,
      superErrorContextIndexLiteral: this._compileCallableSuperErrorContextIndexLiteral(callableNode),
      inheritedMethodDependencies: this._compileInheritedMethodDependenciesObject(callableNode._analysis.callableInheritedMethodDependencies),
      signature: overrides.signature ?? {
        argNames: this._getCallableSignature(callableNode).argNames
      }
    };
  }

  _compileMethodEntryObject(entry) {
    const callableFootprint = this._getCallableChainFootprint(entry.ownerNode);
    const ownLinkedChainNames = callableFootprint.linkedChains;
    // Keep mutations separate from links so inherited/component calls can
    // later distinguish read-only participation from write barriers.
    const ownMutatedChainNames = callableFootprint.mutatedChains;
    const ownLinkedChains = JSON.stringify(ownLinkedChainNames);
    const ownMutatedChains = JSON.stringify(ownMutatedChainNames);
    const errorContextIndex = this.compiler.getErrorContextIndex(entry.errorContextNode);
    const name = JSON.stringify(entry.name);
    return `${name}: { name: ${name}, fn: ${entry.fnExpr}, signature: ${JSON.stringify(entry.signature)}, errorContextIndex: ${errorContextIndex}, isConstructor: ${entry.isConstructor ? 'true' : 'false'}, super: ${entry.usesSuper ? 'true' : 'false'}, superErrorContextIndex: ${entry.superErrorContextIndexLiteral ?? 'null'}, inheritedMethodDependencies: ${entry.inheritedMethodDependencies || '{}'}, ownLinkedChains: ${ownLinkedChains}, ownMutatedChains: ${ownMutatedChains} }`;
  }

  _compileInheritedMethodDependenciesObject(methodDependencies) {
    if (!methodDependencies) {
      return '{}';
    }
    const names = Object.keys(methodDependencies);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(methodDependencies[name])}`).join(', ')} }`;
  }

  _compileCallableSuperErrorContextIndexLiteral(callableNode) {
    return callableNode._analysis.callableSuperErrorContextIndex !== undefined
      ? String(callableNode._analysis.callableSuperErrorContextIndex)
      : 'null';
  }

  _compileSharedSchemaLiteral(node) {
    const sharedDeclarations = this._getSharedDeclarations(node);
    const entries = sharedDeclarations.map((child) => {
      const errorContextNode = child.declarationOrigin ? child.declarationOrigin.node : node;
      return `${JSON.stringify(child.name)}: { ` +
        `type: ${JSON.stringify(child.type)}, ` +
        `errorContextIndex: ${this.compiler.getErrorContextIndex(errorContextNode)}, ` +
        `hasDefault: ${child.initializer ? 'true' : 'false'} ` +
        `}`;
    });
    return `{ ${entries.join(', ')} }`;
  }

  _getCallableChainFootprint(ownerNode) {
    const bodyAnalysis = ownerNode.body ? ownerNode.body._analysis : ownerNode._analysis;
    const usedChains = bodyAnalysis.usedChains ?? new Set();
    const mutatedChains = bodyAnalysis.mutatedChains ?? new Set();
    const rootNode = this.compiler.analysis.getRootNode(ownerNode._analysis);
    const sharedStorageNames = new Set(this._getSharedDeclarations(rootNode).map((declaration) => declaration.name));
    const linkedChainNames = Array.from(usedChains).filter((name) => sharedStorageNames.has(name));
    const mutatedChainNames = Array.from(mutatedChains).filter((name) => sharedStorageNames.has(name));
    return {
      linkedChains: linkedChainNames,
      mutatedChains: mutatedChainNames
    };
  }

  compileExtends(node) {
    // Parent selection is emitted once in resolveInheritanceParent.
  }

  compileSuper(node) {
    const name = node.blockName.value;
    const id = node.symbol ? node.symbol.value : null;
    const positionalArgsNode = this._getPositionalSuperArgsNode(node);
    const args = positionalArgsNode.children;
    const compilingBlock = this.currentCallableNode;
    const knownArgNames = compilingBlock ? this._getCallableSignature(compilingBlock).argNames : [];
    const isScriptMethod = this.compiler.scriptMode;
    const hasAssignmentTarget = !!id;
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

    if (hasAssignmentTarget) {
      this.emit(`let ${id} = `);
    } else if (needsSafeTemplateOutput) {
      this.emit('runtime.markSafe(');
    }
    this.emit('currentInstance.invokeSuper(methodData, ');
    if (hasExplicitArgs) {
      this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
    } else {
      this.emit('[]');
    }
    this.emit(`, context, ${this.compiler.buffer.currentBuffer}, ${this.compiler.emitErrorContext(node)}`);
    this.emit(')');
    if (!hasAssignmentTarget) {
      if (needsSafeTemplateOutput) {
        this.emit(')');
      }
      return;
    }
    this.emit.line(';');
    if (needsSafeTemplateOutput) {
      this.emit.line(`${id} = runtime.markSafe(${id});`);
    }
  }

}

export {CompileInheritance};

