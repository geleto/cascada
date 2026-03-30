'use strict';

const nodes = require('../nodes');
const CompileBuffer = require('./compile-buffer');

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

  _emitDeclaredValueSnapshots(analysis, targetVarsVar, positionNode) {
    const lineno = positionNode && positionNode.lineno != null ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno != null ? positionNode.colno : 0;
    const visibleChannels = this.compiler.analysis.getIncludeVisibleVarChannels(analysis);
    visibleChannels.forEach((entry) => {
      const snapshotExpr = this.compiler.buffer.emitAddSnapshot(entry.runtimeName, { lineno, colno }, true);
      this.emit.line(`${targetVarsVar}[${JSON.stringify(entry.baseName)}] = ${snapshotExpr};`);
    });
  }

  _emitDeclaredValueAliasMap(analysis, aliasVar) {
    const visibleChannels = this.compiler.analysis.getIncludeVisibleVarChannels(analysis);
    const aliases = Object.create(null);
    for (let i = 0; i < visibleChannels.length; i++) {
      const entry = visibleChannels[i];
      if (entry.baseName === entry.runtimeName) {
        continue;
      }
      aliases[entry.baseName] = entry.runtimeName;
    }
    const keys = Object.keys(aliases);
    for (let i = 0; i < keys.length; i++) {
      const base = keys[i];
      this.emit.line(`${aliasVar}[${JSON.stringify(base)}] = ${JSON.stringify(aliases[base])};`);
    }
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

  /**
   * Collect canonical runtime channel names that should be prelinked for include composition.
   *
   * Include composition snapshots visible declared var channels by nearest lexical
   * name. Mirror that here so nested/shadowed loop metadata links only the
   * currently visible channel lane for each name.
   */
  _collectIncludeLinkCandidates(analysis) {
    return this.compiler.analysis.getIncludeVisibleVarChannels(analysis)
      .map((entry) => entry.runtimeName);
  }

  _templateName() {
    return this.compiler.templateName === null ? 'undefined' : JSON.stringify(this.compiler.templateName);
  }

  _compileGetTemplateOrScript(node, frame, eagerCompile, ignoreMissing) {
    const parentTemplateId = this.compiler._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    if (this.compiler.asyncMode) {
      const getTemplateFunc = this.compiler._tmpid();
      //the AsyncEnviuronment.getTemplate returns a Promise
      this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
      this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      // Template/script lookup expressions feed composition boundaries, which
      // emit their own completion tracking separately from root-expression WRCs.
      this.compiler.compileExpression(node.template, frame, positionNode, true);
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    } else {
      const cb = this.compiler._makeCallback(parentTemplateId);
      this.emit(`env.get${this.compiler.scriptMode ? 'Script' : 'Template'}(`);
      // Template/script lookup expressions feed composition boundaries, which
      // emit their own completion tracking separately from root-expression WRCs.
      this.compiler.compileExpression(node.template, frame, node.template, true);
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);
    }

    return parentTemplateId;
  }

  compileImport(node, frame) {
    const target = node.target.value;
    const id = this._compileGetTemplateOrScript(node, frame, false, false);

    if (this.compiler.asyncMode) {
      const exportedId = this.compiler._tmpid();
      if (node.withContext) {
        const importVarsVar = this.compiler._tmpid();
        this.emit.line(`let ${importVarsVar} = Object.assign({}, context.getVariables());`);
        this._emitDeclaredValueSnapshots(node._analysis, importVarsVar, node);
        this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => resolvedTemplate.getExported(${importVarsVar}, cb));`);
      } else {
        this.emit.line(`let ${exportedId} = runtime.resolveSingle(${id}).then((resolvedTemplate) => resolvedTemplate.getExported(null, cb));`);
      }
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      this._emitValueImportBinding(target, exportedId, node);
      return;
    } else {
      this.emit.addScopeLevel();
      this.emit.line(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this.compiler._makeCallback(id));
      this.emit.addScopeLevel();
    }

    frame.set(target, id);

    if (frame.parent) {
      this.emit.line(`frame.set("${target}", ${id});`);
    } else {
      this.emit.line(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    // Pass node.template for position in _compileGetTemplateOrScript
    const importedId = this._compileGetTemplateOrScript(node, frame, false, false);

    if (this.compiler.asyncMode) {
      const exportedId = this.compiler._tmpid();
      const bindingIds = [];
      if (node.withContext) {
        const importVarsVar = this.compiler._tmpid();
        this.emit.line(`let ${importVarsVar} = Object.assign({}, context.getVariables());`);
        this._emitDeclaredValueSnapshots(node._analysis, importVarsVar, node);
        this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => resolvedTemplate.getExported(${importVarsVar}, cb));`);
      } else {
        this.emit.line(`let ${exportedId} = runtime.resolveSingle(${importedId}).then((resolvedTemplate) => resolvedTemplate.getExported(null, cb));`);
      }

      // Now extract each individual variable from the exported object
      node.names.children.forEach((nameNode) => {
        let name;
        let alias;
        let id = this.compiler._tmpid();

        if (nameNode instanceof nodes.Pair) {
          name = nameNode.key.value;
          alias = nameNode.value.value;
        } else {
          name = nameNode.value;
          alias = name;
        }

        // Generate context within the compiler scope
        const errorContext = this.compiler._generateErrorContext(node, nameNode);
        const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

        // Create individual promise for this variable - await ${importedId} which now holds the exported object
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

      // from-import boundary completion as a single completion unit.
      if (bindingIds.length > 0) {
        const boundaryCompletion = this.compiler._tmpid();
        this.emit.line(`let ${boundaryCompletion} = runtime.resolveAll([${bindingIds.join(', ')}]);`);
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(boundaryCompletion, node);
      } else {
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(exportedId, node);
      }
    } else {
      // Sync mode remains unchanged
      this.emit.addScopeLevel(); // after _compileGetTemplateOrScript
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

        // Generate context within the compiler scope
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
  }

  compileBlock(node, frame) {
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

    if (this.compiler.asyncMode) {
      this.compiler.boundaries.compileBlockTextBoundary(
        this.compiler.buffer,
        node,
        frame,
        (f, id) => {
          this.emit.line(`let ${id};`);
          // The dynamic check runs when:
          // 1. We're at top level (!this.inBlock)
          // 2. There might be a dynamic parent (hasDynamicExtends OR hasStaticExtends)
          //    - hasDynamicExtends: Need to check frame variable
          //    - hasStaticExtends with hasDynamicExtends: Dynamic can override static
          const needsParentCheck = !this.compiler.inBlock && (this.compiler.hasDynamicExtends || this.compiler.hasStaticExtends);
          if (needsParentCheck) {
            this.emit.line(`const parentPromise = runtime.resolveSingle(runtime.channelLookup("__parentTemplate", ${this.compiler.buffer.currentBuffer}));`);
            this.emit.line(`${id} = parentPromise.then((parent) => {`);
            this.emit.line('  if (parent) return "";');
            this.emit.line(`  return context.getAsyncBlock("${node.name.value}").then((blockFunc) => blockFunc(env, context, runtime, cb, ${this.compiler.buffer.currentBuffer}));`);
            this.emit.line('});');
          } else {
            this.emit.line(`${id} = context.getAsyncBlock("${node.name.value}").then((blockFunc) => blockFunc(env, context, runtime, cb, ${this.compiler.buffer.currentBuffer}));`);
          }
          // Step 7: block invocation boundary completion in limited-loop waited output.
          this.compiler.buffer.emitOwnWaitedConcurrencyResolve(id, node);
        }
      );
    }
    else {
      let id = this.compiler._tmpid();
      if (!this.compiler.inBlock) {
        this.emit('(parentTemplate ? function(e, c, f, r, cb) { cb(null, ""); } : ');
      }
      this.emit(`context.getBlock("${node.name.value}")`);
      if (!this.compiler.inBlock) {
        this.emit(')');
      }
      this.emit.line('(env, context, frame, runtime, ' + this.compiler._makeCallback(id));

      if (this.compiler.asyncMode) {
        //non-async node but in async mode -> emit a buffered TextCommand through CompileBuffer
        this.compiler.buffer.addToBuffer(node, frame, function () {
          this.emit(id);
        }, node, this.compiler.buffer.currentTextChannelName, true);
      } else {
        this.emit.line(`${this.compiler.buffer.currentBuffer} += ${id};`);
      }
      this.emit.addScopeLevel();
    }
  }

  compileExtends(node, frame) {
    var k = this.compiler._tmpid();

    if (this.compiler.asyncMode) {
      this.emit.line('context.prepareForAsyncBlocks();');
    }

    const parentTemplateId = this._compileGetTemplateOrScript(node, frame, true, false);

    if (this.compiler.asyncMode) {
      if (node.asyncStoreIn) {
        const resolvedParentTemplateId = `${node.asyncStoreIn}_resolvedParentTemplate`;
        // Transformed dynamic extends publishes the parent later through
        // `set __parentTemplate = tempVar`. Delay that promise until async
        // block registration is complete, so root cannot observe the parent
        // before `context.addBlock(...)` / `finishAsyncBlocks()` have settled.
        this.emit.line(`let ${node.asyncStoreIn} = Promise.resolve(${parentTemplateId}).then((${resolvedParentTemplateId}) => {`);
        this.emit.line('  if (context.asyncBlocksPromise) {');
        this.emit.line(`    return context.asyncBlocksPromise.then(() => ${resolvedParentTemplateId});`);
        this.emit.line('  }');
        this.emit.line(`  return ${resolvedParentTemplateId};`);
        this.emit.line('});');
      }
      const extendsResult = this.compiler.buffer._compileControlFlowBoundary(node, frame, (blockFrame) => {
        const templateVar = this.compiler._tmpid();
        if (!node.asyncStoreIn) {
          this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '__parentTemplate', args: [${parentTemplateId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '__parentTemplate');`);
        }
        this.emit.line(`let ${templateVar} = await ${parentTemplateId};`);
        this.emit.line(`for(let ${k} in ${templateVar}.blocks) {`);
        this.emit.line(`  context.addBlock(${k}, ${templateVar}.blocks[${k}]);`);
        this.emit.line('}');
        this.emit.line('await context.finishAsyncBlocks();');
        return blockFrame;
      });
      frame = extendsResult.frame;
    } else {
      // SYNC MODE
      this.emit.line(`parentTemplate = ${parentTemplateId};`);
      this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
      this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
      this.emit.line('}');
      this.emit.addScopeLevel();
    }
  }

  compileSuper(node, frame) {
    var name = node.blockName.value;
    var id = node.symbol.value;

    if (this.compiler.asyncMode) {
      //this.emit.line(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime);`);

      // Call getSuper directly - async blocks now return text snapshot promises
      // The callback (cb) is passed through for error propagation
      this.emit.line(`let ${id} = context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer});`);
      this.emit.line(`${id} = runtime.markSafe(${id});`);
    }
    else {
      const cb = this.compiler._makeCallback(id);
      this.emit.line(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
      this.emit.line(`${id} = runtime.markSafe(${id});`);
    }

    if (!this.compiler.asyncMode) {
      this.emit.addScopeLevel();
    }
  }

  compileInclude(node, frame) {
    if (!this.compiler.asyncMode) {
      this.compileIncludeSync(node, frame);
      return;
    }
    const includeResult = this.compiler.buffer._compileControlFlowBoundary(node, frame, (f) => {
      // Get the template object (this part is async)
      const templateVar = this.compiler._tmpid();
      const templateNameVar = this.compiler._tmpid();
      const includeVarsVar = this.compiler._tmpid();
      const aliasMapVar = this.compiler._tmpid();
      const includeTextPromise = this.compiler._tmpid();
      // Included template renders into its own default text lane.
      // The caller lane may be scope-specific (e.g. capture text output) and
      // is only used when enqueueing the final TextCommand in the parent buffer.
      const includeOutputChannelName = CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      // Include target lookup is handled by include/import boundary tracking,
      // so it intentionally bypasses root waited-expression tracking.
      this.compiler.compileExpression(node.template, f, node.template, true);
      this.emit.line(';');

      // Keep producer synchronous: carry async template lookup/render in promise chain.
      this.emit.line(`let ${templateVar} = env.getTemplate.bind(env)(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // Includes run in a separate template/frame. To preserve caller-visible
      // var-channel reads, copy context vars and inject currently-declared
      // var channels as snapshot promises from the active command buffer.
      // This keeps ordering semantics and leaves include logic declaration-driven.
      this.emit.line(`let ${includeVarsVar} = Object.assign({}, context.getVariables());`);
      this._emitDeclaredValueSnapshots(node._analysis, includeVarsVar, node);
      this.emit.line(`let ${aliasMapVar} = {};`);
      this._emitDeclaredValueAliasMap(node._analysis, aliasMapVar);

      this.emit.line(`const ${templateVar}_resolved = await runtime.resolveSingle(${templateVar});`);
      this.emit.line(`const composed = ${templateVar}_resolved._renderForComposition(${includeVarsVar}, cb);`);
      // Compose child buffer with base->canonical aliases (e.g. loop -> loop#7)
      // so natural names used inside included templates target the right lane.
      this.emit.line(`composed._setBoundaryAliases(${aliasMapVar});`);
      // Structural prelinking: attach composed child to parent lanes up front so
      // include-time symbol snapshots do not depend on lookup-time dynamic linking.
      const includeLinkCandidates = this._collectIncludeLinkCandidates(node._analysis);
      const parentBufferExpr = this.compiler.buffer.currentBuffer;
      this.compiler.emitLinkWithParentCompositionBuffer(
        includeLinkCandidates,
        parentBufferExpr,
        'composed',
        'composed._channels'
      );
      // Includes own a composed child text boundary. Use the child text channel's
      // finalSnapshot() as the structural completion signal rather than adding an
      // extra point-in-time snapshot command for that boundary.
      this.emit.line(`let ${includeTextPromise} = composed.getChannel("${includeOutputChannelName}").finalSnapshot();`);
      this.emit.line(`${this.compiler.buffer.currentBuffer}.add(new runtime.TextCommand({ channelName: "${this.compiler.buffer.currentTextChannelName}", args: [${includeTextPromise}], pos: {lineno: ${node?.lineno ?? 0}, colno: ${node?.colno ?? 0}} }), "${this.compiler.buffer.currentTextChannelName}");`);
      // Include boundary completion in limited-loop waited output.
      // Wait on the composed include snapshot promise (timing unit), not on the
      // command object created for parent enqueue.
      this.compiler.buffer.emitOwnWaitedConcurrencyResolve(includeTextPromise, node);
      return f;
    });
    frame = includeResult.frame;
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this._compileGetTemplateOrScript(node, frame, false, node.ignoreMissing);
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

    // Adding to buffer is synchronous here
    if (this.compiler.asyncMode) {
      //non-async node but in async mode -> emit a buffered TextCommand through CompileBuffer
      this.compiler.buffer.addToBuffer(node, frame, function () {
        this.emit('result');
      }, node, this.compiler.buffer.currentTextChannelName, true);
    } else {
      this.emit.line(`${this.compiler.buffer.currentBuffer} += result;`);
    }
    this.emit.line('callback(null);');
    this.emit.line('});');
    this.emit.line('env.waterfall(tasks, function(){');
    this.emit.addScopeLevel();
  }
}

module.exports = CompileInheritance;

