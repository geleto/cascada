import * as nodes from '../language/nodes.js';

class CompileComposition {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  _emitValueImportBinding(name, sourceVar, node) {
    this.emit.line(`runtime.markPromiseHandled(${sourceVar});`);
    if (this.compiler.analysis.isRootScopeOwner(node._analysis)) {
      this.emit.line(`context.addResolvedExport("${name}", ${sourceVar});`);
    }
  }

  compileAsyncResolveTargetFile(node, eagerCompile, ignoreMissing, allowNoParent = false, loadFailureKind = null) {
    const targetVar = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.sourcePath);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const positionNode = node.template || node;
    const getTargetFunc = this.compiler._tmpid();
    const resolvedTargetValue = this.compiler._tmpid();
    const errorContext = this.compiler.emitErrorContext(positionNode);

    this.emit.line(`const ${getTargetFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`const ${resolvedTargetValue} = `);
    this.compiler.compileExpression(node.template, null, positionNode, true);
    this.emit.line(';');
    this.emit.line(`let ${targetVar} = runtime.valueWithOrigin(runtime.resolveThen(${resolvedTargetValue}, (resolvedTargetName) => {`);
    if (allowNoParent) {
      this.emit.line('  if (resolvedTargetName === null || resolvedTargetName === undefined) {');
      this.emit.line('    return null;');
      this.emit.line('  }');
    }
    if (loadFailureKind) {
      this.emit.line(`  return Promise.resolve().then(() => ${getTargetFunc}(resolvedTargetName, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg})).catch((e) => runtime.handleLoadFailure(e, ${errorContext}, "${loadFailureKind}", env));`);
    } else {
      this.emit.line(`  return ${getTargetFunc}(resolvedTargetName, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    }
    this.emit.line(`}), ${errorContext}, "LoadFailed");`);

    return targetVar;
  }

  compileSyncResolveTargetFile(node, frame, eagerCompile, ignoreMissing, allowNoParent = false) {
    const targetVar = this.compiler._tmpid();
    const errId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.sourcePath);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const resolvedTargetValue = this.compiler._tmpid();

    this.emit(`let ${resolvedTargetValue} = `);
    this.compiler.compileExpression(node.template, frame, node.template, true);
    this.emit.line(';');
    this.emit.line('(function(cb) {');
    if (allowNoParent) {
      this.emit.line(`  if (${resolvedTargetValue} === null || ${resolvedTargetValue} === undefined) {`);
      this.emit.line('    cb(null, null);');
      this.emit.line('  } else {');
      this.emit.line(`    env.getTemplate(${resolvedTargetValue}, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, cb);`);
      this.emit.line('  }');
    } else {
      this.emit.line(`  env.getTemplate(${resolvedTargetValue}, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, cb);`);
    }
    this.emit.line(`})(function(${errId}, ${targetVar}) {`);
    this.emit.line(`if(${errId}) { cb(${errId}); return; }`);

    return targetVar;
  }

  compileImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      const target = node.target.value;
      const id = this.compileAsyncResolveTargetFile(node, false, false, false, 'import');
      const exportedId = node._analysis.importedExportId;
      const errorContext = this.compiler.emitErrorContext(node);
      this.emit.line(`let ${exportedId} = runtime.valueWithOrigin(runtime.resolveThen(${id}, (resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  renderState.throwIfFatalErrorReported();');
      this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, null, renderState));');
      this.emit.line(`}).catch((e) => runtime.handleLoadFailure(e, ${errorContext}, "import", env)), ${errorContext}, "LoadFailed");`);
      this.compiler.buffer.emitLimitedLoopCompletion(exportedId, node);
      this._emitValueImportBinding(target, exportedId, node);
      return;
    }

    const target = node.target.value;
    const id = this.compileAsyncResolveTargetFile(node, false, false, false, 'import');
    const exportedId = node._analysis.importedExportId;
    const importVarsVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    const errorContext = this.compiler.emitErrorContext(node);
    this.emit.line(`let ${importVarsVar} = {};`);
    this.compiler.compositionPayload.emitCompiledInputs(node, importVarsVar);
    this.compiler.compositionPayload.emitContext(importContextVar, importVarsVar, node.withContext);
    this.emit.line(`let ${exportedId} = runtime.valueWithOrigin(runtime.resolveThen(${id}, (resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line('  renderState.throwIfFatalErrorReported();');
    this.emit.line(`  return runtime.resolveSingle(resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, renderState));`);
    this.emit.line(`}).catch((e) => runtime.handleLoadFailure(e, ${errorContext}, "import", env)), ${errorContext}, "LoadFailed");`);
    this.compiler.buffer.emitLimitedLoopCompletion(exportedId, node);
    this._emitValueImportBinding(target, exportedId, node);
  }

  compileSyncImport(node, frame) {
    if ((node.withVars && node.withVars.children && node.withVars.children.length > 0) || node.withValue) {
      this.compiler.fail(
        'sync import does not support explicit with inputs',
        node.lineno,
        node.colno,
        node
      );
    }
    const target = node.target.value;
    const id = this.compileSyncResolveTargetFile(node, frame, false, false);
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

  compileFromImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      this._compileAsyncFromImportWithoutPayload(node);
      return;
    }
    this._compileAsyncFromImportWithPayload(node);
  }

  _compileAsyncFromImportWithoutPayload(node) {
    const importedId = this.compileAsyncResolveTargetFile(node, false, false, false, 'import');
    const exportedId = node._analysis.importedExportId;
    const bindingIds = [];
    const errorContext = this.compiler.emitErrorContext(node);
    this.emit.line(`let ${exportedId} = runtime.valueWithOrigin(runtime.resolveThen(${importedId}, (resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line('  renderState.throwIfFatalErrorReported();');
    this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, null, renderState));');
    this.emit.line(`}).catch((e) => runtime.handleLoadFailure(e, ${errorContext}, "import", env)), ${errorContext}, "LoadFailed");`);
    this._emitAsyncFromImportBindings(node, exportedId, bindingIds);
    this.compiler.buffer.emitLimitedLoopCompletions(bindingIds.length > 0 ? bindingIds : [exportedId], node);
  }

  _compileAsyncFromImportWithPayload(node) {
    const importedId = this.compileAsyncResolveTargetFile(node, false, false, false, 'import');
    const exportedId = node._analysis.importedExportId;
    const bindingIds = [];
    const importVarsVar = this.compiler._tmpid();
    const importContextVar = this.compiler._tmpid();
    const errorContext = this.compiler.emitErrorContext(node);
    this.emit.line(`let ${importVarsVar} = {};`);
    this.compiler.compositionPayload.emitCompiledInputs(node, importVarsVar);
    this.compiler.compositionPayload.emitContext(importContextVar, importVarsVar, node.withContext);
    this.emit.line(`let ${exportedId} = runtime.valueWithOrigin(runtime.resolveThen(${importedId}, (resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line('  renderState.throwIfFatalErrorReported();');
    this.emit.line(`  return runtime.resolveSingle(resolvedTemplate.getExported(${importContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, renderState));`);
    this.emit.line(`}).catch((e) => runtime.handleLoadFailure(e, ${errorContext}, "import", env)), ${errorContext}, "LoadFailed");`);
    this._emitAsyncFromImportBindings(node, exportedId, bindingIds);
    this.compiler.buffer.emitLimitedLoopCompletions(bindingIds.length > 0 ? bindingIds : [exportedId], node);
  }

  _emitAsyncFromImportBindings(node, exportedId, bindingIds) {
    node.names.children.forEach((nameNode) => {
      const importedName = nameNode instanceof nodes.Pair
        ? nameNode.key.value
        : this.compiler.analysis.getBaseChainName(nameNode.value);
      const alias = nameNode instanceof nodes.Pair
        ? nameNode.value.value
        : nameNode.value;
      const id = node._analysis.importBindingIds.get(alias);
      const errorContext = this.compiler.emitErrorContext(nameNode);
      this.emit.line(`let ${id} = runtime.valueWithOrigin(runtime.thenValue(${exportedId}, (exported) => {`);
      this.emit.line(`  return runtime.getImportedExport(exported, ${JSON.stringify(importedName)}, ${errorContext});`);
      this.emit.line(`}), ${errorContext}, "ImportBindingMissing");`);
      bindingIds.push(id);
      this._emitValueImportBinding(alias, id, node);
    });
  }

  compileSyncFromImport(node, frame) {
    if ((node.withVars && node.withVars.children && node.withVars.children.length > 0) || node.withValue) {
      this.compiler.fail(
        'sync from-import does not support explicit with inputs',
        node.lineno,
        node.colno,
        node
      );
    }
    const importedId = this.compileSyncResolveTargetFile(node, frame, false, false);
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
      this.emit.line(`var err = runtime.createSyncRuntimeError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); cb(err); return;`);
      this.emit.line('}');

      frame.set(alias, id);
      if (frame.parent) {
        this.emit.line(`frame.set("${alias}", ${id});`);
      } else {
        this.emit.line(`context.setVariable("${alias}", ${id});`);
      }
    });
  }

  compileInclude(node) {
    this.compiler.boundaries.compileAsyncControlFlowBoundary(this.compiler.buffer, node, () => {
      const templateVar = this.compiler._tmpid();
      const templateNameVar = this.compiler._tmpid();
      const includeVarsVar = this.compiler._tmpid();
      const includeContextVar = this.compiler._tmpid();
      const includeTextValue = this.compiler._tmpid();
      const includeCompletionValue = this.compiler._tmpid();
      const includeError = this.compiler._tmpid();
      const shouldRenderInclude = this.compiler._tmpid();

      this.emit(`let ${templateNameVar} = `);
      this.compiler.compileExpression(node.template, null, node.template, true);
      this.emit.line(';');

      this.emit.line(`let ${includeVarsVar} = {};`);
      this.compiler.compositionPayload.emitCompiledInputs(node, includeVarsVar);
      this.compiler.compositionPayload.emitContext(includeContextVar, includeVarsVar, node.withContext);

      this.emit.line(`let ${includeCompletionValue} = Promise.resolve();`);
      this.emit.line(`let ${shouldRenderInclude} = true;`);
      this.emit.line(`let ${templateNameVar}_resolved;`);
      this.emit.line(`let ${templateVar}_resolved;`);
      this.emit.line('try {');
      this.emit.line(`  ${templateNameVar}_resolved = await runtime.resolveSingle(${templateNameVar});`);
      this.emit.line(`  let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}_resolved, false, ${JSON.stringify(this.compiler.sourcePath)}, ${node.ignoreMissing ? 'true' : 'false'});`);
      this.emit.line(`  ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`} catch (${includeError}) {`);
      this.emit.line(`  if (runtime.isRuntimeError(${includeError})) {`);
      this.emit.line(`    throw ${includeError};`);
      this.emit.line(`  } else if (runtime.isPoisonError(${includeError})) {`);
      this.emit.line(`    ${this.compiler.buffer.currentBuffer}.addCommand(new runtime.TextCommand({ chainName: "${this.compiler.buffer.currentTextChainName}", args: [runtime.createPoison(${includeError})], errorContext: ${this.compiler.emitErrorContext(node)} }), "${this.compiler.buffer.currentTextChainName}");`);
      this.emit.line(`    ${shouldRenderInclude} = false;`);
      this.emit.line(`  } else if (${node.ignoreMissing ? 'false' : 'runtime.isLoadFailureFatal(env, "include")'}) {`);
      this.emit.line(`    runtime.RuntimeError.reportAndThrow(${includeError}, ${this.compiler.emitErrorContext(node)});`);
      this.emit.line('  } else {');
      this.emit.line(`    ${shouldRenderInclude} = false;`);
      this.emit.line('  }');
      this.emit.line('}');
      this.emit.line('renderState.throwIfFatalErrorReported();');
      this.emit.line(`if (${shouldRenderInclude}) {`);
      this.emit.line(`  if (!${templateVar}_resolved) {`);
      this.emit.line(`    if (${node.ignoreMissing ? 'true' : '!runtime.isLoadFailureFatal(env, "include")'}) {`);
      this.emit.line(`      ${shouldRenderInclude} = false;`);
      this.emit.line('    } else {');
      this.emit.line(`      runtime.RuntimeError.reportAndThrow(new Error("Template not found: " + ${templateNameVar}_resolved), ${this.compiler.emitErrorContext(node)});`);
      this.emit.line('    }');
      this.emit.line('  }');
      this.emit.line('}');
      this.emit.line(`if (${shouldRenderInclude}) {`);
      this.emit.line(`  ${templateVar}_resolved.compile();`);
      this.emit.line(`  let ${includeTextValue} = ${templateVar}_resolved._renderIncludeText(${includeContextVar}, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'}, renderState);`);
      this.emit.line(`  ${includeCompletionValue} = ${includeTextValue};`);
      this.emit.line(`  ${this.compiler.buffer.currentBuffer}.addCommand(new runtime.TextCommand({ chainName: "${this.compiler.buffer.currentTextChainName}", args: [${includeTextValue}], errorContext: ${this.compiler.emitErrorContext(node)} }), "${this.compiler.buffer.currentTextChainName}");`);
      this.emit.line('}');
      this.compiler.buffer.emitLimitedLoopCompletion(includeCompletionValue, node);
    }, node, {}, { asyncCallback: true });
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
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this.compileSyncResolveTargetFile(node, frame, false, node.ignoreMissing);
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

export {CompileComposition};
