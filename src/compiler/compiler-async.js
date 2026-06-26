
import * as nodes from '../language/nodes.js';

import {
  validateScriptExtendsSourceOrder,
  validateScriptExtendsExpression,
  validateTemplateInheritanceSurface,
} from './validation.js';

import {CompilerBaseAsync} from './compiler-base-async.js';
import {CompileBuffer} from './buffer.js';
import {WAITED_CHAIN_NAME} from './reserved.js';
import {DECLARATION_IMPORT_KIND} from './declarations.js';

class CompilerAsync extends CompilerBaseAsync {
  init(sourcePath, options) {
    super.init({ ...options, asyncMode: true, sourcePath });
  }

  analyzeCallExtension(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChain = this.analysis.getCurrentTextChain(node._analysis);
    return textChain
      ? { mutates: [textChain] }
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

  postAnalyzeDo(node) {
    if (this.scriptMode) {
      return {};
    }
    if (node.findAll(nodes.FunCall).length > 0) {
      return {};
    }
    const hasSequenceRepair = node.findAll(nodes.Symbol).some(child => child._analysis.sequenceLockLookup?.repair) ||
      node.findAll(nodes.LookupVal).some(child => child._analysis.sequenceLockLookup?.repair);
    if (!hasSequenceRepair) {
      this.fail(
        'The do tag must contain at least one function call or sequence repair.',
        node.lineno,
        node.colno,
        node
      );
    }
    return {};
  }

  _compileAsyncCallExtension(node, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var resolveArgs = node.resolveArgs;
    const positionNode = args || node;

    const emitExtensionArgs = () => {
      if ((args && args.children.length) || contentArgs.length) {
        this.emit(',');
      }

      emitArgs();
    };

    const emitArgs = () => {
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
                this.compile(arg, null);
              }, arg);
              this.emit(')');
            } else {
              // External/Nunjucks-compatible adapter callback, kept as cb.
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit._compileAsyncCallbackRenderBoundary(node, function () {
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

    const emitCallPrefix = () => {
      if (!async) {
        this.emit(`${ext}["${node.prop}"](context`);
      } else {
        this.emit(`runtime.invokeCallbackExtension(${ext}["${node.prop}"].bind(${ext}), context`);
      }
    };

    const ext = this._tmpid();
    this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
    const returnId = this._tmpid();
    const errorContext = this.emitErrorContext(positionNode);
    this.emit.line(`let ${returnId};`);
    this.emit(`try { ${returnId} = `);
    if (resolveArgs) {
      this.emit('runtime.thenValue(runtime.resolveAll([');
      emitArgs();
      this.emit(']), (resolvedArgs) => { try { return ');
      emitCallPrefix();
      this.emit(', ...resolvedArgs); } catch (e) { return Promise.reject(e); } })');
    } else {
      emitCallPrefix();
      emitExtensionArgs();
      this.emit(')');
    }
    this.emit.line('; } catch (e) {');
    this.emit.line('  if (!runtime.isPoisonError(e) && !runtime.isRuntimeError(e)) {');
    this.emit.line(`    runtime.RuntimeError.reportAndThrow(e, ${errorContext});`);
    this.emit.line('  }');
    this.emit.line('  throw e;');
    this.emit.line('}');
    this.emit.line(`${returnId} = runtime.valueWithOrigin(${returnId}, ${errorContext}, "UserCallThrew");`);
    const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, positionNode, true);
    this.emit.line(`${this.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.buffer.currentTextChainName}");`);
    this.buffer.emitLimitedLoopCompletion(returnId, positionNode);
  }

  _collectLoopDeclarationFacts(node, analysisPass, declarationsInBody = false) {
    if (node.name instanceof nodes.Symbol) {
      node.name.addAnalysis({ isSymbolTarget: true });
    } else if (node.name instanceof nodes.Array || node.name instanceof nodes.NodeList) {
      node.name.children.forEach((child) => {
        child.addAnalysis({ isSymbolTarget: true });
      });
    }
    const declareOnEnter = [];
    const declaredNames = analysisPass.extractSymbols(node.name);
    declaredNames.forEach((name) => {
      declareOnEnter.push({ name, type: 'var', initializer: null, loopVariable: true });
    });
    if (declarationsInBody) {
      node.body.addAnalysis({
        createScope: true,
        loopOwner: node,
        declareOnEnter
      });
      if (node.else_) {
        node.else_.addAnalysis({ createScope: true });
      }
      return { createScope: true, wantsLinkedChildBuffer: true };
    }
    return { createScope: true, declareOnEnter, wantsLinkedChildBuffer: true };
  }

  _createWaitedChainFacts() {
    return {
      declareOnEnter: [{ name: WAITED_CHAIN_NAME, type: 'var', initializer: null, internal: true }],
      mutates: [WAITED_CHAIN_NAME]
    };
  }

  analyzeWhile(node) {
    node.body.addAnalysis({
      createScope: true,
      declareOnEnter: [{ name: 'iterationCount', type: 'var', initializer: null, internal: true }]
    });
    this.analysis.addCommandFacts(node.body, { mutated: ['iterationCount'] });
    node.cond.addAnalysis({ errorContextLabel: 'While.Condition' });
    return {
      ...this._createWaitedChainFacts(),
      createScope: true,
      wantsLinkedChildBuffer: true
    };
  }

  analyzeFor(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    const facts = this._collectLoopDeclarationFacts(node, analysisPass, true);
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
      return {
        ...facts,
        ...this._createWaitedChainFacts()
      };
    }
    return facts;
  }

