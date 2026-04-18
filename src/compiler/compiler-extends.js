'use strict';

// Extends root compiler helper.
// Owns root-level extends startup/finalization, compiled method metadata, and
// parent constructor handoff shared by static and dynamic extends flows.

const nodes = require('../nodes');
const inheritanceConstants = require('../inheritance-constants');
const CompileBuffer = require('./buffer');
const CompileExtendsDynamicRoot = require('./compiler-extends-dynamic-root');

const { DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME, RETURN_CHANNEL_NAME } = inheritanceConstants;

// Generated-code indentation in this file is controlled by explicit `indent`
// string threading. Keep new helpers on that pattern for consistency.
class CompileExtends {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
    this.dynamicTemplateRoot = new CompileExtendsDynamicRoot(this);
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

  getCompiledMethodOwnerKey() {
    return this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName);
  }

  collectCompiledMethods(node, rootSharedChannelNames = []) {
    const methods = Object.create(null);
    const blocks = node.findAll(nodes.Block);
    const ownerKey = this.getCompiledMethodOwnerKey();

    methods.__constructor__ = {
      functionName: 'm___constructor__',
      kind: 'constructor',
      contract: {
        inputNames: [],
        withContext: false
      },
      ownerKey,
      linkedChannels: this.compiler.linkedChannels.getLinkedChannels(node, {
        seedChannels: rootSharedChannelNames,
        includeDefaultTemplateTextChannel: true,
        excludeSequentialChannels: true
      })
    };

    blocks.forEach((block) => {
      if (this.compiler.scriptMode && block.name && block.name.value === '__constructor__') {
        this.compiler.fail(
          'Identifier \'__constructor__\' is reserved and cannot be used as a method name',
          block.lineno,
          block.colno,
          block
        );
      }
      const signature = this.compiler._getBlockSignature(block);
      methods[block.name.value] = {
        functionName: `b_${block.name.value}`,
        kind: this.compiler.scriptMode ? 'method' : 'block',
        contract: {
          inputNames: signature.inputNames,
          withContext: !!block.withContext
        },
        ownerKey,
        linkedChannels: this.compiler.linkedChannels.getLinkedChannels(block.body, {
          excludeNames: this.compiler._getBlockInputNames(block),
          sharedOnly: true,
          excludeSequentialChannels: true
        })
      };
    });

    return methods;
  }

  hasUserCompiledMethods(compiledMethods) {
    return !!(compiledMethods && Object.keys(compiledMethods).some((name) => name !== '__constructor__'));
  }

  needsRootInheritanceState(compiledMethods, rootSharedSchema) {
    const hasCompiledMethods = this.hasUserCompiledMethods(compiledMethods);
    const hasSharedSchema = Array.isArray(rootSharedSchema) && rootSharedSchema.length > 0;
    return hasCompiledMethods || hasSharedSchema || this.compiler.hasExtends;
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

  _emitExtendsCompositionPayloadSetup(node, explicitInputVarsVar, compositionPayloadVar) {
    const explicitInputValuesVar = this.compiler._tmpid();
    const rootContextVar = this.compiler._tmpid();

    this.emit.line(`const ${explicitInputVarsVar} = {};`);
    this._emitImmediateExternInputs(node, explicitInputVarsVar);
    // Keep two distinct views on purpose:
    // explicitInputValues is the named-input set captured at the extends site
    // (validated as externs on the legacy path, or as shared preloads on the
    // new static script path), while rootContext preserves the full inherited
    // constructor context the ancestor should execute against.
    this._emitCompositionContextObject(node, explicitInputVarsVar, explicitInputValuesVar, null, !!node.withContext);
    this._emitCompositionContextObject(node, explicitInputVarsVar, rootContextVar, null, true);
    this.emit.line(
      `const ${compositionPayloadVar} = context.createExtendsCompositionPayload(` +
      `${explicitInputValuesVar}, Object.keys(${explicitInputVarsVar}), ${rootContextVar}, ${explicitInputValuesVar});`
    );
  }

  emitDynamicParentTemplateStore(node, parentTemplateExpr, bufferExpr = null, indent = '') {
    return this.dynamicTemplateRoot.emitDynamicParentTemplateStore(node, parentTemplateExpr, bufferExpr, indent);
  }

  emitDynamicParentTemplateStoreWait(storeVar, parentTemplateExpr, indent = '') {
    return this.dynamicTemplateRoot.emitDynamicParentTemplateStoreWait(storeVar, parentTemplateExpr, indent);
  }

  emitDynamicTopLevelBlockResolution(node, resultVar, blockPayloadExpr, blockRenderCtxExpr, indent = '') {
    return this.dynamicTemplateRoot.emitDynamicTopLevelBlockResolution(
      node,
      resultVar,
      blockPayloadExpr,
      blockRenderCtxExpr,
      indent
    );
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

  _emitResolvedParentContinuation(node, templateVar, compositionPayloadExpr, currentBufferExpr, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const allowDynamicRoot = !!(options && options.allowDynamicRoot);

    this._emitParentConstructorHandoff(
      node,
      templateVar,
      compositionPayloadExpr,
      currentBufferExpr,
      { indent, dynamicRootMode: allowDynamicRoot ? 'fire_and_forget' : 'none' }
    );
  }

  _emitParentConstructorHandoff(node, templateExpr, compositionPayloadExpr, currentBufferExpr, options = null) {
    const opts = options || {};
    const indent = opts.indent || '';
    const shouldAwaitCompletion = (opts.dynamicRootMode || 'none') === 'await_completion' || !!opts.returnConstructorCompletion;
    const errorContextJson = JSON.stringify(this.compiler._generateErrorContext(node));
    const startVar = this.compiler._tmpid();

    this.emit.line(
      `${indent}const ${startVar} = runtime.startParentConstructor(` +
      `${templateExpr}, context, ${compositionPayloadExpr}, inheritanceState, env, runtime, cb, ${currentBufferExpr}, ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${errorContextJson}, path: ${templateExpr}.path }, ` +
      `${JSON.stringify(shouldAwaitCompletion)});`
    );
    if (shouldAwaitCompletion) {
      this.emit.line(`${indent}return ${startVar};`);
    }
  }

  _emitStaticExtendsAsyncBoundary(node, options = null) {
    const opts = options || {};
    const k = this.compiler._tmpid();
    const explicitInputVarsVar = this.compiler._tmpid();
    const compositionPayloadVar = this.compiler._tmpid();
    const templateVar = this.compiler._tmpid();
    const parentTemplateId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, true, false);
    const prevBuffer = this.compiler.buffer.currentBuffer;

    this._emitExtendsCompositionPayloadSetup(
      node,
      explicitInputVarsVar,
      compositionPayloadVar
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
        compositionPayloadExpr: compositionPayloadVar
      });
    }
    this.emit.line(`  for (let ${k} in ${templateVar}.blocks) {`);
    this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
    this.emit.line('  }');
    this._emitResolvedParentContinuation(
      node,
      templateVar,
      compositionPayloadVar,
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
      emitInputSetup: ({ templateVar, currentBufferExpr, compositionPayloadExpr }) => {
        this.emit.line(`  runtime.preloadSharedInputs(${templateVar}.sharedSchema || [], ${compositionPayloadExpr}.explicitInputValues, ${currentBufferExpr}, context, { lineno: ${node.lineno}, colno: ${node.colno} });`);
      }
    });
  }

  compileAsyncStaticTemplateExtends(node) {
    this._emitStaticExtendsAsyncBoundary(node, {
      linkedChannels: [CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL],
      allowDynamicRoot: true,
      emitInputSetup: ({ templateVar, compositionPayloadExpr }) => {
        this.emit.line(`  runtime.validateExternInputs(${templateVar}.externSpec || [], ${compositionPayloadExpr}.explicitInputNames, Object.keys(${compositionPayloadExpr}.explicitInputValues), "extends");`);
      }
    });
  }

  compileAsyncExtends(node) {
    return this.dynamicTemplateRoot.compileAsyncDynamicTemplateExtends(node);
  }

  _emitRootInheritanceBootstrap(compiledMethods, rootSharedSchema) {
    const hasCompiledMethods = this.hasUserCompiledMethods(compiledMethods);
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
    this.emit(`, ${JSON.stringify(rootSharedSchema || [])}, ${JSON.stringify(this.getCompiledMethodOwnerKey())}, ${this.compiler.buffer.currentBuffer}, context);`);
    this.emit.line();
  }

  _emitFinalizationErrorCallback(node, errorExpr = 'err', indent = '') {
    const errorVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${errorVar} = runtime.isPoisonError(${errorExpr}) ? ${errorExpr} : runtime.handleError(${errorExpr}, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line(`${indent}cb(${errorVar});`);
  }

  _emitRenderScriptRootReturn(node, resultVar, completionGateVar = null, indent = '') {
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

  _emitRenderTemplateRootReturn(node, completionGateVar = null, indent = '') {
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

  _emitCompositionRootReturn(node, completionGateVar = null, indent = '') {
    if (completionGateVar) {
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
      return;
    }
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return ${this.compiler.buffer.currentBuffer};`);
  }

  _emitConstructorNullReturn(indent = '') {
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return null;`);
  }

  _emitConstructorReturnChannelSnapshot(node, indent = '') {
    const returnVar = this.compiler._tmpid();
    this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, node, returnVar, false);
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}return ${returnVar};`);
  }

  _emitRootConstructorAdmission(node, constructorMethod) {
    const constructorAdmissionVar = this.compiler._tmpid();
    const completionVar = `${constructorAdmissionVar}_completion`;
    const result = {
      admissionVar: constructorAdmissionVar,
      completionVar
    };

    this.emit(`const ${constructorAdmissionVar} = runtime.admitConstructorEntry(context, inheritanceState, `);
    this.emitCompiledMethodEntryValue(constructorMethod);
    this.emit.line(`, [], env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${JSON.stringify(this.compiler._createErrorContext(node))});`);
    this.emit.line(`const ${completionVar} = ${constructorAdmissionVar}.completion;`);

    if (this.compiler.scriptMode) {
      result.valueVar = `${constructorAdmissionVar}_value`;
      this.emit.line(`const ${result.valueVar} = ${constructorAdmissionVar}.promise;`);
    }

    return result;
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

  _finishAsyncConstructorEntry(node, returnsValue = false) {
    this.emit.line('context.resolveExports();');
    if (returnsValue) {
      this._emitConstructorReturnChannelSnapshot(node);
    } else {
      this._emitConstructorNullReturn();
    }
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

      this._finishAsyncConstructorEntry(node, true);
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

      this._finishAsyncConstructorEntry(node, false);
    });
  }

  _compileConstructorAdmittedRootBody(node, constructorMethod) {
    const constructorAdmission = this._emitRootConstructorAdmission(node, constructorMethod);

    this.emit.line('if (!compositionMode) {');
    if (this.compiler.scriptMode) {
      this._emitRenderScriptRootReturn(
        node,
        constructorAdmission.valueVar,
        constructorAdmission.completionVar,
        '  '
      );
    } else {
      this._emitRenderTemplateRootReturn(
        node,
        constructorAdmission.completionVar,
        '  '
      );
    }
    this.emit.line('} else {');
    this._emitCompositionRootReturn(
      node,
      this.compiler.scriptMode ? null : constructorAdmission.completionVar,
      '  '
    );
    this.emit.line('}');
  }

  _compileAsyncRootBody(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    const needsRootInheritanceState = this.needsRootInheritanceState(compiledMethods, rootSharedSchema);
    const isDynamicTemplateRoot = !this.compiler.scriptMode && this.compiler.hasDynamicExtends;

    this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
    if (needsRootInheritanceState) {
      this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
    }
    this._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);

    if (isDynamicTemplateRoot) {
      this.dynamicTemplateRoot.compileDynamicParentRootBody(node);
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
