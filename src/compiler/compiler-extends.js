'use strict';

// Extends root compiler helper.
// Owns root-level extends startup/bootstrap coordination and parent constructor
// handoff shared by static and dynamic extends flows.

const nodes = require('../nodes');
const inheritanceConstants = require('../inheritance-constants');
const CompileBuffer = require('./buffer');
const CompileExtendsDynamicRoot = require('./compiler-extends-dynamic-root');
const CompileMethodMetadata = require('./compiler-method-metadata');
const CompileRootFinalization = require('./compiler-root-finalization');

const { DYNAMIC_PARENT_TEMPLATE_CHANNEL_NAME, RETURN_CHANNEL_NAME } = inheritanceConstants;

// Generated-code indentation in this file is controlled by explicit `indent`
// string threading. Keep new helpers on that pattern for consistency.
class CompileExtends {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
    this.metadata = new CompileMethodMetadata(compiler);
    this.dynamicTemplateRoot = new CompileExtendsDynamicRoot(this);
    this.rootFinalization = new CompileRootFinalization(this);
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
    this.compiler.composition.emitCapturedNameAssignments({
      targetVar: templateLocalCapturesVar,
      names: templateLocalCaptures,
      ownerNode: node,
      contextExpr,
      bufferExpr,
      indent
    });
    this.emit.line(`${indent}runtime.setTemplateLocalCaptures(inheritanceState, ${templateKey}, ${templateLocalCapturesVar});`);
  }

  _emitExtendsCompositionPayloadSetup(node, explicitInputVarsVar, compositionPayloadVar) {
    const explicitInputValuesVar = this.compiler._tmpid();
    const rootContextVar = this.compiler._tmpid();

    this.emit.line(`const ${explicitInputVarsVar} = {};`);
    this.compiler.composition.emitCapturedNameNodeAssignments({
      targetVar: explicitInputVarsVar,
      nameNodes: node.withVars && node.withVars.children ? node.withVars.children : [],
      ownerNode: node,
      contextExpr: 'context',
      bufferExpr: this.compiler.buffer.currentBuffer
    });
    // Keep two distinct views on purpose:
    // explicitInputValues is the named-input set captured at the extends site
    // (validated as externs on the legacy path, or as shared preloads on the
    // new static script path), while rootContext preserves the full inherited
    // constructor context the ancestor should execute against.
    this.compiler.composition.emitCompositionContextObject({
      targetVar: explicitInputValuesVar,
      explicitVarsVar: explicitInputVarsVar,
      includeRenderContext: !!node.withContext
    });
    this.compiler.composition.emitCompositionContextObject({
      targetVar: rootContextVar,
      explicitVarsVar: explicitInputVarsVar,
      includeRenderContext: true
    });
    this.emit.line(
      `const ${compositionPayloadVar} = runtime.createExtendsCompositionPayload(` +
      `${explicitInputValuesVar}, Object.keys(${explicitInputVarsVar}), ${rootContextVar}, ${explicitInputValuesVar});`
    );
  }

  shouldSkipTopLevelBlockRender() {
    return !this.compiler.inBlock && this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends;
  }

  emitTopLevelBlockResolution(node, resultVar, blockPayloadExpr, blockRenderCtxExpr, indent = '') {
    if (!this.compiler.inBlock && this.compiler.hasDynamicExtends) {
      this.dynamicTemplateRoot.emitDynamicTopLevelBlockResolution(
        node,
        resultVar,
        blockPayloadExpr,
        blockRenderCtxExpr,
        indent
      );
      return;
    }

    this.emit.line(
      `${indent}${resultVar} = runtime.getRegisteredAsyncBlock(inheritanceState, context, "${node.name.value}")` +
      `.then((blockFunc) => blockFunc(` +
      `env, context, runtime, cb, ${this.compiler.buffer.currentBuffer}, inheritanceState, ` +
      `runtime.prepareInheritancePayloadForBlock(inheritanceState, blockFunc, context.path, ${blockPayloadExpr}), ${blockRenderCtxExpr}));`
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
    const parentTemplateId = this.compiler.composition._compileAsyncGetTemplateOrScript(node, true, false);
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
    this._emitParentConstructorHandoff(
      node,
      templateVar,
      compositionPayloadVar,
      'currentBuffer',
      { indent: '  ', dynamicRootMode: opts.allowDynamicRoot ? 'fire_and_forget' : 'none' }
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
        this.compiler.composition.emitExternValidation({
          externSpecExpr: `${templateVar}.externSpec || []`,
          explicitInputNamesExpr: `${compositionPayloadExpr}.explicitInputNames`,
          availableValueNamesExpr: `Object.keys(${compositionPayloadExpr}.explicitInputValues)`,
          operationName: 'extends',
          indent: '  '
        });
      }
    });
  }

  compileAsyncExtends(node) {
    return this.dynamicTemplateRoot.compileAsyncDynamicTemplateExtends(node);
  }

  _emitRootInheritanceBootstrap(compiledMethods, rootSharedSchema) {
    const hasCompiledMethods = this.metadata.hasUserCompiledMethods(compiledMethods);
    const hasSharedSchema = Array.isArray(rootSharedSchema) && rootSharedSchema.length > 0;
    if (!hasCompiledMethods && !hasSharedSchema) {
      return;
    }
    this.emit(`runtime.bootstrapInheritanceMetadata(inheritanceState, `);
    if (hasCompiledMethods) {
      this.metadata.emitCompiledMethodsLiteral(compiledMethods, '');
    } else {
      this.emit('{}');
    }
    this.emit(`, ${JSON.stringify(rootSharedSchema || [])}, ${this.compiler.buffer.currentBuffer}, context);`);
    this.emit.line('');
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
      this.rootFinalization._emitConstructorReturnChannelSnapshot(node);
    } else {
      this.rootFinalization._emitConstructorNullReturn();
    }
    this.emit.endEntryFunction(node, true);
  }

  _compileConstructorEntryChildren(node, invariantLabel, options = null) {
    const opts = options || {};
    const beforeExtends = opts.beforeExtends || null;
    const afterExtends = opts.afterExtends || null;
    const afterNoExtends = opts.afterNoExtends || null;
    const emitStaticExtends = opts.emitStaticExtends;
    const extendsSplit = this._getStaticConstructorExtendsSplit(node, invariantLabel);

    if (extendsSplit) {
      extendsSplit.preExtendsChildren.forEach((child) => {
        this.compiler.compile(child, null);
      });
      if (typeof beforeExtends === 'function') {
        beforeExtends(extendsSplit);
      }
      emitStaticExtends(extendsSplit.extendsNode);
      extendsSplit.postExtendsChildren.forEach((child) => {
        this.compiler.compile(child, null);
      });
      if (typeof afterExtends === 'function') {
        afterExtends(extendsSplit);
      }
      return;
    }

    this.compiler._compileChildren(node, null);
    if (typeof afterNoExtends === 'function') {
      afterNoExtends();
    }
  }

  _compileAsyncScriptConstructorEntry(node, sharedChannelNames = [], constructorLinkedChannels = []) {
    this.compiler._withRootExportBufferScope(() => {
      this._beginAsyncConstructorEntry(node, constructorLinkedChannels);
      this.compiler.emitDeclareReturnChannel(this.compiler.buffer.currentBuffer);
      this._compileConstructorEntryChildren(node, 'script', {
        emitStaticExtends: (extendsNode) => {
          this.compileAsyncStaticRootExtends(
            extendsNode,
            node,
            sharedChannelNames || []
          );
        }
      });

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
      this._compileConstructorEntryChildren(node, 'template', {
        beforeExtends: () => {
          this.emitInheritanceLocalCaptureSnapshot(node);
        },
        emitStaticExtends: (extendsNode) => {
          this.compileAsyncStaticTemplateExtends(extendsNode);
        },
        afterExtends: () => {
          this.emitInheritanceLocalCaptureSnapshot(node);
        },
        afterNoExtends: () => {
          this.emitInheritanceLocalCaptureSnapshot(node);
        }
      });

      this._finishAsyncConstructorEntry(node, false);
    });
  }

  _compileAsyncRootBody(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    this.rootFinalization.compileAsyncRootBody(node, compiledMethods, rootSharedSchema);
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
