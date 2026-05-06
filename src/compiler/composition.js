import * as nodes from '../nodes.js';
import {CompileBuffer} from './buffer.js';

class CompileComposition {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
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

  compileAsyncResolveCompositionTargetFile(node, eagerCompile, ignoreMissing, allowNoParent = false) {
    const targetVar = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';
    const positionNode = node.template || node;

    const getTemplateFunc = this.compiler._tmpid();
    const resolvedTargetValue = this.compiler._tmpid();
    this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
    this.emit(`const ${resolvedTargetValue} = `);
    this.compiler.compileExpression(node.template, null, positionNode, true);
    this.emit.line(';');
    this.emit.line(`let ${targetVar} = runtime.resolveSingle(${resolvedTargetValue}).then((resolvedTemplateName) => {`);
    if (allowNoParent) {
      this.emit.line('  if (resolvedTemplateName === null || resolvedTemplateName === undefined) {');
      this.emit.line('    return null;');
      this.emit.line('  }');
    }
    this.emit.line(`  return ${getTemplateFunc}(resolvedTemplateName, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    this.emit.line('});');

    return targetVar;
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

  compileSyncResolveCompositionTargetFile(node, frame, eagerCompile, ignoreMissing, allowNoParent = false) {
    const targetVar = this.compiler._tmpid();
    const errId = this.compiler._tmpid();
    const parentName = JSON.stringify(this.compiler.templateName);
    const eagerCompileArg = eagerCompile ? 'true' : 'false';
    const ignoreMissingArg = ignoreMissing ? 'true' : 'false';
    const resolvedTargetValue = this.compiler._tmpid();

    this.emit(`let ${resolvedTargetValue} = `);
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
    this.emit.line(`})(function(${errId}, ${targetVar}) {`);
    this.emit.line(`if(${errId}) { cb(${errId}); return; }`);

    return targetVar;
  }

  compileAsyncImport(node) {
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      const target = node.target.value;
      const id = this.compileAsyncResolveCompositionTargetFile(node, false, false);
      const exportedId = this.compiler._tmpid();
      this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => {`);
      this.emit.line('  resolvedTemplate.compile();');
      this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, cb));');
      this.emit.line('});');
      this.compiler.buffer.emitLimitedLoopCompletion(exportedId, node);
      this._emitValueImportBinding(target, exportedId, node);
      return;
    }

    const target = node.target.value;
    const id = this.compileAsyncResolveCompositionTargetFile(node, false, false);
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
    const id = this.compileSyncResolveCompositionTargetFile(node, frame, false, false);
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
    const withVars = node.withVars && node.withVars.children ? node.withVars.children : [];
    if (!node.withContext && withVars.length === 0 && !node.withValue) {
      this._compileAsyncFromImportWithoutPayload(node);
      return;
    }
    this._compileAsyncFromImportWithPayload(node);
  }

  _compileAsyncFromImportWithoutPayload(node) {
    const importedId = this.compileAsyncResolveCompositionTargetFile(node, false, false);
    const exportedId = this.compiler._tmpid();
    const bindingIds = [];
    this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => {`);
    this.emit.line('  resolvedTemplate.compile();');
    this.emit.line('  return runtime.resolveSingle(resolvedTemplate.getExported(null, cb));');
    this.emit.line('});');
    this._emitAsyncFromImportBindings(node, exportedId, bindingIds);
    this._emitFromImportCompletion(node, exportedId, bindingIds);
  }

  _compileAsyncFromImportWithPayload(node) {
    const importedId = this.compileAsyncResolveCompositionTargetFile(node, false, false);
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
    this._emitAsyncFromImportBindings(node, exportedId, bindingIds);
    this._emitFromImportCompletion(node, exportedId, bindingIds);
  }

  _emitAsyncFromImportBindings(node, exportedId, bindingIds) {
    node.names.children.forEach((nameNode) => {
      const importedName = nameNode instanceof nodes.Pair
        ? nameNode.key.value
        : this.compiler.analysis.getBaseChannelName(nameNode.value);
      const alias = nameNode instanceof nodes.Pair
        ? nameNode.value.value
        : nameNode.value;
      const id = this.compiler._tmpid();
      const errorContext = this.compiler._generateErrorContext(node, nameNode);
      const failMsg = `cannot import '${importedName}'`.replace(/"/g, '\\"');

      this.emit.line(`let ${id} = (async () => { try {`);
      this.emit.line(`  let exported = await ${exportedId};`);
      this.emit.line(`  if(Object.prototype.hasOwnProperty.call(exported, "${importedName}")) {`);
      this.emit.line(`    return exported["${importedName}"];`);
      this.emit.line(`  } else {`);
      this.emit.line(`    var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err;`);
      this.emit.line(`  }`);
      this.emit.line(`} catch(e) { var err = runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err; } })();`);
      bindingIds.push(id);
      this._emitValueImportBinding(alias, id, node);
    });
  }

  _emitFromImportCompletion(node, exportedId, bindingIds) {
    if (bindingIds.length > 0) {
      const boundaryCompletion = this.compiler._tmpid();
      this.emit.line(`let ${boundaryCompletion} = runtime.resolveAll([${bindingIds.join(', ')}]);`);
      this.compiler.buffer.emitLimitedLoopCompletion(boundaryCompletion, node);
    } else {
      this.compiler.buffer.emitLimitedLoopCompletion(exportedId, node);
    }
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
    const importedId = this.compileSyncResolveCompositionTargetFile(node, frame, false, false);
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
      const includeContextVar = this.compiler._tmpid();
      const includeTextPromise = this.compiler._tmpid();
      const includeTextChannelName = CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;

      this.emit(`let ${templateNameVar} = `);
      this.compiler.compileExpression(node.template, null, node.template, true);
      this.emit.line(';');

      this.emit.line(`let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}, false, ${JSON.stringify(this.compiler.templateName)}, ${node.ignoreMissing ? 'true' : 'false'});`);
      this.emit.line(`let ${includeVarsVar} = {};`);
      this.emitCompiledPayloadInputs(node, includeVarsVar);
      this.emitCompositionContext(includeContextVar, includeVarsVar, node.withContext);

      this.emit.line(`const ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`${templateVar}_resolved.compile();`);
      this.emit.line(`const composed = ${templateVar}_resolved.renderForComposition(${includeContextVar}, cb, ${node.withContext ? 'context.getRenderContextVariables()' : 'null'});`);
      this.emit.line(`let ${includeTextPromise} = composed.getChannel("${includeTextChannelName}").finalSnapshot();`);
      this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(new runtime.TextCommand({ channelName: "${this.compiler.buffer.currentTextChannelName}", args: [${includeTextPromise}], pos: {lineno: ${node?.lineno ?? 0}, colno: ${node?.colno ?? 0}} }), "${this.compiler.buffer.currentTextChannelName}");`);
      this.compiler.buffer.emitLimitedLoopCompletion(includeTextPromise, node);
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
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this.compileSyncResolveCompositionTargetFile(node, frame, false, node.ignoreMissing);
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
