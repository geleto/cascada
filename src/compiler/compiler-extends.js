'use strict';

const nodes = require('../nodes');
const inheritanceConstants = require('../inheritance-constants');
const CompileBuffer = require('./buffer');

const { DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME, RETURN_CHANNEL_NAME } = inheritanceConstants;

// Generated-code indentation in this file is controlled by explicit `indent`
// string threading. Keep new helpers on that pattern for consistency.
class CompileExtends {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  getDynamicParentTemplateChannelName() {
    return DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME;
  }

  getDynamicExtendsChannelAnalysis() {
    const channelName = this.getDynamicParentTemplateChannelName();
    return {
      uses: [channelName],
      mutates: [channelName]
    };
  }

  isDynamicParentTemplateBinding(node, requiredVarType = null) {
    return !!(
      node instanceof nodes.Set &&
      (!requiredVarType || node.varType === requiredVarType) &&
      node.targets &&
      node.targets[0] &&
      node.targets[0].value === this.getDynamicParentTemplateChannelName()
    );
  }

  usesDynamicParentTemplateBridge(node) {
    if (node && node.dynamicParentStoreVar) {
      return true;
    }

    let cursor = node;
    while (cursor && cursor._analysis && cursor._analysis.parent) {
      cursor = cursor._analysis.parent.node;
    }

    const rootNode = cursor instanceof nodes.Root ? cursor : null;
    if (!rootNode || !Array.isArray(rootNode.children)) {
      return false;
    }

    return rootNode.children.some((child) => this.isDynamicParentTemplateBinding(child, 'declaration'));
  }

  emitCompiledMethodEntryValue(method) {
    this.emit(`{ fn: ${method.functionName}, kind: ${JSON.stringify(method.kind || 'method')}, contract: ${JSON.stringify(method.contract)}, ownerKey: ${JSON.stringify(method.ownerKey)}, linkedChannels: ${JSON.stringify(method.linkedChannels || [])} }`);
  }

  emitCompiledMethodsLiteral(compiledMethods, indent = '') {
    this.emit.line(`${indent}{`);
    Object.keys(compiledMethods || {}).forEach((name) => {
      const method = compiledMethods[name];
      this.emit(`${indent}  ${JSON.stringify(name)}: `);
      this.emitCompiledMethodEntryValue(method);
      this.emit.line(',');
    });
    this.emit.line(`${indent}}`);
  }

