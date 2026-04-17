'use strict';

const nodes = require('../nodes');
const CompileBuffer = require('./buffer');

const RETURN_CHANNEL_NAME = '__return__';

class CompileExtends {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
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

  _emitParentCompositionContext(parentTemplateVar, parentContextVar, options = null) {
    const indent = options && options.indent ? options.indent : '';
    const contextExpr = options && options.contextExpr ? options.contextExpr : 'context';
    const extendsCompositionVar = this.compiler._tmpid();
    this.emit.line(`${indent}const ${extendsCompositionVar} = ${contextExpr}.getExtendsComposition(${parentTemplateVar});`);
    this.emit.line(`${indent}const ${parentContextVar} = ${extendsCompositionVar}`);
    this.emit.line(`${indent}  ? ${contextExpr}.forkForComposition(${parentTemplateVar}.path, ${extendsCompositionVar}.rootContext, ${contextExpr}.getRenderContextVariables(), ${extendsCompositionVar}.externContext)`);
    this.emit.line(`${indent}  : ${contextExpr}.forkForPath(${parentTemplateVar}.path);`);
  }

  _emitDirectRenderParentRootHandoff(node, parentTemplateVar, handoffVar, indent = '') {
    const parentContextVar = this.compiler._tmpid();

    this.emitInheritanceLocalCaptureSnapshot(node, {
      indent,
      contextExpr: 'context',
      bufferExpr: this.compiler.buffer.currentBuffer
    });
    this._emitParentCompositionContext(parentTemplateVar, parentContextVar, {
      indent,
      contextExpr: 'context'
    });
    this.emit.line(`${indent}${handoffVar} = true;`);
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`${indent}${parentTemplateVar}.rootRenderFunc(env, ${parentContextVar}, runtime, cb, compositionMode, null, inheritanceState);`);
  }

  _emitCompositionParentRootHandoff(parentTemplateVar, indent = '') {
    const parentContextVar = this.compiler._tmpid();

    this._emitParentCompositionContext(parentTemplateVar, parentContextVar, {
      indent,
      contextExpr: 'context'
    });
    this.emit.line(`${indent}${parentTemplateVar}.rootRenderFunc(env, ${parentContextVar}, runtime, cb, true, ${this.compiler.buffer.currentBuffer}, inheritanceState);`);
    this.emit.line(`${indent}${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
  }

  emitAsyncRootCompletion(node) {
    const completionVar = this.compiler._tmpid();
    const handoffVar = this.compiler._tmpid();
    this.emit.line('if (!compositionMode) {');
    this.emit.line(`let ${handoffVar} = false;`);
    if (this.compiler.hasExtends) {
      const finalParentVar = this.compiler._tmpid();
      this.emit.line(`let ${completionVar} = runtime.resolveSingle(runtime.channelLookup("__parentTemplate", ${this.compiler.buffer.currentBuffer})).then((${finalParentVar}) => {`);
      this.emit.line(`  if (${finalParentVar}) {`);
      this._emitDirectRenderParentRootHandoff(node, finalParentVar, handoffVar, '    ');
      this.emit.line('    return null;');
      this.emit.line('  }');
      if (this.compiler.scriptMode) {
        this.compiler._emitScriptRootLeafResultPromise(node, completionVar);
      } else {
        this.compiler._emitAsyncTemplateRootLeafResultPromise(completionVar);
      }
      this.emit.line(`  return ${completionVar};`);
      this.emit.line('});');
    } else if (this.compiler.scriptMode) {
      this.compiler._emitScriptRootLeafResultPromise(node, completionVar);
    } else {
      this.compiler._emitAsyncTemplateRootLeafResultPromise(completionVar);
    }
    this.emit.line(`  ${completionVar}.then((value) => {`);
    this.emit.line(`    if (!${handoffVar}) {`);
    this.emit.line('      cb(null, value);');
    this.emit.line('    }');
    this.emit.line('  }).catch(e => {');
    this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line('  cb(err);');
    this.emit.line('});');
    this.emit.line('} else {');
    if (this.compiler.hasExtends) {
      const compositionParentVar = this.compiler._tmpid();
      this.emit.line(`  runtime.resolveSingle(runtime.channelLookup("__parentTemplate", ${this.compiler.buffer.currentBuffer})).then((${compositionParentVar}) => {`);
      this.emit.line(`    if (${compositionParentVar}) {`);
      this._emitCompositionParentRootHandoff(compositionParentVar, '      ');
      this.emit.line('      return;');
      this.emit.line('    }');
      this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`  }).catch((e) => {`);
      this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`    var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line('    cb(err);');
      this.emit.line('  });');
    } else {
      this.emit.line(`  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    }
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('}');
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
    const errorContextJson = JSON.stringify(this.compiler._generateErrorContext(node));
    const innerIndent = allowDynamicRoot ? `${indent}  ` : indent;

    this.emit.line(`${indent}const ${parentContextVar} = context.forkForComposition(${templateVar}.path, ${rootContextVar}, context.getRenderContextVariables(), ${externContextVar});`);
    if (allowDynamicRoot) {
      this.emit.line(`${indent}if (${templateVar}.hasDynamicExtends) {`);
      this.emit.line(`${indent}  ${templateVar}.rootRenderFunc(env, ${parentContextVar}, runtime, cb, true, ${currentBufferExpr}, inheritanceState);`);
      this.emit.line(`${indent}} else {`);
    }
    this.emit.line(`${innerIndent}runtime.admitMethodEntry(${parentContextVar}, inheritanceState, (${templateVar}.methods || {}).__constructor__, [], env, runtime, cb, ${currentBufferExpr}, { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${errorContextJson}, path: ${parentContextVar}.path });`);
    if (allowDynamicRoot) {
      this.emit.line(`${indent}}`);
    }
  }

  compileAsyncStaticRootExtends(node, scriptRootNode, rootSharedChannelNames = []) {
    const k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsSharedInputNamesVar = this.compiler._tmpid();
    const extendsSharedInputValuesVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const templateVar = this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();
    const parentTemplateId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, true, false);
    const prevBuffer = this.compiler.buffer.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(scriptRootNode, {
      includeDeclaredChannelNames: rootSharedChannelNames
    });

    this.compiler.inheritance._emitExtendsContextSetup(
      node,
      extendsVarsVar,
      extendsSharedInputValuesVar,
      extendsSharedInputNamesVar,
      extendsRootContextVar
    );
    this.emit.line('context.beginAsyncExtendsBlockRegistration();');
    this.emit.line('// Step 4 still reuses the existing composition-context setup for');
    this.emit.line('// parent execution, but named extends inputs are now validated and');
    this.emit.line('// preloaded through shared-schema bootstrap rather than extern slots.');
    this.emit(`runtime.runControlFlowBoundary(${prevBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`);
    this.emit.asyncClosureDepth++;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.emit.line('try {');
    this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
    this.emit.line(`  ${templateVar}.compile();`);
    this.emit.line(`  runtime.bootstrapInheritanceMetadata(inheritanceState, ${templateVar}.methods || {}, ${templateVar}.sharedSchema || [], ${templateVar}.path, currentBuffer, context);`);
    this.emit.line(`  runtime.ensureCurrentBufferSharedLinks(${templateVar}.sharedSchema || [], currentBuffer);`);
    this.emit.line(`  runtime.preloadSharedInputs(${templateVar}.sharedSchema || [], ${extendsSharedInputValuesVar}, currentBuffer, context, { lineno: ${node.lineno}, colno: ${node.colno} });`);
    this.emit.line(`  for (let ${k} in ${templateVar}.blocks) {`);
    this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
    this.emit.line('  }');
    this._emitResolvedParentContinuation(
      node,
      templateVar,
      parentContextVar,
      extendsRootContextVar,
      extendsSharedInputValuesVar,
      'currentBuffer',
      { indent: '  ' }
    );
    this.emit.line('} finally {');
    this.emit.line('  context.finishAsyncExtendsBlockRegistration();');
    this.emit.line('}');
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.emit.asyncClosureDepth--;
    this.emit.line('});');
  }

  compileAsyncStaticTemplateExtends(node) {
    const k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsExternInputNamesVar = this.compiler._tmpid();
    const extendsExternContextVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const templateVar = this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();
    const parentTemplateId = this.compiler.inheritance._compileAsyncGetTemplateOrScript(node, true, false);
    const prevBuffer = this.compiler.buffer.currentBuffer;

    this.compiler.inheritance._emitExtendsContextSetup(
      node,
      extendsVarsVar,
      extendsExternContextVar,
      extendsExternInputNamesVar,
      extendsRootContextVar
    );
    this.emit.line('context.beginAsyncExtendsBlockRegistration();');
    this.emit(`runtime.runControlFlowBoundary(${prevBuffer}, ["${CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL}"], context, cb, async (currentBuffer) => {`);
    this.emit.asyncClosureDepth++;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.emit.line('try {');
    this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
    this.emit.line(`  ${templateVar}.compile();`);
    this.emit.line(`  runtime.bootstrapInheritanceMetadata(inheritanceState, ${templateVar}.methods || {}, ${templateVar}.sharedSchema || [], ${templateVar}.path, currentBuffer, context);`);
    this.emit.line(`  runtime.ensureCurrentBufferSharedLinks(${templateVar}.sharedSchema || [], currentBuffer);`);
    this.emit.line(`  runtime.validateExternInputs(${templateVar}.externSpec || [], ${extendsExternInputNamesVar}, Object.keys(${extendsExternContextVar}), "extends");`);
    this.emit.line(`  for (let ${k} in ${templateVar}.blocks) {`);
    this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
    this.emit.line('  }');
    this._emitResolvedParentContinuation(
      node,
      templateVar,
      parentContextVar,
      extendsRootContextVar,
      extendsExternContextVar,
      'currentBuffer',
      { indent: '  ', allowDynamicRoot: true }
    );
    this.emit.line('} finally {');
    this.emit.line('  context.finishAsyncExtendsBlockRegistration();');
    this.emit.line('}');
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.emit.asyncClosureDepth--;
    this.emit.line('});');
  }

  _emitRootConstructorAdmission(node, constructorMethod) {
    const constructorAdmissionVar = this.compiler._tmpid();
    this.emit(`const ${constructorAdmissionVar} = runtime.admitMethodEntryWithCompletion(context, inheritanceState, `);
    this.emitCompiledMethodEntryValue(constructorMethod);
    this.emit.line(`, [], env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${JSON.stringify(this.compiler._createErrorContext(node))});`);
    this.emit.line(`const ${constructorAdmissionVar}_completion = ${constructorAdmissionVar}.completion;`);
    if (this.compiler.scriptMode) {
      this.emit.line(`const ${constructorAdmissionVar}_value = ${constructorAdmissionVar}.value;`);
      this._emitAsyncConstructorRootCompletion(node, {
        mode: 'script',
        resultVar: `${constructorAdmissionVar}_value`,
        completionGateVar: `${constructorAdmissionVar}_completion`
      });
      return;
    }
    this._emitAsyncConstructorRootCompletion(node, {
      mode: 'template',
      completionGateVar: `${constructorAdmissionVar}_completion`
    });
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

  _emitAsyncConstructorRootCompletion(node, options = null) {
    const mode = options && options.mode;
    const completionGateVar = options && options.completionGateVar ? options.completionGateVar : null;
    const resultVar = options && options.resultVar ? options.resultVar : null;
    const finishVar = this.compiler._tmpid();
    const errorVar = this.compiler._tmpid();

    if (mode !== 'script' && mode !== 'template') {
      throw new Error(`Compiler invariant: unknown constructor root completion mode '${mode}'`);
    }

    if (mode === 'script') {
      const deliverVar = this.compiler._tmpid();
      const gatedResultVar = this.compiler._tmpid();
      const normalizedVar = this.compiler._tmpid();
      const effectiveCompletionGateVar = completionGateVar || resultVar;
      this.emit.line('if (!compositionMode) {');
      this.emit.line(`  const ${finishVar} = () => (${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(), ${resultVar});`);
      this.emit.line(`  const ${deliverVar} = (value) => {`);
      this.emit.line(`    const ${normalizedVar} = runtime.normalizeFinalPromise(value);`);
      this.emit.line(`    if (${normalizedVar} && typeof ${normalizedVar}.then === "function") {`);
      this.emit.line(`      ${normalizedVar}.then((finalValue) => cb(null, finalValue)).catch((err) => {`);
      this.emit.line(`        const ${errorVar} = runtime.isPoisonError(err) ? err : runtime.handleError(err, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line(`        cb(${errorVar});`);
      this.emit.line('      });');
      this.emit.line('      return;');
      this.emit.line('    }');
      this.emit.line(`    cb(null, ${normalizedVar});`);
      this.emit.line('  };');
      this.emit.line(`  const ${gatedResultVar} = ${effectiveCompletionGateVar} && typeof ${effectiveCompletionGateVar}.then === "function"`);
      this.emit.line(`    ? ${effectiveCompletionGateVar}.then(${finishVar}, (err) => { ${finishVar}(); throw err; })`);
      this.emit.line(`    : ${finishVar}();`);
      this.emit.line(`  if (${gatedResultVar} && typeof ${gatedResultVar}.then === "function") {`);
      this.emit.line(`    ${gatedResultVar}.then(${deliverVar}).catch((err) => {`);
      this.emit.line(`      const ${errorVar} = runtime.isPoisonError(err) ? err : runtime.handleError(err, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line(`      cb(${errorVar});`);
      this.emit.line('    });');
      this.emit.line('  } else {');
      this.emit.line(`    ${deliverVar}(${gatedResultVar});`);
      this.emit.line('  }');
      this.emit.line('} else {');
      this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
      this.emit.line('}');
      return;
    }

    const finalizedResultVar = this.compiler._tmpid();
    this.emit.line('if (!compositionMode) {');
    this.emit.line(`  const ${finishVar} = () => {`);
    this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`    return ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot();`);
    this.emit.line('  };');
    this.emit.line(`  const ${finalizedResultVar} = ${completionGateVar} && typeof ${completionGateVar}.then === "function"`);
    this.emit.line(`    ? ${completionGateVar}.then(${finishVar}, (err) => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); throw err; })`);
    this.emit.line(`    : ${finishVar}();`);
    this.emit.line(`  ${finalizedResultVar}.then((value) => cb(null, value)).catch((err) => {`);
    this.emit.line(`    const ${errorVar} = runtime.isPoisonError(err) ? err : runtime.handleError(err, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line(`    cb(${errorVar});`);
    this.emit.line('  });');
    this.emit.line('} else {');
    this.emit.line(`  if (${completionGateVar} && typeof ${completionGateVar}.then === "function") {`);
    this.emit.line(`    ${completionGateVar}.then(() => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); }, (err) => {`);
    this.emit.line(`      ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line('      throw err;');
    this.emit.line(`    }).catch((err) => {`);
    this.emit.line(`      const ${errorVar} = runtime.isPoisonError(err) ? err : runtime.handleError(err, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
    this.emit.line(`      cb(${errorVar});`);
    this.emit.line('    });');
    this.emit.line('  } else {');
    this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line('  }');
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('}');
  }

  _compileAsyncScriptConstructorEntry(node, sharedChannelNames = [], constructorLinkedChannels = []) {
    this.compiler._withRootExportBufferScope(() => {
      this.emit.beginEntryFunction(
        node,
        'm___constructor__',
        constructorLinkedChannels
      );
      this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
      this.compiler.emitDeclareReturnChannel(this.compiler.buffer.currentBuffer);
      this.compiler._emitRootSequenceLockDeclarations(node);
      this.compiler._emitRootExternInitialization(node);

      if (this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends) {
        const staticExtendsIndex = node.children.findIndex((child) => child instanceof nodes.Extends);
        if (staticExtendsIndex === -1) {
          throw new Error('Compiler invariant: static script extends analysis found no root Extends node');
        }
        const extendsNode = node.children[staticExtendsIndex];
        const preExtendsChildren = node.children.slice(0, staticExtendsIndex);
        const postExtendsChildren = node.children.slice(staticExtendsIndex + 1);

        preExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });

        this.compileAsyncStaticRootExtends(
          extendsNode,
          node,
          sharedChannelNames || []
        );
        postExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
      } else {
        this.compiler._compileChildren(node, null);
      }

      this.emit.line('context.resolveExports();');
      const returnVar = this.compiler._tmpid();
      this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, node, returnVar, !this.compiler.hasStaticExtends);
      if (this.compiler.hasStaticExtends) {
        const finalizedReturnVar = this.compiler._tmpid();
        this.emit.line(`const ${finalizedReturnVar} = context.asyncExtendsBlocksPromise`);
        this.emit.line(`  ? context.asyncExtendsBlocksPromise.then(() => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); return ${returnVar}; }, (err) => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); throw err; })`);
        this.emit.line(`  : (() => { ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks(); return ${returnVar}; })();`);
        this.emit.line(`return ${finalizedReturnVar};`);
      } else {
        this.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line(`return ${returnVar};`);
      }
      this.emit.endEntryFunction(node, true);
    });
  }

  _compileAsyncTemplateConstructorEntry(node, constructorLinkedChannels = []) {
    this.compiler._withRootExportBufferScope(() => {
      this.emit.beginEntryFunction(
        node,
        'm___constructor__',
        constructorLinkedChannels,
        [],
        { ownTextChannel: false }
      );
      this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
      this.compiler._emitRootSequenceLockDeclarations(node);
      this.compiler._emitRootExternInitialization(node);

      if (this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends) {
        const staticExtendsIndex = node.children.findIndex((child) => child instanceof nodes.Extends);
        if (staticExtendsIndex === -1) {
          throw new Error('Compiler invariant: static template extends analysis found no root Extends node');
        }
        const extendsNode = node.children[staticExtendsIndex];
        const preExtendsChildren = node.children.slice(0, staticExtendsIndex);
        const postExtendsChildren = node.children.slice(staticExtendsIndex + 1);

        preExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
        this.emitInheritanceLocalCaptureSnapshot(node);
        this.compileAsyncStaticTemplateExtends(extendsNode);
        postExtendsChildren.forEach((child) => {
          this.compiler.compile(child, null);
        });
      } else {
        this.compiler._compileChildren(node, null);
      }

      this.emitInheritanceLocalCaptureSnapshot(node);
      this.emit.line('context.resolveExports();');
      this.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line('return null;');
      this.emit.endEntryFunction(node, true);
    });
  }

  _compileAsyncRootBody(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    this.emit.line(`runtime.markChannelBufferScope(${this.compiler.buffer.currentBuffer});`);
    if (this.compiler.scriptMode) {
      if (this.compiler._needsRootInheritanceState(compiledMethods, rootSharedSchema)) {
        this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
      }
      this._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);
      const constructorMethod = compiledMethods && compiledMethods.__constructor__;
      this._emitRootConstructorAdmission(node, constructorMethod);
      return;
    }

    if (this.compiler.hasDynamicExtends) {
      if (this.compiler._needsRootInheritanceState(compiledMethods, rootSharedSchema)) {
        this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
      }
      this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "__parentTemplate", "var", context, null);`);
      this.compiler._emitRootSequenceLockDeclarations(node);
      this._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);
      this.compiler._emitRootExternInitialization(node);
      this.compiler._compileChildren(node, null);
      this.emit.line('context.resolveExports();');
      this.emitAsyncRootCompletion(node);
      return;
    }

    if (this.compiler._needsRootInheritanceState(compiledMethods, rootSharedSchema)) {
      this.emit.line('inheritanceState = inheritanceState || runtime.createInheritanceState();');
    }
    this._emitRootInheritanceBootstrap(compiledMethods || [], rootSharedSchema || []);
    const constructorMethod = compiledMethods && compiledMethods.__constructor__;
    this._emitRootConstructorAdmission(node, constructorMethod);
  }

  _compileAsyncRoot(node, sharedChannelNames = null, compiledMethods = null, rootSharedSchema = null) {
    this.compiler._withRootExportBufferScope(() => {
      this.emit.beginEntryFunction(
        node,
        'root',
        this.compiler.scriptMode ? (sharedChannelNames || []) : null
      );
      this._compileAsyncRootBody(node, sharedChannelNames, compiledMethods, rootSharedSchema);
      this.emit.endEntryFunction(node, true);
    });
    this.compiler.inBlock = true;
    return this.compiler._compileAsyncBlockEntries(node);
  }
}

module.exports = CompileExtends;