  analyzeAsyncEach(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
    }
    const result = this._collectLoopDeclarationFacts(node, analysisPass, true);
    return {
      ...result,
      ...this._createWaitedChainFacts()
    };
  }

  analyzeAsyncAll(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    const facts = this._collectLoopDeclarationFacts(node, analysisPass, true);
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
      return {
        ...facts,
        ...this._createWaitedChainFacts()
      };
    }
    return facts;
  }

  analyzeSwitch(node) {
    node.expr.addAnalysis({ errorContextLabel: 'Switch.Expression' });
    node.cases.forEach((c) => {
      c.cond.addAnalysis({ errorContextLabel: 'Switch.Case' });
    });
    if (node.default) {
      node.default.addAnalysis({ createScope: true });
    }
    return { wantsLinkedChildBuffer: true };
  }

  compileSwitch(node) {
    this.boundaries.compileAsyncControlFlowBoundary(this.buffer, node, () => {
      const poisonTargetChains = this._getSkippedRegionPoisonChains(
        [...node.cases.map(c => c.body), node.default]
      );
      const switchResultId = this._tmpid();
      const hasDynamicCases = node.cases.some((c) => !(c.cond instanceof nodes.Literal));

      this.emit('return runtime.consumeControlFlowValue(');
      this._compileExpression(node.expr, null, node.expr);
      this.emit.line(`, ${this.buffer.currentBuffer}, ${JSON.stringify(poisonTargetChains)}, ${this.emitErrorContext(node.expr)}, (${switchResultId}) => {`);
      if (hasDynamicCases) {
        this._emitDynamicSwitch(node, switchResultId, poisonTargetChains);
      } else {
        this._emitLiteralSwitch(node, switchResultId);
      }
      this.emit.line('});');
    }, node.expr);
  }

  _emitLiteralSwitch(node, switchResultId) {
    this.emit(`switch (${switchResultId}) {`);

    node.cases.forEach((c) => {
      this.emit('case ');
      this._compileExpression(c.cond, null, c.cond);
      this.emit(': ');

      if (c.body.children.length) {
        this.withBranchAddedContext(this._switchCaseAddedContext(c), 'Switch.Case', () => {
          this.compile(c.body, null);
        });
        this.emit.line('break;');
      }
    });

    if (node.default) {
      this.emit('default: ');
      this.withBranchAddedContext(null, 'Switch.Default', () => {
        this.compile(node.default, null);
      });
    }

    this.emit('}');
  }

  _emitDynamicSwitch(node, switchResultId, poisonTargetChains) {
    const switchTargetId = this._tmpid();
    const switchDispatchId = this._tmpid();
    const defaultTarget = node.default ? node.cases.length : -1;
    const targetByCase = node.cases.map((c, index) => this._switchBodyTarget(node, index, defaultTarget));

    this.emit.line(`let ${switchTargetId} = ${defaultTarget};`);
    this._emitSwitchDispatch(node, switchTargetId, switchDispatchId, defaultTarget);
    this._emitSwitchMatcher(node, 0, switchResultId, switchTargetId, targetByCase, switchDispatchId, poisonTargetChains);
  }

  _switchBodyTarget(node, startIndex, defaultTarget) {
    for (let i = startIndex; i < node.cases.length; i++) {
      if (node.cases[i].body.children.length) {
        return i;
      }
    }
    return defaultTarget;
  }

  _emitSwitchDispatch(node, switchTargetId, switchDispatchId, defaultTarget) {
    this.emit.line(`const ${switchDispatchId} = () => {`);
    this.emit(`switch (${switchTargetId}) {`);

    node.cases.forEach((c, index) => {
      if (!c.body.children.length) {
        return;
      }
      this.emit(`case ${index}: `);
      this.withBranchAddedContext(this._switchCaseAddedContext(c), 'Switch.Case', () => {
        this.compile(c.body, null);
      });
      this.emit.line('break;');
    });

    if (node.default) {
      this.emit(`case ${defaultTarget}: `);
      this.withBranchAddedContext(null, 'Switch.Default', () => {
        this.compile(node.default, null);
      });
    }

    this.emit('}');
    this.emit.line('};');
  }

  _emitSwitchMatcher(node, caseIndex, switchResultId, switchTargetId, targetByCase, switchDispatchId, poisonTargetChains) {
    if (caseIndex >= node.cases.length) {
      this.emit.line(`return ${switchDispatchId}();`);
      return;
    }

    const c = node.cases[caseIndex];
    const emitMatch = () => {
      this.emit.line(`${switchTargetId} = ${targetByCase[caseIndex]};`);
      this.emit.line(`return ${switchDispatchId}();`);
    };
    const emitNoMatch = () => {
      this._emitSwitchMatcher(node, caseIndex + 1, switchResultId, switchTargetId, targetByCase, switchDispatchId, poisonTargetChains);
    };

    if (c.cond instanceof nodes.Literal) {
      this.emit(`if (${switchResultId} === `);
      this._compileExpression(c.cond, null, c.cond);
      this.emit(') {');
      emitMatch();
      this.emit('} else {');
      emitNoMatch();
      this.emit('}');
      return;
    }

    const rawCaseValueId = this._tmpid();
    const caseValueId = this._tmpid();

    this.emit(`const ${rawCaseValueId} = `);
    this._compileExpression(c.cond, null, c.cond);
    this.emit.line(';');
    this.emit.line(
      `return runtime.consumeControlFlowValue(${rawCaseValueId}, ${this.buffer.currentBuffer}, ${JSON.stringify(poisonTargetChains)}, ${this.emitErrorContext(c.cond)}, (${caseValueId}) => {`
    );
    this.emit(`if (${switchResultId} === ${caseValueId}) {`);
    emitMatch();
    this.emit('} else {');
    emitNoMatch();
    this.emit('}');
    this.emit.line('});');
  }

  _switchCaseAddedContext(caseNode) {
    if (!(caseNode.cond instanceof nodes.Literal)) {
      return '{ dynamicCase: true }';
    }
    const literalValue = typeof caseNode.cond.value === 'string'
      ? JSON.stringify(caseNode.cond.value)
      : caseNode.cond.value === null ? 'null' : caseNode.cond.value.toString();
    return `{ caseValue: ${JSON.stringify(literalValue)} }`;
  }

  withBranchAddedContext(addedContextExpr, label, emitBody) {
    if (!addedContextExpr) {
      // Boundary-only labels such as If.Then/If.Else identify this stack entry;
      // commands inside the branch keep their own source labels.
      this.emit(`runtime.setContextLabel(${this.buffer.currentBuffer}.bufferStackErrorContext, ${JSON.stringify(label)});`);
      emitBody();
      return;
    }
    // Switch cases also expose non-duplicative data, e.g. caseValue, to nested
    // command/helper contexts while the boundary label stays local to the buffer.
    this.withInheritedAddedContextExpr(addedContextExpr, (addedContextVar) => {
      this.emit(`runtime.mergeAddedContext(${this.buffer.currentBuffer}.bufferStackErrorContext, ${addedContextVar});`);
      this.emit(`runtime.setContextLabel(${this.buffer.currentBuffer}.bufferStackErrorContext, ${JSON.stringify(label)});`);
      emitBody();
    });
  }

  analyzeCase(node) {
    node.body.addAnalysis({ createScope: true });
    return {};
  }

  analyzeIf(node) {
    node.cond.addAnalysis({ errorContextLabel: 'If.Condition' });
    node.body.addAnalysis({ createScope: true });
    if (node.else_) {
      node.else_.addAnalysis({ createScope: true });
    }
    return { wantsLinkedChildBuffer: true };
  }

  analyzeIfAsync(node) {
    return this.analyzeIf(node);
  }

  compileIf(node) {
    this.boundaries.compileAsyncControlFlowBoundary(this.buffer, node, () => {
      const poisonTargetChains = this._getSkippedRegionPoisonChains([node.body, node.else_]);
      const condResultId = this._tmpid();

      this.emit('return runtime.consumeControlFlowValue(');
      this._compileExpression(node.cond, null, node.cond);
      this.emit.line(`, ${this.buffer.currentBuffer}, ${JSON.stringify(poisonTargetChains)}, ${this.emitErrorContext(node.cond)}, (${condResultId}) => {`);
      this.emit(`if (${condResultId}) {`);
      this.withBranchAddedContext(null, 'If.Then', () => {
        this.compile(node.body, null);
      });
      this.emit('} else {');
      this.withBranchAddedContext(null, 'If.Else', () => {
        if (node.else_) {
          this.compile(node.else_, null);
        }
      });
      this.emit('}');
      this.emit.line('});');
    }, node.cond);
  }

  _getSkippedRegionPoisonChains(regions) {
    const chains = new Set();
    regions.forEach((region) => {
      if (region) {
        this.analysis.getChainsMutatedFromParent(region).forEach(ch => chains.add(ch));
      }
    });
    return Array.from(chains);
  }

  analyzeCapture(node) {
    if (this.scriptMode) {
      this.fail('Capture blocks are only supported in template mode', node.lineno, node.colno, node);
    }
    const textOutput = `${CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN}${this._tmpid()}`;
    this.analysis.addCommandFacts(node, { observed: [textOutput] });
    return {
      createScope: true,
      scopeBoundary: false,
      declareOnEnter: [{ name: textOutput, type: 'text', initializer: null, internal: true }],
      textOutput,
      wantsLinkedChildBuffer: true
    };
  }

  compileCapture(node) {
    this.boundaries.compileCaptureBoundary(
      this.buffer,
      node,
      function() {
        this.compile(node.body, null);
      },
      node.body,
      { capture: true }
    );
  }

  analyzeOutput(node) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared chains and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textChain = !this.scriptMode
      ? this.analysis.getCurrentTextChain(node._analysis)
      : null;
    return this.scriptMode ? {}
      : {
        mutates: [textChain],
        // Output is analyzed as one source-order text slot even though
        // compileOutput emits per-child text boundaries. The aggregate link set
        // keeps every child expression attached to the chains needed by the
        // full output slot.
        wantsLinkedChildBuffer: true
      };
  }

  compileOutput(node) {
    const textChainName = this.buffer.currentTextChainName;
    node.children.forEach((child) => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, null, function() {
            this.compileLiteral(child, null);
          }, child, textChainName, true);
        }
        return;
      }
      if (this.analysis.getChainsMutatedFromParent(child).length > 0) {
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
        this.emit.line(`${this.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${textChainName}");`);
      }
    });
  }

  compileDo(node) {
    node.children.forEach((child) => {
      if (this._isSharedChainOperationExpression(child)) {
        // Shared text/data calls enqueue commands instead of returning an
        // expression value, so they cannot be wrapped by the discard observer.
        this.compileExpression(child, null, child);
        this.emit.line(';');
        return;
      }
      this.emit('runtime.observeDiscardedExpression(');
      this.compileExpression(child, null, child);
      this.emit.line(`, ${this.emitErrorContext(child)});`);
    });
  }

  _isSharedChainOperationExpression(node) {
    const chainOperationCall = node._analysis.chainOperationCall;
    return !!(
      chainOperationCall &&
      this.chain.isSharedChainOperationCall(node, chainOperationCall) &&
      (chainOperationCall.chainType === 'text' || chainOperationCall.chainType === 'data')
    );
  }

  analyzeImport(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'Import.Script' : 'Import.Template' });
    node.target.addAnalysis({ isSymbolTarget: true });
    const declarations = this.prepareImportDeclarations(node);
    declarations.forEach((declaration) => {
      this.importedBindings.add(declaration.name);
    });
    const isRootConstructorImport = this.inheritance._isInsideCompilerInternalCallable(node);
    const declarationsKey = isRootConstructorImport
      ? 'declareInRootOnExit'
      : 'declareOnExit';
    this._markScopeVisibleImportDeclarations(declarations, isRootConstructorImport);
    return {
      [declarationsKey]: declarations,
      importedExportId: node._analysis.importedExportId
    };
  }

  analyzeFromImport(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'FromImport.Script' : 'FromImport.Template' });
    const declarations = this.prepareImportDeclarations(node);
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        nameNode.value.addAnalysis({ isSymbolTarget: true });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode.addAnalysis({ isSymbolTarget: true });
      }
    });
    declarations.forEach((declaration) => {
      this.importedBindings.add(declaration.name);
    });
    const isRootConstructorImport = this.inheritance._isInsideCompilerInternalCallable(node);
    const declarationsKey = isRootConstructorImport
      ? 'declareInRootOnExit'
      : 'declareOnExit';
    this._markScopeVisibleImportDeclarations(declarations, isRootConstructorImport);
    return {
      [declarationsKey]: declarations,
      importedExportId: node._analysis.importedExportId,
      importBindingIds: node._analysis.importBindingIds
    };
  }

  prepareImportDeclarations(node) {
    const existingDeclarations = node._analysis?.preseededImportDeclarations || null;
    if (existingDeclarations) {
      return existingDeclarations;
    }
    if (node instanceof nodes.Import) {
      return this._prepareNamespaceImportDeclarations(node);
    }
    if (node instanceof nodes.FromImport) {
      return this._prepareFromImportDeclarations(node);
    }
    return [];
  }

  _prepareNamespaceImportDeclarations(node) {
    const importedExportId = node._analysis?.importedExportId || this._tmpid();
    const declaration = {
      name: node.target.value,
      imported: true,
      importKind: DECLARATION_IMPORT_KIND.NAMESPACE,
      sourceImportNode: node,
      sourceOrderNode: node,
      directStorage: true,
      jsVar: importedExportId
    };
    node.addAnalysis({
      importedExportId,
      preseededImportDeclarations: [declaration]
    });
    return [declaration];
  }

  _prepareFromImportDeclarations(node) {
    const importedExportId = node._analysis?.importedExportId || this._tmpid();
    const importBindingIds = node._analysis?.importBindingIds || new Map();
    const declarations = [];
    node.names.children.forEach((nameNode) => {
      let name = null;
      let importedName = null;
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        importedName = nameNode.key.value;
        name = nameNode.value.value;
      } else if (nameNode instanceof nodes.Symbol) {
        importedName = nameNode.value;
        name = nameNode.value;
      }
      if (!name) {
        return;
      }
      const bindingId = importBindingIds.get(name) || this._tmpid();
      importBindingIds.set(name, bindingId);
      declarations.push({
        name,
        imported: true,
        importKind: DECLARATION_IMPORT_KIND.FROM,
        sourceImportNode: node,
        sourceOrderNode: nameNode,
        exportedName: importedName,
        directStorage: true,
        jsVar: bindingId
      });
    });
    node.addAnalysis({
      importedExportId,
      importBindingIds,
      preseededImportDeclarations: declarations
    });
    return declarations;
  }

  _markScopeVisibleImportDeclarations(declarations, shouldMark) {
    if (!shouldMark) {
      return;
    }
    declarations.forEach((declaration) => {
      declaration.scopeVisibleCallable = true;
    });
  }

  analyzeInclude(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'Include.Script' : 'Include.Template' });
    if (this.scriptMode) {
      return {};
    }
    const textChain = this.analysis.getCurrentTextChain(node._analysis);
    return {
      mutates: textChain ? [textChain] : [],
      wantsLinkedChildBuffer: true
    };
  }

  analyzeRoot(node) {
    const inheritanceAnalysis = this.inheritance.collectRootAnalysis(node);
    const declareOnEnter = this._getRootDeclarations(node);
    return {
      createScope: true,
      scopeBoundary: true,
      declareOnEnter,
      textOutput: this._getRootTextOutput(),
      sequenceLocks: [],
      sequenceLockUsages: [],
      ...inheritanceAnalysis
    };
  }

  postAnalyzeRoot(node) {
    this.sequential.validateSequenceLockUsages(node);
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
      this.emitErrorContextHelper();
      this.emit.line('return { root, getErrorContexts };');
      return;
    }

    this.inheritance.compileParticipantRootExport(node, rootCompileResult);
  }

  _getRootDeclarations(node) {
    const declareOnEnter = [];
    if (this.scriptMode) {
      declareOnEnter.push(this.return.createChainDeclaration());
    } else {
      declareOnEnter.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN, type: 'text', initializer: null });
    }
    return declareOnEnter;
  }

  _getRootTextOutput() {
    return this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN;
  }

  _emitRootBufferSetup(node) {
    if (this.scriptMode) {
      this.return.emitDeclareChain(this.buffer.currentBuffer);
    }
    const sequenceLocks = node._analysis.sequenceLocks;
    for (const name of sequenceLocks) {
      this.emit.line(`runtime.declareBufferChain(${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
    }
    this.inheritance.emitRootSharedDeclarations(node);
  }

  _emitRootResult(node) {
    if (this.scriptMode) {
      const returnVar = this._tmpid();
      this.return.emitFinalSnapshot(this.buffer.currentBuffer, returnVar);
      this.emit.line(`return ${returnVar};`);
    } else {
      this.emit.line(`  ${this.buffer.currentBuffer}.finish();`);
      this.emit.line(`return ${this.buffer.currentTextChainVar}.finalSnapshot();`);
    }
  }

  _compilePlainAsyncRootBody(node) {
    this._emitRootBufferSetup(node);
    this._compileChildren(node, null);
    this._emitRootResult(node);
  }

  _compileParticipantAsyncRootBody(node) {
    this.inheritance.compileParticipantRootBody(node);
  }

  _compileAsyncRoot(node) {
    const inheritanceParticipates = node._analysis.inheritance.participates;
    let rootFactsArgs = {};
    if (inheritanceParticipates) {
      const sharedChains = this.inheritance
        ._getSharedDeclarations(node)
        .map((declaration) => declaration.name);
      rootFactsArgs = this.chain.getCommandBufferFactsArgs(
        node,
        sharedChains,
        sharedChains
      );
    }
    const rootOptions = {
      noReturn: true,
      ...rootFactsArgs
    };
    this.emit.entryFunction(node, 'root', () => {
      if (inheritanceParticipates) {
        this._compileParticipantAsyncRootBody(node);
      } else {
        this._compilePlainAsyncRootBody(node);
      }
    }, rootOptions);
    if (!inheritanceParticipates) {
      return { callableEntries: [] };
    }
    this.inBlock = true;
    return {
      callableEntries: this.inheritance.compileCallableEntries(node)
    };
  }

  _compileExpressionToString(node) {
    return this.emit.capture(() => {
      this.compileExpression(node, null, node, true);
    });
  }

}

export {CompilerAsync};
