
import * as nodes from '../nodes.js';
import {Frame} from '../runtime/frame.js';
import {CompilerBaseSync} from './compiler-base-sync.js';
import {CompileBuffer} from './buffer.js';

class CompilerSync extends CompilerBaseSync {
  init(templateName, options) {
    super.init(Object.assign({}, options, { asyncMode: false, templateName }));
  }

  compileCallExtension(node, frame) {
    this._compileSyncCallExtension(node, frame, false);
  }

  compileCallExtensionAsync(node, frame) {
    this._compileSyncCallExtension(node, frame, true);
  }

  _compileSyncCallExtension(node, frame, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async;
    const positionNode = args || node;

    const emitCallArgs = (callFrame) => {
      if ((args && args.children.length) || contentArgs.length) {
        this.emit(',');
      }

      if (args) {
        if (!(args instanceof nodes.NodeList)) {
          this.fail('compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`', node.lineno, node.colno, node);
        }

        args.children.forEach((arg, i) => {
          this._compileExpression(arg, callFrame);
          if (i !== args.children.length - 1 || contentArgs.length) {
            this.emit(',');
          }
        });
      }

      if (contentArgs.length) {
        contentArgs.forEach((arg, i) => {
          if (i > 0) {
            this.emit(',');
          }

          if (arg) {
            this.emit.line('function(cb) {');
            this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this.emit.withScopedSyntax(() => {
              this.emit._compileSyncCallbackRenderBoundary(node, callFrame, function () {
                this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, frame);
              }, 'cb', arg);
              this.emit.line(';');
            });

            this.emit.line('}');
          } else {
            this.emit('null');
          }
        });
      }
    };

    const ext = this._tmpid();
    this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
    if (noExtensionCallback) {
      this.buffer.addToBuffer(node, frame, () => {
        this.emit('runtime.suppressValue(');
        this.emit(`${ext}["${node.prop}"](context`);
        emitCallArgs(frame);
        this.emit(`), ${autoescape} && env.opts.autoescape)`);
      }, positionNode, this.buffer.currentTextChannelName, false);
      return;
    }

