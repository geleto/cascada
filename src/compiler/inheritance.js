'use strict';

const nodes = require('../nodes');
const CompileBuffer = require('./buffer');
const INHERITANCE_STARTUP_PROMISE_VAR = '__inheritanceStartupPromise';

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

  _emitValueImportBinding(name, sourceVar, node) {
    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${name}", "var", context, null);`);
    this.emit.line(
      `${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${sourceVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${name}');`
    );
    if (this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.emit.line(`context.addDeferredExport("${name}", "${name}", ${this.compiler.buffer.currentBuffer});`);
    }
  }

  _compileAsyncGetTemplateOrScript(node, eagerCompile, ignoreMissing, allowNoParent = false) {
    const parentTemplateId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    const getTemplateFunc = this.compiler._tmpid();
    const resolvedTargetValue = this.compiler._tmpid();
    // Template/script lookup expressions feed composition boundaries, which
    // emit their own completion tracking separately from root-expression WRCs.
    this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`const ${resolvedTargetValue} = `);
    this.compiler.compileExpression(node.template, null, positionNode, true);
    this.emit.line(';');
    this.emit.line(`let ${parentTemplateId} = runtime.resolveSingle(${resolvedTargetValue}).then((resolvedTemplateName) => {`);
    if (allowNoParent) {
      this.emit.line('  if (resolvedTemplateName === null || resolvedTemplateName === undefined) {');
      this.emit.line('    return null;');
      this.emit.line('  }');
    }
    this.emit.line(`  return ${getTemplateFunc}(resolvedTemplateName, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    this.emit.line('});');

    return parentTemplateId;
  }

  _emitExplicitExternInputs(node, targetVarsVar) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const externName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(externName)}] = `);
      this.compiler.compileExpression(nameNode, null, nameNode, true);
      this.emit.line(';');
    });
    if (node.withValue) {
      // Object-style inputs are merged last, so they intentionally override
      // earlier shorthand `with foo, bar` entries on key collisions.
      this.emit(`Object.assign(${targetVarsVar}, `);
      this.compiler.compileExpression(node.withValue, null, node.withValue, true);
      this.emit.line(');');
    }
  }

  _emitImmediateExternInputs(node, targetVarsVar) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const externName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(externName)}] = runtime.captureCompositionValue(context, ${JSON.stringify(externName)}, ${this.compiler.buffer.currentBuffer}`);
      this.emit.line(');');
    });
  }

  _emitNamedArgBindings(argNodes, targetVarsVar) {
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

  _compileSyncGetTemplate(node, frame, eagerCompile, ignoreMissing, allowNoParent = false) {
    const templateId = this.compiler._tmpid();
    const errId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const resolvedTargetValue = this.compiler._tmpid();

    this.emit(`let ${resolvedTargetValue} = `);
    // Template lookup expressions feed composition boundaries, which
    // emit their own completion tracking separately from root-expression WRCs.
    this.compiler.compileExpression(node.template, frame, node.template, true);
    this.emit.line(';');
    this.emit.line(`(function(cb) {`);
    if (allowNoParent) {
      this.emit.line(`  if (${resolvedTargetValue} === null || ${resolvedTargetValue} === undefined) {`);
      this.emit.line('    cb(null, null);');
      this.emit.line('  } else {');
      this.emit.line(`    env.getTemplate(${resolvedTargetValue}, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, cb);`);
      this.emit.line('  }');
    } else {
      this.emit.line(`  env.getTemplate(${resolvedTargetValue}, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, cb);`);
    }
    this.emit.line(`})(function(${errId}, ${templateId}) {`);
    this.emit.line(`if(${errId}) { cb(${errId}); return; }`);

    return templateId;
  }

  _compileAsyncImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      const target = node.target.value;
      const id = this._compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  runtime.validateIsolatedExternSpec(resolvedTemplate.externSpec || [], "import");');
      this.emit.line('  return resolvedTemplate.getExported(null, cb);');
      this.emit.line('});');
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      this._emitValueImportBinding(target, exportedId, node);
      return;
    }

    const target = node.target.value;
    const id = this._compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const importVarsVar = this.compiler._tmpid();
    const importInputNamesVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this.emit.line(`let ${importVarsVar} = {};`);
    this._emitExplicitExternInputs(node, importVarsVar);
    this._emitCompositionContextObject(node, importVarsVar, importContextVar, importInputNamesVar);
    this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line(`  runtime.validateExternInputs(resolvedTemplate.externSpec || [], ${importInputNamesVar}, Object.keys(${importContextVar}), "import");`);
    this.emit.line(`  return resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, cb);`);
    this.emit.line('});');
    this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
    this._emitValueImportBinding(target, exportedId, node);
  }

  _compileSyncImport(node, frame) {
    if ((node.withVars && node.withVars.children && node.withVars.children.length > 0) || node.withValue) {
      this.compiler.fail(
        'sync import does not support explicit with inputs',
        node.lineno,
        node.colno,
        node
      );
    }
    const target = node.target.value;
    const id = this._compileSyncGetTemplate(node, frame, false, false);
    this.emit.addScopeLevel();
    this.emit.line(id + '.getExported(' +
      (node.withContext ? 'context.getVariables(), frame, ' : '') +
      this.compiler._makeCallback(id));
    this.emit.addScopeLevel();
    frame.set(target, id);
    if (frame.parent) {
      this.emit.line(`frame.set("${target}", ${id});`);
    } else {
      this.emit.line(`context.setVariable("${target}", ${id});`);
    }
  }

  _compileAsyncFromImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0) {
      const importedId = this._compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      const bindingIds = [];
      this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  runtime.validateIsolatedExternSpec(resolvedTemplate.externSpec || [], "from-import");');
      this.emit.line('  return resolvedTemplate.getExported(null, cb);');
      this.emit.line('});');

      node.names.children.forEach((nameNode) => {
        let name;
        let alias;
        let id = this.compiler._tmpid();

        if (nameNode instanceof nodes.Pair) {
          name = nameNode.key.value;
          alias = nameNode.value.value;
        } else {
          name = this.compiler.analysis.getBaseChannelName(nameNode.value);
          alias = nameNode.value;
        }

        const errorContext = this.compiler._generateErrorContext(node, nameNode);
        const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

        this.emit.line(`let ${id} = (async () => { try {`);
        this.emit.line(`  let exported = await ${exportedId};`);
        this.emit.line(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this.emit.line(`    return exported["${name}"];`);
        this.emit.line(`  } else {`);
        this.emit.line(`    var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err;`);
        this.emit.line(`  }`);
        this.emit.line(`} catch(e) { var err = runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err; } })();`);
        bindingIds.push(id);

        this._emitValueImportBinding(alias, id, node);
      });

      if (bindingIds.length > 0) {
        const boundaryCompletion = this.compiler._tmpid();
        this.emit.line(`let ${boundaryCompletion} = runtime.resolveAll([${bindingIds.join(', ')}]);`);
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(boundaryCompletion, node);
      } else {
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      }
      return;
    }

    const importedId = this._compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const bindingIds = [];
    const importVarsVar = this.compiler._tmpid();
    const importInputNamesVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this.emit.line(`let ${importVarsVar} = {};`);
    this._emitExplicitExternInputs(node, importVarsVar);
    this._emitCompositionContextObject(node, importVarsVar, importContextVar, importInputNamesVar);
    this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line(`  runtime.validateExternInputs(resolvedTemplate.externSpec || [], ${importInputNamesVar}, Object.keys(${importContextVar}), "from-import");`);
    this.emit.line(`  return resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, cb);`);
    this.emit.line('});');

    node.names.children.forEach((nameNode) => {
      let name;
      let alias;
      let id = this.compiler._tmpid();

      if (nameNode instanceof nodes.Pair) {
        name = nameNode.key.value;
        alias = nameNode.value.value;
      } else {
        name = this.compiler.analysis.getBaseChannelName(nameNode.value);
        alias = nameNode.value;
      }

      const errorContext = this.compiler._generateErrorContext(node, nameNode);
      const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

      this.emit.line(`let ${id} = (async () => { try {`);
      this.emit.line(`  let exported = await ${exportedId};`);
      this.emit.line(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
      this.emit.line(`    return exported["${name}"];`);
      this.emit.line(`  } else {`);
      this.emit.line(`    var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err;`);
      this.emit.line(`  }`);
      this.emit.line(`} catch(e) { var err = runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err; } })();`);
      bindingIds.push(id);

      this._emitValueImportBinding(alias, id, node);
    });

    if (bindingIds.length > 0) {
      const boundaryCompletion = this.compiler._tmpid();
      this.emit.line(`let ${boundaryCompletion} = runtime.resolveAll([${bindingIds.join(', ')}]);`);
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(boundaryCompletion, node);
    } else {
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
    }
  }

  _compileSyncFromImport(node, frame) {
    if (node.withVars && node.withVars.children && node.withVars.children.length > 0) {
      this.compiler.fail(
        'sync from-import does not support explicit with variables',
        node.lineno,
        node.colno,
        node
      );
    }
    const importedId = this._compileSyncGetTemplate(node, frame, false, false);
    this.emit.addScopeLevel();
    this.emit.line(importedId + '.getExported(' +
      (node.withContext ? 'context.getVariables(), frame, ' : '') +
      this.compiler._makeCallback(importedId));
    this.emit.addScopeLevel();

    node.names.children.forEach((nameNode) => {
      let name;
      let alias;
      let id = this.compiler._tmpid();
      this.emit.line(`let ${id};`);

      if (nameNode instanceof nodes.Pair) {
        name = nameNode.key.value;
        alias = nameNode.value.value;
      } else {
        name = nameNode.value;
        alias = name;
      }

      const errorContext = this.compiler._generateErrorContext(node, nameNode);
      const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

      this.emit.line(`if(Object.prototype.hasOwnProperty.call(${importedId}, "${name}")) {`);
      this.emit.line(`${id} = ${importedId}.${name};`);
      this.emit.line('} else {');
      this.emit.line(`var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); cb(err); return;`);
      this.emit.line('}');

      frame.set(alias, id);
      if (frame.parent) {
        this.emit.line(`frame.set("${alias}", ${id});`);
      } else {
        this.emit.line(`context.setVariable("${alias}", ${id});`);
      }
    });
  }

  compileAsyncImport(node) {
    this._compileAsyncImport(node);
  }

  compileSyncImport(node, frame) {
    this._compileSyncImport(node, frame);
  }

  compileAsyncFromImport(node) {
    this._compileAsyncFromImport(node);
  }

  compileSyncFromImport(node, frame) {
    this._compileSyncFromImport(node, frame);
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

    this.compiler.boundaries.compileBlockTextBoundary(
      this.compiler.buffer,
      node,
      (id) => {
        this.emit.line(`let ${id};`);
        const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
        const explicitBlockArgNodes = this.getBlockArgNodes(node);
        const explicitBlockArgsNode = new nodes.NodeList(node.lineno, node.colno, explicitBlockArgNodes);
        const needsParentCheck = isTopLevelTemplateBlock && (this.compiler.hasDynamicExtends || this.compiler.hasStaticExtends);
        if (needsParentCheck) {
          this.emit.line('const parentPromise = runtime.resolveSingle(extendsState && extendsState.parentSelection);');
          this.emit.line(`${id} = parentPromise.then((parent) => {`);
          // A truthy parent means this top-level child block will be rendered
          // through the selected parent path instead of dispatching locally.
          this.emit.line('  if (parent) return "";');
          this.emit(`  return runtime.invokeInheritedMethod(inheritanceState, "${node.name.value}", `);
          this.compiler._compileAggregate(explicitBlockArgsNode, null, '[', ']', false, false);
          this.emit.line(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson});`);
          this.emit.line('});');
        } else {
          this.emit(`  ${id} = runtime.invokeInheritedMethod(inheritanceState, "${node.name.value}", `);
          this.compiler._compileAggregate(explicitBlockArgsNode, null, '[', ']', false, false);
          this.emit.line(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson});`);
        }
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(id, node);
      }
    );
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

  emitAsyncRootStateInitialization(compiledMethodsVar, compiledSharedSchemaVar) {
    if (!this.compiler.needsInheritanceState) {
      this.emit.line('if (inheritanceState) {');
      this.emit.line('  inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context);');
      this.emit.line('}');
      return;
    }
    this.emit.line('if (!inheritanceState) {');
    this.emit.line('  inheritanceState = runtime.createInheritanceState();');
    this.emit.line('}');
    this.emit.line(`inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, ${compiledMethodsVar}, ${compiledSharedSchemaVar}, ${this.compiler.buffer.currentBuffer}, context);`);
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
      this.emit.line(`let ${INHERITANCE_STARTUP_PROMISE_VAR} = null;`);
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
        if (constructorDefinition && constructorDefinition.body) {
          this.compiler._compileChildren(constructorDefinition.body, null);
        }
      } finally {
        this.compiler.currentCallableDefinition = previousCallableDefinition;
        this.compiler.isCompilingCallableEntry = previousCompilingCallableEntry;
      }
      this.emit.line('if (!runtime.isInheritanceCompositionMode(inheritanceState, runtime.COMPONENT_COMPOSITION_MODE)) {');
      this.emit.line('  context.resolveExports();');
      this.emit.line('}');
      this.emit.line(`return ${INHERITANCE_STARTUP_PROMISE_VAR};`);
      this.emit.closeScopeLevels();
      this.emit.line('} catch (e) {');
      this.emit.line(`  throw runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line('}');
      this.emit.line('}');
    });
  }

  emitScriptRootLeafResult(node) {
    const returnVar = this.compiler._tmpid();
    if (this.compiler.hasExtends) {
      // The boundary promise gates root-buffer finalization. `getFinishedPromise()`
      // also waits on child buffers, but we must not mark the root buffer finished
      // until the extends boundary has linked the parent work into the tree.
      this.emit.line(`    if (${INHERITANCE_STARTUP_PROMISE_VAR}) {`);
      this.emit.line(`      await ${INHERITANCE_STARTUP_PROMISE_VAR};`);
      this.emit.line('    }');
    }
    this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, node, returnVar);
    this.emit.line(`    await ${this.compiler.buffer.currentBuffer}.getFinishedPromise();`);
    this.emit.line(`    if (inheritanceState && inheritanceState.sharedRootBuffer && inheritanceState.sharedRootBuffer !== ${this.compiler.buffer.currentBuffer}) {`);
      this.emit.line('      inheritanceState.sharedRootBuffer.markFinishedAndPatchLinks();');
      this.emit.line('      await inheritanceState.sharedRootBuffer.getFinishedPromise();');
    this.emit.line('    }');
    this.emit.line(`    cb(null, runtime.normalizeFinalPromise(await ${returnVar}));`);
  }

  emitAsyncTemplateRootLeafResult() {
    if (this.compiler.hasExtends) {
      this.emit.line(`    if (${INHERITANCE_STARTUP_PROMISE_VAR}) {`);
      this.emit.line(`      await ${INHERITANCE_STARTUP_PROMISE_VAR};`);
      this.emit.line('    }');
    }
    if (this.compiler.hasDeferredDynamicExtends) {
      this._emitDynamicTemplateParentRender(`    `);
    }
    this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`    if (inheritanceState && inheritanceState.sharedRootBuffer && inheritanceState.sharedRootBuffer !== ${this.compiler.buffer.currentBuffer}) { inheritanceState.sharedRootBuffer.markFinishedAndPatchLinks(); }`);
    this.emit.line(`    cb(null, await ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot());`);
  }

  _emitParentRootRender({ indent = '', templateExpr, compositionPayloadExpr, currentBufferExpr }) {
    const parentTemplateVar = this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();
    const parentOutputVar = this.compiler._tmpid();
    const parentCompositionModeVar = this.compiler._tmpid();

    this.emit.line(`${indent}const ${parentTemplateVar} = await runtime.resolveSingle(${templateExpr});`);
    this.emit.line(`${indent}if (${parentTemplateVar} === null || ${parentTemplateVar} === undefined) {`);
    this.emit.line(`${indent}  return;`);
    this.emit.line(`${indent}}`);
    this.emit.line(`${indent}${parentTemplateVar}.compile();`);
    this.emit.line(`${indent}const ${parentContextVar} = ${compositionPayloadExpr}`);
    this.emit.line(`${indent}  ? context.forkForComposition(${parentTemplateVar}.path, ${compositionPayloadExpr}.rootContext || {}, context.getRenderContextVariables(), ${compositionPayloadExpr}.externContext || {})`);
    this.emit.line(`${indent}  : context.forkForPath(${parentTemplateVar}.path);`);
    this.emit.line(`${indent}const ${parentCompositionModeVar} = runtime.isInheritanceCompositionMode(inheritanceState, runtime.COMPONENT_COMPOSITION_MODE) ? runtime.COMPONENT_COMPOSITION_MODE : true;`);
    this.emit.line(`${indent}const ${parentOutputVar} = ${parentTemplateVar}.rootRenderFunc(env, ${parentContextVar}, runtime, cb, ${parentCompositionModeVar}, ${currentBufferExpr}, inheritanceState);`);
    this.emit.line(`${indent}await runtime.waitForParentRootRender(${parentOutputVar}, ${currentBufferExpr}, inheritanceState, ${parentCompositionModeVar});`);
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
    this.emit.line(`} else if (compositionMode === runtime.COMPONENT_COMPOSITION_MODE) {`);
    this.emit.line(`  return ${this.compiler.buffer.currentBuffer};`);
    this.emit.line('} else {');
    if (this.compiler.hasExtends) {
      this.emit.line(`  if (${INHERITANCE_STARTUP_PROMISE_VAR}) {`);
      this.emit.line(`    ${INHERITANCE_STARTUP_PROMISE_VAR} = ${INHERITANCE_STARTUP_PROMISE_VAR}.then(async () => {`);
      if (this.compiler.hasDeferredDynamicExtends) {
        this._emitDynamicTemplateParentRender(`      `);
      }
      this.emit.line(`      ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`      return ${this.compiler.buffer.currentBuffer};`);
      this.emit.line('    }).catch((e) => {');
      this.emit.line(`      var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
      this.emit.line('      cb(err);');
      this.emit.line('    });');
      this.emit.line(`    runtime.setInheritanceStartupPromise(inheritanceState, ${INHERITANCE_STARTUP_PROMISE_VAR});`);
      this.emit.line('  } else {');
      if (this.compiler.hasDeferredDynamicExtends) {
        const finishPromiseVar = this.compiler._tmpid();
        this.emit.line(`    const ${finishPromiseVar} = (async () => {`);
        this._emitDynamicTemplateParentRender(`      `);
        this.emit.line(`      ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line(`      return ${this.compiler.buffer.currentBuffer};`);
        this.emit.line('    })();');
        this.emit.line(`    ${INHERITANCE_STARTUP_PROMISE_VAR} = ${finishPromiseVar};`);
        this.emit.line(`    runtime.setInheritanceStartupPromise(inheritanceState, ${finishPromiseVar});`);
        this.emit.line(`    ${finishPromiseVar}.catch((e) => {`);
        this.emit.line(`      var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node)}", context.path);`);
        this.emit.line('      cb(err);');
        this.emit.line('    });');
      } else {
        this.emit.line(`    ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      }
      this.emit.line('  }');
    } else {
      this.emit.line(`  ${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    }
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

  _emitExtendsCompositionPayload(node, extendsVarsVar, extendsExternInputNamesVar, extendsExternContextVar, extendsRootContextVar, payloadVar) {
    this.emit.line(`const ${payloadVar} = inheritanceState && inheritanceState.compositionPayload ? inheritanceState.compositionPayload : {`);
    this.emit.line(`  explicitInputValues: ${extendsVarsVar},`);
    this.emit.line(`  explicitInputNames: ${extendsExternInputNamesVar},`);
    this.emit.line(`  rootContext: ${extendsRootContextVar},`);
    this.emit.line(`  externContext: ${extendsExternContextVar}`);
    this.emit.line('};');
    this.emit.line('if (inheritanceState && !inheritanceState.compositionPayload) {');
    this.emit.line(`  inheritanceState.compositionPayload = ${payloadVar};`);
    this.emit.line('}');
  }

  _prepareAsyncExtendsCompositionPayload(node, emitInputCapture) {
    const extendsVarsVar = this.compiler._tmpid();
    const extendsExternInputNamesVar = this.compiler._tmpid();
    const extendsExternContextVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const compositionPayloadVar = this.compiler._tmpid();

    this.emit.line(`const ${extendsVarsVar} = {};`);
    emitInputCapture(extendsVarsVar);
    this._emitCompositionContextObject(node, extendsVarsVar, extendsExternContextVar, extendsExternInputNamesVar, !!node.withContext);
    this._emitCompositionContextObject(node, extendsVarsVar, extendsRootContextVar, null, true);
    this._emitExtendsCompositionPayload(
      node,
      extendsVarsVar,
      extendsExternInputNamesVar,
      extendsExternContextVar,
      extendsRootContextVar,
      compositionPayloadVar
    );

    return {
      extendsVarsVar,
      extendsExternInputNamesVar,
      extendsExternContextVar,
      extendsRootContextVar,
      compositionPayloadVar
    };
  }

  _emitTemplateExtendsBoundaryFromSelection(deferredSelectionVar) {
    const linkedChannelsArg = '["__text__"]';
    this.emit.line(`${INHERITANCE_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`);
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

  getBlockArgNames(block) {
    return this.getBlockSignature(block).argNames;
  }

  getBlockArgNodes(block) {
    return this.getBlockSignature(block).argNodes;
  }

  getBlockSignature(block) {
    const signatureArgs = block && block.args && block.args.children ? block.args : new nodes.NodeList();
    const parsed = this.compiler._parseCallableSignature(signatureArgs, {
      allowKeywordArgs: false,
      symbolsOnly: true,
      label: 'block signature',
      ownerNode: block
    });
    return {
      argNames: parsed.args.map((nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value)),
      argNodes: parsed.args
    };
  }

  emitAsyncBlockArgInitialization(block, options = {}) {
    const blockSignature = this.getBlockSignature(block);
    const declaredBlockArgNames = Array.isArray(options.declaredBlockArgNames)
      ? options.declaredBlockArgNames
      : blockSignature.argNames;
    const staticLocalNames = Array.from(new Set(declaredBlockArgNames));
    const allLocalNamesVar = this.compiler._tmpid();
    const blockPayloadOriginalArgsVar = options.payloadOriginalArgsVar || this.compiler._tmpid();

    this.emit.line(`const ${allLocalNamesVar} = ${JSON.stringify(staticLocalNames)};`);
    if (!options.payloadOriginalArgsVar) {
      this.emit.line(`const ${blockPayloadOriginalArgsVar} = blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};`);
    }
    this.emit.line(`if (${allLocalNamesVar}.length > 0) {`);
    this.emit.line(`for (const name of ${allLocalNamesVar}) {`);
    const blockValueId = this.compiler._tmpid();
    this.emit.line(`  runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, name, "var", context, null);`);
    this.emit.line(`  const ${blockValueId} = ${blockPayloadOriginalArgsVar}[name];`);
    this.emit.line(`  ${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: name, args: [${blockValueId}], pos: {lineno: ${block.lineno}, colno: ${block.colno}} }), name);`);
    this.emit.line('}');
    this.emit.line('}');
  }

  compileAsyncBlockEntry(block) {
    const name = block.name.value;
    const isScriptMethod = this._isScriptMethodEntry(block);
    const invocationPath = isScriptMethod
      ? JSON.stringify(this._getMethodInvocationPath(block))
      : (this.compiler.templateName == null
        ? 'null'
        : JSON.stringify(String(this.compiler.templateName)));
    const declaredBlockArgNames = this.getBlockArgNames(block);
    // This only wires the entry-local output buffer to its immediate parent
    // invocation buffer. Caller-side inherited dispatch linking is resolved
    // separately from helper-resolved method metadata at runtime.
    const extraParams = ['blockPayload = null', 'blockRenderCtx = undefined', 'inheritanceState = null', 'methodData'];
    this.emit.beginEntryFunction(
      block,
      `b_${name}`,
      null,
      extraParams
    );
    if (isScriptMethod) {
      this.compiler.emitDeclareReturnChannel(this.compiler.buffer.currentBuffer);
    }
    const payloadOriginalArgsVar = this.compiler._tmpid();
    this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};`);
    if (isScriptMethod) {
      const methodBaseContextVar = this.compiler._tmpid();
      const methodExternContextVar = this.compiler._tmpid();
      this.emit.line(`const ${methodBaseContextVar} = context.getCompositionContextVariables ? context.getCompositionContextVariables() : (context.getRenderContextVariables ? context.getRenderContextVariables() : {});`);
      this.emit.line(`const ${methodExternContextVar} = context.getExternContextVariables ? context.getExternContextVariables() : undefined;`);
      this.emit.line(`context = context.forkForComposition(${invocationPath}, ${methodBaseContextVar}, ${block.withContext ? '(blockRenderCtx || undefined)' : 'undefined'}, ${methodExternContextVar});`);
    } else {
      const signatureBaseContextVar = this.compiler._tmpid();
      const payloadContextVar = this.compiler._tmpid();
      const blockExternContextVar = this.compiler._tmpid();
      this.emit.line(`const ${blockExternContextVar} = context.getExternContextVariables ? context.getExternContextVariables() : undefined;`);
      this.emit.line(
        `const ${signatureBaseContextVar} = ${declaredBlockArgNames.length > 0
          ? (block.withContext
            ? '(blockRenderCtx || {})'
            : '{}')
          // During the composition-context transition, some callers still
          // expose only render-context variables while newer paths provide a
          // dedicated composition-context view.
          : '(context.getCompositionContextVariables ? context.getCompositionContextVariables() : (context.getRenderContextVariables ? context.getRenderContextVariables() : {}))'};`
      );
      this.emit.line(`const ${payloadContextVar} = Object.assign({}, ${signatureBaseContextVar}, ${payloadOriginalArgsVar});`);
      this.emit.line(`if (blockPayload !== null || blockRenderCtx !== undefined || Object.keys(${payloadContextVar}).length > 0) {`);
      this.emit.line(`  context = context.forkForComposition(${invocationPath}, ${payloadContextVar}, ${block.withContext ? 'blockRenderCtx' : 'undefined'}, ${blockExternContextVar});`);
      this.emit.line('} else {');
      this.emit.line(`  context = context.forkForPath(${invocationPath});`);
      this.emit.line('}');
    }
    this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
    this.emit.line(`runtime.linkCurrentBufferToParentChannels(parentBuffer, ${this.compiler.buffer.currentBuffer}, runtime.getMethodLinkedChannels(methodData));`);
    if (!isScriptMethod) {
      this.emit.line(`${this.compiler.buffer.currentTextChannelVar}._context = context;`);
    }
    this.emitAsyncBlockArgInitialization(block, {
      declaredBlockArgNames,
      payloadOriginalArgsVar
    });
    const previousCallableDefinition = this.compiler.currentCallableDefinition;
    const previousCompilingCallableEntry = this.compiler.isCompilingCallableEntry;
    this.compiler.currentCallableDefinition = block;
    this.compiler.isCompilingCallableEntry = true;
    try {
      this.compiler.compile(block.body, null);
    } finally {
      this.compiler.currentCallableDefinition = previousCallableDefinition;
      this.compiler.isCompilingCallableEntry = previousCompilingCallableEntry;
    }
    if (isScriptMethod) {
      const resultVar = this.compiler._tmpid();
      this.compiler.emitReturnChannelSnapshot(this.compiler.buffer.currentBuffer, block, resultVar);
      // Script methods still own their entry-local output buffer lifetime.
      // The invocation command waits on the per-call invocation buffer after
      // this local buffer closes, so caller-visible completion still covers the
      // full inherited call.
      this.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`return runtime.normalizeFinalPromise(${resultVar});`);
    } else {
      this.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`return ${this.compiler.buffer.currentTextChannelVar}.finalSnapshot();`);
    }
    this.emit.endEntryFunction(block, true);
  }

  compileAsyncBlockEntries(node) {
    const blockNames = new Set();
    const blocks = this.compiler.scriptMode
      ? this.compiler._getMethodDefinitions(node)
      : node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const name = block.name.value;

      if (blockNames.has(name)) {
        this.compiler.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.add(name);
      this.compileAsyncBlockEntry(block);
    });

    return blocks;
  }

  collectCompiledMethods(node, blocks, pendingMethodNames = []) {
    const localMethodNames = new Set();
    const constructorDefinition = this.compiler._getConstructorDefinition(node);
    const ownerKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
    const pendingLinkedChannelsExpr = JSON.stringify(
      this.compiler._getSharedDeclarations(node).map((child) => child.name.value)
    );
    const methodEntries = blocks.map((block) => {
      const methodName = block.name.value;
      localMethodNames.add(methodName);
      return this.compileMethodMetadataEntry({
        methodName,
        fnExpr: `b_${methodName}`,
        analysis: block.body && block.body._analysis,
        ownerNode: block,
        superExpr: this.blockUsesSuper(block)
          ? `__createPendingInheritanceEntry(${pendingLinkedChannelsExpr})`
          : 'null',
        signatureExpr: JSON.stringify({
          argNames: this.getBlockSignature(block).argNames,
          withContext: !!block.withContext
        }),
        ownerKey
      });
    });

    if (constructorDefinition) {
      methodEntries.push(this.compileMethodMetadataEntry({
        methodName: '__constructor__',
        fnExpr: 'b___constructor__',
        analysis: constructorDefinition.body && constructorDefinition.body._analysis,
        ownerNode: constructorDefinition,
        superExpr: this.blockUsesSuper(constructorDefinition)
          ? `__createPendingInheritanceEntry(${pendingLinkedChannelsExpr})`
          : 'null',
        signatureExpr: JSON.stringify({ argNames: [], withContext: false }),
        ownerKey
      }));
    }

    pendingMethodNames.forEach((name) => {
      if (localMethodNames.has(name) || name === '__constructor__') {
        return;
      }
      methodEntries.push(`${JSON.stringify(name)}: __createPendingInheritanceEntry(${pendingLinkedChannelsExpr})`);
    });
    return `{ ${methodEntries.join(', ')} }`;
  }

  compileMethodMetadataEntry({ methodName, fnExpr, analysis, ownerNode, superExpr, signatureExpr, ownerKey }) {
    const ownUsedChannels = JSON.stringify(this.collectMethodChannelNames(analysis, ownerNode));
    const ownMutatedChannels = JSON.stringify(this.collectMethodChannelNames(
      analysis,
      ownerNode,
      'mutatedChannels'
    ));
    const sharedLookupCandidates = JSON.stringify(this.collectMethodSharedLookupCandidates(ownerNode));
    return `${JSON.stringify(methodName)}: { fn: ${fnExpr}, ownUsedChannels: ${ownUsedChannels}, ownMutatedChannels: ${ownMutatedChannels}, sharedLookupCandidates: ${sharedLookupCandidates}, super: ${superExpr}, signature: ${signatureExpr}, ownerKey: ${ownerKey} }`;
  }

  collectMethodSharedLookupCandidates(ownerNode) {
    if (this.compiler.scriptMode || !(ownerNode instanceof nodes.Block) || !ownerNode.body) {
      return [];
    }

    const candidates = new Set();
    ownerNode.body.findAll(nodes.Symbol).forEach((symbolNode) => {
      if (!symbolNode || symbolNode.isCompilerInternal || (symbolNode._analysis && symbolNode._analysis.declarationTarget)) {
        return;
      }
      const name = symbolNode.value;
      if (!name) {
        return;
      }
      if (this.compiler.analysis.findDeclaration(symbolNode._analysis, name)) {
        return;
      }
      candidates.add(name);
    });

    return Array.from(candidates);
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

  hasMethodSuperDependencies(blocks) {
    return Array.isArray(blocks) && blocks.some((block) => this.blockUsesSuper(block));
  }

  emitPendingInheritanceEntryFactory() {
    this.emit.line('const __createPendingInheritanceEntry = runtime.createPendingInheritanceEntry;');
  }

  collectMethodChannelNames(analysis, ownerNode, fieldName = 'usedChannels') {
    if (!analysis) {
      return [];
    }

    return Array.from(analysis[fieldName] || []).filter((name) => {
      if (!name || name === '__return__' || name === CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL) {
        return false;
      }
      const declaration = this.compiler.analysis.findDeclaration(analysis, name);
      if (declaration && (declaration.internal || declaration.blockArg)) {
        return false;
      }
      if (ownerNode && (ownerNode instanceof nodes.Block || ownerNode instanceof nodes.MethodDefinition)) {
        const declarationOwner = this.compiler.analysis.findDeclarationOwner(analysis, name);
        if (declarationOwner === ownerNode._analysis || declarationOwner === ownerNode.body._analysis) {
          return false;
        }
        if (
          ownerNode instanceof nodes.Block &&
          declaration &&
          declaration.type === 'var' &&
          !declaration.shared &&
          !declaration.extern
        ) {
          return false;
        }
      }
      return true;
    });
  }

  compileSyncBlock(node, frame) {
    const args = node.args && node.args.children ? node.args.children : [];
    if (args.length > 0 || node.withContext !== null) {
      this.compiler.fail(
        'block signatures and block with-clauses are only supported in async mode',
        node.lineno,
        node.colno,
        node
      );
    }
    //var id = this._tmpid();

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
        this._emitExplicitExternInputs(node, extendsVarsVar);
      });

      const parentTemplateId = this._compileAsyncGetTemplateOrScript(node, true, false, true);
      // This first channel set links the caller's root buffer to the boundary
      // child buffer so any post-extends constructor work stays ordered behind
      // the boundary slot for the channels currently known at the call site.
      const linkedChannelsArg = 'Object.keys((inheritanceState && inheritanceState.sharedSchema) || {})';
      this.emit.line(`${INHERITANCE_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`);
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
      this._emitImmediateExternInputs(node, extendsVarsVar);
    });
    const parentTemplateId = this._compileAsyncGetTemplateOrScript(node, true, false, true);

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
    if (node.withContext !== null || withVars.length > 0) {
      this.compiler.fail(
        'extends with explicit composition inputs is not implemented yet',
        node.lineno,
        node.colno,
        node
      );
    }
    const parentTemplateId = this._compileSyncGetTemplate(node, frame, true, false, true);
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
    const knownArgNames = compilingBlock ? this.getBlockArgNames(compilingBlock) : [];
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
    this.emit(`runtime.invokeSuperMethod(inheritanceState, "${name}", ${ownerKeyJson}, `);
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

  compileAsyncInclude(node) {
    this.compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      // Get the template object (this part is async)
      const templateVar = this.compiler._tmpid();
      const templateNameVar = this.compiler._tmpid();
      const includeVarsVar = this.compiler._tmpid();
      const includeInputNamesVar = this.compiler._tmpid();
      const includeContextVar = this.compiler._tmpid();
      const includeTextPromise = this.compiler._tmpid();
      // Included template renders into its own default text lane.
      // The caller lane may be scope-specific (e.g. capture text output) and
      // is only used when enqueueing the final TextCommand in the parent buffer.
      const includeOutputChannelName = CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      // Include target lookup is handled by include/import boundary tracking,
      // so it intentionally bypasses root waited-expression tracking.
      this.compiler.compileExpression(node.template, null, node.template, true);
      this.emit.line(';');

      // Keep producer synchronous: carry async template lookup/render in promise chain.
      this.emit.line(`let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}, false, ${JSON.stringify(this.compiler.templateName)}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // Async include passes only explicit extern inputs to the child.
      this.emit.line(`let ${includeVarsVar} = {};`);
      this._emitExplicitExternInputs(node, includeVarsVar);
      this._emitCompositionContextObject(node, includeVarsVar, includeContextVar, includeInputNamesVar);

      this.emit.line(`const ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`${templateVar}_resolved.compile();`);
      this.emit.line(`if (!${node.ignoreMissing ? 'true' : 'false'} || ${templateVar}_resolved.path) {`);
      this.emit.line(`  runtime.validateExternInputs(${templateVar}_resolved.externSpec || [], ${includeInputNamesVar}, Object.keys(${includeContextVar}), "include");`);
      this.emit.line('}');
      this.emit.line(`const composed = ${templateVar}_resolved._renderForComposition(${includeContextVar}, cb, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'});`);
      // Includes own a composed child text boundary. Use the child text channel's
      // finalSnapshot() as the structural completion signal rather than adding an
      // extra point-in-time snapshot command for that boundary.
      this.emit.line(`let ${includeTextPromise} = composed.getChannel("${includeOutputChannelName}").finalSnapshot();`);
      this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.TextCommand({ channelName: "${this.compiler.buffer.currentTextChannelName}", args: [${includeTextPromise}], pos: {lineno: ${node?.lineno ?? 0}, colno: ${node?.colno ?? 0}} }), "${this.compiler.buffer.currentTextChannelName}");`);
      // Include boundary completion in limited-loop waited output.
      // Wait on the composed include snapshot promise (timing unit), not on the
      // command object created for parent enqueue.
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(includeTextPromise, node);
    });
  }

  compileSyncInclude(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this._compileSyncGetTemplate(node, frame, false, node.ignoreMissing);
    this.emit.line(`callback(null,${id});});`);

    this.emit.line('});');

    const id2 = this.compiler._tmpid();
    this.emit.line('tasks.push(');
    this.emit.line('function(template, callback){');
    this.emit.line('template.render(context.getVariables(), frame, ' + this.compiler._makeCallback(id2));
    this.emit.line('callback(null,' + id2 + ');});');
    this.emit.line('});');

    this.emit.line('tasks.push(');
    this.emit.line('function(result, callback){');

    this.emit.line(`${this.compiler.buffer.currentBuffer} += result;`);
    this.emit.line('callback(null);');
    this.emit.line('});');
    this.emit.line('env.waterfall(tasks, function(){');
    this.emit.addScopeLevel();
  }
}

module.exports = CompileInheritance;
module.exports.INHERITANCE_STARTUP_PROMISE_VAR = INHERITANCE_STARTUP_PROMISE_VAR;

