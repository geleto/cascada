'use strict';

const nodes = require('../nodes');

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

  _templateName() {
    return this.compiler.templateName === null ? 'undefined' : JSON.stringify(this.compiler.templateName);
  }

  _compileGetTemplateOrScript(node, frame, eagerCompile, ignoreMissing, wrapInAsyncBlock) {
    const parentTemplateId = this.compiler._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    if (node.isAsync) {
      const getTemplateFunc = this.compiler._tmpid();
      //the AsyncEnviuronment.getTemplate returns a Promise
      this.emit.line(`const ${getTemplateFunc} = env.get${this.compiler.scriptMode ? 'Script' : 'Template'}.bind(env);`);
      this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      /*if (wrapInAsyncBlock) {
        // Wrap the expression evaluation in an async block if needed, use template node position
        this.emit.AsyncBlockValue(node.template, frame, (n, f) => {
          this._compileExpression(n, f, true, positionNode);
        }, undefined, positionNode);
      } else {*/
      this.compiler._compileExpression(node.template, frame, wrapInAsyncBlock, positionNode);
      /*}*/
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    } else {
      const cb = this.compiler._makeCallback(parentTemplateId);
      this.emit(`env.get${this.compiler.scriptMode ? 'Script' : 'Template'}(`);
      this.compiler._compileExpression(node.template, frame, false);
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);
    }

    return parentTemplateId;
  }

  compileImport(node, frame) {
    const target = node.target.value;
    const id = this._compileGetTemplateOrScript(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this.compiler._tmpid();
      this.emit(`${id} = `);
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.emit(`let ${res} = (await ${id}).getExported(${n.withContext
          ? `context.getVariables(), frame, astate, cb`
          : `null, null, astate, cb`
        });`);
      }, res, node);
      //this.emit.line(';');
    } else {
      this.emit.addScopeLevel();
      this.emit.line(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this.compiler._makeCallback(id));
      this.emit.addScopeLevel();
    }

    frame.set(target, id);
    if (node.isAsync) {
      this.compiler._addDeclaredVar(frame, target);
    }

    if (frame.parent) {
      this.emit.line(`frame.set("${target}", ${id});`);
    } else {
      this.emit.line(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    // Pass node.template for position in _compileGetTemplateOrScript
    const importedId = this._compileGetTemplateOrScript(node, frame, false, false, true);

    if (node.isAsync) {
      // Get the exported object from the template
      const res = this.compiler._tmpid();
      this.emit(`${importedId} = `);
      // Use node as position node for the getExported part
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.emit(`let ${res} = (await ${importedId}).getExported(${n.withContext
          ? `context.getVariables(), frame, astate, cb`
          : `null, null, astate, cb`
        });`);
      }, res, node);

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
        this.emit.line(`  let exported = await ${importedId};`);
        this.emit.line(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this.emit.line(`    return exported["${name}"];`);
        this.emit.line(`  } else {`);
        this.emit.line(`    var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err;`);
        this.emit.line(`  }`);
        this.emit.line(`} catch(e) { var err = runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err; } })();`);

        frame.set(alias, id);
        this.compiler._addDeclaredVar(frame, alias);

        if (frame.parent) {
          this.emit.line(`frame.set("${alias}", ${id});`);
        } else {
          this.emit.line(`context.setVariable("${alias}", ${id});`);
        }
      });
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
      this.compiler.buffer.asyncAddToBuffer(node, frame, (id, f) => {
        // The dynamic check runs when:
        // 1. We're at top level (!this.inBlock)
        // 2. There might be a dynamic parent (hasDynamicExtends OR hasStaticExtends)
        //    - hasDynamicExtends: Need to check frame variable
        //    - hasStaticExtends with hasDynamicExtends: Dynamic can override static
        const needsParentCheck = !this.compiler.inBlock && (this.compiler.hasDynamicExtends || this.compiler.hasStaticExtends);
        if (needsParentCheck) {
          if (this.compiler.hasDynamicExtends) {
            this.compiler.async.updateFrameReads(f, '__parentTemplate');
            this.emit.line('let parent = await runtime.contextOrFrameLookup(context, frame, "__parentTemplate");');
            if (this.compiler.hasStaticExtends) {
              // Check both: dynamic can override static
              this.emit.line('if (!parent) parent = parentTemplate;');
            }
          } else {
            // Only static extends (but in a context where dynamic might exist)
            this.emit.line('let parent = parentTemplate;');
          }
          this.emit.line('if (!parent) {');
        }
        const blockFunc = this.compiler._tmpid();
        //this.emit.line(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        //this.emit.line(`${blockFunc} = runtime.promisify(${blockFunc}.bind(context));`);
        this.emit.line(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        this.emit.line(`${id} = ${blockFunc}(env, context, frame, runtime, astate, cb);`);
        if (needsParentCheck) {
          this.emit.line('}');
        }
      }, node);
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
        //non-async node but in async mode -> use the proper buffer implementation
        this.emit(`${this.compiler.buffer.currentBuffer}[index++] = ${id};`);
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

    const parentTemplateId = this._compileGetTemplateOrScript(node, frame, true, false, true);

    if (this.compiler.asyncMode) {
      if (node.asyncStoreIn) {
        this.emit.line(`let ${node.asyncStoreIn} = ${parentTemplateId};`);
      }

      frame = this.emit.asyncBlockBegin(node, frame, false, node.template);
      const templateVar = this.compiler._tmpid();
      this.emit.line(`let ${templateVar} = await ${parentTemplateId};`);

      // ALWAYS store in parentTemplate for block registration (and static case)
      this.emit.line(`parentTemplate = ${templateVar};`);

      // Register blocks while still inside async block
      this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
      this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
      this.emit.line('}');

      this.emit.line('context.finishAsyncBlocks()');
      frame = this.emit.asyncBlockEnd(node, frame, false, false, node.template);
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

    if (node.isAsync) {
      //this.emit.line(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);

      // Call getSuper directly - it returns the output synchronously
      // The callback (cb) is passed through for error propagation
      this.emit.line(`let ${id} = context.getSuper(env, "${name}", b_${name}, frame, runtime, astate, cb);`);
    }
    else {
      const cb = this.compiler._makeCallback(id);
      this.emit.line(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this.emit.line(`${id} = runtime.markSafe(${id});`);

    if (!node.isAsync) {
      this.emit.addScopeLevel();
    }
    frame.set(id, id);
    if (node.isAsync) {
      this.compiler._addDeclaredVar(frame, id);
    }
  }

  compileInclude(node, frame) {
    if (!node.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    // `asyncBlockAddToBuffer` places the final result into the parent buffer.
    // The block is async because `getTemplate` returns a promise.
    this.compiler.buffer.asyncAddToBuffer(node, frame, (resultVar, f) => {
      // Get the template object (this part is async)
      const templateVar = this.compiler._tmpid();
      const templateNameVar = this.compiler._tmpid();

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      this.compiler._compileExpression(node.template, f, false);
      this.emit.line(';');

      //the AsyncEnviuronment.getTemplate returns a Promise
      this.emit.line(`let ${templateVar} = await env.getTemplate.bind(env)(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // Call the template in composition mode. This is a SYNCHRONOUS call
      // that returns the incomplete output array immediately. The master `cb` from the
      // closure is passed for error propagation.
      this.emit.line(`${resultVar} = ${templateVar}._renderForComposition(context.getVariables(), frame, astate, cb);`);
    }, node);
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this._compileGetTemplateOrScript(node, frame, false, node.ignoreMissing, false);
    this.emit.line(`callback(null,${id});});`);

    this.emit.line('});');

    const id2 = this.compiler._tmpid();
    this.emit.line('tasks.push(');
    this.emit.line('function(template, callback){');
    this.emit.line('template.render(context.getVariables(), frame, ' + (node.isAsync ? 'astate,' : '') + this.compiler._makeCallback(id2));
    this.emit.line('callback(null,' + id2 + ');});');
    this.emit.line('});');

    this.emit.line('tasks.push(');
    this.emit.line('function(result, callback){');

    // Adding to buffer is synchronous here
    if (this.compiler.asyncMode) {
      //non-async node but in async mode -> use the proper buffer implementation
      this.emit.line(`${this.compiler.buffer.currentBuffer}[index++] = result;`);
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
