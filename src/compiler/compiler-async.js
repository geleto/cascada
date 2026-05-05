
import * as nodes from '../nodes.js';

import {
  validateScriptExtendsSourceOrder,
  validateLocalSharedMethodNameCollisions,
} from './validation.js';

import {CompilerBaseAsync} from './compiler-base-async.js';
import {CompileBuffer} from './buffer.js';
import {CompileGuard} from './guard.js';
import {CompileAssignment} from './assignment.js';
import {ROOT_STARTUP_PROMISE_VAR} from './inheritance.js';

const COMPILED_METHODS_VAR = '__compiledMethods';
const COMPILED_SHARED_SCHEMA_VAR = '__compiledSharedSchema';
const COMPILED_INVOKED_METHODS_VAR = '__compiledInvokedMethods';

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
        this.emit(`b___promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
      } else {
        this.emit(`runtime.resolveArguments(b___promisify(${ext}["${node.prop}"].bind(${ext})), 1)(context`);
      }
    }
    emitCallArgs(ext);
    this.emit(')');
    this.emit.line(';');
    const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, positionNode, true);
    this.emit.line(`${this.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.buffer.currentTextChannelName}");`);
  }

  analyzeCallAssign(node, analysisPass) {
    return this.assignment.analyzeSet(node, analysisPass);
  }

  postAnalyzeCallAssign(node) {
    return this.assignment.postAnalyzeSet(node);
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

  compileCallAssign(node) {
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

  analyzeCase(node) {
    return { createScope: true };
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
    this.inheritance.compileAsyncImport(node);
  }

  analyzeComponent(node) {
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
    this.inheritance.compileAsyncFromImport(node);
  }

  analyzeBlock(node) {
    const signature = this.inheritance.getBlockSignature(node);
    const declares = [];
    const seenBlockArgNames = new Set();
    signature.argNodes.forEach((nameNode, index) => {
      nameNode._analysis = { ...nameNode._analysis, skipDeclarationOwner: node._analysis };
      const canonicalName = signature.argNames[index];
      if (seenBlockArgNames.has(canonicalName)) {
        this.fail(
          `block argument '${canonicalName}' is declared more than once`,
          nameNode.lineno,
          nameNode.colno,
          node,
          nameNode
        );
      }
      seenBlockArgNames.add(canonicalName);
      declares.push({
        name: canonicalName,
        type: 'var',
        initializer: null,
        explicit: true,
        blockArg: true
      });
    });
    if (declares.length > 0 && node.body) {
      node.body._analysis = {
        ...node.body._analysis,
        declares: (node.body._analysis?.declares ?? []).concat(declares)
      };
    }
    return {
      createScope: true,
      scopeBoundary: false,
      parentReadOnly: true,
      createsLinkedChildBuffer: true
    };
  }

  compileBlock(node) {
    this.inheritance.compileAsyncBlock(node);
  }

  postAnalyzeBlock(node) {
    return this.inheritance.createMethodChannelFootprint(node);
  }

  compileSuper(node) {
    this.inheritance.compileAsyncSuper(node);
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
    if (this.scriptMode) {
      return { createsLinkedChildBuffer: true };
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return {
      uses: textChannel ? [textChannel] : [],
      mutates: textChannel ? [textChannel] : [],
      createsLinkedChildBuffer: true
    };
  }

  compileExtends(node) {
    this.inheritance.compileAsyncExtends(node);
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
    this.inheritance.compileAsyncInclude(node);
  }

  postAnalyzeRoot(node) {
    const rootCompileFacts = this._getRootCompileFacts(node);
    validateScriptExtendsSourceOrder(this, node);
    validateLocalSharedMethodNameCollisions(this, node);
    return {
      rootCompileFacts
    };
  }

  _emitRootCompositionPayloadInitialization(node) {
    const skippedNames = Object.create(null);
    this._getRootDeclarations(node).forEach((declaration) => {
      skippedNames[declaration.name] = true;
    });
    this._getSharedDeclarations(node).forEach((declaration) => {
      skippedNames[declaration.name.value] = true;
    });
    this.emit.line(`runtime.declareCompositionPayloadChannels(${this.buffer.currentBuffer}, context, ${JSON.stringify(skippedNames)});`);
  }

  analyzeRoot(node) {
    const declares = this._getRootDeclarations(node);
    const templateUsesInheritanceSurface = !this.scriptMode && this._templateUsesInheritanceSurface(node);
    this.templateUsesInheritanceSurface = templateUsesInheritanceSurface;
    if (templateUsesInheritanceSurface) {
      const inferredTemplateSharedDeclarations = this._collectInferredTemplateSharedDeclarations(node);
      node._analysis.inferredTemplateSharedDeclarations = inferredTemplateSharedDeclarations;
      inferredTemplateSharedDeclarations.forEach((declaration) => {
        declares.push({
          name: declaration.name.value,
          type: 'var',
          initializer: null,
          shared: true
        });
      });
    }
    const sequenceLocks = node._analysis.sequenceLocks ?? [];
    sequenceLocks.forEach((lockName) => {
      declares.push({ name: lockName, type: 'sequential_path', initializer: null });
    });
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
      textOutput: this._getRootTextOutput()
    };
  }

  _templateUsesInheritanceSurface(rootNode) {
    if (this.scriptMode || !rootNode || typeof rootNode.findAll !== 'function') {
      return false;
    }
    return rootNode.findAll(nodes.Extends).length > 0 || rootNode.findAll(nodes.Block).length > 0;
  }

  _collectInferredTemplateSharedDeclarations(rootNode) {
    const calleeNodes = new Set();
    rootNode.findAll(nodes.FunCall).forEach((callNode) => {
      if (callNode && callNode.name) {
        calleeNodes.add(callNode.name);
      }
    });

    const inferred = new Map();
    rootNode.findAll(nodes.LookupVal).forEach((lookupNode) => {
      if (
        lookupNode.target instanceof nodes.Symbol &&
        lookupNode.target.value === 'this' &&
        !(lookupNode.val instanceof nodes.Literal && typeof lookupNode.val.value === 'string')
      ) {
        this.fail(
          'Dynamic this[...] shared access is not supported in templates.',
          lookupNode.lineno,
          lookupNode.colno,
          lookupNode
        );
      }
      if (calleeNodes.has(lookupNode)) {
        return;
      }
      const staticPath = this.sequential._extractStaticPath(lookupNode);
      if (!staticPath || staticPath.length < 2 || staticPath[0] !== 'this') {
        return;
      }
      const name = staticPath[1];
      if (inferred.has(name)) {
        return;
      }
      const nameNode = new nodes.Symbol(lookupNode.lineno, lookupNode.colno, name);
      const declaration = new nodes.ChannelDeclaration(lookupNode.lineno, lookupNode.colno, 'var', nameNode, null, true);
      inferred.set(name, declaration);
    });
    return Array.from(inferred.values());
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

  _getRootCompileFacts(node) {
    const extendsNodes = node.findAll(nodes.Extends).filter((child) => !child.noParentLiteral);
    const topLevelDynamicExtends = new Set(
      node.children.filter((child) => this._isDynamicExtendsNode(child))
    );
    const hasStaticExtends = node.children.some((child) => this._isStaticExtendsNode(child));
    const hasDynamicExtends = extendsNodes.some((child) => this._isDynamicExtendsNode(child));
    const hasDeferredDynamicExtends = extendsNodes.some((child) =>
      this._isDynamicExtendsNode(child) && !topLevelDynamicExtends.has(child)
    );
    const hasExtends = hasStaticExtends || hasDynamicExtends;
    const constructorDefinition = this._getConstructorDefinition(node);
    const methodDefinitions = this.scriptMode ? this._getMethodDefinitions(node) : node.findAll(nodes.Block);
    const callableDefinitions = constructorDefinition
      ? methodDefinitions.concat([constructorDefinition])
      : methodDefinitions;
    const invokedMethodRefs = this.inheritance.collectAllInvokedMethodRefsFromNode(node);
    const needsInheritanceState =
      hasExtends ||
      this._getSharedDeclarations(node).length > 0 ||
      callableDefinitions.length > 0 ||
      Object.keys(invokedMethodRefs).length > 0;

    return {
      topLevelDynamicExtends,
      hasStaticExtends,
      hasDynamicExtends,
      hasDeferredDynamicExtends,
      hasExtends,
      needsInheritanceState,
      invokedMethodRefs
    };
  }

  _compileAsyncRootBody(node) {
    this.inheritance.emitAsyncRootStateInitialization(
      COMPILED_METHODS_VAR,
      COMPILED_SHARED_SCHEMA_VAR,
      COMPILED_INVOKED_METHODS_VAR
    );
    this.emit.line(`let ${ROOT_STARTUP_PROMISE_VAR} = null;`);
    this.emit.line(`const extendsState = ${(!this.scriptMode && this.hasDynamicExtends) ? '{ parentSelection: null }' : 'null'};`);
    this.emit.line(`${ROOT_STARTUP_PROMISE_VAR} = runtime.runCompiledRootStartup({`);
    this.emit.line('  setup: b___setup__,');
    this.emit.line(`  compiledMethods: ${COMPILED_METHODS_VAR},`);
    this.emit.line('  inheritanceState,');
    this.emit.line('  env,');
    this.emit.line('  context,');
    this.emit.line('  runtime,');
    this.emit.line('  cb,');
    this.emit.line(`  output: ${this.buffer.currentBuffer},`);
    this.emit.line(`  extendsState: ${this.scriptMode ? 'null' : 'extendsState'},`);
    this.emit.line('  options: { resolveExports: true }');
    this.emit.line('});');
    this.inheritance.emitAsyncRootCompletion(node);
  }

  _getGenericScriptBodySource(node) {
    if (!this.scriptMode) {
      return null;
    }
    const constructorDefinition = this._getConstructorDefinition(node);
    if (constructorDefinition && constructorDefinition.body) {
      return constructorDefinition.body;
    }
    if (this.hasExtends) {
      return null;
    }
    return node;
  }

  _compileAsyncScriptBodyEntry(node) {
    if (!this.scriptMode) {
      return false;
    }

    const bodySource = this._getGenericScriptBodySource(node);
    if (!bodySource) {
      return false;
    }

    this.inheritance._withAsyncConstructorEntryState(false, () => {
      this.emit.line('function b___scriptBody__(env, context, runtime, cb, output, inheritanceState = null, extendsState = null) {');
      this.emit.line('try {');
      this.emit.line(`let ${ROOT_STARTUP_PROMISE_VAR} = null;`);
      this._compileChildren(bodySource, null);
      this.emit.line(`return ${ROOT_STARTUP_PROMISE_VAR};`);
      this.emit.closeScopeLevels();
      this.emit.line('} catch (e) {');
      this.emit.line(`  throw runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`);
      this.emit.line('}');
      this.emit.line('}');
    });

    return true;
  }

  _compileAsyncRootSetupEntry(node, hasGenericScriptBody = false) {
    const isTemplateRoot = !this.scriptMode;
    const skipGenericSetup = this.scriptMode && this._getConstructorDefinition(node);

    this.inheritance._withAsyncConstructorEntryState(isTemplateRoot, () => {
      this.emit.line('function b___setup__(env, context, runtime, cb, output, inheritanceState = null, extendsState = null) {');
      this.emit.line('try {');
      this.emit.line(`let ${ROOT_STARTUP_PROMISE_VAR} = null;`);
      if (isTemplateRoot) {
        this.emit.line(`let ${this.buffer.currentTextChannelVar} = output.getChannel("${this.buffer.currentTextChannelName}");`);
        this.emit.line(`${this.buffer.currentBuffer}._context = context;`);
        this.emit.line(`${this.buffer.currentTextChannelVar}._context = context;`);
      }
      this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
      if (this.scriptMode) {
        this.return.emitDeclareChannel(this.buffer.currentBuffer);
      }
      const sequenceLocks = node._analysis.sequenceLocks ?? [];
      for (const name of sequenceLocks) {
        this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
      }
      this._emitRootCompositionPayloadInitialization(node);
      this.inheritance.emitRootSharedDeclarations(node);
      if (this.scriptMode && hasGenericScriptBody && !skipGenericSetup) {
        this.emit.line(`__rootStartupPromise = b___scriptBody__(env, context, runtime, cb, output, inheritanceState, extendsState);`);
      } else {
        this._compileChildren(node, null);
      }
      this.emit.line(`return ${ROOT_STARTUP_PROMISE_VAR};`);
      this.emit.closeScopeLevels();
      this.emit.line('} catch (e) {');
      this.emit.line(`  throw runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`);
      this.emit.line('}');
      this.emit.line('}');
    });
  }

  _compileAsyncRoot(node) {
    this.emit.beginEntryFunction(node, 'root');
    this._compileAsyncRootBody(node);
    this.emit.endEntryFunction(node, true);
    this.inBlock = true;
    const hasGenericScriptBody = this._compileAsyncScriptBodyEntry(node);
    this._compileAsyncRootSetupEntry(node, hasGenericScriptBody);
    this.inheritance.compileAsyncConstructorEntry(node);
    const blocks = this.inheritance.compileAsyncBlockEntries(node);
    return { blocks, hasGenericScriptBody };
  }

  compileRoot(node) {
    if (node.findAll(nodes.CallExtensionAsync).length > 0) {
      this.emit.lines(
        'function b___promisify(fn) {',
        '  return function(...args) {',
        '    return new Promise((resolvePromise, reject) => {',
        '      const callback = (error, ...results) => {',
        '        if (error) {',
        '          reject(error);',
        '        } else {',
        '          resolvePromise(results.length === 1 ? results[0] : results);',
        '        }',
        '      };',
        '      fn(...args, callback);',
        '    });',
        '  };',
        '}'
      );
    }

    const rootCompileFacts = node._analysis.rootCompileFacts;
    this.topLevelDynamicExtends = rootCompileFacts.topLevelDynamicExtends;
    this.hasStaticExtends = rootCompileFacts.hasStaticExtends;
    this.hasDynamicExtends = rootCompileFacts.hasDynamicExtends;
    this.hasDeferredDynamicExtends = rootCompileFacts.hasDeferredDynamicExtends;
    this.hasExtends = rootCompileFacts.hasExtends;
    this.needsInheritanceState = rootCompileFacts.needsInheritanceState;
    const rootCompileResult = this._compileAsyncRoot(node);
    const invokedMethods = this.inheritance.compileInvokedMethodsLiteral(rootCompileFacts.invokedMethodRefs);
    const methods = this.inheritance.collectCompiledMethods(node, rootCompileResult.blocks);

    this.emit.line(`const ${COMPILED_METHODS_VAR} = ${methods};`);
    this.emit.line(`const ${COMPILED_SHARED_SCHEMA_VAR} = ${this.inheritance.compileSharedSchemaLiteral(node)};`);
    this.emit.line(`const ${COMPILED_INVOKED_METHODS_VAR} = ${invokedMethods};`);
    this.emit.line('return {');
    this.emit.line('inheritanceSpec: {');
    this.emit.line('  setup: b___setup__,');
    this.emit.line(`  methods: ${COMPILED_METHODS_VAR},`);
    this.emit.line(`  sharedSchema: ${COMPILED_SHARED_SCHEMA_VAR},`);
    this.emit.line(`  invokedMethods: ${COMPILED_INVOKED_METHODS_VAR},`);
    this.emit.line(`  hasExtends: ${this.hasExtends ? 'true' : 'false'}`);
    this.emit.line('},');
    this.emit.line('root: root\n};');
  }

  _compileExpressionToString(node) {
    return this.emit.capture(() => {
      this.compileExpression(node, null, node, true);
    });
  }

  analyzeMethodDefinition(node) {
    const analysis = this.analyzeBlock(node);
    if (node && node.isSyntheticConstructor) {
      analysis.parentReadOnly = false;
    }
    analysis.declares = (analysis.declares ?? []).concat([
      this.return.createChannelDeclaration()
    ]);
    return analysis;
  }

  compileMethodDefinition() {
    // Method definitions are compiled through upfront metadata and dedicated
    // async entry functions, not by inline root-body emission.
  }

  postAnalyzeMethodDefinition(node) {
    return this.inheritance.createMethodChannelFootprint(node);
  }
}

export {CompilerAsync};
