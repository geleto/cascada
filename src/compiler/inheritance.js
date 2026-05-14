
import * as nodes from '../language/nodes.js';
import {CompileBuffer} from './buffer.js';

const COMPILED_METHOD_ENTRIES_VAR = '__compiledMethodEntries';
const COMPILED_SHARED_SCHEMA_VAR = '__compiledSharedSchema';
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
  }

  supportsInheritedMethodCalls() {
    return !!(this.compiler.scriptMode || this.compiler.templateUsesInheritanceSurface);
  }

  templateUsesInheritanceSurface(rootNode) {
    const compiler = this.compiler;
    return !compiler.scriptMode;
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

  ensureImplicitTemplateSharedDeclaration(analysis, name, type, originNode) {
    const compiler = this.compiler;
    if (compiler.scriptMode || !compiler.templateUsesInheritanceSurface) {
      return null;
    }
    if (!name || name.charAt(0) === '!') {
      return null;
    }

    const declaration = {
      name,
      type,
      initializer: null,
      shared: true,
      implicitTemplateShared: true
    };
    const sharedDeclaration = this.ensureRootSharedDeclaration(
      analysis,
      declaration,
      originNode ? (originNode._analysis || analysis) : analysis
    );
    return sharedDeclaration;
  }

  ensureRootSharedDeclaration(analysis, declaration, originAnalysis) {
    const rootOwner = this.compiler.analysis.getRootScopeOwner(analysis);
    const existingDeclaration = this.findRootSharedDeclaration(rootOwner, declaration.name);
    if (existingDeclaration) {
      return existingDeclaration;
    }

    declaration.shared = true;
    declaration.declarationOrigin = this.compiler.analysis.getTopmostChildAnalysis(originAnalysis);
    rootOwner.declaredChannels = rootOwner.declaredChannels || new Map();
    if (!rootOwner.declaredChannels.has(declaration.name)) {
      rootOwner.declaredChannels.set(declaration.name, declaration);
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
    return this.createCallableChannelFootprint(node);
  }

  getMethodDefinitions(node) {
    return node.inheritanceMetadata.methods.children.filter((method) => method.name.value !== '__constructor__');
  }

  getConstructorDefinition(node) {
    return node.inheritanceMetadata.methods.children.find((method) => method.name.value === '__constructor__') || null;
  }

  getConstructorCompilationNodes(node) {
    const constructorDefinition = this.getConstructorDefinition(node);
    if (constructorDefinition && constructorDefinition.body) {
      return {
        bodyNode: constructorDefinition.body,
        ownerNode: constructorDefinition,
        originNode: constructorDefinition
      };
    }

    if (!this.compiler.scriptMode && node._analysis.inheritance.hasExtends) {
      return null;
    }

    const hasBodyChild = node.children.some((child) => !(child instanceof nodes.Extends));
    if (!hasBodyChild) {
      return null;
    }

    return {
      bodyNode: node,
      ownerNode: node,
      originNode: node
    };
  }

  hasLocalMethodDefinition(analysis, name) {
    if (!this.compiler.scriptMode) {
      return false;
    }
    const rootNode = this.compiler.analysis.getRootNode(analysis);
    return this.getMethodDefinitions(rootNode).some((method) => method.name.value === name);
  }

  getSharedDeclarations(node) {
    return node._analysis.inheritanceSharedDeclarations ?? [];
  }

  compileParticipantRootBody(node) {
    // TODO(Step 5): Replace this fail-fast body with the clean direct-render
    // lifecycle once instances can invoke __constructor__ through runtime state.
    // `env` is part of the final root ABI and will be used by that lifecycle.
    this.emit.line('void env;');
    this.emit.line(`cb(runtime.handleError(new Error("inheritance participant rendering is not implemented until the inheritance runtime lifecycle is available"), ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path));`);
    this.emit.line('return output;');
  }

  compileParticipantRootExport(node, rootCompileResult) {
    const methodEntries = this.compileCallableEntriesLiteral(node, rootCompileResult);
    this.emit.line(`const ${COMPILED_METHOD_ENTRIES_VAR} = ${methodEntries};`);
    this.emit.line(`const ${COMPILED_SHARED_SCHEMA_VAR} = ${this.compileSharedSchemaLiteral(node)};`);
    this.compileExtendsParentResolver(node);
    this.emit.line('return {');
    this.emit.line('root,');
    this.emit.line('inheritanceSpec: {');
    this.emit.line(`  methodEntries: ${COMPILED_METHOD_ENTRIES_VAR},`);
    this.emit.line(`  sharedSchema: ${COMPILED_SHARED_SCHEMA_VAR},`);
    this.emit.line(`  hasExtends: ${node._analysis.inheritance.hasExtends ? 'true' : 'false'}`);
    this.emit.line('},');
    this.emit.line('resolveInheritanceParent');
    this.emit.line('};');
  }

  computeRootInheritanceFacts(node) {
    const compiler = this.compiler;
    const allExtendsNodes = node.findAll(nodes.Extends);
    const extendsNodes = allExtendsNodes.filter((child) => !child.noParentLiteral);
    // The local syntax may be `extends none`; hasExtends only means a real parent is selected.
    const localExtendsNode = node.children.find((child) => child instanceof nodes.Extends) || null;
    const hasDynamicExtends = extendsNodes.some((child) => this.isDynamicExtendsNode(child));
    const hasExtends = extendsNodes.length > 0;
    const methodDefinitions = compiler.scriptMode ? this.getMethodDefinitions(node) : node.findAll(nodes.Block);
    const invokedMethodRefs = node._analysis.inheritanceInvokedMethodRefs ?? Object.create(null);

    const sharedDeclarations = this.getSharedDeclarations(node);
    const componentOperations = node.findAll(nodes.Component);
    const hasSuper = !!node._analysis.inheritanceHasSuper;
    const hasInheritedCalls = Object.keys(invokedMethodRefs).length > 0;
    const participates = !!(
      allExtendsNodes.length > 0 ||
      methodDefinitions.length > 0 ||
      sharedDeclarations.length > 0 ||
      componentOperations.length > 0 ||
      hasSuper ||
      hasInheritedCalls
    );

    return {
      hasExtends,
      hasDynamicExtends,
      localExtendsNode,
      participates,
      methodEntries: methodDefinitions.map((methodNode) => ({
        name: methodNode.name.value,
        signature: { argNames: this.getCallableSignature(methodNode).argNames }
      })),
      sharedSchemaInputs: sharedDeclarations.map((declaration) => ({
        name: declaration.name,
        type: declaration.type,
        hasDefault: !!declaration.initializer
      })),
      componentOperations,
      componentSharedObservations: []
    };
  }

  getInheritedMethodCallName(node) {
    return node instanceof nodes.LookupVal &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this' &&
      node.val instanceof nodes.Literal &&
      typeof node.val.value === 'string'
      ? node.val.value
      : null;
  }

  analyzeInheritedMethodCallTarget(nameNode) {
    return this.supportsInheritedMethodCalls()
      ? this.getInheritedMethodCallName(nameNode)
      : null;
  }

  analyzeInheritedMethodCall(node, analysisPass) {
    const methodName = node && node.name
      ? this.analyzeInheritedMethodCallTarget(node.name)
      : null;
    if (!methodName) {
      return null;
    }
    const thisSharedAccess = this.compiler.channel.probeThisSharedAccessFacts(
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
      (node.name._analysis || (node.name._analysis = {})).allowInheritedMethodCall = true;
      this.recordInheritedMethodCall(node, methodName);
    }
    return methodName;
  }

  analyzeSuper(node) {
    const rootAnalysis = this.getRootAnalysis(node._analysis);
    rootAnalysis.inheritanceHasSuper = true;
    const callableAnalysis = this.getNearestCallableAnalysis(node._analysis);
    if (callableAnalysis) {
      callableAnalysis.callableUsesSuper = true;
      if (!callableAnalysis.callableSuperOrigin) {
        callableAnalysis.callableSuperOrigin = this.compiler._createErrorContext(node);
      }
      return;
    }
    rootAnalysis.callableUsesSuper = true;
    if (!rootAnalysis.callableSuperOrigin) {
      rootAnalysis.callableSuperOrigin = this.compiler._createErrorContext(node);
    }
  }

  recordInheritedMethodCall(callNode, methodName) {
    const rootAnalysis = this.getRootAnalysis(callNode._analysis);
    this.recordInheritedMethodRef(rootAnalysis, 'inheritanceInvokedMethodRefs', methodName, callNode);
    const callableAnalysis = this.getNearestCallableAnalysis(callNode._analysis);
    if (callableAnalysis) {
      this.recordInheritedMethodRef(callableAnalysis, 'callableInvokedMethodRefs', methodName, callNode);
    } else {
      this.recordInheritedMethodRef(rootAnalysis, 'callableInvokedMethodRefs', methodName, callNode);
    }
  }

  recordInheritedMethodRef(analysis, fieldName, methodName, originNode) {
    if (!analysis[fieldName]) {
      analysis[fieldName] = Object.create(null);
    }
    if (!analysis[fieldName][methodName]) {
      analysis[fieldName][methodName] = {
        name: methodName,
        origin: this.compiler._createErrorContext(originNode)
      };
    }
  }

  getRootAnalysis(analysis) {
    let current = analysis;
    while (current.parent) {
      current = current.parent;
    }
    return current;
  }

  getNearestCallableAnalysis(analysis) {
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
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    this.emitInheritedMethodInvocation(methodName, node.args, errorContextJson);
    return true;
  }

  emitInheritedMethodInvocation(methodName, argsNode, errorContextJson) {
    if (!this.compiler.scriptMode) {
      this.emit('runtime.markSafe(');
    }
    this.emit(`runtime.invokeInheritedCallable(inheritanceState, "${methodName}", `);
    this.compiler._compileAggregate(argsNode, null, '[', ']', false, false);
    this.emit(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    if (!this.compiler.scriptMode) {
      this.emit(')');
    }
  }

  emitNamedArgBindings(argNodes, targetVarsVar) {
    argNodes.forEach((nameNode) => {
      const inputName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(inputName)}] = `);
      this.compiler.compileExpression(nameNode, null, nameNode, true);
      this.emit.line(';');
    });
  }

  analyzeBlock(node) {
    const compiler = this.compiler;
    const signature = this.getCallableSignature(node);
    const declares = [];
    const seenBlockArgNames = new Set();
    signature.argNameNodes.forEach((nameNode, index) => {
      nameNode._analysis = { ...nameNode._analysis, skipDeclarationOwner: node._analysis };
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
      node.body._analysis = {
        ...bodyAnalysis,
        declares: bodyDeclares
      };
    }
    const textChannel = !compiler.scriptMode
      ? compiler.analysis.getCurrentTextChannel(node._analysis)
      : null;
    return {
      createScope: true,
      scopeBoundary: true,
      parentReadOnly: true,
      uses: textChannel ? [textChannel] : [],
      mutates: textChannel ? [textChannel] : [],
      createsLinkedChildBuffer: true
    };
  }

  analyzeMethodDefinition(node) {
    const analysis = this.analyzeBlock(node);
    analysis.declares = [this.compiler.return.createChannelDeclaration()];
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

  emitBlockTextPlacement(node, id, emitValue) {
    this.emit(`${id} = `);
    emitValue();
    this.emit.line(';');
    const textCmdExpr = this.compiler.buffer._emitTemplateTextCommandExpression(id, node, true);
    this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.compiler.buffer.currentTextChannelName}");`);
    this.compiler.buffer.emitLimitedLoopCompletion(id, node);
  }

  compileBlock(node) {
    // We cannot use `!this.compiler.inBlock` here: async root compilation now
    // emits callable entries before the template body runs, so top-level block
    // definitions are already visited under the root-entry setup path. The
    // `isCompilingCallableEntry` answers whether we are compiling the callable
    // entry body itself, while `currentCallableDefinition` tracks the callable
    // owner used for visibility and super() validation inside that body.
    const isTopLevelTemplateBlock = !this.compiler.scriptMode && !this.compiler.isCompilingCallableEntry;
    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution.
    const rootNode = this.compiler.analysis.getRootNode(node._analysis);
    if (isTopLevelTemplateBlock && rootNode._analysis.inheritance.hasExtends) {
      return;
    }

    const id = this.compiler._tmpid();
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    const explicitBlockArgNodes = this.getCallableArgNodes(node);
    const explicitBlockArgsNode = new nodes.NodeList(node.lineno, node.colno, explicitBlockArgNodes);
    this.emit.line(`let ${id};`);
    this.emitBlockTextPlacement(node, id, () => {
      this.emitInheritedMethodInvocation(node.name.value, explicitBlockArgsNode, errorContextJson);
    });
  }

  emitRootSharedDeclarations(node) {
    const sharedDeclarations = this.getSharedDeclarations(node);
    sharedDeclarations.forEach((declaration) => {
      this.emitSharedDeclaration(declaration);
    });
  }

  emitSharedDeclaration(declaration) {
    this.emit(
      `runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedRootBuffer(${this.compiler.buffer.currentBuffer}, inheritanceState), ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context`
    );
    if (declaration.initializer) {
      this.emit(', ');
      this.compiler.compile(declaration.initializer, null);
    }
    this.emit.line(');');
  }

  compileExtendsParentResolver(node) {
    this.emit.line('async function resolveInheritanceParent(env, context, runtime, origin) {');
    const inheritanceFacts = node._analysis.inheritance;
    if (!inheritanceFacts.localExtendsNode || inheritanceFacts.localExtendsNode.noParentLiteral) {
      this.emit.line('  return runtime.noInheritanceParent();');
      this.emit.line('}');
      return;
    }

    const extendsNode = inheritanceFacts.localExtendsNode;
    const originJson = JSON.stringify(this.compiler._createErrorContext(extendsNode));
    const runtimeErrorContextJson = JSON.stringify({
      lineno: extendsNode.lineno,
      colno: extendsNode.colno,
      errorContextString: this.compiler._generateErrorContext(extendsNode)
    });
    this.emit.line(`  const parentOrigin = origin ?? ${originJson};`);
    if (this.isStaticExtendsNode(extendsNode)) {
      // Static targets are known non-null here, so null-target error context is
      // only needed by the dynamic branch.
      this.emit.line(`  return runtime.resolveInheritanceParent(env, ${this.compiler.scriptMode ? 'true' : 'false'}, ${JSON.stringify(extendsNode.template.value)}, parentOrigin, context);`);
    } else {
      this.emit('  const parentSelection = ');
      this.compiler.compileExpression(extendsNode.template, null, extendsNode.template, true);
      this.emit.line(';');
      this.emit.line(`  return runtime.resolveInheritanceParent(env, ${this.compiler.scriptMode ? 'true' : 'false'}, parentSelection, parentOrigin, context, ${runtimeErrorContextJson});`);
    }
    this.emit.line('}');
  }

  getOwnerContextPath() {
    return this.compiler.templateName ?? INLINE_SOURCE_OWNER_PATH;
  }

  getScriptMethodContextPath(callableNode) {
    const sourcePath = this.getOwnerContextPath();
    return `${sourcePath}#method:${callableNode.name.value}`;
  }

  compileConstructorEntry(node) {
    const constructorNodes = this.getConstructorCompilationNodes(node);
    if (!constructorNodes) {
      return null;
    }

    const extraParams = ['blockPayload = null', 'blockRenderCtx = undefined', 'inheritanceState = null', 'methodData'];
    this.emit.beginEntryFunction(constructorNodes.originNode, 'b___constructor__', null, extraParams);
    if (this.compiler.scriptMode) {
      this.compiler.return.emitDeclareChannel(this.compiler.buffer.currentBuffer);
    }
    // TODO(Step 5): Move participant root setup that belongs to constructor
    // execution, such as shared/runtime channel initialization, into this
    // prologue when the clean instance lifecycle invokes __constructor__.
    this.emitCallableEntryParentLinks(constructorNodes.originNode, this.compiler.scriptMode);
    this.withCallableBodyCompile(constructorNodes.ownerNode, () => {
      this.compiler._compileChildren(constructorNodes.bodyNode, null);
    });
    this.emitCallableEntryReturn(this.compiler.scriptMode);
    this.emit.endEntryFunction(constructorNodes.originNode, true);
    return constructorNodes;
  }

  getCallableArgNames(callableNode) {
    return this.getCallableSignature(callableNode).argNames;
  }

  getCallableArgNodes(callableNode) {
    return this.getCallableSignature(callableNode).placementArgNodes;
  }

  getCallableSignature(callableNode) {
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
      callableNode._analysis.callableSignatureFacts = signatureFacts;
    }
    return signatureFacts;
  }

  emitCallableArgInitialization(callableNode, options = {}) {
    const callableSignature = this.getCallableSignature(callableNode);
    const declaredCallableArgNames = Array.isArray(options.declaredCallableArgNames)
      ? options.declaredCallableArgNames
      : callableSignature.argNames;
    const payloadOriginalArgsVar = options.payloadOriginalArgsVar || this.compiler._tmpid();

    if (!options.payloadOriginalArgsVar) {
      this.emit.line(`const ${payloadOriginalArgsVar} = runtime.getInheritanceCallableOriginalArgs(blockPayload);`);
    }
    const keywordDefaultsByName = new Map(callableSignature.keywordDefaults.map((entry) => [entry.name, entry.valueNode]));
    const uniqueArgNames = Array.from(new Set(declaredCallableArgNames));
    // Declare all local argument channels before emitting init commands, so
    // default expressions can read any parameter channel in the callable frame.
    uniqueArgNames.forEach((name) => {
      this.compiler.channel.emitLocalVarChannelDeclaration(this.compiler.buffer.currentBuffer, name);
    });
    uniqueArgNames.forEach((name) => {
      this.compiler.channel.emitLocalVarChannelInit(
        this.compiler.buffer.currentBuffer,
        name,
        () => {
          this.emit(`Object.prototype.hasOwnProperty.call(${payloadOriginalArgsVar}, ${JSON.stringify(name)}) ? ${payloadOriginalArgsVar}[${JSON.stringify(name)}] : `);
          const defaultValueNode = keywordDefaultsByName.get(name);
          if (defaultValueNode) {
            this.compiler._compileExpression(defaultValueNode, null);
          } else {
            this.emit('undefined');
          }
        },
        callableNode
      );
      this.emit.line('');
    });
  }

  emitCallableEntryContextFork(callableNode, isScriptMethod, invocationPath, payloadOriginalArgsVar) {
    this.emit.line(
      `context = runtime.createInheritanceCallableContext(` +
      `context, ${isScriptMethod ? 'true' : 'false'}, ${invocationPath}, blockPayload, blockRenderCtx, ${payloadOriginalArgsVar}` +
      `);`
    );
  }

  emitCallableEntryParentLinks(callableNode, isScriptMethod) {
    this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
    this.emit.line(
      `runtime.linkCurrentBufferToParentChannels(` +
      `parentBuffer, ${this.compiler.buffer.currentBuffer}, ` +
      `runtime.getCallableLinkedChannels(methodData, ${JSON.stringify(this.compiler._createErrorContext(callableNode))}), ` +
      `runtime.getCallableMutatedChannels(methodData, ${JSON.stringify(this.compiler._createErrorContext(callableNode))})` +
      `);`
    );
    if (!isScriptMethod) {
      this.emit.line(`${this.compiler.buffer.currentTextChannelVar}._context = context;`);
    }
  }

  withCallableBodyCompile(callableNode, emitBody) {
    const previousCallableDefinition = this.compiler.currentCallableDefinition;
    const previousCompilingCallableEntry = this.compiler.isCompilingCallableEntry;
    this.compiler.currentCallableDefinition = callableNode;
    this.compiler.isCompilingCallableEntry = true;
    try {
      emitBody();
    } finally {
      this.compiler.currentCallableDefinition = previousCallableDefinition;
      this.compiler.isCompilingCallableEntry = previousCompilingCallableEntry;
    }
  }

  emitCallableEntryReturn(isScriptMethod) {
    if (isScriptMethod) {
      const resultVar = this.compiler._tmpid();
      this.compiler.return.emitFinalSnapshot(this.compiler.buffer.currentBuffer, resultVar);
      // Script methods still own their entry-local command-buffer lifetime.
      // The invocation command waits on the per-call invocation buffer after
      // this local buffer closes, so caller-visible completion still covers the
      // full inherited call.
      this.emit.line(`return runtime.normalizeFinalPromise(${resultVar});`);
      return;
    }

    this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`return ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot();`);
  }

  compileInheritedCallableEntry(callableNode) {
    const name = callableNode.name.value;
    const isScriptMethod = this.compiler.scriptMode;
    const invocationPath = isScriptMethod
      ? JSON.stringify(this.getScriptMethodContextPath(callableNode))
      : (this.compiler.templateName == null
        ? 'null'
        : JSON.stringify(String(this.compiler.templateName)));
    const declaredCallableArgNames = this.getCallableArgNames(callableNode);
    // This only wires the entry-local command buffer to its immediate parent
    // invocation buffer. Caller-side inherited invocation linking is resolved
    // separately from helper-resolved method metadata at runtime.
    const extraParams = ['blockPayload = null', 'blockRenderCtx = undefined', 'inheritanceState = null', 'methodData'];
    this.emit.beginEntryFunction(
      callableNode,
      `b_${name}`,
      null,
      extraParams
    );
    if (isScriptMethod) {
      this.compiler.return.emitDeclareChannel(this.compiler.buffer.currentBuffer);
    }
    const payloadOriginalArgsVar = this.compiler._tmpid();
    this.emit.line(`const ${payloadOriginalArgsVar} = runtime.getInheritanceCallableOriginalArgs(blockPayload);`);
    this.emitCallableEntryContextFork(callableNode, isScriptMethod, invocationPath, payloadOriginalArgsVar);
    this.emitCallableEntryParentLinks(callableNode, isScriptMethod);
    this.emitCallableArgInitialization(callableNode, {
      declaredCallableArgNames,
      payloadOriginalArgsVar
    });
    this.withCallableBodyCompile(callableNode, () => {
      this.compiler.compile(callableNode.body, null);
    });
    this.emitCallableEntryReturn(isScriptMethod);
    this.emit.endEntryFunction(callableNode, true);
  }

  compileInheritedCallableEntries(node) {
    const callableNames = new Set();
    const callableKind = this.compiler.scriptMode ? 'method' : 'block';
    const callables = this.compiler.scriptMode
      ? this.getMethodDefinitions(node)
      : node.findAll(nodes.Block);

    callables.forEach((callableNode) => {
      const name = callableNode.name.value;

      if (callableNames.has(name)) {
        this.compiler.fail(`${callableKind} "${name}" defined more than once.`, callableNode.lineno, callableNode.colno, callableNode);
      }
      callableNames.add(name);
      this.compileInheritedCallableEntry(callableNode);
    });

    return callables;
  }

  compileCallableEntriesLiteral(node, rootCompileResult) {
    const callables = rootCompileResult.blocks;
    const constructorEntry = rootCompileResult.constructorEntry;
    const methodEntries = callables.map((callableNode) => {
      const methodName = callableNode.name.value;
      return this.compileMethodEntryLiteral({
        methodName,
        fnExpr: `b_${methodName}`,
        ownerNode: callableNode,
        originNode: callableNode,
        isConstructor: false,
        superExpr: callableNode._analysis.callableUsesSuper ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(callableNode),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(callableNode._analysis.callableInvokedMethodRefs),
        signatureExpr: JSON.stringify({
          argNames: this.getCallableSignature(callableNode).argNames
        })
      });
    });

    if (constructorEntry) {
      const constructorOwnerNode = constructorEntry.ownerNode;
      methodEntries.push(this.compileMethodEntryLiteral({
        methodName: '__constructor__',
        fnExpr: 'b___constructor__',
        ownerNode: constructorOwnerNode,
        originNode: constructorEntry.originNode,
        isConstructor: true,
        superExpr: constructorOwnerNode._analysis.callableUsesSuper ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(constructorOwnerNode),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(constructorOwnerNode._analysis.callableInvokedMethodRefs),
        signatureExpr: JSON.stringify({ argNames: [] }),
      }));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  compileMethodEntryLiteral({ methodName, fnExpr, ownerNode, originNode, isConstructor, superExpr, superOriginExpr, invokedMethodRefsExpr, signatureExpr }) {
    const ownLinkedChannelNames = ownerNode._analysis.methodLinkedChannels ?? [];
    // Keep mutations separate from links so inherited/component calls can
    // later distinguish read-only participation from write barriers.
    const ownMutatedChannelNames = ownerNode._analysis.methodMutatedChannels ?? [];
    const ownLinkedChannels = JSON.stringify(ownLinkedChannelNames);
    const ownMutatedChannels = JSON.stringify(ownMutatedChannelNames);
    const origin = JSON.stringify(this.compiler._createErrorContext(originNode));
    return `${JSON.stringify(methodName)}: { name: ${JSON.stringify(methodName)}, fn: ${fnExpr}, signature: ${signatureExpr}, origin: ${origin}, isConstructor: ${isConstructor ? 'true' : 'false'}, super: ${superExpr}, superOrigin: ${superOriginExpr || 'null'}, invokedMethodRefs: ${invokedMethodRefsExpr || '{}'}, ownLinkedChannels: ${ownLinkedChannels}, ownMutatedChannels: ${ownMutatedChannels} }`;
  }

  compileInvokedMethodRefsLiteral(methodRefs) {
    if (!methodRefs) {
      return '{}';
    }
    const names = Object.keys(methodRefs);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(methodRefs[name])}`).join(', ')} }`;
  }

  compileCallableSuperOriginLiteral(callableNode) {
    return callableNode._analysis.callableSuperOrigin
      ? JSON.stringify(callableNode._analysis.callableSuperOrigin)
      : 'null';
  }

  compileSharedSchemaLiteral(node) {
    const sharedDeclarations = this.getSharedDeclarations(node);
    const entries = sharedDeclarations.map((child) => {
      const originNode = child.declarationOrigin ? child.declarationOrigin.node : node;
      return `${JSON.stringify(child.name)}: { ` +
        `type: ${JSON.stringify(child.type)}, ` +
        `origin: ${JSON.stringify(this.compiler._createErrorContext(originNode))}, ` +
        `hasDefault: ${child.initializer ? 'true' : 'false'} ` +
        `}`;
    });
    return `{ ${entries.join(', ')} }`;
  }

  createCallableChannelFootprint(ownerNode) {
    const bodyAnalysis = ownerNode.body ? ownerNode.body._analysis : ownerNode._analysis;
    // Mutation metadata stays separate for future read/write scheduling.
    // Parent-visible used channels are today's callable link footprint.
    const methodLinkedChannels = this.collectCallableChannelNames(bodyAnalysis.usedChannels ?? [], bodyAnalysis, ownerNode);
    const methodMutatedChannels = this.collectCallableChannelNames(bodyAnalysis.mutatedChannels ?? [], bodyAnalysis, ownerNode);
    return {
      methodLinkedChannels,
      methodMutatedChannels
    };
  }

  collectCallableChannelNames(channelNames, analysis, ownerNode) {
    return Array.from(channelNames).filter((name) => {
      if (!name || name === '__return__' || name === CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL) {
        return false;
      }
      const declaration = this.compiler.analysis.findDeclaration(analysis, name);
      if (declaration && (declaration.internal || declaration.blockArg)) {
        return false;
      }
      if (ownerNode) {
        const declarationOwner = this.compiler.analysis.findDeclarationOwner(analysis, name);
        if (declarationOwner === ownerNode._analysis) {
          return false;
        }
        if (
          this.compiler.scriptMode &&
          declaration &&
          !declaration.shared &&
          !declaration.imported
        ) {
          return false;
        }
        if (
          !this.compiler.scriptMode &&
          declaration &&
          declaration.type === 'var' &&
          !declaration.shared
        ) {
          return false;
        }
      }
      return true;
    });
  }

  // TODO(final cleanup): The clean async inheritance rebuild does not own sync
  // inheritance. Delete the sync inheritance methods below when the legacy sync
  // path is separated or removed.
  compileSyncBlock(node, frame) {
    const args = node.args && node.args.children ? node.args.children : [];
    if (args.length > 0) {
      this.compiler.fail(
        'block signatures are only supported in async mode',
        node.lineno,
        node.colno,
        node
      );
    }
    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution.
    if (!this.compiler.inBlock && this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends) {
      return;
    }


    // If we are executing outside a block (creating a top-level
    // block), we really don't want to execute its code because it
    // will execute twice: once when the child template runs and
    // again when the parent template runs. Note that blocks
    // within blocks will *always* execute immediately *and*
    // wherever else they are invoked (like used in a parent
    // template). This may have behavioral differences from jinja
    // because blocks can have side effects, but it seems like a
    // waste of performance to always execute huge top-level
    // blocks twice
    let id = this.compiler._tmpid();
    if (!this.compiler.inBlock) {
      this.emit('(parentTemplate ? function(e, c, f, r, cb) { cb(null, ""); } : ');
    }
    this.emit(`context.getBlock("${node.name.value}")`);
    if (!this.compiler.inBlock) {
      this.emit(')');
    }
    this.emit.line('(env, context, frame, runtime, ' + this.compiler._makeCallback(id));

    this.emit.line(`${this.compiler.buffer.currentBuffer} += ${id};`);
    this.emit.addScopeLevel();
  }

  compileExtends(node) {
    // Parent selection is emitted once in resolveInheritanceParent.
  }

  compileSyncExtends(node, frame) {
    if (node.noParentLiteral) {
      return;
    }

    const k = this.compiler._tmpid();
    const parentTemplateId = this.compiler.composition.compileSyncResolveTargetFile(node, frame, true, false, true);
    this.emit.line(`parentTemplate = ${parentTemplateId};`);
    this.emit.line('if (parentTemplate) {');
    this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
    this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this.emit.line('}');
    this.emit.line('}');
    this.emit.addScopeLevel();
  }

  compileSuper(node) {
    const name = node.blockName.value;
    const id = node.symbol ? node.symbol.value : null;
    const positionalArgsNode = this._getPositionalSuperArgsNode(node);
    const args = positionalArgsNode.children;
    const compilingBlock = this.compiler.currentCallableDefinition;
    const knownArgNames = compilingBlock ? this.getCallableArgNames(compilingBlock) : [];
    const isScriptMethod = this.compiler.scriptMode;

    if (args.length > knownArgNames.length) {
      this.compiler.fail(
        `super(...) for ${isScriptMethod ? 'method' : 'block'} "${name}" received too many arguments`,
        node.lineno,
        node.colno,
        node
      );
    }

    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    // TODO(Step 4): The clean super() path must use finalized methodData.super.
    // This source label is only for the transitional legacy helper bridge.
    const ownerPathJson = JSON.stringify(this.getOwnerContextPath());
    if (id) {
      this.emit(`let ${id} = `);
    } else if (!isScriptMethod) {
      this.emit('runtime.markSafe(');
    }
    this.emit(`runtime.invokeSuperCallable(inheritanceState, "${name}", ${ownerPathJson}, `);
    this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
    this.emit(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    if (!id) {
      if (!isScriptMethod) {
        this.emit(')');
      }
      return;
    }
    this.emit.line(';');
    if (!isScriptMethod) {
      this.emit.line(`${id} = runtime.markSafe(${id});`);
    }
  }

  compileSyncSuper(node, frame) {
    const args = node.args && node.args.children ? node.args.children : [];
    if (args.length > 0) {
      this.compiler.fail(
        'super(...) is only supported in async mode',
        node.lineno,
        node.colno,
        node
      );
      return;
    }
    this._compileSyncBareSuper(node, frame);
  }

  _compileSyncBareSuper(node, frame) {
    const name = node.blockName.value;
    const id = node.symbol.value;
    const cb = this.compiler._makeCallback(id);
    this.emit.line(`context.getSyncSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    this.emit.line(`${id} = runtime.markSafe(${id});`);
    this.emit.addScopeLevel();
  }

}

export {CompileInheritance};