    this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
    emitCallArgs(frame);
    const res = this._tmpid();
    this.emit.line(', ' + this._makeCallback(res));
    this.boundaries.compileSyncTextBoundary(
      this.buffer,
      node,
      frame,
      positionNode,
      () => {
        this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
      },
      {}
    );
    this.emit.addScopeLevel();
  }

  compileCallAssign(node) {
    this.fail('call_assign is only supported in script mode', node.lineno, node.colno, node);
  }

  compileSet(node, frame) {
    const ids = [];

    node.targets.forEach(() => {
      const id = this._tmpid();
      this.emit.line(`var ${id};`);
      ids.push(id);
    });

    if (node.path) {
      if (ids.length !== 1) {
        this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
      }
      this.emit(ids[0] + ' = ');
      this.emit('runtime.deepAssign(');
      this.emit(`frame.lookup("${node.targets[0].value}"), `);
      this.compile(node.path, frame);
      this.emit(', ');
      this.compile(node.value, frame);
      this.emit(')');
      this.emit.line(';');
    } else if (node.value) {
      this.emit(ids.join(' = ') + ' = ');
      this.compileExpression(node.value, frame, node.value);
      this.emit.line(';');
    } else {
      this.emit(ids.join(' = ') + ' = ');
      this.compile(node.body, frame);
      this.emit.line(';');
    }

    node.targets.forEach((target, i) => {
      const id = ids[i];
      const name = target.value;
      this.emit.line(`frame.set("${name}", ${id}, true);`);
      this.emit.line('if (frame.topLevel) {');
      this.emit.line(`context.setVariable("${name}", ${id});`);
      if (name.charAt(0) !== '_') {
        this.emit.line(`context.addResolvedExport("${name}", ${id});`);
      }
      this.emit.line('}');
    });
  }

  compileWhile(node, frame) {
    this.loop.compileSyncWhile(node, frame);
  }

  compileFor(node, frame) {
    this.loop.compileSyncFor(node, frame);
  }

  compileAsyncEach(node, frame) {
    this.loop.compileSyncAsyncEach(node, frame);
  }

  compileAsyncAll(node, frame) {
    this.loop.compileSyncAsyncAll(node, frame);
  }

  compileSwitch(node, frame) {
    this.buffer._compileSyncControlFlowBoundary(node, frame, (blockFrame) => {
      this.emit('switch (');
      this._compileAwaitedExpression(node.expr, blockFrame);
      this.emit(') {');

      node.cases.forEach((c) => {
        this.emit('case ');
        this._compileAwaitedExpression(c.cond, blockFrame);
        this.emit(': ');

        if (c.body.children.length) {
          this.compile(c.body, blockFrame);
          this.emit.line('break;');
        }
      });

      if (node.default) {
        this.emit('default: ');
        this.compile(node.default, blockFrame);
      }

      this.emit('}');
    });
  }

  compileIf(node, frame) {
    this.buffer._compileSyncControlFlowBoundary(node, frame, (blockFrame) => {
      this.emit('if(');
      this._compileAwaitedExpression(node.cond, blockFrame);
      this.emit('){');

      this.emit.withScopedSyntax(() => {
        this.compile(node.body, blockFrame);
      });

      this.emit('} else {');

      if (node.else_) {
        this.emit.withScopedSyntax(() => {
          this.compile(node.else_, blockFrame);
        });
      }
      this.emit('}');
    });
  }

  _compileLegacyCallbackIf(node, frame) {
    this.emit('(function(cb) {');
    this.buffer._compileSyncControlFlowBoundary(node, frame, (blockFrame) => {
      this.emit('if(');
      this._compileAwaitedExpression(node.cond, blockFrame);
      this.emit('){');

      this.emit.withScopedSyntax(() => {
        this.compile(node.body, blockFrame);
        this.emit('cb()');
      });

      this.emit('} else {');

      if (node.else_) {
        this.emit.withScopedSyntax(() => {
          this.compile(node.else_, blockFrame);
          this.emit('cb()');
        });
      } else {
        this.emit('cb()');
      }
      this.emit('}');
    });
    this.emit('})(' + this._makeCallback());
    this.emit.addScopeLevel();
  }

  compileIfAsync(node, frame) {
    this._compileLegacyCallbackIf(node, frame);
  }

  compileCapture(node, frame) {
    if (this.scriptMode) {
      this.fail('Capture blocks are only supported in template mode', node.lineno, node.colno, node);
    }
    const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
    this.emit.line('(function() {');
    this.emit.line('let output = "";');
    this.buffer.withBufferState({
      currentBuffer: 'output',
      currentTextChannelVar: 'output_textChannelVar',
      currentTextChannelName: captureTextOutputName
    }, () => {
      this.emit.withScopedSyntax(() => {
        this.compile(node.body, frame);
      });
    });
    this.emit.line('return output;');
    this.emit.line('})()');
  }

  compileOutput(node, frame) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared channels and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textChannelName = this.buffer.currentTextChannelName;
    node.children.forEach((child) => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, frame, function() {
            this.compileLiteral(child, frame);
          }, child, textChannelName, false);
        }
        return;
      }

      this.buffer.addToBuffer(node, frame, function() {
        this.emit('runtime.suppressValue(');
        if (this.throwOnUndefined) {
          this.emit('runtime.ensureDefined(');
        }
        this.compileExpression(child, frame, child);
        if (this.throwOnUndefined) {
          this.emit(`,${child.lineno},${child.colno}, context)`);
        }
        this.emit(', env.opts.autoescape)');
      }, child, textChannelName, false);
    });
  }

  _emitSyncRootCompletion() {
    this.emit.line('if(parentTemplate) {');
    this.emit.line('  let parentContext = context.forkForPath(parentTemplate.path);');
    this.emit.line('  parentTemplate.rootRenderFunc(env, parentContext, frame, runtime, cb);');
    this.emit.line('} else {');
    this.emit.line(`  cb(null, ${this.buffer.currentBuffer});`);
    this.emit.line('}');
  }

  _compileSyncRootBody(node, frame) {
    this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
    this.emit.line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    this._emitSyncRootCompletion();
  }

  _compileSyncBlockEntry(block, frame) {
    const name = block.name.value;
    const blockFrame = frame.new();
    this.emit.beginEntryFunction(block, `b_${name}`);
    this.emit.line('var frame = frame.push(true);');
    this.compile(block.body, blockFrame);
    this.emit.endEntryFunction(block);
  }

  _compileSyncBlockEntries(node, frame) {
    const blockNames = new Set();
    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const name = block.name.value;

      if (blockNames.has(name)) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.add(name);
      this._compileSyncBlockEntry(block, frame);
    });

    return blocks;
  }

  _compileSyncRoot(node, frame) {
    this.emit.beginEntryFunction(node, 'root');
    this._compileSyncRootBody(node, frame);
    this.emit.endEntryFunction(node, true);
    this.inBlock = true;
    return this._compileSyncBlockEntries(node, frame);
  }

  compileRoot(node, frame) {
    if (frame) {
      this.fail('compileRoot: root node can\'t have frame', node.lineno, node.colno, node);
    }

    this.hasStaticExtends = node.children.some((child) => this._isStaticExtendsNode(child));
    this.hasDynamicExtends = node.children.some((child) =>
      this._isDynamicExtendsNode(child)
    );
    this.hasExtends = this.hasStaticExtends || this.hasDynamicExtends;
    const blocks = this._compileSyncRoot(node, new Frame());

    this.emit.line('return {');
    blocks.forEach((block) => {
      const blockName = `b_${block.name.value}`;
      this.emit.line(`${blockName}: ${blockName},`);
    });
    this.emit.line('root: root\n};');
  }

  compileMacro(node, frame) {
    this.macro.compileSyncMacroDeclaration(node, frame);
  }

  compileImport(node, frame) {
    this.inheritance.compileSyncImport(node, frame);
  }

  compileFromImport(node, frame) {
    this.inheritance.compileSyncFromImport(node, frame);
  }

  compileBlock(node, frame) {
    this.inheritance.compileSyncBlock(node, frame);
  }

  compileSuper(node, frame) {
    this.inheritance.compileSyncSuper(node, frame);
  }

  compileExtends(node, frame) {
    this.inheritance.compileSyncExtends(node, frame);
  }

  compileInclude(node, frame) {
    this.inheritance.compileSyncInclude(node, frame);
  }

  compileIncludeSync(node, frame) {
    this.inheritance.compileSyncInclude(node, frame);
  }

  compileDo(node, frame) {
    node.children.forEach((child) => {
      this.compileExpression(child, frame, child);
      this.emit.line(';');
    });
  }

  compileReturn(node, frame) {
    this.emit('cb(null, ');
    if (node.value) {
      this.compileExpression(node.value, frame, node);
    } else {
      this.emit('null');
    }
    this.emit.line(');');
    this.emit.line('return;');
  }

  compileChannelDeclaration(node) {
    this.fail('Channel declarations are only supported in async script mode', node.lineno, node.colno, node);
  }

  compileChannelCommand(node) {
    this.fail('Channel commands are only supported in async script mode', node.lineno, node.colno, node);
  }

  _getRootDeclarations() {
    return [{ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL, type: 'text', initializer: null }];
  }

  _getRootTextOutput() {
    return CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;
  }

}

export {CompilerSync};
