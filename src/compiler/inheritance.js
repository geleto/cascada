
import * as nodes from '../language/nodes.js';
import {CompileBuffer} from './buffer.js';
const ROOT_STARTUP_PROMISE_VAR = '__rootStartupPromise';

/**
 * CompileInheritance - Handles template inheritance operations
 *
 * This module contains all the compiler methods related to template inheritance,
 * including extends, include, import, fromimport, and block operations.
 */

class CompileInheritance {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  supportsExplicitThisDispatch() {
    return !!(this.compiler.scriptMode || this.compiler.templateUsesInheritanceSurface);
  }

  getExplicitThisDispatchMethodName(node) {
    return node instanceof nodes.LookupVal &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this' &&
      node.val instanceof nodes.Literal &&
      typeof node.val.value === 'string'
      ? node.val.value
      : null;
  }

  analyzeExplicitThisDispatchLookup(nameNode) {
    return this.supportsExplicitThisDispatch()
      ? this.getExplicitThisDispatchMethodName(nameNode)
      : null;
  }

  analyzeExplicitThisDispatchCall(node, analysisPass) {
    const methodName = node && node.name
      ? this.analyzeExplicitThisDispatchLookup(node.name)
      : null;
    if (!methodName) {
      return null;
    }
    const thisSharedDispatch = this.compiler.channel.getThisSharedAccessFacts(
      node.name,
      analysisPass,
      node._analysis
    );
    return thisSharedDispatch ? null : methodName;
  }

  postAnalyzeExplicitThisDispatchCall(node, thisSharedFacts = null) {
    if (thisSharedFacts) {
      return null;
    }
    const methodName = node && node.name
      ? this.analyzeExplicitThisDispatchLookup(node.name)
      : null;
    if (methodName) {
      (node.name._analysis || (node.name._analysis = {})).allowExplicitThisDispatchCall = true;
    }
    return methodName;
  }

  validateBareExplicitThisDispatchLookup(node) {
    const methodName =
      node._analysis.explicitThisDispatchMethodName ||
      this.analyzeExplicitThisDispatchLookup(node);
    if (methodName && !node._analysis.allowExplicitThisDispatchCall) {
      this.compiler.fail(
        `bare inherited-method references are not supported; bare this.${methodName} references are not allowed; use this.${methodName}(...)`,
        node.lineno,
        node.colno,
        node
      );
    }
  }

