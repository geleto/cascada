'use strict';

// Composition compiler helper.
// Owns shared composition helpers plus import/include/from-import compilation
// for non-inheritance composition boundaries.

const nodes = require('../nodes');
const CompileBuffer = require('./buffer');

class CompileComposition {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = compiler.emit;
  }

  emitValueImportBinding(name, sourceVar, node) {
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
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const positionNode = node.template || node;
    const getTemplateFunc = this.compiler._tmpid();

    this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
    this.compiler.compileExpression(node.template, null, positionNode, true);
    this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);

    return parentTemplateId;
  }

  _compileSyncGetTemplate(node, frame, eagerCompile, ignoreMissing) {
    const templateId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const cb = this.compiler._makeCallback(templateId);

    this.emit('env.getTemplate(');
    this.compiler.compileExpression(node.template, frame, node.template, true);
    this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);

    return templateId;
  }

  _getWithVars(node) {
    return node.withVars && node.withVars.children ? node.withVars.children : [];
  }

  _hasAsyncCompositionContext(node) {
    return !!node.withContext || this._getWithVars(node).length > 0;
  }

  _emitAsyncCompositionContextSetup(node, explicitVarsVar, explicitNamesVar, contextVar) {
    this.emit.line(`let ${explicitVarsVar} = {};`);
    this.emitResolvedNameNodeAssignments({
      targetVar: explicitVarsVar,
      nameNodes: this._getWithVars(node)
    });
    this.emitCompositionContextObject({
      targetVar: contextVar,
      explicitVarsVar,
      explicitNamesVar,
      includeRenderContext: !!node.withContext
    });
  }

  _emitAsyncResolvedExportLookup(resultVar, templateExpr, options = null) {
    const config = options || {};
    const operationName = config.operationName;
    const isolated = !!config.isolated;
    const contextExpr = isolated ? 'null' : config.contextExpr;
    const renderContextExpr = isolated ? 'null' : config.renderContextExpr;

    this.emit.line(`let ${resultVar} = runtime.resolveSingle(${templateExpr}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    if (isolated) {
      this.emitExternValidation({
        externSpecExpr: 'resolvedTemplate.externSpec || []',
        operationName,
        isolated: true,
        indent: '  '
      });
    } else {
      this.emitExternValidationForContext({
        externSpecExpr: 'resolvedTemplate.externSpec || []',
        explicitInputNamesExpr: config.explicitInputNamesExpr,
        contextVar: config.contextVar,
        operationName,
        indent: '  '
      });
    }
    this.emit.line(`  return resolvedTemplate.getExported(${contextExpr}, ${renderContextExpr}, cb);`);
    this.emit.line('});');
  }

  _emitAsyncFromImportBindings(node, exportedId) {
    const bindingIds = [];

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

      this.emitValueImportBinding(alias, id, node);
    });

    return bindingIds;
  }

  _emitAsyncBindingCompletion(bindingIds, fallbackId, node) {
    if (bindingIds.length > 0) {
      const boundaryCompletion = this.compiler._tmpid();
      this.emit.line(`let ${boundaryCompletion} = runtime.resolveAll([${bindingIds.join(', ')}]);`);
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(boundaryCompletion, node);
      return;
    }

    this.compiler.buffer.emitOwnWaitedConcurrencyResolve(fallbackId, node);
  }

  _emitInputAssignments({
    targetVar,
    entries,
    indent = '',
    getTargetName,
    emitValue
  }) {
    const items = Array.isArray(entries) ? entries : [];
    items.forEach((entry) => {
      const targetName = getTargetName(entry);
      this.emit(`${indent}${targetVar}[${JSON.stringify(targetName)}] = `);
      emitValue(entry, targetName);
      this.emit.line(';');
    });
  }

  emitCapturedInputAssignments({
    targetVar,
    entries,
    ownerNode,
    getSourceName,
    getTargetName = getSourceName,
    getPositionNode = (entry) => entry,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    const helperName = this.compiler.scriptMode
      ? 'captureCompositionScriptValue'
      : 'captureCompositionValue';

    this._emitInputAssignments({
      targetVar,
      entries,
      indent,
      getTargetName,
      emitValue: (entry) => {
        const sourceName = getSourceName(entry);
        const positionNode = getPositionNode(entry);
        this.emit(`runtime.${helperName}(${contextExpr}, ${JSON.stringify(sourceName)}, ${bufferExpr}`);
        if (this.compiler.scriptMode) {
          this.emit(
            `, { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, ` +
            `errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(ownerNode || positionNode, positionNode))}, ` +
            `path: ${contextExpr}.path }`
          );
        }
        this.emit(')');
      }
    });
  }

  emitCapturedNameNodeAssignments({
    targetVar,
    nameNodes,
    ownerNode,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    this.emitCapturedInputAssignments({
      targetVar,
      entries: nameNodes,
      ownerNode,
      getSourceName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      getTargetName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      getPositionNode: (nameNode) => nameNode,
      contextExpr,
      bufferExpr,
      indent
    });
  }

  emitCapturedNameAssignments({
    targetVar,
    names,
    ownerNode,
    contextExpr = 'context',
    bufferExpr = this.compiler.buffer.currentBuffer,
    indent = ''
  }) {
    this.emitCapturedInputAssignments({
      targetVar,
      entries: names,
      ownerNode,
      getSourceName: (name) => name,
      getTargetName: (name) => name,
      getPositionNode: () => ownerNode,
      contextExpr,
      bufferExpr,
      indent
    });
  }

  emitResolvedInputAssignments({
    targetVar,
    entries,
    getTargetName,
    emitExpression,
    indent = ''
  }) {
    this._emitInputAssignments({
      targetVar,
      entries,
      indent,
      getTargetName,
      emitValue: emitExpression
    });
  }

  emitResolvedNameNodeAssignments({
    targetVar,
    nameNodes,
    indent = ''
  }) {
    this.emitResolvedInputAssignments({
      targetVar,
      entries: nameNodes,
      getTargetName: (nameNode) => this.compiler.analysis.getBaseChannelName(nameNode.value),
      emitExpression: (nameNode) => this.compiler.compileExpression(nameNode, null, nameNode, true),
      indent
    });
  }

  emitCompositionContextObject({
    targetVar,
    explicitVarsVar,
    explicitNamesVar = null,
    includeRenderContext = false
  }) {
    this.emit.line(`const ${targetVar} = {};`);
    if (includeRenderContext) {
      this.emit.line(`Object.assign(${targetVar}, context.getRenderContextVariables());`);
    }
    this.emit.line(`Object.assign(${targetVar}, ${explicitVarsVar});`);
    if (explicitNamesVar) {
      this.emit.line(`const ${explicitNamesVar} = Object.keys(${explicitVarsVar});`);
    }
  }

  emitExternValidation({
    externSpecExpr,
    operationName,
    explicitInputNamesExpr = null,
    availableValueNamesExpr = null,
    isolated = false,
    indent = ''
  }) {
    if (isolated) {
      this.emit.line(
        `${indent}runtime.validateIsolatedExternSpec(${externSpecExpr}, ${JSON.stringify(operationName)});`
      );
      return;
    }
    this.emit.line(
      `${indent}runtime.validateExternInputs(` +
      `${externSpecExpr}, ${explicitInputNamesExpr}, ${availableValueNamesExpr}, ${JSON.stringify(operationName)});`
    );
  }

  emitExternValidationForContext({
    externSpecExpr,
    explicitInputNamesExpr,
    contextVar,
    operationName,
    indent = ''
  }) {
    this.emitExternValidation({
      externSpecExpr,
      explicitInputNamesExpr,
      availableValueNamesExpr: `Object.keys(${contextVar})`,
      operationName,
      indent
    });
  }

  compileAsyncImport(node) {
    if (this.compiler.scriptMode) {
      return this.compiler.componentCompiler.compileAsyncComponentImport(node);
    }
    if (!this._hasAsyncCompositionContext(node)) {
      const target = node.target.value;
      const id = this._compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      this._emitAsyncResolvedExportLookup(exportedId, id, {
        operationName: 'import',
        isolated: true
      });
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      this.emitValueImportBinding(target, exportedId, node);
      return;
    }

    const target = node.target.value;
    const id = this._compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const importVarsVar = this.compiler._tmpid();
    const importInputNamesVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this._emitAsyncCompositionContextSetup(node, importVarsVar, importInputNamesVar, importContextVar);
    this._emitAsyncResolvedExportLookup(exportedId, id, {
      operationName: 'import',
      explicitInputNamesExpr: importInputNamesVar,
      contextVar: importContextVar,
      contextExpr: importContextVar,
      renderContextExpr: node.withContext ? 'context.getRenderContextVariables()' : 'null'
    });
    this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
    this.emitValueImportBinding(target, exportedId, node);
  }

  compileSyncImport(node, frame) {
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

  compileAsyncFromImport(node) {
    if (!this._hasAsyncCompositionContext(node)) {
      const importedId = this._compileAsyncGetTemplateOrScript(node, false, false);
      const exportedId = this.compiler._tmpid();
      this._emitAsyncResolvedExportLookup(exportedId, importedId, {
        operationName: 'from-import',
        isolated: true
      });
      const bindingIds = this._emitAsyncFromImportBindings(node, exportedId);
      this._emitAsyncBindingCompletion(bindingIds, exportedId, node);
      return;
    }

    const importedId = this._compileAsyncGetTemplateOrScript(node, false, false);
    const exportedId = this.compiler._tmpid();
    const importVarsVar = this.compiler._tmpid();
    const importInputNamesVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    this._emitAsyncCompositionContextSetup(node, importVarsVar, importInputNamesVar, importContextVar);
    this._emitAsyncResolvedExportLookup(exportedId, importedId, {
      operationName: 'from-import',
      explicitInputNamesExpr: importInputNamesVar,
      contextVar: importContextVar,
      contextExpr: importContextVar,
      renderContextExpr: node.withContext ? 'context.getRenderContextVariables()' : 'null'
    });
    const bindingIds = this._emitAsyncFromImportBindings(node, exportedId);
    this._emitAsyncBindingCompletion(bindingIds, exportedId, node);
  }

  compileSyncFromImport(node, frame) {
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

  compileAsyncInclude(node) {
    this.compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const templateVar = this.compiler._tmpid();
      const templateNameVar = this.compiler._tmpid();
      const includeVarsVar = this.compiler._tmpid();
      const includeInputNamesVar = this.compiler._tmpid();
      const includeContextVar = this.compiler._tmpid();
      const includeTextPromise = this.compiler._tmpid();
      const includeOutputChannelName = CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;

      this.emit(`let ${templateNameVar} = `);
      this.compiler.compileExpression(node.template, null, node.template, true);
      this.emit.line(';');

      this.emit.line(`let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}, false, ${JSON.stringify(this.compiler.templateName)}, ${node.ignoreMissing ? 'true' : 'false'});`);

      this._emitAsyncCompositionContextSetup(node, includeVarsVar, includeInputNamesVar, includeContextVar);

      this.emit.line(`const ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`${templateVar}_resolved.compile();`);
      this.emit.line(`if (!${node.ignoreMissing ? 'true' : 'false'} || ${templateVar}_resolved.path) {`);
      this.emitExternValidationForContext({
        externSpecExpr: `${templateVar}_resolved.externSpec || []`,
        explicitInputNamesExpr: includeInputNamesVar,
        contextVar: includeContextVar,
        operationName: 'include',
        indent: '  '
      });
      this.emit.line('}');
      this.emit.line(`const composed = ${templateVar}_resolved._renderForComposition(${includeContextVar}, cb, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'});`);
      this.emit.line(`let ${includeTextPromise} = composed.getChannel("${includeOutputChannelName}").finalSnapshot();`);
      this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.TextCommand({ channelName: "${this.compiler.buffer.currentTextChannelName}", args: [${includeTextPromise}], pos: {lineno: ${node?.lineno ?? 0}, colno: ${node?.colno ?? 0}} }), "${this.compiler.buffer.currentTextChannelName}");`);
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(includeTextPromise, node);
    });
  }

  compileSyncInclude(node, frame) {
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

module.exports = CompileComposition;