  collectBlockContracts(node) {
    const contracts = {};
    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const signature = this.compiler._getBlockSignature(block);
      contracts[block.name.value] = {
        inputNames: signature.inputNames,
        withContext: !!block.withContext
      };
    });

    return contracts;
  }

  emitInheritanceLocalCaptureSnapshot(node, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const contextExpr = options && options.contextExpr ? options.contextExpr : 'context';
    const bufferExpr = options && options.bufferExpr ? options.bufferExpr : this.compiler.buffer.currentBuffer;
    const templateLocalCaptures = this.compiler._collectTemplateInheritanceCaptureNames(node);
    if (templateLocalCaptures.length === 0) {
      return;
    }
    const templateKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
    const templateLocalCapturesVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${templateLocalCapturesVar} = {};`);
    templateLocalCaptures.forEach((name) => {
      const helperName = this.compiler.scriptMode
        ? 'captureCompositionScriptValue'
        : 'captureCompositionValue';
      this.emit(`${indent}${templateLocalCapturesVar}[${JSON.stringify(name)}] = runtime.${helperName}(${contextExpr}, ${JSON.stringify(name)}, ${bufferExpr}`);
      if (this.compiler.scriptMode) {
        this.emit(`, { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node))}, path: ${contextExpr}.path }`);
      }
      this.emit.line(');');
    });
    this.emit.line(`${indent}${contextExpr}.setTemplateLocalCaptures(${templateKey}, ${templateLocalCapturesVar});`);
  }

  _emitImmediateExternInputs(node, targetVarsVar) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const externName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      const helperName = this.compiler.scriptMode
        ? 'captureCompositionScriptValue'
        : 'captureCompositionValue';
      this.emit(`${targetVarsVar}[${JSON.stringify(externName)}] = runtime.${helperName}(context, ${JSON.stringify(externName)}, ${this.compiler.buffer.currentBuffer}`);
      if (this.compiler.scriptMode) {
        this.emit(`, { lineno: ${nameNode.lineno}, colno: ${nameNode.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node, nameNode))}, path: context.path }`);
      }
      this.emit.line(');');
    });
  }

  _emitCompositionContextObject(node, explicitVarsVar, compositionCtxVar, explicitNamesVar = null, includeRenderContext = !!node.withContext) {
    this.emit.line(`const ${compositionCtxVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${compositionCtxVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${compositionCtxVar}, ${explicitVarsVar});`);
    if (explicitNamesVar) {
      this.emit.line(`const ${explicitNamesVar} = Object.keys(${explicitVarsVar});`);
    }
  }

  _emitExtendsContextSetup(node, extendsVarsVar, extendsInputValuesVar, extendsInputNamesVar, extendsRootContextVar) {
    this.emit.line(`const ${extendsVarsVar} = {};`);
    this._emitImmediateExternInputs(node, extendsVarsVar);
    // Keep two distinct views on purpose:
    // inputValues is the explicit named-input set captured at the extends site
    // (validated as externs on the legacy path, or as shared preloads on the
    // new static script path), while rootContext preserves the full inherited
    // constructor context the ancestor should execute against.
    this._emitCompositionContextObject(node, extendsVarsVar, extendsInputValuesVar, extendsInputNamesVar, !!node.withContext);
    this._emitCompositionContextObject(node, extendsVarsVar, extendsRootContextVar, null, true);
  }

  _emitParentCompositionContext(parentTemplateVar, parentContextVar, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const contextExpr = options && options.contextExpr ? options.contextExpr : 'context';
    const extendsCompositionVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${extendsCompositionVar} = ${contextExpr}.getExtendsComposition(${parentTemplateVar});`);
    this.emit.line(`${indent}const ${parentContextVar} = ${extendsCompositionVar}`);
    this.emit.line(`${indent}  ? ${contextExpr}.forkForComposition(${parentTemplateVar}.path, ${extendsCompositionVar}.rootContext, ${contextExpr}.getRenderContextVariables(), ${extendsCompositionVar}.externContext)`);
    this.emit.line(`${indent}  : ${contextExpr}.forkForPath(${parentTemplateVar}.path);`);
  }

  _emitDynamicParentTemplateResolution(bufferExpr, parentVar, indent = '') {
    this.emit.line(`${indent}runtime.resolveDynamicParentTemplate(${bufferExpr}).then((${parentVar}) => {`);
  }

  emitDynamicParentTemplateStore(node, parentTemplateExpr, bufferExpr = null, indent = '') {
    const targetBufferExpr = bufferExpr || this.compiler.buffer.currentBuffer;
    const channelName = this.getDynamicParentTemplateChannelName();
    this.emit.line(`${indent}${targetBufferExpr}.add(new runtime.VarCommand({ channelName: '${channelName}', args: [${parentTemplateExpr}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${channelName}');`);
  }

  emitDynamicParentTemplateStoreWait(storeVar, parentTemplateExpr, indent = '') {
    this.emit.line(`${indent}let ${storeVar} = runtime.bridgeDynamicParentTemplate(inheritanceState, ${parentTemplateExpr});`);
  }

  emitDynamicTopLevelBlockResolution(node, resultVar, blockPayloadExpr, blockRenderCtxExpr, indent = '') {
    this.emit.line(
      `${indent}${resultVar} = runtime.renderDynamicTopLevelBlock(` +
      `${JSON.stringify(node.name.value)}, context, ${this.compiler.buffer.currentBuffer}, env, runtime, cb, inheritanceState, ${blockPayloadExpr}, ${blockRenderCtxExpr});`
    );
  }

  _emitDynamicRootStartupCompletion(node, options = null) {
    const opts = options || {};
    const indent = opts.indent || '';
    const completionVar = opts.completionVar || this.compiler._tmpid();
    const parentVar = opts.parentVar || this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();

    this.emit(`${indent}const ${completionVar} = `);
    this._emitDynamicParentTemplateResolution(this.compiler.buffer.currentBuffer, parentVar, '');
    this.emit.line(`${indent}  if (${parentVar}) {`);
    if (opts.captureInheritanceLocals) {
      this.emitInheritanceLocalCaptureSnapshot(node, {
        indent: `${indent}    `,
        contextExpr: 'context',
        bufferExpr: this.compiler.buffer.currentBuffer
      });
    }
    this._emitParentCompositionContext(parentVar, parentContextVar, {
      indent: `${indent}    `,
      contextExpr: 'context'
    });
    this._emitParentConstructorHandoff(
      node,
      parentVar,
      parentContextVar,
      this.compiler.buffer.currentBuffer,
      {
        indent: `${indent}    `,
        dynamicRootMode: 'await_completion',
        returnConstructorCompletion: true
      }
    );
    this.emit.line(`${indent}  }`);
    this.emit.line(`${indent}  return null;`);
    this.emit.line(`${indent}});`);

    return completionVar;
  }

  _emitDynamicRootCompletionBranch(node, options = null) {
    const opts = options || {};
    const indent = opts.indent || '';
    const completionVar = this._emitDynamicRootStartupCompletion(node, {
      indent,
      captureInheritanceLocals: !!opts.captureInheritanceLocals
    });

    this._emitRootOutcome(
      node,
      Object.assign({}, opts.outcome || {}, { completionGateVar: completionVar }),
      indent
    );
  }

  _emitDynamicParentRootFinalization(node) {
    if (this.compiler.scriptMode || !this.compiler.hasDynamicExtends) {
      throw new Error('Compiler invariant: dynamic parent root finalization is only valid for dynamic template roots');
    }

    this.emit.line('if (!compositionMode) {');
    this._emitDynamicRootCompletionBranch(node, {
      indent: '  ',
      captureInheritanceLocals: true,
      outcome: { kind: 'text' }
    });
    this.emit.line('} else {');
    this._emitDynamicRootCompletionBranch(node, {
      indent: '  ',
      outcome: { kind: 'buffer' }
    });
    this.emit.line('}');
  }

  _compileDynamicParentRootBody(node) {
    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${this.getDynamicParentTemplateChannelName()}", "var", context, null);`);
    this.compiler._emitRootSequenceLockDeclarations(node);
    this.compiler._emitRootExternInitialization(node);
    this.compiler._compileChildren(node, null);
    this.emit.line('context.resolveExports();');
    this._emitDynamicParentRootFinalization(node);
  }

  emitInheritedMethodCall(node) {
    const explicitCall = this.getExplicitInheritedMethodCall(node);
    if (!explicitCall) {
      return false;
    }
    const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
    this.emit(`runtime.callInheritedMethod(context, inheritanceState, ${JSON.stringify(explicitCall.methodName)}, `);
    this.compiler._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    return true;
  }

  isExplicitInheritedMethodLookup(node) {
    return !!(
      this.compiler.scriptMode &&
      node instanceof nodes.LookupVal &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this'
    );
  }

  getExplicitInheritedMethodCall(node) {
    if (!this.isExplicitInheritedMethodLookup(node && node.name)) {
      return null;
    }
    const nameNode = node.name.val;
    const methodName = nameNode instanceof nodes.Symbol || nameNode instanceof nodes.Literal
      ? nameNode.value
      : null;
    if (!methodName || typeof methodName !== 'string') {
      this.compiler.fail(
        '`this.method(...)` requires a direct method name',
        node.lineno,
        node.colno,
        node
      );
    }
    return {
      methodName
    };
  }

  _emitResolvedParentContinuation(node, templateVar, parentContextVar, rootContextVar, externContextVar, currentBufferExpr, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const allowDynamicRoot = !!(options && options.allowDynamicRoot);

    this.emit.line(`${indent}const ${parentContextVar} = context.forkForComposition(${templateVar}.path, ${rootContextVar}, context.getRenderContextVariables(), ${externContextVar});`);
    this._emitParentConstructorHandoff(
      node,
      templateVar,
      parentContextVar,
      currentBufferExpr,
      { indent, dynamicRootMode: allowDynamicRoot ? 'fire_and_forget' : 'none' }
    );
  }

  _emitParentConstructorHandoff(node, templateExpr, parentContextExpr, currentBufferExpr, options = null) {
    const opts = options || {};
    const indent = opts.indent || '';
    const shouldAwaitCompletion = (opts.dynamicRootMode || 'none') === 'await_completion' || !!opts.returnConstructorCompletion;
    const errorContextJson = JSON.stringify(this.compiler._generateErrorContext(node));
    const startVar = this.compiler._tmpid();

    this.emit.line(
      `${indent}const ${startVar} = runtime.startParentConstructor(` +
      `${templateExpr}, context, ${parentContextExpr}, inheritanceState, env, runtime, cb, ${currentBufferExpr}, ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${errorContextJson}, path: ${parentContextExpr}.path }, ` +
      `{ awaitCompletion: ${JSON.stringify(shouldAwaitCompletion)} });`
    );
    if (shouldAwaitCompletion) {
      this.emit.line(`${indent}return ${startVar};`);
    }
  }

  _emitStaticExtendsAsyncBoundary(node, options = null) {
    const opts = options || {};
    const k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsInputNamesVar = this.compiler._tmpid();
    const extendsInputContextVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const templateVar = this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();
    const parentTemplateId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, true, false);
    const prevBuffer = this.compiler.buffer.currentBuffer;

    this._emitExtendsContextSetup(
      node,
      extendsVarsVar,
      extendsInputContextVar,
      extendsInputNamesVar,
      extendsRootContextVar
    );
    this.emit.line('runtime.beginInheritanceResolution(inheritanceState);');
    if (Array.isArray(opts.leadingCommentLines)) {
      opts.leadingCommentLines.forEach((line) => {
        this.emit.line(line);
      });
    }
    const linkedChannelsLiteral = this.compiler.emit.linkedChannelsLiteral(opts.linkedChannels || []);
    this.emit(`runtime.runControlFlowBoundary(${prevBuffer}, ${linkedChannelsLiteral}, context, cb, async (currentBuffer) => {`);
    this.emit.asyncClosureDepth++;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.emit.line('try {');
    this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
    this.emit.line(`  ${templateVar}.compile();`);
    if (typeof opts.emitInputSetup === 'function') {
      opts.emitInputSetup({
        templateVar,
        currentBufferExpr: 'currentBuffer',
        inputNamesVar: extendsInputNamesVar,
        inputContextVar: extendsInputContextVar
      });
    }
    this.emit.line(`  for (let ${k} in ${templateVar}.blocks) {`);
    this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
    this.emit.line('  }');
    this._emitResolvedParentContinuation(
      node,
      templateVar,
      parentContextVar,
      extendsRootContextVar,
      extendsInputContextVar,
      'currentBuffer',
      { indent: '  ', allowDynamicRoot: !!opts.allowDynamicRoot }
    );
    this.emit.line('} finally {');
    this.emit.line('  runtime.finishInheritanceResolution(inheritanceState);');
    this.emit.line('}');
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.emit.asyncClosureDepth--;
    this.emit.line('});');
  }

  compileAsyncStaticRootExtends(node, scriptRootNode, rootSharedChannelNames = []) {
    const linkedChannels = this.compiler.emit.getLinkedChannels(scriptRootNode, {
      includeDeclaredChannelNames: rootSharedChannelNames
    });

    this._emitStaticExtendsAsyncBoundary(node, {
      linkedChannels,
      leadingCommentLines: [
        '// Step 4 still reuses the existing composition-context setup for',
        '// parent execution, but named extends inputs are now validated and',
        '// preloaded through shared-schema bootstrap rather than extern slots.'
      ],
      emitInputSetup: ({ templateVar, currentBufferExpr, inputContextVar }) => {
        this.emit.line(`  runtime.preloadSharedInputs(${templateVar}.sharedSchema || [], ${inputContextVar}, ${currentBufferExpr}, context, { lineno: ${node.lineno}, colno: ${node.colno} });`);
      }
    });
  }

  compileAsyncStaticTemplateExtends(node) {
    this._emitStaticExtendsAsyncBoundary(node, {
      linkedChannels: [CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL],
      allowDynamicRoot: true,
      emitInputSetup: ({ templateVar, inputNamesVar, inputContextVar }) => {
        this.emit.line(`  runtime.validateExternInputs(${templateVar}.externSpec || [], ${inputNamesVar}, Object.keys(${inputContextVar}), "extends");`);
      }
    });
  }

  compileAsyncDynamicTemplateExtends(node) {
    const k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsExternInputNamesVar = this.compiler._tmpid();
    const extendsExternContextVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();

    this.emit.line('runtime.beginInheritanceResolution(inheritanceState);');
    this._emitExtendsContextSetup(
      node,
      extendsVarsVar,
      extendsExternContextVar,
      extendsExternInputNamesVar,
      extendsRootContextVar
    );
    const parentTemplateId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, true, false);

    if (node.dynamicParentStoreVar) {
      this.emitDynamicParentTemplateStoreWait(node.dynamicParentStoreVar, parentTemplateId);
    }
    this.compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const templateVar = this.compiler._tmpid();
      this.emit.line('try {');
      if (!node.dynamicParentStoreVar) {
        this.emitDynamicParentTemplateStore(node, parentTemplateId, this.compiler.buffer.currentBuffer, '  ');
      }
      this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
      this.emit.line(`  ${templateVar}.compile();`);
      if (this.compiler.scriptMode) {
        this.emit.line(`  runtime.bootstrapInheritanceMetadata(inheritanceState, ${templateVar}.methods || {}, ${templateVar}.sharedSchema || [], ${templateVar}.path, ${this.compiler.buffer.currentBuffer}, context);`);
      }
      this.emit.line(`  runtime.validateExternInputs(${templateVar}.externSpec || [], ${extendsExternInputNamesVar}, Object.keys(${extendsExternContextVar}), "extends");`);
      this.emit.line(`  context.setExtendsComposition(${templateVar}, ${extendsRootContextVar}, ${extendsExternContextVar});`);
      this.emit.line(`  for(let ${k} in ${templateVar}.blocks) {`);
      this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
      this.emit.line('  }');
      this.emit.line('} finally {');
      this.emit.line('  runtime.finishInheritanceResolution(inheritanceState);');
      this.emit.line('}');
    });
    if (node.dynamicParentStoreVar) {
      this.emitDynamicParentTemplateStore(node, node.dynamicParentStoreVar, this.compiler.buffer.currentBuffer);
    }
  }

  compileAsyncExtends(node) {
    return this.compileAsyncDynamicTemplateExtends(node);
  }

  _emitRootInheritanceBootstrap(compiledMethods, rootSharedSchema) {
    const hasCompiledMethods = this.compiler._hasUserCompiledMethods(compiledMethods);
    const hasSharedSchema = Array.isArray(rootSharedSchema) && rootSharedSchema.length > 0;
    if (!hasCompiledMethods && !hasSharedSchema) {
      return;
    }
    this.emit(`runtime.bootstrapInheritanceMetadata(inheritanceState, `);
    if (hasCompiledMethods) {
      this.emitCompiledMethodsLiteral(compiledMethods, '');
    } else {
      this.emit('{}');
    }
    this.emit(`, ${JSON.stringify(rootSharedSchema || [])}, ${JSON.stringify(this.compiler._getCompiledMethodOwnerKey())}, ${this.compiler.buffer.currentBuffer}, context);`);
    this.emit.line();
  }

  _emitFinalizationErrorCallback(node, errorExpr = 'err', indent = '') {
    const errorVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${errorVar} = runtime.isPoisonError(${errorExpr}) ? ${errorExpr} : runtime.handleError(${errorExpr}, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line(`${indent}cb(${errorVar});`);
  }

  _emitDirectValueFinalization(node, resultVar, completionGateVar = null, indent = '') {
    const finishVar = this.compiler._tmpid();
    const deliverVar = this.compiler._tmpid();
    const gatedResultVar = this.compiler._tmpid();
    const normalizedVar = this.compiler._tmpid();
    const effectiveCompletionGateVar = completionGateVar || resultVar;

    this.emit.line(`${indent}const ${finishVar} = () => (${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(), ${resultVar});`);
    this.emit.line(`${indent}const ${deliverVar} = (value) => {`);
    this.emit.line(`${indent}  const ${normalizedVar} = runtime.normalizeFinalPromise(value);`);
    this.emit.line(`${indent}  if (${normalizedVar} && typeof ${normalizedVar}.then === "function") {`);
    this.emit.line(`${indent}    ${normalizedVar}.then((finalValue) => cb(null, finalValue)).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}      `);
    this.emit.line(`${indent}    });`);
    this.emit.line(`${indent}    return;`);
    this.emit.line(`${indent}  }`);
    this.emit.line(`${indent}  cb(null, ${normalizedVar});`);
    this.emit.line(`${indent}};`);
    this.emit.line(`${indent}const ${gatedResultVar} = ${effectiveCompletionGateVar} && typeof ${effectiveCompletionGateVar}.then === "function"`);
    this.emit.line(`${indent}  ? ${effectiveCompletionGateVar}.then(${finishVar}, (err) => { ${finishVar}(); throw err; })`);
    this.emit.line(`${indent}  : ${finishVar}();`);
    this.emit.line(`${indent}if (${gatedResultVar} && typeof ${gatedResultVar}.then === "function") {`);
    this.emit.line(`${indent}  ${gatedResultVar}.then(${deliverVar}).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}    `);
    this.emit.line(`${indent}  });`);
    this.emit.line(`${indent}} else {`);
    this.emit.line(`${indent}  ${deliverVar}(${gatedResultVar});`);
    this.emit.line(`${indent}}`);
  }

  _emitDirectTextFinalization(node, completionGateVar = null, indent = '') {
    const finishVar = this.compiler._tmpid();
    const finalizedResultVar = this.compiler._tmpid();

    this.emit.line(`${indent}const ${finishVar} = () => {`);
    this.emit.line(`${indent}  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}  return ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot();`);
    this.emit.line(`${indent}};`);
    this.emit.line(`${indent}const ${finalizedResultVar} = ${completionGateVar} && typeof ${completionGateVar}.then === "function"`);
    this.emit.line(`${indent}  ? ${completionGateVar}.then(${finishVar}, (err) => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); throw err; })`);
    this.emit.line(`${indent}  : ${finishVar}();`);
    this.emit.line(`${indent}${finalizedResultVar}.then((value) => cb(null, value)).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}  `);
    this.emit.line(`${indent}});`);
  }

  _emitRootOutcome(node, outcome, indent = '') {
    const normalizedOutcome = outcome || { kind: 'buffer' };
    if (normalizedOutcome.kind === 'value') {
      this._emitDirectValueFinalization(
        node,
        normalizedOutcome.resultVar,
        normalizedOutcome.completionGateVar || null,
        indent
      );
      return;
    }
    if (normalizedOutcome.kind === 'text') {
      this._emitDirectTextFinalization(
        node,
        normalizedOutcome.completionGateVar || null,
        indent
      );
      return;
    }
    if (normalizedOutcome.kind !== 'buffer') {
      throw new Error(`Compiler invariant: unsupported root outcome kind '${normalizedOutcome.kind}'`);
    }
    if (normalizedOutcome.completionGateVar) {
      this._emitReturnCurrentBufferAfterCompletionGate(
        node,
        normalizedOutcome.completionGateVar,
        indent
      );
      return;
    }
    this.emit.line(`${indent}return ${this.compiler.buffer.currentBuffer};`);
  }

  _emitRootModeSplit(node, renderOutcome, compositionOutcome, indent = '') {
    this.emit.line(`${indent}if (!compositionMode) {`);
    this._emitRootOutcome(node, renderOutcome, `${indent}  `);
    this.emit.line(`${indent}} else {`);
    this._emitRootOutcome(node, compositionOutcome, `${indent}  `);
    this.emit.line(`${indent}}`);
  }

  _emitReturnCurrentBufferAfterCompletionGate(node, completionGateVar = null, indent = '') {
    this.emit.line(`${indent}if (${completionGateVar} && typeof ${completionGateVar}.then === "function") {`);
    this.emit.line(`${indent}  ${completionGateVar}.then(() => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); }, (err) => {`);
    this.emit.line(`${indent}    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}    throw err;`);
    this.emit.line(`${indent}  }).catch((err) => {`);
    this._emitFinalizationErrorCallback(node, 'err', `${indent}    `);
    this.emit.line(`${indent}  });`);
    this.emit.line(`${indent}} else {`);
    this.emit.line(`${indent}  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}}`);
    this.emit.line(`${indent}return ${this.compiler.buffer.currentBuffer};`);
  }

  _emitConstructorEntryOutcome(node, outcome, indent = '') {
    const normalizedOutcome = outcome || { kind: 'null' };
    if (normalizedOutcome.kind === 'return_value') {
      const returnVar = this.compiler._tmpid();
      this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, node, returnVar, false);
      this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`${indent}return ${returnVar};`);
      return;
    }
    if (normalizedOutcome.kind !== 'null') {
      throw new Error(`Compiler invariant: unsupported constructor outcome kind '${normalizedOutcome.kind}'`);
    }
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return null;`);
  }

  _emitRootConstructorAdmission(node, constructorMethod) {
    const constructorAdmissionVar = this.compiler._tmpid();

    this.emit(`const ${constructorAdmissionVar} = runtime.admitConstructorEntry(context, inheritanceState, `);
    this.emitCompiledMethodEntryValue(constructorMethod);
    this.emit.line(`, [], env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${JSON.stringify(this.compiler._createErrorContext(node))});`);
    this.emit.line(`const ${constructorAdmissionVar}_completion = ${constructorAdmissionVar}.completion;`);
    const renderOutcome = {
      kind: this.compiler.scriptMode ? 'value' : 'text',
      completionGateVar: `${constructorAdmissionVar}_completion`
    };
    const compositionOutcome = {
      kind: 'buffer'
    };

    if (renderOutcome.kind === 'value') {
      this.emit.line(`const ${constructorAdmissionVar}_value = ${constructorAdmissionVar}.promise;`);
      renderOutcome.resultVar = `${constructorAdmissionVar}_value`;
    } else {
      compositionOutcome.completionGateVar = `${constructorAdmissionVar}_completion`;
    }

    return { renderOutcome, compositionOutcome };
  }

  _getStaticConstructorExtendsSplit(node, invariantLabel) {
    if (!(this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends)) {
      return null;
    }
    const staticExtendsIndex = node.children.findIndex((child) => child instanceof nodes.Extends);
    if (staticExtendsIndex === -1) {
      throw new Error(`Compiler invariant: static ${invariantLabel} extends analysis found no root Extends node`);
    }
    return {
      extendsNode: node.children[staticExtendsIndex],
      preExtendsChildren: node.children.slice(0, staticExtendsIndex),
      postExtendsChildren: node.children.slice(staticExtendsIndex + 1)
    };
  }

  _beginAsyncConstructorEntry(node, constructorLinkedChannels = [], entryOptions = null) {
    this.emit.beginEntryFunction(
      node,
      'm___constructor__',
      this.emit.linkedChannelsLiteral(constructorLinkedChannels || []),
      [],
      entryOptions || null
    );
    this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
    this.compiler._emitRootSequenceLockDeclarations(node);
    this.compiler._emitRootExternInitialization(node);
  }

  _finishAsyncConstructorEntry(node, constructorOutcome) {
    this.emit.line('context.resolveExports();');
    this._emitConstructorEntryOutcome(node, constructorOutcome);
    this.emit.endEntryFunction(node, true);
  }

  _compileAsyncScriptConstructorEntry(node, sharedChannelNames = [], constructorLinkedChannels = []) {
    this.compiler._withRootExportBufferScope(() => {
      this._beginAsyncConstructorEntry(node, constructorLinkedChannels);
      this.compiler.emitDeclareReturnChannel(this.compiler.buffer.currentBuffer);

      const extendsSplit = this._getStaticConstructorExtendsSplit(node, 'script');
      if (extendsSplit) {
        extendsSplit.preExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
        this.compileAsyncStaticRootExtends(
          extendsSplit.extendsNode,
          node,
          sharedChannelNames || []
        );
        extendsSplit.postExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
      } else {
        this.compiler._compileChildren(node, null);
      }

      this._finishAsyncConstructorEntry(node, { kind: 'return_value' });
    });
  }

  _compileAsyncTemplateConstructorEntry(node, constructorLinkedChannels = []) {
    this.compiler._withRootExportBufferScope(() => {
      this._beginAsyncConstructorEntry(
        node,
        constructorLinkedChannels,
        { ownTextChannel: false }
      );

      const extendsSplit = this._getStaticConstructorExtendsSplit(node, 'template');
      if (extendsSplit) {
        extendsSplit.preExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
        this.emitInheritanceLocalCaptureSnapshot(node);
        this.compileAsyncStaticTemplateExtends(extendsSplit.extendsNode);
        extendsSplit.postExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
        this.emitInheritanceLocalCaptureSnapshot(node);
      } else {
        this.compiler._compileChildren(node, null);
        this.emitInheritanceLocalCaptureSnapshot(node);
      }

      this._finishAsyncConstructorEntry(node, { kind: 'null' });
    });
  }

  _compileConstructorAdmittedRootBody(node, constructorMethod) {
    const { renderOutcome, compositionOutcome } = this._emitRootConstructorAdmission(node, constructorMethod);
    this._emitRootModeSplit(node, renderOutcome, compositionOutcome);
  }

  _compileAsyncRootBody(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    const needsRootInheritanceState = this.compiler._needsRootInheritanceState(compiledMethods, rootSharedSchema);
    const isDynamicTemplateRoot = !this.compiler.scriptMode && this.compiler.hasDynamicExtends;

    this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
    if (needsRootInheritanceState) {
      this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
    }
    this._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);

    if (isDynamicTemplateRoot) {
      this._compileDynamicParentRootBody(node);
      return;
    }

    this._compileConstructorAdmittedRootBody(
      node,
      compiledMethods && compiledMethods.__constructor__
    );
  }

  _compileAsyncRoot(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    this.compiler._withRootExportBufferScope(() => {
      this.emit.beginEntryFunction(
        node,
        'root',
        this.compiler.scriptMode
          ? this.emit.linkedChannelsLiteral(sharedChannelNames || [])
          : null
      );
      this._compileAsyncRootBody(node, sharedChannelNames, compiledMethods, rootSharedSchema);
      this.emit.endEntryFunction(node, true);
    });
    this.compiler.inBlock = true;
    return this.compiler._compileAsyncBlockEntries(node);
  }
}

module.exports = CompileExtends;