  compileExplicitThisDispatchCall(node) {
    const methodName = node._analysis.explicitThisDispatchMethodName ?? null;
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
    this.emitInheritedInvocationArgs(argsNode);
    this.emit(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    if (!this.compiler.scriptMode) {
      this.emit(')');
    }
  }

  emitInheritedInvocationArgs(argsNode) {
    if (this.compiler.scriptMode) {
      this.compiler._compileAggregate(argsNode, null, '[', ']', false, false);
      return;
    }

    const children = argsNode && argsNode.children ? argsNode.children : [];
    this.emit('runtime.createArray([');
    children.forEach((argNode, index) => {
      if (index > 0) {
        this.emit(', ');
      }
      this.emitTemplateBlockPlacementArg(argNode);
    });
    this.emit('])');
  }

  emitTemplateBlockPlacementArg(argNode) {
    if (argNode instanceof nodes.Symbol) {
      const inputName = this.compiler.analysis.getBaseChannelName(argNode.value);
      this.emit(`runtime.resolveBlockPlacementArg(${JSON.stringify(inputName)}, ${this.compiler.buffer.currentBuffer}, context)`);
      return;
    }
    this.compiler.compileExpression(argNode, null, argNode, true);
  }

  emitNamedArgBindings(argNodes, targetVarsVar) {
    argNodes.forEach((nameNode) => {
      const inputName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(inputName)}] = `);
      this.compiler.compileExpression(nameNode, null, nameNode, true);
      this.emit.line(';');
    });
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
    const sharedDeclarations = this.compiler._getSharedDeclarations(node);
    sharedDeclarations.forEach((declaration) => {
      this.compiler.compileChannelDeclaration(declaration);
    });
  }

  _getMethodInvocationPath(methodNode) {
    const ownerPath = this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName);
    return `${ownerPath}#method:${methodNode.name.value}`;
  }

  _isScriptMethodEntry(node) {
    return !!(this.compiler.scriptMode && node instanceof nodes.MethodDefinition);
  }

  emitAsyncRootStateInitialization(compiledInheritanceSpecVar) {
    if (!this.compiler.needsInheritanceState) {
      this.emit.line('if (inheritanceState) {');
      this.emit.line('  inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context);');
      this.emit.line('}');
      return;
    }
    this.emit.line('if (!inheritanceState) {');
    this.emit.line('  inheritanceState = runtime.createInheritanceState();');
    this.emit.line('}');
    this.emit.line(`inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, ${compiledInheritanceSpecVar}, context);`);
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
    const isTemplateConstructor = !this.compiler.scriptMode;
    const constructorDefinition = this.compiler._getConstructorDefinition(node);

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
    if (this.compiler.hasDeferredDynamicExtends) {
      this._emitDynamicTemplateParentRender(`    `);
    }
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

  _emitDynamicTemplateParentRender(indent = '') {
    if (!this.compiler.hasDynamicExtends) {
      return;
    }
    const parentSelectionVar = this.compiler._tmpid();
    const parentPayloadVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${parentSelectionVar} = await runtime.resolveSingle(extendsState && extendsState.parentSelection);`);
    this.emit.line(`${indent}if (${parentSelectionVar}) {`);
    this.emit.line(`${indent}  const ${parentPayloadVar} = ${parentSelectionVar}.compositionPayload || (inheritanceState && inheritanceState.compositionPayload) || null;`);
    this._emitParentRootRender({
      indent: `${indent}  `,
      templateExpr: `${parentSelectionVar}.template`,
      compositionPayloadExpr: parentPayloadVar,
      currentBufferExpr: this.compiler.buffer.currentBuffer
    });
    this.emit.line(`${indent}}`);
  }

  _emitAsyncCompositionRootCompletion(node) {
    this.emit.line(`} else if (componentMode) {`);
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('} else {');
    this.emit.line(`  if (${ROOT_STARTUP_PROMISE_VAR}) {`);
    this.emit.line(`    ${ROOT_STARTUP_PROMISE_VAR} = ${ROOT_STARTUP_PROMISE_VAR}.then(async () => {`);
    if (this.compiler.hasDeferredDynamicExtends) {
      this._emitDynamicTemplateParentRender(`      `);
    }
    this.emit.line(`      ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`      return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('    }).catch((e) => {');
    this.emit.line(`      var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line('      cb(err);');
    this.emit.line('    });');
    this.emit.line(`    runtime.setInheritanceStartupPromise(inheritanceState, ${ROOT_STARTUP_PROMISE_VAR});`);
    this.emit.line('  } else {');
    if (this.compiler.hasDeferredDynamicExtends) {
      const finishPromiseVar = this.compiler._tmpid();
      this.emit.line(`    const ${finishPromiseVar} = (async () => {`);
      this._emitDynamicTemplateParentRender(`      `);
      this.emit.line(`      ${this.compiler.buffer.currentBuffer}.finish();`);
      this.emit.line(`      return ${this.compiler.buffer.currentBuffer};`);
      this.emit.line('    })();');
      this.emit.line(`    ${ROOT_STARTUP_PROMISE_VAR} = ${finishPromiseVar};`);
      this.emit.line(`    runtime.setInheritanceStartupPromise(inheritanceState, ${finishPromiseVar});`);
      this.emit.line(`    ${finishPromiseVar}.catch((e) => {`);
      this.emit.line(`      var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line('      cb(err);');
      this.emit.line('    });');
    } else {
      this.emit.line(`    ${this.compiler.buffer.currentBuffer}.finish();`);
    }
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

  _emitExtendsCompositionPayload(node, extendsVarsVar, extendsRootContextVar, payloadVar) {
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
    this.compiler.compositionPayload.emitContext(extendsRootContextVar, extendsVarsVar, node.withContext !== false);
    this._emitExtendsCompositionPayload(
      node,
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
    return this.getCallableSignature(callableNode).argNodes;
  }

  getCallableSignature(callableNode) {
    const signatureArgs = callableNode && callableNode.args && callableNode.args.children ? callableNode.args : new nodes.NodeList();
    const label = callableNode instanceof nodes.MethodDefinition ? 'method signature' : 'block signature';
    const parsed = this.compiler._parseCallableSignature(signatureArgs, {
      allowKeywordArgs: false,
      symbolsOnly: true,
      label,
      ownerNode: callableNode
    });
    return {
      argNames: parsed.args.map((nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value)),
      argNodes: parsed.args
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
      this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload?.originalArgs ?? {};`);
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

  compileAsyncCallableEntry(callableNode) {
    const name = callableNode.name.value;
    const isScriptMethod = this._isScriptMethodEntry(callableNode);
    const invocationPath = isScriptMethod
      ? JSON.stringify(this._getMethodInvocationPath(callableNode))
      : (this.compiler.templateName == null
        ? 'null'
        : JSON.stringify(String(this.compiler.templateName)));
    const declaredCallableArgNames = this.getCallableArgNames(callableNode);
    // This only wires the entry-local command buffer to its immediate parent
    // invocation buffer. Caller-side inherited dispatch linking is resolved
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
    this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload?.originalArgs ?? {};`);
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

  compileAsyncCallableEntries(node) {
    const callableNames = new Set();
    const callables = this.compiler.scriptMode
      ? this.compiler._getMethodDefinitions(node)
      : node.findAll(nodes.Block);

    callables.forEach((callableNode) => {
      const name = callableNode.name.value;

      if (callableNames.has(name)) {
        this.compiler.fail(`Block "${name}" defined more than once.`, callableNode.lineno, callableNode.colno, callableNode);
      }
      callableNames.add(name);
      this.compileAsyncCallableEntry(callableNode);
    });

    return callables;
  }

  collectCompiledMethodEntries(node, blocks) {
    const constructorDefinition = this.compiler._getConstructorDefinition(node);
    const ownerKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
    const methodEntries = blocks.map((block) => {
      const methodName = block.name.value;
      return this.compileMethodMetadataEntry({
        methodName,
        fnExpr: `b_${methodName}`,
        ownerNode: block,
        superExpr: this.blockUsesSuper(block) ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(block),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(this.collectDirectInvokedMethodRefsForCallable(block)),
        signatureExpr: JSON.stringify({
          argNames: this.getCallableSignature(block).argNames
        }),
        ownerKey
      });
    });

    if (constructorDefinition) {
      methodEntries.push(this.compileMethodMetadataEntry({
        methodName: '__constructor__',
        fnExpr: 'b___constructor__',
        ownerNode: constructorDefinition,
        superExpr: this.blockUsesSuper(constructorDefinition) ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(constructorDefinition),
        invokedMethodRefsExpr: this.compileInvokedMethodRefsLiteral(this.collectDirectInvokedMethodRefsForCallable(constructorDefinition)),
        signatureExpr: JSON.stringify({ argNames: [] }),
        ownerKey
      }));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  compileMethodMetadataEntry({ methodName, fnExpr, ownerNode, superExpr, superOriginExpr, invokedMethodRefsExpr, signatureExpr, ownerKey }) {
    const ownLinkedChannelNames = this._getMethodFootprintField(ownerNode, 'methodLinkedChannels');
    // Keep mutations separate from links so inherited/component calls can
    // later distinguish read-only participation from write barriers.
    const ownMutatedChannelNames = this._getMethodFootprintField(ownerNode, 'methodMutatedChannels');
    const ownLinkedChannels = JSON.stringify(ownLinkedChannelNames);
    const ownMutatedChannels = JSON.stringify(ownMutatedChannelNames);
    return `${JSON.stringify(methodName)}: { fn: ${fnExpr}, ownMutatedChannels: ${ownMutatedChannels}, ownLinkedChannels: ${ownLinkedChannels}, super: ${superExpr}, superOrigin: ${superOriginExpr || 'null'}, invokedMethodRefs: ${invokedMethodRefsExpr || '{}'}, signature: ${signatureExpr}, ownerKey: ${ownerKey} }`;
  }

  _getMethodFootprintField(ownerNode, fieldName) {
    if (fieldName !== 'methodLinkedChannels' && fieldName !== 'methodMutatedChannels') {
      throw new Error(`Unsupported method footprint field '${fieldName}'`);
    }
    const channels = ownerNode?._analysis?.[fieldName] ?? [];
    return Array.isArray(channels) ? channels : [];
  }

  collectDirectInvokedMethodRefsForCallable(callableNode) {
    const calls = this.collectDirectFunCallsForCallableBody(this.getCallableBodyNode(callableNode));
    return this.collectInvokedMethodRefsFromCalls(calls);
  }

  collectAllInvokedMethodRefsFromNode(sourceNode) {
    const calls = sourceNode && typeof sourceNode.findAll === 'function'
      ? sourceNode.findAll(nodes.FunCall)
      : [];
    return this.collectInvokedMethodRefsFromCalls(calls);
  }

  collectInvokedMethodRefsFromCalls(calls) {
    const refs = Object.create(null);
    calls.forEach((callNode) => {
      const methodName = this.getAnalyzedExplicitThisDispatchMethodName(callNode);
      if (methodName && !refs[methodName]) {
        refs[methodName] = {
          name: methodName,
          origin: this.compiler._createErrorContext(callNode)
        };
      }
    });
    return refs;
  }

  getAnalyzedExplicitThisDispatchMethodName(callNode) {
    return callNode &&
      callNode._analysis &&
      typeof callNode._analysis.explicitThisDispatchMethodName === 'string'
      ? callNode._analysis.explicitThisDispatchMethodName
      : null;
  }

  getCallableBodyNode(callableNode) {
    // Keep this helper callable-shaped so future macro metadata can reuse it
    // without accidentally traversing into nested callable boundaries.
    if (
      callableNode instanceof nodes.Block ||
      callableNode instanceof nodes.MethodDefinition ||
      callableNode instanceof nodes.Macro
    ) {
      return callableNode.body || null;
    }
    return callableNode;
  }

  collectDirectFunCallsForCallableBody(ownerNode, calls = []) {
    if (!ownerNode) {
      return calls;
    }
    if (Array.isArray(ownerNode)) {
      ownerNode.forEach((child) => this.collectDirectFunCallsForCallableBody(child, calls));
      return calls;
    }
    if (ownerNode instanceof nodes.Block || ownerNode instanceof nodes.MethodDefinition || ownerNode instanceof nodes.Macro) {
      return calls;
    }
    if (ownerNode instanceof nodes.FunCall) {
      calls.push(ownerNode);
    }
    if (ownerNode instanceof nodes.Node && typeof ownerNode.iterFields === 'function') {
      ownerNode.iterFields((value) => {
        this.collectDirectFunCallsForCallableBody(value, calls);
      });
    }
    return calls;
  }

  collectCompiledInvokedMethodRefs(node) {
    return this.compileInvokedMethodRefsLiteral(this.collectAllInvokedMethodRefsFromNode(node));
  }

  compileInvokedMethodRefsLiteral(methodRefs) {
    if (!methodRefs || typeof methodRefs !== 'object') {
      return '{}';
    }
    const names = Object.keys(methodRefs).filter(Boolean);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(methodRefs[name])}`).join(', ')} }`;
  }

  compileCallableSuperOriginLiteral(callableNode) {
    const bodyNode = this.getCallableBodyNode(callableNode);
    const superNodes = bodyNode && typeof bodyNode.findAll === 'function'
      ? bodyNode.findAll(nodes.Super)
      : [];
    if (superNodes.length === 0) {
      return 'null';
    }
    return JSON.stringify(this.compiler._createErrorContext(superNodes[0]));
  }

  compileSharedSchemaLiteral(node) {
    const fragments = ['{'];
    const sharedDeclarations = this.compiler._getSharedDeclarations(node);
    let needsComma = false;
    sharedDeclarations.forEach((child) => {
      if (needsComma) {
        fragments.push(', ');
      }
      fragments.push(`${JSON.stringify(child.name.value)}: ${JSON.stringify(child.channelType)}`);
      needsComma = true;
    });
    fragments.push('}');
    return fragments.join('');
  }

  blockUsesSuper(block) {
    return !!(block && block.body && block.body.findAll(nodes.Super).length > 0);
  }

  createMethodChannelFootprint(ownerNode) {
    const bodyAnalysis = ownerNode && ownerNode.body && ownerNode.body._analysis;
    // Mutation metadata stays separate for future read/write scheduling.
    const methodLinkedChannels = this.collectMethodChannelNames(
      bodyAnalysis,
      ownerNode,
      'usedChannels' // Parent-visible used channels are today's callable link footprint.
    );
    const methodMutatedChannels = this.collectMethodChannelNames(bodyAnalysis, ownerNode, 'mutatedChannels');
    return {
      methodLinkedChannels,
      methodMutatedChannels
    };
  }

  collectMethodChannelNames(analysis, ownerNode, fieldName) {
    if (fieldName !== 'usedChannels' && fieldName !== 'mutatedChannels') {
      throw new Error(`Unsupported method channel footprint field '${fieldName}'`);
    }
    if (!analysis) {
      return [];
    }

    return Array.from(analysis[fieldName] ?? []).filter((name) => {
      if (!name || name === '__return__' || name === CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL) {
        return false;
      }
      const declaration = this.compiler.analysis.findDeclaration(analysis, name);
      if (declaration && (declaration.internal || declaration.blockArg)) {
        return false;
      }
      if (ownerNode && (ownerNode instanceof nodes.Block || ownerNode instanceof nodes.MethodDefinition)) {
        const declarationOwner = this.compiler.analysis.findDeclarationOwner(analysis, name);
        if (declarationOwner === ownerNode._analysis) {
          return false;
        }
        if (
          ownerNode instanceof nodes.MethodDefinition &&
          declaration &&
          !declaration.shared &&
          !declaration.imported
        ) {
          return false;
        }
        if (
          ownerNode instanceof nodes.Block &&
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
    this.emit.line('    return null;');
    this.emit.line('  }');
    this.emit.line(`  return { template: resolvedParentTemplate, compositionPayload: ${compositionPayloadVar} };`);
    this.emit.line('});');
    if (this.compiler.hasDynamicExtends) {
      const isTopLevelDynamicExtends =
        !!(this.compiler.topLevelDynamicExtends && this.compiler.topLevelDynamicExtends.has(node));
      this.emit.line(`if (extendsState) { extendsState.parentSelection = ${deferredSelectionVar}; }`);
      if (!isTopLevelDynamicExtends) {
        return;
      }
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
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (node.withContext !== null || withVars.length > 0 || node.withValue) {
      this.compiler.fail(
        'extends with explicit composition inputs is not supported in sync mode',
        node.lineno,
        node.colno,
        node
      );
    }
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
    const isScriptMethod = this.compiler.scriptMode && this._isScriptMethodEntry(compilingBlock);

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
