
import * as nodes from '../nodes.js';
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

  getCurrentCallableBindingOwners(node, name) {
    return {
      declarationOwner: this.compiler.analysis.findDeclarationOwner(node._analysis, name),
      callableOwner: this.compiler.currentCallableDefinition
        ? this.compiler.currentCallableDefinition._analysis
        : null,
      callableBodyOwner: this.compiler.currentCallableDefinition && this.compiler.currentCallableDefinition.body
        ? this.compiler.currentCallableDefinition.body._analysis
        : null
    };
  }

  isHiddenFromCurrentCallable(node, name, declaredChannel, opts = {}) {
    const { includeImported = false } = opts;
    const { declarationOwner, callableOwner, callableBodyOwner } =
      this.getCurrentCallableBindingOwners(node, name);
    const isVisibleFromCurrentCallable = !!(
      declaredChannel.shared ||
      (includeImported && declaredChannel.imported) ||
      declarationOwner === callableOwner ||
      declarationOwner === callableBodyOwner
    );
    return !isVisibleFromCurrentCallable;
  }

  supportsExplicitThisDispatch() {
    return !!(this.compiler.scriptMode || this.compiler.templateUsesInheritanceSurface);
  }

  getExplicitThisDispatchMethodName(node) {
    return node instanceof nodes.LookupVal &&
      node.target instanceof nodes.Symbol &&
      node.target.value === 'this' &&
      node.val &&
      'value' in node.val &&
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

  finalizeAnalyzeExplicitThisDispatchCall(node, thisSharedFacts = null) {
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
    this.emit(`runtime.invokeInheritedMethod(inheritanceState, "${methodName}", `);
    this.compiler._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, context, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    return true;
  }

  _emitValueImportBinding(name, sourceVar, node) {
    this.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${name}", "var", context, null);`);
    this.emit.line(
      `${this.compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: '${name}', args: [${sourceVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${name}');`
    );
    if (this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.emit.line(`context.addDeferredExport("${name}", "${name}", ${this.compiler.buffer.currentBuffer});`);
    }
  }

  compileAsyncGetTemplateOrScript(node, eagerCompile, ignoreMissing, allowNoParent = false) {
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

  emitCompiledPayloadInputs(node, targetVarsVar) {
    this.emitPayloadInputVariables(node, targetVarsVar, (nameNode) => {
      this.compiler.compileExpression(nameNode, null, nameNode, true);
    });
    this.emitPayloadObjectInput(node, targetVarsVar);
  }

  emitCurrentPositionPayloadInputs(node, targetVarsVar) {
    this.emitPayloadInputVariables(node, targetVarsVar, (nameNode, inputName) => {
      const declaration = this.compiler.analysis.findDeclaration(nameNode._analysis, inputName);
      if (declaration && declaration.type === 'var' && !declaration.shared) {
        this.emit(`runtime.channelLookup(${JSON.stringify(inputName)}, ${this.compiler.buffer.currentBuffer})`);
      } else {
        this.emit(`context.lookup(${JSON.stringify(inputName)})`);
      }
    });
    this.emitPayloadObjectInput(node, targetVarsVar);
  }

  emitPayloadInputVariables(node, targetVarsVar, emitValue) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    withVars.forEach((nameNode) => {
      const inputName = this.compiler.analysis.getBaseChannelName(nameNode.value);
      this.emit(`${targetVarsVar}[${JSON.stringify(inputName)}] = `);
      emitValue(nameNode, inputName);
      this.emit.line(';');
    });
  }

  emitPayloadObjectInput(node, targetVarsVar) {
    if (node.withValue) {
      // Object-style inputs are merged last, so they intentionally override
      // earlier shorthand `with foo, bar` entries on key collisions.
      this.emit(`Object.assign(${targetVarsVar}, `);
      this.compiler.compileExpression(node.withValue, null, node.withValue, true);
      this.emit.line(');');
    }
  }

  emitCompositionContext(targetCtxVar, payloadVarsVar, includeRenderContext) {
    this.emit.line(`const ${targetCtxVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${targetCtxVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${targetCtxVar}, ${payloadVarsVar});`);
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
      const id = this.compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, cb));');
      this.emit.line('});');
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      this._emitValueImportBinding(target, exportedId, node);
      return;
    }

    const target = node.target.value;
    const id = this.compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const importVarsVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this.emit.line(`let ${importVarsVar} = {};`);
    this.emitCompiledPayloadInputs(node, importVarsVar);
    this.emitCompositionContext(importContextVar, importVarsVar, node.withContext);
    this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line(`  return runtime.resolveSingle(resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, cb));`);
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
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      const importedId = this.compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      const bindingIds = [];
      this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, cb));');
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

    const importedId = this.compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const bindingIds = [];
    const importVarsVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this.emit.line(`let ${importVarsVar} = {};`);
    this.emitCompiledPayloadInputs(node, importVarsVar);
    this.emitCompositionContext(importContextVar, importVarsVar, node.withContext);
    this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line(`  return runtime.resolveSingle(resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, cb));`);
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
    if ((node.withVars && node.withVars.children && node.withVars.children.length > 0) || node.withValue) {
      this.compiler.fail(
        'sync from-import does not support explicit with inputs',
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

    // Inherited block text boundaries carry text placement only. Shared reads
    // and writes inside the block are enqueued by the admitted method
    // invocation at call time; linking those lanes here would place shared
    // observations at the earlier parent-render scheduling point.
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
          this.emit.line('  if (inheritanceState) { inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context); }');
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

  emitAsyncRootStateInitialization(compiledMethodsVar, compiledSharedSchemaVar, compiledInvokedMethodsVar) {
    if (!this.compiler.needsInheritanceState) {
      this.emit.line('if (inheritanceState) {');
      this.emit.line('  inheritanceState = runtime.finalizeInheritanceMetadata(inheritanceState, context);');
      this.emit.line('}');
      return;
    }
    this.emit.line('if (!inheritanceState) {');
    this.emit.line('  inheritanceState = runtime.createInheritanceState();');
    this.emit.line('}');
    this.emit.line(`inheritanceState = runtime.bootstrapInheritanceMetadata(inheritanceState, ${compiledMethodsVar}, ${compiledSharedSchemaVar}, ${compiledInvokedMethodsVar}, ${this.compiler.buffer.currentBuffer}, context);`);
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
    this.emitCompositionContext(extendsRootContextVar, extendsVarsVar, node.withContext !== false);
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
    this.emit.line(`${ROOT_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, null, ${linkedMutatedChannelsArg}, context, cb, async (currentBuffer) => {`);
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
    this.emit.line(`  ${this.compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: name, args: [${blockValueId}], pos: {lineno: ${block.lineno}, colno: ${block.colno}} }), name);`);
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
    // This only wires the entry-local command buffer to its immediate parent
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
      this.compiler.return.emitDeclareChannel(this.compiler.buffer.currentBuffer);
    }
    const payloadOriginalArgsVar = this.compiler._tmpid();
    this.emit.line(`const ${payloadOriginalArgsVar} = blockPayload && blockPayload.originalArgs ? blockPayload.originalArgs : {};`);
    if (isScriptMethod) {
      const methodBaseContextVar = this.compiler._tmpid();
      this.emit.line(`const ${methodBaseContextVar} = context.getCompositionContextVariables();`);
      this.emit.line(`context = context.forkForComposition(${invocationPath}, ${methodBaseContextVar}, ${block.withContext ? '(blockRenderCtx || undefined)' : 'undefined'});`);
    } else {
      const signatureBaseContextVar = this.compiler._tmpid();
      const compositionPayloadContextVar = this.compiler._tmpid();
      const payloadContextVar = this.compiler._tmpid();
      this.emit.line(`const ${compositionPayloadContextVar} = context.getCompositionPayloadVariables() || {};`);
      this.emit.line(
        `const ${signatureBaseContextVar} = ${declaredBlockArgNames.length > 0
          ? (block.withContext
            ? `Object.assign({}, (blockRenderCtx || {}), ${compositionPayloadContextVar})`
            : compositionPayloadContextVar)
          : `(Object.keys(${compositionPayloadContextVar}).length > 0 ? ${compositionPayloadContextVar} : context.getCompositionContextVariables())`};`
      );
      this.emit.line(`const ${payloadContextVar} = Object.assign({}, ${signatureBaseContextVar}, ${payloadOriginalArgsVar});`);
      this.emit.line(`if (blockPayload !== null || blockRenderCtx !== undefined || Object.keys(${payloadContextVar}).length > 0) {`);
      this.emit.line(`  context = context.forkForComposition(${invocationPath}, ${payloadContextVar}, ${block.withContext ? 'blockRenderCtx' : 'undefined'});`);
      this.emit.line('} else {');
      this.emit.line(`  context = context.forkForPath(${invocationPath});`);
      this.emit.line('}');
    }
    this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
    this.emit.line(
      `runtime.linkCurrentBufferToParentChannels(` +
      `parentBuffer, ${this.compiler.buffer.currentBuffer}, ` +
      `runtime.getCallableBodyLinkedChannels(methodData, ${JSON.stringify(this.compiler._createErrorContext(block))}), ` +
      `runtime.getCallableBodyMutatedChannels(methodData, ${JSON.stringify(this.compiler._createErrorContext(block))})` +
      `);`
    );
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
      this.compiler.return.emitFinalSnapshot(this.compiler.buffer.currentBuffer, resultVar);
      // Script methods still own their entry-local command-buffer lifetime.
      // The invocation command waits on the per-call invocation buffer after
      // this local buffer closes, so caller-visible completion still covers the
      // full inherited call.
      this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
      this.emit.line(`return runtime.normalizeFinalPromise(${resultVar});`);
    } else {
      this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
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

  collectCompiledMethods(node, blocks) {
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
        invokedMethodsExpr: this.compileInvokedMethodsLiteral(this.collectDirectInvokedMethodRefsForCallable(block)),
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
        ownerNode: constructorDefinition,
        superExpr: this.blockUsesSuper(constructorDefinition) ? 'true' : 'false',
        superOriginExpr: this.compileCallableSuperOriginLiteral(constructorDefinition),
        invokedMethodsExpr: this.compileInvokedMethodsLiteral(this.collectDirectInvokedMethodRefsForCallable(constructorDefinition)),
        signatureExpr: JSON.stringify({ argNames: [], withContext: false }),
        ownerKey
      }));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  compileMethodMetadataEntry({ methodName, fnExpr, ownerNode, superExpr, superOriginExpr, invokedMethodsExpr, signatureExpr, ownerKey }) {
    const ownLinkedChannelNames = this._getMethodFootprintField(ownerNode, 'methodLinkedChannels');
    // Keep mutations separate from links so inherited/component calls can
    // later distinguish read-only participation from write barriers.
    const ownMutatedChannelNames = this._getMethodFootprintField(ownerNode, 'methodMutatedChannels');
    const ownLinkedChannels = JSON.stringify(ownLinkedChannelNames);
    const ownMutatedChannels = JSON.stringify(ownMutatedChannelNames);
    return `${JSON.stringify(methodName)}: { fn: ${fnExpr}, ownMutatedChannels: ${ownMutatedChannels}, ownLinkedChannels: ${ownLinkedChannels}, super: ${superExpr}, superOrigin: ${superOriginExpr || 'null'}, invokedMethods: ${invokedMethodsExpr || '{}'}, signature: ${signatureExpr}, ownerKey: ${ownerKey} }`;
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

  collectCompiledInvokedMethods(node) {
    return this.compileInvokedMethodsLiteral(this.collectAllInvokedMethodRefsFromNode(node));
  }

  compileInvokedMethodsLiteral(methodRefs) {
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
    if (args.length > 0 || node.withContext !== null) {
      this.compiler.fail(
        'block signatures and block with-clauses are only supported in async mode',
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
        this.emitCompiledPayloadInputs(node, extendsVarsVar);
      });

      const parentTemplateId = this.compileAsyncGetTemplateOrScript(node, true, false, true);
      // Script inheritance startup links the chain-level shared schema known
      // at runtime after parent metadata has been bootstrapped. This is not a
      // local analysis fact for the extending script: parent schemas can arrive
      // dynamically, and this boundary must preserve post-extends constructor
      // ordering for the channels available at that runtime call site.
      const linkedChannelsArg = 'Object.keys((inheritanceState && inheritanceState.sharedSchema) || {})';
      const linkedMutatedChannelsArg = linkedChannelsArg;
      this.emit.line(`${ROOT_STARTUP_PROMISE_VAR} = runtime.runControlFlowBoundary(${this.compiler.buffer.currentBuffer}, ${linkedChannelsArg}, null, ${linkedMutatedChannelsArg}, context, cb, async (currentBuffer) => {`);
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
      this.emitCurrentPositionPayloadInputs(node, extendsVarsVar);
    });
    const parentTemplateId = this.compileAsyncGetTemplateOrScript(node, true, false, true);

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
      const includeContextVar = this.compiler._tmpid();
      const includeTextPromise = this.compiler._tmpid();
      // Included template renders into its own default text lane.
      // The caller lane may be scope-specific (e.g. capture text output) and
      // is only used when enqueueing the final TextCommand in the parent buffer.
      const includeTextChannelName = CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      // Include target lookup is handled by include/import boundary tracking,
      // so it intentionally bypasses root waited-expression tracking.
      this.compiler.compileExpression(node.template, null, node.template, true);
      this.emit.line(';');

      // Keep producer synchronous: carry async template lookup/render in promise chain.
      this.emit.line(`let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}, false, ${JSON.stringify(this.compiler.templateName)}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // Async include passes explicit payload inputs to the child.
      this.emit.line(`let ${includeVarsVar} = {};`);
      this.emitCompiledPayloadInputs(node, includeVarsVar);
      this.emitCompositionContext(includeContextVar, includeVarsVar, node.withContext);

      this.emit.line(`const ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`${templateVar}_resolved.compile();`);
      this.emit.line(`const composed = ${templateVar}_resolved._renderForComposition(${includeContextVar}, cb, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'});`);
      // Includes own a composed child text boundary. Use the child text channel's
      // finalSnapshot() as the structural completion signal rather than adding an
      // extra point-in-time snapshot command for that boundary.
      this.emit.line(`let ${includeTextPromise} = composed.getChannel("${includeTextChannelName}").finalSnapshot();`);
      this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(new runtime.TextCommand({ channelName: "${this.compiler.buffer.currentTextChannelName}", args: [${includeTextPromise}], pos: {lineno: ${node?.lineno ?? 0}, colno: ${node?.colno ?? 0}} }), "${this.compiler.buffer.currentTextChannelName}");`);
      // Include boundary completion in the limited-loop waited channel.
      // Wait on the composed include snapshot promise (timing unit), not on the
      // command object created for parent enqueue.
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(includeTextPromise, node);
    });
  }

  compileSyncInclude(node, frame) {
    if ((node.withVars && node.withVars.children && node.withVars.children.length > 0) || node.withValue) {
      this.compiler.fail(
        'include with explicit composition inputs is not supported in sync mode',
        node.lineno,
        node.colno,
        node
      );
    }
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

export {CompileInheritance};
export {ROOT_STARTUP_PROMISE_VAR};
