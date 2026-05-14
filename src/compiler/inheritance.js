
import * as nodes from '../language/nodes.js';
import {CompileBuffer} from './buffer.js';
const ROOT_STARTUP_PROMISE_VAR = '__rootStartupPromise';

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
    const sharedDeclarations = rootAnalysis.inheritanceSharedDeclarations || [];
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

  hasLocalMethodDefinition(analysis, name) {
    if (!this.compiler.scriptMode) {
      return false;
    }
    const rootNode = this.compiler.analysis.getRootNode(analysis);
    return this.getMethodDefinitions(rootNode).some((method) => method.name.value === name);
  }

  getSharedDeclarations(node) {
    return node._analysis.inheritanceSharedDeclarations || [];
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
    const invokedMethodRefs = node._analysis.inheritanceInvokedMethodRefs || Object.create(null);

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
        type: declaration.type
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
    }
  }

  recordInheritedMethodCall(callNode, methodName) {
    const rootAnalysis = this.getRootAnalysis(callNode._analysis);
    this.recordInheritedMethodRef(rootAnalysis, 'inheritanceInvokedMethodRefs', methodName, callNode);
    const callableAnalysis = this.getNearestCallableAnalysis(callNode._analysis);
    if (callableAnalysis) {
      this.recordInheritedMethodRef(callableAnalysis, 'callableInvokedMethodRefs', methodName, callNode);
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

  emitAsyncBlockTextPlacement(node, id, emitValue) {
    this.emit(`${id} = `);
    emitValue();
    this.emit.line(';');
    const textCmdExpr = this.compiler.buffer._emitTemplateTextCommandExpression(id, node, true);
    this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.compiler.buffer.currentTextChannelName}");`);
    this.compiler.buffer.emitLimitedLoopCompletion(id, node);
  }

  compileAsyncBlock(node) {
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
    // responsible for its execution. The dynamic extends case is handled later
    // with a runtime check using the per-render extendsState parent selection.
    if (isTopLevelTemplateBlock && this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends) {
      return;
    }

    const id = this.compiler._tmpid();
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    const explicitBlockArgNodes = this.getCallableArgNodes(node);
    const explicitBlockArgsNode = new nodes.NodeList(node.lineno, node.colno, explicitBlockArgNodes);
    // TODO(Step 1): Remove this per-block parent-readiness wrapper. The target
    // generated shape resolves the parent through resolveInheritanceParent
    // rather than checking extendsState inside block placement.
    const needsParentCheck = isTopLevelTemplateBlock && this.compiler.hasDynamicExtends;
    this.emit.line(`let ${id};`);
    if (needsParentCheck) {
      const parentPromiseVar = this.compiler._tmpid();
      this.emit.line(`const ${parentPromiseVar} = runtime.resolveSingle(extendsState && extendsState.parentSelection);`);
      this.emitAsyncBlockTextPlacement(node, id, () => {
        this.emit.line(`${parentPromiseVar}.then((parent) => {`);
        this.emit.line('  if (parent) return "";');
        this.emit.line('  if (inheritanceState) { inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context); }');
        this.emit('  return ');
        this.emitInheritedMethodInvocation(node.name.value, explicitBlockArgsNode, errorContextJson);
        this.emit.line(';');
        this.emit('})');
      });
    } else {
      this.emitAsyncBlockTextPlacement(node, id, () => {
        this.emitInheritedMethodInvocation(node.name.value, explicitBlockArgsNode, errorContextJson);
      });
    }
  }

  emitRootSharedDeclarations(node) {
    const sharedDeclarations = this.getSharedDeclarations(node);
    sharedDeclarations.forEach((declaration) => {
      this.emitSharedDeclaration(declaration);
    });
  }

  emitSharedDeclaration(declaration) {
    this.emit(
      `runtime.declareInheritanceSharedChannel(runtime.getInheritanceSharedBuffer(${this.compiler.buffer.currentBuffer}, inheritanceState), ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context`
    );
    if (declaration.initializer) {
      this.emit(', ');
      this.compiler.compile(declaration.initializer, null);
    }
    this.emit.line(');');
  }

  _getCallableInvocationPath(callableNode) {
    const ownerPath = this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName);
    return `${ownerPath}#method:${callableNode.name.value}`;
  }

  emitAsyncRootStateInitialization(compiledMethodEntriesVar, compiledSharedSchemaVar, compiledInvokedMethodRefsVar) {
    // TODO(Step 1): Delete/rewrite this old setup/startup bootstrap path.
    // The target ABI has metadata-only inheritanceSpec, no setup function, and
    // no cross-phase root startup lifecycle helper.
    if (!this.compiler.inheritanceParticipates) {
      this.emit.line('if (inheritanceState) {');
      this.emit.line('  inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context);');
      this.emit.line('}');
      return;
    }
    this.emit.line('if (!inheritanceState) {');
    this.emit.line('  inheritanceState = runtime.createInheritanceState();');
    this.emit.line('}');
    this.emit.line(`inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, ${compiledMethodEntriesVar}, ${compiledSharedSchemaVar}, ${compiledInvokedMethodRefsVar}, ${this.compiler.buffer.currentBuffer}, context);`);
    if (!this.compiler.hasExtends) {
      this.emit.line('inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context);');
    }
  }

  _withAsyncConstructorEntryState(isTemplateConstructor, emitBody) {
    const previousScopeClosers = this.emit.scopeClosers;

    this.compiler.buffer.withBufferState({
      currentBuffer: 'output',
      currentTextChannelVar: isTemplateConstructor ? 'output_textChannelVar' : null,
      currentTextChannelName: isTemplateConstructor ? CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL : null,
      currentWaitedChannelName: null
    }, () => {
      this.emit.scopeClosers = '';
      try {
        emitBody();
      } finally {
        this.emit.scopeClosers = previousScopeClosers;
      }
    });
  }

  compileAsyncConstructorEntry(node) {
    // TODO(Step 1): Rewrite constructor emission to the final callable entry
    // shape. The target constructor entry must not depend on setup/startup
    // lifecycle parameters.
    const isTemplateConstructor = !this.compiler.scriptMode;
    const constructorDefinition = this.getConstructorDefinition(node);

    this._withAsyncConstructorEntryState(isTemplateConstructor, () => {
      this.emit.line('function b___constructor__(env, context, runtime, cb, output, inheritanceState = null, extendsState = null) {');
      this.emit.line('try {');
      this.emit.line(`let ${ROOT_STARTUP_PROMISE_VAR} = null;`);
      if (isTemplateConstructor) {
        this.emit.line(`let ${this.compiler.buffer.currentTextChannelVar} = output.getChannel("${this.compiler.buffer.currentTextChannelName}");`);
        this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
        this.emit.line(`${this.compiler.buffer.currentTextChannelVar}._context = context;`);
      }
      const previousCallableDefinition = this.compiler.currentCallableDefinition;
      const previousCompilingCallableEntry = this.compiler.isCompilingCallableEntry;
      this.compiler.currentCallableDefinition = constructorDefinition;
      this.compiler.isCompilingCallableEntry = !!constructorDefinition;
      try {
        if (constructorDefinition && constructorDefinition.body && this.compiler.scriptMode) {
          this.emit.line(`__rootStartupPromise = b___scriptBody__(env, context, runtime, cb, output, inheritanceState, extendsState);`);
        } else if (constructorDefinition && constructorDefinition.body) {
          this.compiler._compileChildren(constructorDefinition.body, null);
        }
      } finally {
        this.compiler.currentCallableDefinition = previousCallableDefinition;
        this.compiler.isCompilingCallableEntry = previousCompilingCallableEntry;
      }
      this.emit.line(`return ${ROOT_STARTUP_PROMISE_VAR};`);
      this.emit.closeScopeLevels();
      this.emit.line('} catch (e) {');
      this.emit.line(`  throw runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line('}');
      this.emit.line('}');
    });
  }

  emitScriptRootLeafResult(node) {
    const returnVar = this.compiler._tmpid();
    // Startup work can now come from more than just extends-parent loading, so
    // root finalization must key off the actual pending startup promise.
    this.emit.line(`    if (${ROOT_STARTUP_PROMISE_VAR}) {`);
    this.emit.line(`      await ${ROOT_STARTUP_PROMISE_VAR};`);
    this.emit.line('    }');
    this.compiler.return.emitFinalSnapshot(this.compiler.buffer.currentBuffer, returnVar);
    this.emit.line(`    await ${this.compiler.buffer.currentBuffer}.getFinishedPromise();`);
    this.emit.line(`    if (inheritanceState && inheritanceState.sharedRootBuffer && inheritanceState.sharedRootBuffer !== ${this.compiler.buffer.currentBuffer}) {`);
    this.emit.line('      inheritanceState.sharedRootBuffer.finish();');
    this.emit.line('      await inheritanceState.sharedRootBuffer.getFinishedPromise();');
    this.emit.line('    }');
    this.emit.line(`    cb(null, runtime.normalizeFinalPromise(await ${returnVar}));`);
  }

  emitAsyncTemplateRootLeafResult() {
    this.emit.line(`    if (${ROOT_STARTUP_PROMISE_VAR}) {`);
    this.emit.line(`      await ${ROOT_STARTUP_PROMISE_VAR};`);
    this.emit.line('    }');
    this.emit.line(`    ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`    if (inheritanceState && inheritanceState.sharedRootBuffer && inheritanceState.sharedRootBuffer !== ${this.compiler.buffer.currentBuffer}) { inheritanceState.sharedRootBuffer.finish(); }`);
    this.emit.line(`    cb(null, await ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot());`);
  }

  _emitParentRootRender({ indent = '', templateExpr, compositionPayloadExpr, currentBufferExpr }) {
    const helperName = this.compiler.scriptMode
      ? 'bootstrapInheritanceParentScript'
      : 'renderInheritanceParentRoot';
    const targetKey = this.compiler.scriptMode ? 'scriptOrPromise' : 'templateOrPromise';
    this.emit.line(`${indent}await runtime.${helperName}({`);
    this.emit.line(`${indent}  ${targetKey}: ${templateExpr},`);
    this.emit.line(`${indent}  compositionPayload: ${compositionPayloadExpr},`);
    this.emit.line(`${indent}  context,`);
    this.emit.line(`${indent}  env,`);
    this.emit.line(`${indent}  runtime,`);
    this.emit.line(`${indent}  cb,`);
    this.emit.line(`${indent}  currentBuffer: ${currentBufferExpr},`);
    this.emit.line(`${indent}  inheritanceState`);
    this.emit.line(`${indent}});`);
  }

  _emitAsyncCompositionRootCompletion(node) {
    // TODO(Step 1): Remove this composition/lifecycle completion branch when
    // root emission switches to the target {rootFunction, inheritanceSpec,
    // resolveInheritanceParent} shape.
    this.emit.line(`} else if (componentMode) {`);
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('} else {');
    this.emit.line(`  if (${ROOT_STARTUP_PROMISE_VAR}) {`);
    this.emit.line(`    ${ROOT_STARTUP_PROMISE_VAR} = ${ROOT_STARTUP_PROMISE_VAR}.then(async () => {`);
    this.emit.line(`      ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`      return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('    }).catch((e) => {');
    this.emit.line(`      var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line('      cb(err);');
    this.emit.line('    });');
    this.emit.line(`    runtime.setInheritanceStartupPromise(inheritanceState, ${ROOT_STARTUP_PROMISE_VAR});`);
    this.emit.line('  } else {');
    this.emit.line(`    ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line('  }');
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('}');
  }

  emitAsyncRootCompletion(node) {
    const emitLeafResult = this.compiler.scriptMode
      ? () => this.emitScriptRootLeafResult(node)
      : () => this.emitAsyncTemplateRootLeafResult();

    this.emit.line('if (!compositionMode) {');
    this.emit.line('(async () => {');
    emitLeafResult();
    this.emit.line('})().catch(e => {');
    this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line('  cb(err);');
    this.emit.line('});');
    this._emitAsyncCompositionRootCompletion(node);
  }

  _emitExtendsCompositionPayload(extendsVarsVar, extendsRootContextVar, payloadVar) {
    // TODO(Step 1): Re-evaluate composition payload capture when parent
    // resolution moves into resolveInheritanceParent. This helper must not
    // grow support for removed `extends ... with ...` syntax.
    this.emit.line(`const ${payloadVar} = inheritanceState && inheritanceState.compositionPayload ? inheritanceState.compositionPayload : runtime.createCompositionPayload(${extendsRootContextVar}, ${extendsVarsVar});`);
    this.emit.line('if (inheritanceState && !inheritanceState.compositionPayload) {');
    this.emit.line(`  inheritanceState.compositionPayload = ${payloadVar};`);
    this.emit.line('}');
  }

  _prepareAsyncExtendsCompositionPayload(node, emitInputCapture) {
    const extendsVarsVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const compositionPayloadVar = this.compiler._tmpid();

    this.emit.line(`const ${extendsVarsVar} = {};`);
    emitInputCapture(extendsVarsVar);
    this.compiler.compositionPayload.emitContext(extendsRootContextVar, extendsVarsVar, true);
    this._emitExtendsCompositionPayload(
      extendsVarsVar,
      extendsRootContextVar,
      compositionPayloadVar
    );

    return {
      extendsVarsVar,
      extendsRootContextVar,
      compositionPayloadVar
    };
  }

  _emitTemplateExtendsBoundaryFromSelection(deferredSelectionVar) {
    // Template extends startup carries parent-render text placement only.
    // Shared reads/writes from inherited blocks are linked by the admitted
    // method invocation at the actual call site; linking shared lanes here
    // would move those observations to the earlier extends scheduling point.
    // In template mode this is the root text output lane.
    const linkedChannelsArg = JSON.stringify([this.compiler.buffer.currentTextChannelName]);
    const linkedMutatedChannelsArg = linkedChannelsArg;
    this.emit.line(`${ROOT_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, ${linkedMutatedChannelsArg}, context, cb, async (currentBuffer) => {`);
    const resolvedSelectionVar = this.compiler._tmpid();
    this.emit.line(`  const ${resolvedSelectionVar} = await runtime.resolveSingle(${deferredSelectionVar});`);
    this.emit.line(`  if (${resolvedSelectionVar}) {`);
    this._emitParentRootRender({
      indent: '    ',
      templateExpr: `${resolvedSelectionVar}.template`,
      compositionPayloadExpr: `${resolvedSelectionVar}.compositionPayload`,
      currentBufferExpr: 'currentBuffer'
    });
    this.emit.line('  }');
    this.emit.line('});');
  }

  getCallableArgNames(callableNode) {
    return this.getCallableSignature(callableNode).argNames;
  }

  getCallableArgNodes(callableNode) {
    return this.getCallableSignature(callableNode).placementArgNodes;
  }

  getCallableSignature(callableNode) {
    const signatureArgs = callableNode && callableNode.args && callableNode.args.children ? callableNode.args : new nodes.NodeList();
    const label = this.compiler.scriptMode ? 'method signature' : 'block signature';
    const allowNamedBindings = !this.compiler.scriptMode;
    const parsed = this.compiler._parseCallableSignature(signatureArgs, {
      allowKeywordArgs: allowNamedBindings,
      symbolsOnly: true,
      label,
      ownerNode: callableNode
    });
    if (!allowNamedBindings) {
      return {
        argNames: parsed.args.map((nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value)),
        argNameNodes: parsed.args,
        placementArgNodes: parsed.args
      };
    }

    if (parsed.kwargs && parsed.args.length > 0) {
      this.compiler.fail(
        'block placement arguments cannot mix positional and named bindings',
        parsed.kwargs.lineno,
        parsed.kwargs.colno,
        callableNode,
        parsed.kwargs
      );
    }

    if (parsed.kwargs) {
      const argNameNodes = [];
      const placementArgNodes = [];
      parsed.kwargs.children.forEach((pair) => {
        if (!(pair.key instanceof nodes.Symbol)) {
          this.compiler.fail(
            `${label} only supports identifier arguments`,
            pair.key.lineno,
            pair.key.colno,
            callableNode,
            pair.key
          );
        }
        argNameNodes.push(pair.key);
        placementArgNodes.push(pair.value);
      });
      return {
        argNames: argNameNodes.map((nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value)),
        argNameNodes,
        placementArgNodes
      };
    }

    return {
      argNames: parsed.args.map((nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value)),
      argNameNodes: parsed.args,
      placementArgNodes: parsed.args
    };
  }

  emitAsyncCallableArgInitialization(callableNode, options = {}) {
    const callableSignature = this.getCallableSignature(callableNode);
    const declaredCallableArgNames = Array.isArray(options.declaredCallableArgNames)
      ? options.declaredCallableArgNames
      : callableSignature.argNames;
    const staticLocalNames = Array.from(new Set(declaredCallableArgNames));
    const allLocalNamesVar = this.compiler._tmpid();
    const payloadOriginalArgsVar = options.payloadOriginalArgsVar || this.compiler._tmpid();

    this.emit.line(`const ${allLocalNamesVar} = ${JSON.stringify(staticLocalNames)};`);
    if (!options.payloadOriginalArgsVar) {
      this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};`);
    }
    this.emit.line(`if (${allLocalNamesVar}.length > 0) {`);
    this.emit.line(`for (const name of ${allLocalNamesVar}) {`);
    const argValueId = this.compiler._tmpid();
    this.emit.line(`  runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, name, "var", context, null);`);
    this.emit.line(`  const ${argValueId} = ${payloadOriginalArgsVar}[name];`);
    this.emit.line(`  ${this.compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: name, args: [${argValueId}], pos: {lineno: ${callableNode.lineno}, colno: ${callableNode.colno}} }), name);`);
    this.emit.line('}');
    this.emit.line('}');
  }

  emitCallableEntryContextFork(callableNode, isScriptMethod, invocationPath, payloadOriginalArgsVar) {
    if (isScriptMethod) {
      const methodBaseContextVar = this.compiler._tmpid();
      this.emit.line(`const ${methodBaseContextVar} = context.getCompositionContextVariables();`);
      this.emit.line(`context = context.forkForComposition(${invocationPath}, ${methodBaseContextVar}, (blockRenderCtx || undefined));`);
      return;
    }

    const signatureBaseContextVar = this.compiler._tmpid();
    const compositionPayloadContextVar = this.compiler._tmpid();
    const payloadContextVar = this.compiler._tmpid();
    this.emit.line(`const ${compositionPayloadContextVar} = context.getCompositionPayloadVariables() || {};`);
    this.emit.line(`const ${signatureBaseContextVar} = Object.assign({}, (blockRenderCtx || {}), ${compositionPayloadContextVar});`);
    this.emit.line(`const ${payloadContextVar} = Object.assign({}, ${signatureBaseContextVar}, ${payloadOriginalArgsVar});`);
    this.emit.line(`if (blockPayload !== null || blockRenderCtx !== undefined || Object.keys(${payloadContextVar}).length > 0) {`);
    this.emit.line(`  context = context.forkForComposition(${invocationPath}, ${payloadContextVar}, blockRenderCtx);`);
    this.emit.line('} else {');
    this.emit.line(`  context = context.forkForPath(${invocationPath});`);
    this.emit.line('}');
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

  withCallableEntryState(callableNode, emitBody) {
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
      this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
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
      ? JSON.stringify(this._getCallableInvocationPath(callableNode))
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
    this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};`);
    this.emitCallableEntryContextFork(callableNode, isScriptMethod, invocationPath, payloadOriginalArgsVar);
    this.emitCallableEntryParentLinks(callableNode, isScriptMethod);
    this.emitAsyncCallableArgInitialization(callableNode, {
      declaredCallableArgNames,
      payloadOriginalArgsVar
    });
    this.withCallableEntryState(callableNode, () => {
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

  compileCallableEntriesLiteral(node, callables) {
    const constructorDefinition = this.getConstructorDefinition(node);
    const ownerKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
    const methodEntries = callables.map((callableNode) => {
      const methodName = callableNode.name.value;
      return this.compileMethodEntryLiteral({
        methodName,
        fnExpr: `b_${methodName}`,
        ownerNode: callableNode,
        superExpr: callableNode._analysis.callableUsesSuper ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(callableNode),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(callableNode._analysis.callableInvokedMethodRefs),
        signatureExpr: JSON.stringify({
          argNames: this.getCallableSignature(callableNode).argNames
        }),
        ownerKey
      });
    });

    if (constructorDefinition) {
      methodEntries.push(this.compileMethodEntryLiteral({
        methodName: '__constructor__',
        fnExpr: 'b___constructor__',
        ownerNode: constructorDefinition,
        superExpr: constructorDefinition._analysis.callableUsesSuper ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(constructorDefinition),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(constructorDefinition._analysis.callableInvokedMethodRefs),
        signatureExpr: JSON.stringify({ argNames: [] }),
        ownerKey
      }));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  compileMethodEntryLiteral({ methodName, fnExpr, ownerNode, superExpr, superOriginExpr, invokedMethodRefsExpr, signatureExpr, ownerKey }) {
    const ownLinkedChannelNames = this._getCallableFootprintField(ownerNode, 'methodLinkedChannels');
    // Keep mutations separate from links so inherited/component calls can
    // later distinguish read-only participation from write barriers.
    const ownMutatedChannelNames = this._getCallableFootprintField(ownerNode, 'methodMutatedChannels');
    const ownLinkedChannels = JSON.stringify(ownLinkedChannelNames);
    const ownMutatedChannels = JSON.stringify(ownMutatedChannelNames);
    return `${JSON.stringify(methodName)}: { fn: ${fnExpr}, ownMutatedChannels: ${ownMutatedChannels}, ownLinkedChannels: ${ownLinkedChannels}, super: ${superExpr}, superOrigin: ${superOriginExpr || 'null'}, invokedMethodRefs: ${invokedMethodRefsExpr || '{}'}, signature: ${signatureExpr}, ownerKey: ${ownerKey} }`;
  }

  _getCallableFootprintField(ownerNode, fieldName) {
    if (fieldName !== 'methodLinkedChannels' && fieldName !== 'methodMutatedChannels') {
      throw new Error(`Unsupported method footprint field '${fieldName}'`);
    }
    if (!ownerNode || !ownerNode._analysis) {
      return [];
    }
    const channels = ownerNode._analysis[fieldName];
    if (!Array.isArray(channels)) {
      return [];
    }
    return channels;
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
    const fragments = ['{'];
    const sharedDeclarations = this.getSharedDeclarations(node);
    let needsComma = false;
    sharedDeclarations.forEach((child) => {
      if (needsComma) {
        fragments.push(', ');
      }
      fragments.push(
        `${JSON.stringify(child.name)}: ${JSON.stringify(child.type)}`
      );
      needsComma = true;
    });
    fragments.push('}');
    return fragments.join('');
  }

  createCallableChannelFootprint(ownerNode) {
    const bodyAnalysis = ownerNode && ownerNode.body && ownerNode.body._analysis;
    // Mutation metadata stays separate for future read/write scheduling.
    const methodLinkedChannels = this.collectCallableChannelNames(
      bodyAnalysis,
      ownerNode,
      'usedChannels' // Parent-visible used channels are today's callable link footprint.
    );
    const methodMutatedChannels = this.collectCallableChannelNames(bodyAnalysis, ownerNode, 'mutatedChannels');
    return {
      methodLinkedChannels,
      methodMutatedChannels
    };
  }

  collectCallableChannelNames(analysis, ownerNode, fieldName) {
    if (fieldName !== 'usedChannels' && fieldName !== 'mutatedChannels') {
      throw new Error(`Unsupported method channel footprint field '${fieldName}'`);
    }
    if (!analysis) {
      return [];
    }

    const channelNames = analysis[fieldName];
    if (!channelNames) {
      return [];
    }
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
    // responsible for its execution. The dynamic extends case is handled later
    // with a runtime check using the per-render extendsState parent selection.
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

  compileAsyncExtends(node) {
    if (node.noParentLiteral) {
      return;
    }

    if (this.compiler.scriptMode) {
      const {
        compositionPayloadVar
      } = this._prepareAsyncExtendsCompositionPayload(node, (extendsVarsVar) => {
        this.compiler.compositionPayload.emitCompiledInputs(node, extendsVarsVar);
      });

      const parentTemplateId = this.compiler.composition.compileAsyncResolveTargetFile(node, true, false, true);
      // Script inheritance startup links the chain-level shared schema known
      // at runtime after parent metadata has been bootstrapped. This is not a
      // local analysis fact for the extending script: parent schemas can arrive
      // dynamically, and this boundary must preserve post-extends constructor
      // ordering for the channels available at that runtime call site.
      const linkedChannelsArg = 'Object.keys((inheritanceState && inheritanceState.sharedSchema) || {})';
      const linkedMutatedChannelsArg = linkedChannelsArg;
      this.emit.line(`${ROOT_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, ${linkedMutatedChannelsArg}, context, cb, async (currentBuffer) => {`);
      this._emitParentRootRender({
        indent: '  ',
        templateExpr: parentTemplateId,
        compositionPayloadExpr: compositionPayloadVar,
        currentBufferExpr: 'currentBuffer'
      });
      this.emit.line('});');
      return;
    }

    const {
      compositionPayloadVar
    } = this._prepareAsyncExtendsCompositionPayload(node, (extendsVarsVar) => {
      this.compiler.compositionPayload.emitCurrentPositionInputs(node, extendsVarsVar);
    });
    const parentTemplateId = this.compiler.composition.compileAsyncResolveTargetFile(node, true, false, true);

    const deferredSelectionVar = this.compiler._tmpid();
    this.emit.line(`const ${deferredSelectionVar} = runtime.resolveSingle(${parentTemplateId}).then((resolvedParentTemplate) => {`);
    this.emit.line('  if (resolvedParentTemplate === null || resolvedParentTemplate === undefined) {');
    this.emit.line(`    throw runtime.handleError(new Error("template extends must select a parent template"), ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line('  }');
    this.emit.line(`  return { template: resolvedParentTemplate, compositionPayload: ${compositionPayloadVar} };`);
    this.emit.line('});');
    if (this.compiler.hasDynamicExtends) {
      this.emit.line(`if (extendsState) { extendsState.parentSelection = ${deferredSelectionVar}; }`);
      this._emitTemplateExtendsBoundaryFromSelection(deferredSelectionVar);
      return;
    }
    this.emit.line(`if (extendsState) { extendsState.parentSelection = ${deferredSelectionVar}; }`);
    this._emitTemplateExtendsBoundaryFromSelection(deferredSelectionVar);
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

  compileAsyncSuper(node) {
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
    const ownerKeyJson = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
    if (id) {
      this.emit(`let ${id} = `);
    } else if (!isScriptMethod) {
      this.emit('runtime.markSafe(');
    }
    this.emit(`runtime.invokeSuperCallable(inheritanceState, "${name}", ${ownerKeyJson}, `);
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
export {ROOT_STARTUP_PROMISE_VAR};
