
import * as nodes from '../language/nodes.js';

import {
  validateScriptExtendsSourceOrder,
  validateScriptExtendsExpression,
  validateTemplateInheritanceSurface,
} from './validation.js';

import {CompilerBaseAsync} from './compiler-base-async.js';
import {CompileBuffer} from './buffer.js';

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
      ? { uses: [textChain], mutates: [textChain] }
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
                this.emit.line(`runtime.markChainBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, null);
              }, arg);
              this.emit(')');
            } else {
              // External/Nunjucks-compatible adapter callback, kept as cb.
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit._compileAsyncCallbackRenderBoundary(node, function () {
                  this.emit.line(`runtime.markChainBufferScope(${this.buffer.currentBuffer});`);
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
      node.name.addAnalysis({ declarationTarget: true });
    } else if (node.name instanceof nodes.Array || node.name instanceof nodes.NodeList) {
      node.name.children.forEach((child) => {
        child.addAnalysis({ declarationTarget: true });
      });
    }
    const declares = [];
    const declaredNames = analysisPass.extractSymbols(node.name);
    declaredNames.forEach((name) => {
      declares.push({ name, type: 'var', initializer: null });
    });
    if (declarationsInBody) {
      node.body.addAnalysis({ createScope: true, loopOwner: node, declares });
      if (node.else_) {
        node.else_.addAnalysis({ createScope: true });
      }
      return { wantsLinkedChildBuffer: true };
    }
    return { createScope: true, declares, wantsLinkedChildBuffer: true };
  }

  analyzeWhile(node, analysisPass) {
    const result = this._collectLoopDeclarationFacts(node, analysisPass);
    node.cond.addAnalysis({ errorContextLabel: 'While.Condition' });
    return result;
  }

  postAnalyzeWhile(node) {
    return {
      poisonTargetChains: this._getSkippedRegionPoisonChains([node.body])
    };
  }

  analyzeFor(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
    }
    return this._collectLoopDeclarationFacts(node, analysisPass, true);
  }

  analyzeAsyncEach(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
    }
    const result = this._collectLoopDeclarationFacts(node, analysisPass, true);
    return result;
  }

  analyzeAsyncAll(node, analysisPass) {
    node.arr.addAnalysis({ errorContextLabel: 'For.Iterator' });
    if (node.concurrentLimit) {
      node.concurrentLimit.addAnalysis({ errorContextLabel: 'For.Limit' });
    }
    return this._collectLoopDeclarationFacts(node, analysisPass, true);
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

  postAnalyzeSwitch(node) {
    return {
      poisonTargetChains: this._getSkippedRegionPoisonChains(
        [...node.cases.map(c => c.body), node.default]
      )
    };
  }

  compileSwitch(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      const poisonTargetChains = node._analysis.poisonTargetChains;

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

      const errorContext = this.emitErrorContext(node.expr);
      this.boundaries.emitBranchPoisonCatch(this.buffer, poisonTargetChains, errorContext);
    }, node.expr);
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
    return { createScope: true };
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

  postAnalyzeIf(node) {
    return {
      poisonTargetChains: this._getSkippedRegionPoisonChains([node.body, node.else_])
    };
  }

  compileIf(node) {
    this.buffer._compileAsyncControlFlowBoundary(node, () => {
      const poisonTargetChains = node._analysis.poisonTargetChains;
      const condResultId = this._tmpid();

      this.emit('try {');
      this.emit(`const ${condResultId} = `);
      this._compileAwaitedExpression(node.cond, null);
      this.emit(';');
      this.emit('');
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

      const errorContext = this.emitErrorContext(node.cond);
      this.boundaries.emitBranchPoisonCatch(this.buffer, poisonTargetChains, errorContext);
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
    return {
      createScope: true,
      scopeBoundary: false,
      declares: [{ name: textOutput, type: 'text', initializer: null, internal: true }],
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
        uses: [textChain],
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
      if (isSharedChainCommandExpression(child)) {
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

  analyzeImport(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'Import.Script' : 'Import.Template' });
    node.target.addAnalysis({ declarationTarget: true });
    this.importedBindings.add(node.target.value);
    return {
      declares: [{ name: node.target.value, type: 'var', initializer: null, imported: true }]
    };
  }

  analyzeFromImport(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'FromImport.Script' : 'FromImport.Template' });
    const declares = [];
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        nameNode.value.addAnalysis({ declarationTarget: true });
        this.importedBindings.add(nameNode.value.value);
        declares.push({ name: nameNode.value.value, type: 'var', initializer: null, imported: true });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode.addAnalysis({ declarationTarget: true });
        this.importedBindings.add(nameNode.value);
        declares.push({ name: nameNode.value, type: 'var', initializer: null, imported: true });
      }
    });
    return { declares };
  }

  analyzeInclude(node) {
    node.template.addAnalysis({ errorContextLabel: this.scriptMode ? 'Include.Script' : 'Include.Template' });
    if (this.scriptMode) {
      return {};
    }
    const textChain = this.analysis.getCurrentTextChain(node._analysis);
    return {
      uses: textChain ? [textChain] : [],
      mutates: textChain ? [textChain] : [],
      wantsLinkedChildBuffer: true
    };
  }

  analyzeRoot(node) {
    const inheritanceAnalysis = this.inheritance.collectRootAnalysis(node);
    const declares = this._getRootDeclarations(node);
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
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
    const declares = [];
    if (this.scriptMode) {
      declares.push(this.return.createChainDeclaration());
    } else {
      declares.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN, type: 'text', initializer: null });
    }
    return declares;
  }

  _getRootTextOutput() {
    return this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN;
  }

  _emitRootBufferSetup(node) {
    this.emit.line(`runtime.markChainBufferScope(${this.buffer.currentBuffer});`);
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
    this.emit.entryFunction(node, 'root', () => {
      if (inheritanceParticipates) {
        this._compileParticipantAsyncRootBody(node);
      } else {
        this._compilePlainAsyncRootBody(node);
      }
    }, { noReturn: true });
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

}

function isSharedChainCommandExpression(node) {
  const specialChainCall = node?._analysis?.specialChainCall;
  return !!(
    specialChainCall &&
    specialChainCall.shared &&
    (specialChainCall.chainType === 'text' || specialChainCall.chainType === 'data')
  );
}

export {CompilerAsync};
