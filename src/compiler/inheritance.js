'use strict';

const nodes = require('../nodes');
const CompileBuffer = require('./buffer');

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

  _compileAsyncGetTemplateOrScript(node, eagerCompile, ignoreMissing) {
    const parentTemplateId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    const getTemplateFunc = this.compiler._tmpid();
    // Template/script lookup expressions feed composition boundaries, which
    // emit their own completion tracking separately from root-expression WRCs.
    this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
    this.compiler.compileExpression(node.template, null, positionNode, true);
    this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);

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

  _emitNamedInputBindings(nameNodes, targetVarsVar) {
    nameNodes.forEach((nameNode) => {
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

  _compileSyncGetTemplate(node, frame, eagerCompile, ignoreMissing) {
    const templateId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const cb = this.compiler._makeCallback(templateId);

    this.emit('env.getTemplate(');
    // Template lookup expressions feed composition boundaries, which
    // emit their own completion tracking separately from root-expression WRCs.
    this.compiler.compileExpression(node.template, frame, node.template, true);
    this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);

    return templateId;
  }

  _compileAsyncImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0) {
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
    if (node.withVars && node.withVars.children && node.withVars.children.length > 0) {
      this.compiler.fail(
        'sync import does not support explicit with variables',
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
    //var id = this._tmpid();

    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution. The dynamic extends case is handled later
    // with a runtime check using the __parentTemplate variable.
    if (!this.compiler.inBlock && this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends) {
      return;
    }

    this.compiler.boundaries.compileBlockTextBoundary(
      this.compiler.buffer,
      node,
      (id) => {
        this.emit.line(`let ${id};`);
        const templateKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
        const explicitInputNameNodes = this.compiler._getBlockInputNameNodes(node);
        const localCaptureNames = this.compiler._getBlockLocalCaptureNames(node);
        const hasLocalCaptures = localCaptureNames.length > 0;
        const hasInheritancePayload = !!node.withContext || explicitInputNameNodes.length > 0 || localCaptureNames.length > 0;
        const blockVarsVar = explicitInputNameNodes.length > 0 ? this.compiler._tmpid() : null;
        const blockLocalsVar = hasLocalCaptures ? this.compiler._tmpid() : null;
        const blockPayloadVar = hasInheritancePayload ? this.compiler._tmpid() : null;
        const blockRenderCtxExpr = node.withContext ? 'context.getRenderContextVariables()' : 'undefined';
        if (explicitInputNameNodes.length > 0) {
          this.emit.line(`let ${blockVarsVar} = {};`);
          this._emitNamedInputBindings(explicitInputNameNodes, blockVarsVar);
        }
        if (hasLocalCaptures) {
          this.emit.line(`let ${blockLocalsVar} = {};`);
          localCaptureNames.forEach((name) => {
            const helperName = this.compiler.scriptMode
              ? 'captureCompositionScriptValue'
              : 'captureCompositionValue';
            this.emit(`${blockLocalsVar}[${JSON.stringify(name)}] = runtime.${helperName}(context, ${JSON.stringify(name)}, ${this.compiler.buffer.currentBuffer}`);
            if (this.compiler.scriptMode) {
              this.emit(`, { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node))}, path: context.path }`);
            }
            this.emit.line(');');
          });
        }
        if (hasInheritancePayload) {
          this.emit.line(`const ${blockPayloadVar} = context.createInheritancePayload(${templateKey}, ${explicitInputNameNodes.length > 0 ? blockVarsVar : '{}'}, ${hasLocalCaptures ? blockLocalsVar : 'null'});`);
        }
        const needsParentCheck = !this.compiler.inBlock && (this.compiler.hasDynamicExtends || this.compiler.hasStaticExtends);
        if (needsParentCheck) {
          this.emit.line(`const parentPromise = runtime.resolveSingle(runtime.channelLookup("__parentTemplate", ${this.compiler.buffer.currentBuffer}));`);
          this.emit.line(`${id} = parentPromise.then((parent) => {`);
          this.emit.line('  if (parent) return "";');
          this.emit.line(`  return context.getAsyncBlock("${node.name.value}").then((blockFunc) => blockFunc(env, context, runtime, cb, ${this.compiler.buffer.currentBuffer}, context.prepareInheritancePayloadForBlock(blockFunc, ${hasInheritancePayload ? blockPayloadVar : 'null'}), ${blockRenderCtxExpr}));`);
          this.emit.line('});');
        } else {
          this.emit.line(`${id} = context.getAsyncBlock("${node.name.value}").then((blockFunc) => blockFunc(env, context, runtime, cb, ${this.compiler.buffer.currentBuffer}, context.prepareInheritancePayloadForBlock(blockFunc, ${hasInheritancePayload ? blockPayloadVar : 'null'}), ${blockRenderCtxExpr}));`);
        }
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(id, node);
      }
    );
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
    // with a runtime check using the __parentTemplate variable.
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
    var k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsExternInputNamesVar = this.compiler._tmpid();
    const extendsExternContextVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();

    this.emit.line('context.beginAsyncExtendsBlockRegistration();');
    this._emitExtendsContextSetup(
      node,
      extendsVarsVar,
      extendsExternContextVar,
      extendsExternInputNamesVar,
      extendsRootContextVar
    );
    const parentTemplateId = this._compileAsyncGetTemplateOrScript(node, true, false);

    if (node.asyncStoreIn) {
      const resolvedParentTemplateId = `${node.asyncStoreIn}_resolvedParentTemplate`;
      this.emit.line(`let ${node.asyncStoreIn} = ${parentTemplateId}.then((${resolvedParentTemplateId}) => {`);
      this.emit.line('  if (context.asyncExtendsBlocksPromise) {');
      this.emit.line(`    return context.asyncExtendsBlocksPromise.then(() => ${resolvedParentTemplateId});`);
      this.emit.line('  }');
      this.emit.line(`  return ${resolvedParentTemplateId};`);
      this.emit.line('});');
    }
    this.compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const templateVar = this.compiler._tmpid();
      if (!node.asyncStoreIn) {
        this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '__parentTemplate', args: [${parentTemplateId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '__parentTemplate');`);
      }
      this.emit.line(`let ${templateVar} = await ${parentTemplateId};`);
      this.emit.line(`${templateVar}.compile();`);
      this.emit.line(`runtime.validateExternInputs(${templateVar}.externSpec || [], ${extendsExternInputNamesVar}, Object.keys(${extendsExternContextVar}), "extends");`);
      this.emit.line(`context.setExtendsComposition(${templateVar}, ${extendsRootContextVar}, ${extendsExternContextVar});`);
      this.emit.line(`for(let ${k} in ${templateVar}.blocks) {`);
      this.emit.line(`  context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
      this.emit.line('}');
      this.emit.line('context.finishAsyncExtendsBlockRegistration();');
    });
  }

  compileAsyncStaticRootExtends(node, scriptRootNode, rootSharedChannelNames = []) {
    const k = this.compiler._tmpid();
    const extendsVarsVar = this.compiler._tmpid();
    const extendsSharedInputNamesVar = this.compiler._tmpid();
    const extendsSharedInputValuesVar = this.compiler._tmpid();
    const extendsRootContextVar = this.compiler._tmpid();
    const templateVar = this.compiler._tmpid();
    const parentContextVar = this.compiler._tmpid();
    const parentTemplateId = this._compileAsyncGetTemplateOrScript(node, true, false);
    const prevBuffer = this.compiler.buffer.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(scriptRootNode, {
      includeDeclaredChannelNames: rootSharedChannelNames
    });

    this._emitExtendsContextSetup(
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
    // Fire-and-forget: ordering is structural here. The child buffer is linked
    // into the current buffer synchronously at the extends site, so later root
    // commands stay ordered after that boundary slot without any extra waiting.
    this.emit(`runtime.runControlFlowBoundary(${prevBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`);
    this.emit.asyncClosureDepth++;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.emit.line('try {');
    this.emit.line(`  let ${templateVar} = await ${parentTemplateId};`);
    this.emit.line(`  ${templateVar}.compile();`);
    this.emit.line(`  runtime.ensureCurrentBufferSharedLinks(${templateVar}.sharedSchema || [], currentBuffer);`);
    this.emit.line(`  runtime.preloadSharedInputs(${templateVar}.sharedSchema || [], ${extendsSharedInputValuesVar}, currentBuffer, context, { lineno: ${node.lineno}, colno: ${node.colno} });`);
    this.emit.line(`  for (let ${k} in ${templateVar}.blocks) {`);
    this.emit.line(`    context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
    this.emit.line('  }');
    this.emit.line(`  const ${parentContextVar} = context.forkForComposition(${templateVar}.path, ${extendsRootContextVar}, context.getRenderContextVariables(), ${extendsSharedInputValuesVar});`);
    this.emit.line(`  ${templateVar}.rootRenderFunc(env, ${parentContextVar}, runtime, cb, true, currentBuffer);`);
    this.emit.line('} finally {');
    this.emit.line('  context.finishAsyncExtendsBlockRegistration();');
    this.emit.line('}');
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.emit.asyncClosureDepth--;
    this.emit.line('});');
  }

  compileSyncExtends(node, frame) {
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
    const parentTemplateId = this._compileSyncGetTemplate(node, frame, true, false);
    this.emit.line(`parentTemplate = ${parentTemplateId};`);
    this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
    this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this.emit.line('}');
    this.emit.addScopeLevel();
  }

  compileAsyncSuper(node) {
    const name = node.blockName.value;
    const id = node.symbol ? node.symbol.value : null;
    const positionalArgsNode = this._getPositionalSuperArgsNode(node);
    const args = positionalArgsNode.children;
    const compilingBlock = this.compiler.currentCompilingBlock;
    const knownInputNames = compilingBlock ? this.compiler._getBlockInputNames(compilingBlock) : [];

    if (args.length > knownInputNames.length) {
      this.compiler.fail(
        `super(...) for block "${name}" received too many arguments`,
        node.lineno,
        node.colno,
        node
      );
    }

    if (!id) {
      const superArgsVar = this.compiler._tmpid();
      const superArgsOverrideVar = this.compiler._tmpid();
      const superBlockPayloadVar = this.compiler._tmpid();
      this.emit('(() => {');
      this.emit(`const ${superArgsVar} = `);
      this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
      this.emit.line(';');
      this.emit.line(`const ${superArgsOverrideVar} = {};`);
      knownInputNames.slice(0, args.length).forEach((inputName, idx) => {
        this.emit.line(`${superArgsOverrideVar}[${JSON.stringify(inputName)}] = ${superArgsVar}[${idx}];`);
      });
      this.emit.line(`const ${superBlockPayloadVar} = context.createSuperInheritancePayload(blockPayload, ${superArgsOverrideVar});`);
      this.emit(`return runtime.markSafe(context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${superBlockPayloadVar}, blockRenderCtx));`);
      this.emit('})()');
      return;
    }
    if (args.length > 0) {
      const superArgsVar = this.compiler._tmpid();
      const superArgsOverrideVar = this.compiler._tmpid();
      const superBlockPayloadVar = this.compiler._tmpid();
      this.emit(`const ${superArgsVar} = `);
      this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
      this.emit.line(';');
      this.emit.line(`const ${superArgsOverrideVar} = {};`);
      knownInputNames.slice(0, args.length).forEach((inputName, idx) => {
        this.emit.line(`${superArgsOverrideVar}[${JSON.stringify(inputName)}] = ${superArgsVar}[${idx}];`);
      });
      this.emit.line(`const ${superBlockPayloadVar} = context.createSuperInheritancePayload(blockPayload, ${superArgsOverrideVar});`);
      this.emit.line(`let ${id} = context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, ${superBlockPayloadVar}, blockRenderCtx);`);
    } else {
      this.emit.line(`let ${id} = context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, context.createSuperInheritancePayload(blockPayload), blockRenderCtx);`);
    }
    this.emit.line(`${id} = runtime.markSafe(${id});`);
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

