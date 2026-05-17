
import * as nodes from '../language/nodes.js';

import {
  validateScriptExtendsSourceOrder,
  validateScriptExtendsExpression,
  validateTemplateInheritanceSurface,
} from './validation.js';

import {CompilerBaseAsync} from './compiler-base-async.js';
import {CompileBuffer} from './buffer.js';
import {CompileGuard} from './guard.js';
import {CompileAssignment} from './assignment.js';

class CompilerAsync extends CompilerBaseAsync {
  init(templateName, options) {
    super.init({ ...options, asyncMode: true, templateName });
    this.guard = new CompileGuard(this);
    this.assignment = new CompileAssignment(this);
  }

  analyzeCallExtension(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return textChannel
      ? { uses: [textChannel], mutates: [textChannel] }
      : {};
  }

  analyzeCallExtensionAsync(node) {
    return this.analyzeCallExtension(node);
  }

  compileCallExtension(node) {
    this._compileAsyncCallExtension(node, false);
  }

  compileCallExtensionAsync(node) {
    this._compileAsyncCallExtension(node, true);
  }

  _compileAsyncCallExtension(node, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var resolveArgs = node.resolveArgs;
    const positionNode = args || node;

    const emitCallArgs = (extId) => {
      if ((args && args.children.length) || contentArgs.length) {
        this.emit(',');
      }

      if (args) {
        if (!(args instanceof nodes.NodeList)) {
          this.fail('compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`', node.lineno, node.colno, node);
        }

        args.children.forEach((arg, i) => {
          if (!resolveArgs) {
            this.emit('runtime.normalizeFinalPromise(');
            this._compileExpression(arg, null);
            this.emit(')');
          } else {
            this._compileExpression(arg, null);
          }

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
            if (!resolveArgs) {
              this.emit('runtime.normalizeFinalPromise(');
              this.emit._compileAsyncRenderBoundary(node, function () {
                this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, null);
              }, arg);
              this.emit(')');
            } else {
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit._compileAsyncCallbackRenderBoundary(node, function () {
                  this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                  this.compile(arg, null);
                }, 'cb', arg);
                this.emit.line(';');
              });

              this.emit.line('}');
            }
          } else {
            this.emit('null');
          }
        });
      }
    };

    const ext = this._tmpid();
    this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
    const returnId = this._tmpid();
    this.emit(`let ${returnId} = `);
    if (!async) {
      if (!resolveArgs) {
        this.emit(`${ext}["${node.prop}"](context`);
      } else {
        this.emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
      }
    } else {
      if (!resolveArgs) {
        this.emit(`runtime.invokeCallbackExtension(${ext}["${node.prop}"].bind(${ext}), context`);
      } else {
        this.emit(`runtime.resolveArguments(runtime.invokeCallbackExtension, 2)(${ext}["${node.prop}"].bind(${ext}), context`);
      }
    }
    emitCallArgs(ext);
    this.emit(')');
    this.emit.line(';');
    const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, positionNode, true);
    this.emit.line(`${this.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.buffer.currentTextChannelName}");`);
    this.buffer.emitLimitedLoopCompletion(returnId, positionNode);
  }

  analyzeCallAssign(node, analysisPass) {
    return this.assignment.analyzeSet(node, analysisPass);
  }

  postAnalyzeCallAssign(node) {
    return this.assignment.postAnalyzeSet(node);
  }

  compileCallAssign(node) {
    this.assignment.compileSet(node);
  }

  analyzeSet(node, analysisPass) {
    return this.assignment.analyzeSet(node, analysisPass);
  }

  postAnalyzeSet(node) {
    return this.assignment.postAnalyzeSet(node);
  }

  compileSet(node) {
    this.assignment.compileSet(node);
  }

  _analyzeLoopNodeDeclarations(node, analysisPass, declarationsInBody = false) {
    if (node.name instanceof nodes.Symbol) {
      node.name._analysis = { ...node.name._analysis, declarationTarget: true };
    } else if (node.name instanceof nodes.Array || node.name instanceof nodes.NodeList) {
      node.name.children.forEach((child) => {
        child._analysis = { ...child._analysis, declarationTarget: true };
      });
    }
    const declares = [];
    const declaredNames = analysisPass.extractSymbols(node.name);
    declaredNames.forEach((name) => {
      declares.push({ name, type: 'var', initializer: null });
    });
    if (!declaredNames.includes('loop')) {
      declares.push({ name: 'loop', type: 'var', initializer: null, internal: true, isLoopMeta: true });
    }
    if (node.concurrentLimit) {
      node.body._analysis = {
        ...node.body._analysis,
        waitedChannelName: node.body._analysis?.waitedChannelName ?? `__waited__${this._tmpid()}`
      };
    }
    if (declarationsInBody) {
      node.body._analysis = { ...node.body._analysis, createScope: true, loopOwner: node, declares };
      if (node.else_) {
        node.else_._analysis = { ...node.else_._analysis, createScope: true };
      }
      return { createsLinkedChildBuffer: true };
    }
    return { createScope: true, declares, createsLinkedChildBuffer: true };
  }

  analyzeWhile(node, analysisPass) {
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass);
    if (node.body) {
      node.body._analysis = {
        ...node.body._analysis,
        waitedChannelName: node.body._analysis?.waitedChannelName ?? `__waited__${this._tmpid()}`
      };
    }
    return result;
  }

  compileWhile(node) {
    this.loop.compileAsyncWhile(node);
  }

  analyzeFor(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileFor(node) {
    this.loop.compileAsyncFor(node);
  }

  analyzeAsyncEach(node, analysisPass) {
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass, true);
    if (node.body) {
      node.body._analysis = {
        ...node.body._analysis,
        waitedChannelName: node.body._analysis?.waitedChannelName ?? `__waited__${this._tmpid()}`
      };
    }
    return result;
  }

  compileAsyncEach(node) {
    this.loop.compileAsyncEach(node);
  }

  analyzeAsyncAll(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileAsyncAll(node) {
    this.loop.compileAsyncAll(node);
  }

  analyzeSwitch(node) {
    if (node.default) {
      node.default._analysis = { createScope: true };
    }
    return { createsLinkedChildBuffer: true };
  }

  postAnalyzeSwitch(node) {
    const allChannels = new Set();
    node.cases.forEach((c) => {
      this.analysis.getChannelsUsedFromParent(c.body).forEach(ch => allChannels.add(ch));
    });
    if (node.default) {
      this.analysis.getChannelsUsedFromParent(node.default).forEach(ch => allChannels.add(ch));
    }
    return {
      poisonChannels: Array.from(allChannels)
    };
  }

  compileSwitch(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      let catchPoisonPos;

      this.emit('try {');
      this.emit('const switchResult = ');
      this._compileAwaitedExpression(node.expr, null);
      this.emit(';');
      this.emit('');
      this.emit('switch (switchResult) {');

      node.cases.forEach((c) => {
        this.emit('case ');
        this._compileAwaitedExpression(c.cond, null);
        this.emit(': ');

        if (c.body.children.length) {
          this.compile(c.body, null);
          this.emit.line('break;');
        }
      });

      if (node.default) {
        this.emit('default: ');
        this.compile(node.default, null);
      }

      this.emit('}');

      const errorCtx = this._createErrorContext(node, node.expr);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorCtx.lineno}, ${errorCtx.colno}, "${errorCtx.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');

      for (const channelName of (node._analysis.poisonChannels ?? [])) {
        this.emit.insertLine(
          catchPoisonPos,
          `    ${this.buffer.currentBuffer}.addCommand(new runtime.ErrorCommand(Array.isArray(contextualError) ? contextualError : [contextualError]), "${channelName}");`
        );
      }
    });
  }

  analyzeCase(node) {
    return { createScope: true };
  }

  analyzeGuard(node) {
    return this.guard.analyzeGuard(node);
  }

  postAnalyzeGuard(node) {
    return this.guard.postAnalyzeGuard(node);
  }

  compileGuard(node) {
    this.guard.compileGuard(node);
  }

  analyzeIf(node) {
    node.body._analysis = { createScope: true };
    if (node.else_) {
      node.else_._analysis = { createScope: true };
    }
    return { createsLinkedChildBuffer: true };
  }

  analyzeIfAsync(node) {
    return this.analyzeIf(node);
  }

  postAnalyzeIf(node) {
    const trueBranchChannels = this.analysis.getChannelsUsedFromParent(node.body);
    const falseBranchChannels = node.else_
      ? this.analysis.getChannelsUsedFromParent(node.else_)
      : new Set();
    return {
      poisonChannels: Array.from(new Set([...trueBranchChannels, ...falseBranchChannels]))
    };
  }

  compileIf(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      let catchPoisonPos;
      const condResultId = this._tmpid();

      this.emit('try {');
      this.emit(`const ${condResultId} = `);
      this._compileAwaitedExpression(node.cond, null);
      this.emit(';');
      this.emit('');
      this.emit(`if (${condResultId}) {`);
      this.compile(node.body, null);
      this.emit('} else {');
      if (node.else_) {
        this.compile(node.else_, null);
      }
      this.emit('}');

      const errorContext = this._createErrorContext(node, node.cond);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContext.lineno}, ${errorContext.colno}, "${errorContext.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');

      for (const channelName of (node._analysis.poisonChannels ?? [])) {
        this.emit.insertLine(
          catchPoisonPos,
          `    ${this.buffer.currentBuffer}.addCommand(new runtime.ErrorCommand(Array.isArray(contextualError) ? contextualError : [contextualError]), "${channelName}");`
        );
      }
    });
  }

  analyzeCapture(node) {
    if (this.scriptMode) {
      this.fail('Capture blocks are only supported in template mode', node.lineno, node.colno, node);
    }
    const textOutput = `${CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL}${this._tmpid()}`;
    return {
      createScope: true,
      scopeBoundary: false,
      declares: [{ name: textOutput, type: 'text', initializer: null, internal: true }],
      textOutput,
      createsLinkedChildBuffer: true
    };
  }

  compileCapture(node) {
    this.boundaries.compileCaptureBoundary(
      this.buffer,
      node,
      function() {
        this.compile(node.body, null);
      },
      node.body
    );
  }

  analyzeOutput(node) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared channels and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textChannel = !this.scriptMode
      ? this.analysis.getCurrentTextChannel(node._analysis)
      : null;
    return this.scriptMode ? {}
      : {
        uses: [textChannel],
        mutates: [textChannel],
        // Output is analyzed as one source-order text slot even though
        // compileOutput emits per-child text boundaries. The aggregate link set
        // keeps every child expression attached to the channels needed by the
        // full output slot.
        createsLinkedChildBuffer: true
      };
  }

  compileOutput(node) {
    const textChannelName = this.buffer.currentTextChannelName;
    node.children.forEach((child) => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, null, function() {
            this.compileLiteral(child, null);
          }, child, textChannelName, true);
        }
        return;
      }
      if (child._analysis?.mutatedChannels?.size > 0) {
        // The boundary is emitted for this mutating child expression, but the
        // link metadata comes from the parent Output aggregate so all child
        // boundaries participate in the same source-order text slot.
        this.boundaries.compileAsyncTextBoundary(
          this.buffer,
          node,
          child,
          () => {
            this.compileExpression(child, null, child);
          },
          { emitInCurrentBuffer: true }
        );
      } else {
        const returnId = this._tmpid();
        this.emit.line(`let ${returnId};`);
        this.emit(`${returnId} = `);
        this.compileExpression(child, null, child);
        this.emit.line(';');
        const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, child, true);
        this.emit.line(`${this.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${textChannelName}");`);
      }
    });
  }

  compileDo(node) {
    node.children.forEach((child) => {
      this.compileExpression(child, null, child);
      this.emit.line(';');
    });
  }

  analyzeReturn() {
    return this.return.analyzeStatement();
  }

  compileReturn(node) {
    this.return.compileStatement(node);
  }

  analyzeMacro(node) {
    return this.macro.analyzeMacro(node);
  }

  compileMacro(node) {
    this.macro.compileAsyncMacro(node);
  }

  analyzeImport(node) {
    node.target._analysis = { ...node.target._analysis, declarationTarget: true };
    this.importedBindings.add(node.target.value);
    return {
      declares: [{ name: node.target.value, type: 'var', initializer: null, imported: true }]
    };
  }

  compileImport(node) {
    this.composition.compileAsyncImport(node);
  }

  analyzeComponent(node) {
    this.inheritance.recordComponentOperation(node);
    return this.component.analyzeComponent(node);
  }

  compileComponent(node) {
    this.component.compileComponent(node);
  }

  analyzeFromImport(node) {
    const declares = [];
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        nameNode.value._analysis = { ...nameNode.value._analysis, declarationTarget: true };
        this.importedBindings.add(nameNode.value.value);
        declares.push({ name: nameNode.value.value, type: 'var', initializer: null, imported: true });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode._analysis = { ...nameNode._analysis, declarationTarget: true };
        this.importedBindings.add(nameNode.value);
        declares.push({ name: nameNode.value, type: 'var', initializer: null, imported: true });
      }
    });
    return { declares };
  }

  compileFromImport(node) {
    this.composition.compileAsyncFromImport(node);
  }

  analyzeBlock(node) {
    return this.inheritance.analyzeBlock(node);
  }

  postAnalyzeBlock(node) {
    return this.inheritance.postAnalyzeCallableDefinition(node);
  }

  compileBlock(node) {
    this.inheritance.compileBlock(node);
  }

  compileSuper(node) {
    this.inheritance.compileSuper(node);
  }

  analyzeSuper(node) {
    this.inheritance.analyzeSuper(node);
  }

  analyzeChannelDeclaration(node) {
    return this.channel.analyzeChannelDeclaration(node);
  }

  compileChannelDeclaration(node) {
    this.channel.compileChannelDeclaration(node);
  }

  analyzeChannelCommand(node) {
    return this.channel.analyzeChannelCommand(node);
  }

  compileChannelCommand(node) {
    this.channel.compileChannelCommand(node);
  }

  analyzeExtends(node) {
    const inheritanceAnalysis = this.inheritance.analyzeExtends(node);
    if (this.scriptMode) {
      return inheritanceAnalysis;
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return {
      ...inheritanceAnalysis,
      uses: textChannel ? [textChannel] : [],
      mutates: textChannel ? [textChannel] : []
    };
  }

  compileExtends(node) {
    this.inheritance.compileExtends(node);
  }

  analyzeInclude(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return {
      uses: textChannel ? [textChannel] : [],
      mutates: textChannel ? [textChannel] : [],
      createsLinkedChildBuffer: true
    };
  }

  compileInclude(node) {
    this.composition.compileAsyncInclude(node);
  }

  analyzeRoot(node) {
    const inheritanceAnalysis = this.inheritance.analyzeRoot(node);
    const declares = this._getRootDeclarations(node);
    const sequenceLocks = node._analysis.sequenceLocks ?? [];
    sequenceLocks.forEach((lockName) => {
      declares.push({ name: lockName, type: 'sequential_path', initializer: null });
    });
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
      textOutput: this._getRootTextOutput(),
      ...inheritanceAnalysis
    };
  }

  postAnalyzeRoot(node) {
    const inheritanceFacts = this.inheritance.computeRootInheritanceFacts(node);
    validateScriptExtendsSourceOrder(this, node);
    validateScriptExtendsExpression(this, node);
    validateTemplateInheritanceSurface(this, node);
    return {
      inheritance: inheritanceFacts
    };
  }

  compileRoot(node) {
    const rootCompileResult = this._compileAsyncRoot(node);
    if (!node._analysis.inheritance.participates) {
      this.emit.line('return { root };');
      return;
    }

    this.inheritance.compileParticipantRootExport(node, rootCompileResult);
  }

  _getRootDeclarations(node) {
    const declares = [];
    if (this.scriptMode) {
      declares.push(this.return.createChannelDeclaration());
    } else {
      declares.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL, type: 'text', initializer: null });
    }
    return declares;
  }

  _getRootTextOutput() {
    return this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;
  }

  _emitRootBufferSetup(node) {
    this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
    if (this.scriptMode) {
      this.return.emitDeclareChannel(this.buffer.currentBuffer);
    }
    const sequenceLocks = node._analysis.sequenceLocks ?? [];
    for (const name of sequenceLocks) {
      this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
    }
    this.inheritance.emitRootSharedDeclarations(node);
  }

  _emitRootResult(node) {
    this.emit.line(';(async () => {');
    if (this.scriptMode) {
      const returnVar = this._tmpid();
      this.return.emitFinalSnapshot(this.buffer.currentBuffer, returnVar);
      this.emit.line(`  ${this.buffer.currentBuffer}.finish();`);
      this.emit.line(`  await ${this.buffer.currentBuffer}.getFinishedPromise();`);
      this.emit.line(`  cb(null, runtime.normalizeFinalPromise(${returnVar}));`);
    } else {
      this.emit.line(`  ${this.buffer.currentBuffer}.finish();`);
      this.emit.line(`  const textResult = await ${this.buffer.currentTextChannelVar}.finalSnapshot();`);
      this.emit.line('  cb(null, textResult);');
    }
    this.emit.line('})().catch(e => {');
    this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`);
    this.emit.line('  cb(err);');
    this.emit.line('});');
  }

  _compilePlainAsyncRootBody(node) {
    this._emitRootBufferSetup(node);
    this._compileChildren(node, null);
    this._emitRootResult(node);
    this.emit.line(`return ${this.buffer.currentBuffer};`);
  }

  _compileParticipantAsyncRootBody(node) {
    this.inheritance.compileParticipantRootBody(node);
  }

  _compileAsyncRoot(node) {
    const inheritanceParticipates = node._analysis.inheritance.participates;
    this.emit.beginEntryFunction(node, 'root');
    if (inheritanceParticipates) {
      this._compileParticipantAsyncRootBody(node);
    } else {
      this._compilePlainAsyncRootBody(node);
    }
    this.emit.endEntryFunction(node, true);
    if (!inheritanceParticipates) {
      return { blocks: [], constructorEntry: null };
    }
    this.inBlock = true;
    const constructorEntry = this.inheritance.compileConstructorEntry(node);
    const blocks = this.inheritance.compileInheritedCallableEntries(node);
    return { blocks, constructorEntry };
  }

  _compileExpressionToString(node) {
    return this.emit.capture(() => {
      this.compileExpression(node, null, node, true);
    });
  }

  analyzeMethodDefinition(node) {
    return this.inheritance.analyzeMethodDefinition(node);
  }

  postAnalyzeMethodDefinition(node) {
    return this.inheritance.postAnalyzeCallableDefinition(node);
  }

  compileMethodDefinition() {
    // Method definitions are compiled through metadata and dedicated callable
    // entries, not by inline root-body emission.
  }
}

export {CompilerAsync};
