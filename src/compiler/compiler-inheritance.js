'use strict';

// Inheritance compiler helper.
// Owns inheritance-specific block/super compilation and sync extends block
// registration/runtime call emission.

const nodes = require('../nodes');

class CompileInheritance {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  _shouldSkipTopLevelBlockRender() {
    if (this.compiler.extendsCompiler && typeof this.compiler.extendsCompiler.shouldSkipTopLevelBlockRender === 'function') {
      return this.compiler.extendsCompiler.shouldSkipTopLevelBlockRender();
    }
    return !this.compiler.inBlock && this.compiler.hasStaticExtends && !this.compiler.hasDynamicExtends;
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

  compileAsyncBlock(node) {
    if (this.compiler.scriptMode && !this.compiler.inBlock) {
      return;
    }

    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution. The dynamic extends case is handled later
    // through the extends-owned dynamic parent-resolution helper.
    if (this._shouldSkipTopLevelBlockRender()) {
      return;
    }

    this.compiler.boundaries.compileBlockTextBoundary(
      this.compiler.buffer,
      node,
      (id) => {
        this.emit.line(`let ${id};`);
        const templateKey = JSON.stringify(this.compiler.templateName == null ? '__anonymous__' : String(this.compiler.templateName));
        const explicitInputNameNodes = this.compiler._getBlockInputNameNodes(node);
        const localCaptureNames = Array.isArray(node && node._analysis && node._analysis.localCaptureNames)
          ? node._analysis.localCaptureNames
          : [];
        const hasLocalCaptures = localCaptureNames.length > 0;
        const hasInheritancePayload = !!node.withContext || explicitInputNameNodes.length > 0 || localCaptureNames.length > 0;
        const blockVarsVar = explicitInputNameNodes.length > 0 ? this.compiler._tmpid() : null;
        const blockLocalsVar = hasLocalCaptures ? this.compiler._tmpid() : null;
        const blockPayloadVar = hasInheritancePayload ? this.compiler._tmpid() : null;
        const blockRenderCtxExpr = node.withContext ? 'context.getRenderContextVariables()' : 'undefined';
        if (explicitInputNameNodes.length > 0) {
          this.emit.line(`let ${blockVarsVar} = {};`);
          this.compiler.composition.emitResolvedNameNodeAssignments({
            targetVar: blockVarsVar,
            nameNodes: explicitInputNameNodes
          });
        }
        if (hasLocalCaptures) {
          this.emit.line(`let ${blockLocalsVar} = {};`);
          this.compiler.composition.emitCapturedNameAssignments({
            targetVar: blockLocalsVar,
            names: localCaptureNames,
            ownerNode: node,
            contextExpr: 'context',
            bufferExpr: this.compiler.buffer.currentBuffer
          });
        }
        if (hasInheritancePayload) {
          this.emit.line(`const ${blockPayloadVar} = runtime.createInheritancePayload(${templateKey}, ${explicitInputNameNodes.length > 0 ? blockVarsVar : '{}'}, ${hasLocalCaptures ? blockLocalsVar : 'null'});`);
        }
        this.compiler.extendsCompiler.emitTopLevelBlockResolution(
          node,
          id,
          hasInheritancePayload ? blockPayloadVar : 'null',
          blockRenderCtxExpr
        );
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
    // through the extends-owned dynamic parent-resolution helper.
    if (this._shouldSkipTopLevelBlockRender()) {
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
    const parentTemplateId = this.compiler.composition._compileSyncGetTemplate(node, frame, true, false);
    this.emit.line(`parentTemplate = ${parentTemplateId};`);
    this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
    this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this.emit.line('}');
    this.emit.addScopeLevel();
  }

  compileAsyncSuper(node) {
    if (this.compiler.scriptMode) {
      const id = node.symbol ? node.symbol.value : null;
      const compilingBlock = this.compiler.currentCompilingBlock;
      const blockName = compilingBlock && compilingBlock.name ? compilingBlock.name.value : null;
      const ownerKey = this.compiler.extendsCompiler.metadata.getCompiledMethodOwnerKey();
      if (!blockName) {
        this.compiler.fail(
          'super() is only valid inside a method body',
          node.lineno,
          node.colno,
          node
        );
      }
      const positionalArgsNode = this._getPositionalSuperArgsNode(node);
      const args = positionalArgsNode.children;
      const knownInputNames = this.compiler._getBlockInputNames(compilingBlock);
      if (args.length > knownInputNames.length) {
        this.compiler.fail(
          `super(...) for method "${blockName}" received too many arguments`,
          node.lineno,
          node.colno,
          node
        );
      }
      const errorContextJson = JSON.stringify(this.compiler._createErrorContext(node));
      if (!id) {
        this.emit(`runtime.callSuperMethod(context, inheritanceState, ${JSON.stringify(blockName)}, ${JSON.stringify(ownerKey)}, `);
        this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
        this.emit(`, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, blockPayload, ${errorContextJson})`);
        return;
      }

      const superArgsVar = this.compiler._tmpid();
      const superCallExpr =
        `runtime.callSuperMethod(context, inheritanceState, ${JSON.stringify(blockName)}, ${JSON.stringify(ownerKey)}, ${superArgsVar}, env, runtime, cb, ${this.compiler.buffer.currentBuffer}, blockPayload, ${errorContextJson})`;
      this.emit(`let ${superArgsVar} = `);
      this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
      this.emit.line(';');
      this.emit.line(`let ${id} = ${superCallExpr};`);
      return;
    }

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
      if (args.length === 0) {
        this.emit(`runtime.markSafe(context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, inheritanceState, runtime.createSuperInheritancePayload(blockPayload), blockRenderCtx))`);
        return;
      }
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
      this.emit.line(`const ${superBlockPayloadVar} = runtime.createSuperInheritancePayload(blockPayload, ${superArgsOverrideVar});`);
      this.emit(`return runtime.markSafe(context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, inheritanceState, ${superBlockPayloadVar}, blockRenderCtx));`);
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
      this.emit.line(`const ${superBlockPayloadVar} = runtime.createSuperInheritancePayload(blockPayload, ${superArgsOverrideVar});`);
      this.emit.line(`let ${id} = context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, inheritanceState, ${superBlockPayloadVar}, blockRenderCtx);`);
    } else {
      this.emit.line(`let ${id} = context.getAsyncSuper(env, "${name}", b_${name}, runtime, cb, ${this.compiler.buffer.currentBuffer}, inheritanceState, runtime.createSuperInheritancePayload(blockPayload), blockRenderCtx);`);
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

}

module.exports = CompileInheritance;

