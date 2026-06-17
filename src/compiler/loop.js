
import * as nodes from '../language/nodes.js';
import {WAITED_CHAIN_NAME} from './reserved.js';

class CompileLoop {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileWhile(node) {
    const iteratorCompiler = (_arrNode, _loopFrame, arrVarName) => {
      this.compiler.emit.line(`let ${arrVarName} = runtime.whileIterator();`);
    };

    this._compileAsyncForCore(node, {
      sequentialLoopBody: true,
      iteratorCompiler,
      whileConditionNode: node.cond,
      loopVarNames: ['iterationCount'],
      sourcePositionNode: node.cond
    });
  }

  compileSyncWhile(node, frame) {
    this.compiler.emit('while (');
    this.compiler.compileExpression(node.cond, frame, node.cond, true);
    this.compiler.emit(') {');
    this.compiler.compile(node.body, frame);
    this.compiler.emit('}');
  }

  _compileAsyncForCore(node, options = {}) {
    const sequentialLoopBody = !!options.sequentialLoopBody;
    const iteratorCompiler = options.iteratorCompiler || null;
    const whileConditionNode = options.whileConditionNode || null;
    const loopVarNames = Array.isArray(options.loopVarNames) ? options.loopVarNames : null;
    const sourcePositionNode = options.sourcePositionNode || node.arr;
    const parentWaitedChainName = this.compiler.buffer.currentWaitedChainName;
    const loopVars = this._collectLoopVars(node, loopVarNames);

    this.compiler.boundaries.compileAsyncControlFlowBoundary(this.compiler.buffer, node, () => {
      const arr = this.compiler._tmpid();

      if (iteratorCompiler) {
        iteratorCompiler(sourcePositionNode, null, arr);
      } else {
        this.compiler.buffer.skipOwnWaitedChain(() => {
          this.compiler.emit(`let ${arr} = `);
          this.compiler.compileExpression(node.arr, null, node.arr, true);
          this.compiler.emit.line(';');
        });
      }

      const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
      if (node.concurrentLimit) {
        this.compiler.buffer.skipOwnWaitedChain(() => {
          this.compiler.emit(`let ${limitVar} = `);
          this.compiler.compileExpression(node.concurrentLimit, null, node.concurrentLimit, true);
          this.compiler.emit.line(';');
        });
      }

      const loopBodyFuncId = this.compiler._tmpid();
      this.compiler.emit(`let ${loopBodyFuncId} = `);
      const hasConcurrentLimit = node.concurrentLimit !== null;
      const whilePoisonTargetChains = whileConditionNode
        ? this.compiler._getSkippedRegionPoisonChains([node.body])
        : [];
      this._compileAsyncLoopBody(
        node,
        loopVars,
        sequentialLoopBody,
        hasConcurrentLimit,
        whileConditionNode,
        loopVarNames,
        whilePoisonTargetChains
      );

      const bodyPoisonChains = this.compiler.analysis.getChainsMutatedFromParent(node.body);
      const bodyReturnStateChains = sequentialLoopBody && !whileConditionNode
        ? this.compiler.analysis.getChainsUsedFromParent(node.body)
        : [];
      const returnCheckChainName = this.compiler.return.getSequentialLoopAdvanceCheckChain({
        sequentialLoopBody,
        whileConditionNode,
        bodyReturnStateChains
      });
      let elseFuncId = 'null';
      let elsePoisonChains = [];

      if (node.else_) {
        elseFuncId = this.compiler._tmpid();
        this.compiler.emit(`let ${elseFuncId} = `);
        this.compiler.emit('(function() {');
        this.compiler.withInheritedLabelOverride('"Loop.Else"', () => {
          this.compiler.compile(node.else_, null);
        });
        this.compiler.emit.line('}).bind(context);');
        elsePoisonChains = this.compiler.analysis.getChainsMutatedFromParent(node.else_);
      }

      const asyncOptionsCode = `{
        sequential: ${sequentialLoopBody},
        bodyPoisonChains: ${JSON.stringify(bodyPoisonChains)},
        elsePoisonChains: ${JSON.stringify(elsePoisonChains)},
        concurrentLimit: ${node.concurrentLimit ? limitVar : 'null'},
        returnCheckChainName: ${returnCheckChainName ? `"${returnCheckChainName}"` : 'null'},
        scriptMode: ${this.compiler.scriptMode ? 'true' : 'false'},
        errorContext: ${this.compiler.emitErrorContext(node)}
      }`;

      const loopOwnsWaitedCompletion = sequentialLoopBody || hasConcurrentLimit;
      const shouldTrackNestedLoopCompletion = loopOwnsWaitedCompletion && !!parentWaitedChainName;
      const iteratePromiseId = this.compiler._tmpid();
      this.compiler.emit(`let ${iteratePromiseId} = runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, ${this.compiler.buffer.currentBuffer}, [`);
      loopVars.forEach((varName, index) => {
        if (index > 0) {
          this.compiler.emit(', ');
        }
        this.compiler.emit(`"${varName}"`);
      });
      this.compiler.emit(`], ${asyncOptionsCode});`);
      if (shouldTrackNestedLoopCompletion) {
        this.compiler.buffer.emitLimitedLoopCompletion(iteratePromiseId, node);
      }
      this.compiler.emit.line(`return ${iteratePromiseId};`);
    }, node, { loopVariables: loopVars });
  }

  compileFor(node) {
    this._compileAsyncForCore(node);
  }

  compileSyncFor(node, frame, options = {}) {
    const iteratorCompiler = options.iteratorCompiler || null;
    const whileConditionNode = options.whileConditionNode || null;
    const loopVarNames = Array.isArray(options.loopVarNames) ? options.loopVarNames : null;
    const sourcePositionNode = options.sourcePositionNode || node.arr;

    const blockFrame = frame;
    const innerFrame = blockFrame.push();
    this.compiler.emit.line('frame = frame.push();');

    const arr = this.compiler._tmpid();
    if (iteratorCompiler) {
      iteratorCompiler(sourcePositionNode, innerFrame, arr);
    } else {
      this.compiler.buffer.skipOwnWaitedChain(() => {
        this.compiler.emit(`let ${arr} = `);
        this.compiler.compileExpression(node.arr, innerFrame, node.arr, true);
        this.compiler.emit.line(';');
      });
    }

    const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
    if (node.concurrentLimit) {
      this.compiler.buffer.skipOwnWaitedChain(() => {
        this.compiler.emit(`let ${limitVar} = `);
        this.compiler.compileExpression(node.concurrentLimit, innerFrame, node.concurrentLimit, true);
        this.compiler.emit.line(';');
      });
    }

    const loopVars = this._collectLoopVars(node, loopVarNames);
    loopVars.forEach((name) => {
      innerFrame.set(name, name);
    });

    const loopBodyFuncId = this.compiler._tmpid();
    this.compiler.emit(`let ${loopBodyFuncId} = `);
    this._compileSyncLoopBody(node, innerFrame, loopVars, whileConditionNode, loopVarNames);

    let elseFuncId = 'null';
    if (node.else_) {
      const elseCreatesScope = !!(node.else_ && node.else_._analysis && node.else_._analysis.createScope);
      elseFuncId = this.compiler._tmpid();
      this.compiler.emit(`let ${elseFuncId} = `);
      this.compiler.emit('function() {');
      let elseFrame = innerFrame;
      if (elseCreatesScope) {
        elseFrame = innerFrame.push();
        this.compiler.emit.line('frame = frame.push();');
      }

      this.compiler.compile(node.else_, elseFrame);

      if (elseCreatesScope) {
        this.compiler.emit.line('frame = frame.pop();');
        elseFrame = elseFrame.pop();
      }

      this.compiler.emit.line('};');
    }

    const syncOptionsCode = node.concurrentLimit
      ? `{ concurrentLimit: ${limitVar} }`
      : 'null';
    this.compiler.emit(`runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, null, [`);
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.compiler.emit(', ');
      }
      this.compiler.emit(`"${varName}"`);
    });
    this.compiler.emit(`], ${syncOptionsCode});`);
    this.compiler.emit.line('');
    this.compiler.emit.line('frame = frame.pop();');
  }

  _compileAsyncLoopBody(node, loopVars, sequentialLoopBody, hasConcurrencyLimit = false, whileConditionNode = null, loopVarNames = null, whilePoisonTargetChains = []) {
    this.compiler.emit('(function(');
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.compiler.emit(', ');
      }
      this.compiler.emit(varName);
    });
    const loopIndex = this.compiler._tmpid();
    const loopLength = this.compiler._tmpid();
    const isLast = this.compiler._tmpid();
    const errorContextVar = this.compiler._tmpid();
    this.compiler.emit(`, ${loopIndex}, ${loopLength}, ${isLast}, ${errorContextVar}) {`);
    const loopMetaVar = this.compiler._tmpid();
    // Create the single per-iteration runtime loop object. The tmpid variable
    // is reused both for diagnostics and for the exposed loop binding.
    this.compiler.emit.line(`const ${loopMetaVar} = runtime.createLoopBindings(${loopIndex}, ${loopLength}, ${isLast});`);
    this.compiler.emit.line(`${loopMetaVar}.variables = ${JSON.stringify(loopVars)};`);

    const shouldAwaitLoopBody = sequentialLoopBody || hasConcurrencyLimit;
    const parentBufferArg = this.compiler.buffer.currentBuffer;
    const { linkedFactsArg, ownFactsArg } = this.compiler.buffer.getCommandBufferFactsArgs(node);
    // The iteration boundary owns its label slot; loop metadata stays in added
    // context so nested commands can inherit it without changing source labels.
    const loopAddedContextVar = this.compiler.createInheritedAddedContextVar(`{ loop: ${loopMetaVar} }`);
    const iterationBoundaryContextArg = `runtime.setContextLabel(runtime.cloneWithAddedContext(${this.compiler._emitStaticErrorContext(node)}, ${loopAddedContextVar}), "Iteration")`;
    this.compiler.emit(
      `return runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedFactsArg}, ${ownFactsArg}, context, renderState, (currentBuffer) => {`
    );

    this.compiler.buffer.withBufferState({
      currentBuffer: 'currentBuffer',
      currentTextChainVar: null
    }, () => {
      this.compiler.withInheritedAddedContext(loopAddedContextVar, () => {
        if (shouldAwaitLoopBody) {
          this.compiler.buffer.emitDeclareWaitedChain();
        }

        const emitBodyAndCompletion = () => {
          this.compiler.emit.withScopedSyntax(() => {
            this.compiler.compile(node.body, null);
          });

          if (shouldAwaitLoopBody) {
            const completionHelper = whileConditionNode ? 'finishBufferAndContinue' : 'finishBufferAndWait';
            this.compiler.emit.line(`return runtime.${completionHelper}(${this.compiler.buffer.currentBuffer}, "${WAITED_CHAIN_NAME}");`);
            return;
          }
          if (whileConditionNode) {
            this.compiler.emit.line('return true;');
          }
        };

        const compileIterationBody = () => {
          const buffer = this.compiler.buffer.currentBuffer;
          loopVars.forEach((name) => {
            this.compiler.emit.line(`runtime.declareBufferChain(${buffer}, "${name}", "var", context, null);`);
          });
          this._emitLoopIterationBindings(node, loopVars, loopVarNames, (varName, valueExpr) => {
            this._emitLoopValueAssignment(node, varName, valueExpr);
          });

          if (whileConditionNode) {
            const whileCondId = this.compiler._tmpid();
            const whileCondValueId = this.compiler._tmpid();
            this.compiler.emit(`let ${whileCondValueId} = `);
            this.compiler.buffer.skipOwnWaitedChain(() => {
              this.compiler._compileExpression(whileConditionNode, null, whileConditionNode);
            });
            this.compiler.emit.line(';');
            this.compiler.emit.line(
              `return runtime.consumeControlFlowValue(${whileCondValueId}, ${this.compiler.buffer.currentBuffer}, ${JSON.stringify(whilePoisonTargetChains)}, ${this.compiler.emitErrorContext(whileConditionNode)}, (${whileCondId}) => {`
            );
            this.compiler.emit(`if (!${whileCondId}) {`);
            this.compiler.emit.line('  return false;');
            this.compiler.emit.line('}');
            emitBodyAndCompletion();
            this.compiler.emit.line('}, () => false);');
            return;
          }

          emitBodyAndCompletion();
        };

        if (!shouldAwaitLoopBody) {
          this.compiler.withCurrentLoopVar(loopMetaVar, compileIterationBody);
        } else {
          const waitedOwnerBufferId = this.compiler._tmpid();
          this.compiler.emit.line(`const ${waitedOwnerBufferId} = ${this.compiler.buffer.currentBuffer};`);
          this.compiler.buffer.withOwnWaitedChain(
            () => this.compiler.withCurrentLoopVar(loopMetaVar, compileIterationBody),
            waitedOwnerBufferId
          );
        }
      });
    });
    this.compiler.emit.line(`}, ${iterationBoundaryContextArg});`);
    this.compiler.emit.line('}).bind(context);');

    return null;
  }

  _compileSyncLoopBody(node, frame, loopVars, whileConditionNode = null, loopVarNames = null) {
    const bodyCreatesScope = !!(node.body && node.body._analysis && node.body._analysis.createScope);
    this.compiler.emit('function(');
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.compiler.emit(', ');
      }
      this.compiler.emit(varName);
    });
    const loopIndex = this.compiler._tmpid();
    const loopLength = this.compiler._tmpid();
    const isLast = this.compiler._tmpid();
    const errorContext = this.compiler._tmpid();
    this.compiler.emit(`, ${loopIndex}, ${loopLength}, ${isLast}, ${errorContext}) {`);

    let bodyFrame = frame;
    if (bodyCreatesScope) {
      bodyFrame = frame.push();
      this.compiler.emit.line('frame = frame.push();');
    }

    this.compiler.emit.line(`frame.setLoopBindings(${loopIndex}, ${loopLength}, ${isLast});`);
    this._emitLoopIterationBindings(node, loopVars, loopVarNames, (varName, valueExpr) => {
      this.compiler.emit.line(`frame.set("${varName}", ${valueExpr});`);
    });

    if (whileConditionNode) {
      const whileCondId = this.compiler._tmpid();
      this.compiler.emit(`const ${whileCondId} = `);
      this.compiler.buffer.skipOwnWaitedChain(() => {
        this.compiler._compileAwaitedExpression(whileConditionNode, bodyFrame);
      });
      this.compiler.emit.line(';');
      this.compiler.emit(`if (!${whileCondId}) {`);
      this.compiler.emit.line('  return false;');
      this.compiler.emit.line('}');
    }

    this.compiler.emit.withScopedSyntax(() => {
      this.compiler.compile(node.body, bodyFrame);
    });

    if (bodyCreatesScope) {
      this.compiler.emit.line('frame = frame.pop();');
      bodyFrame = bodyFrame.pop();
    }

    this.compiler.emit.line('};');
    return bodyFrame;
  }

  _collectLoopVars(node, loopVarNames) {
    if (loopVarNames) {
      return [...loopVarNames];
    }
    if (node.name instanceof nodes.Array) {
      return node.name.children.map((child) => child.value);
    }
    return [node.name.value];
  }

  _emitLoopIterationBindings(node, loopVars, loopVarNames, emitBinding) {
    if (loopVars.length > 1) {
      loopVars.forEach((varName) => {
        emitBinding(varName, varName);
      });
      return;
    }

    if (!loopVarNames && node.name instanceof nodes.Array) {
      node.name.children.forEach((child, index) => {
        const varName = child.value;
        const tid = this.compiler._tmpid();
        this.compiler.emit.line(`let ${tid} = Array.isArray(${varName}) ? ${varName}[${index}] : undefined;`);
        emitBinding(varName, tid);
      });
      return;
    }

    const varName = loopVarNames ? loopVars[0] : node.name.value;
    emitBinding(varName, varName);
  }

  _emitLoopValueAssignment(node, chainName, valueExpr) {
    this.compiler.emit.line(
      `${this.compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ chainName: '${chainName}', args: [${valueExpr}], errorContext: ${this.compiler.emitErrorContext(node)} }), '${chainName}');`
    );
  }

  _compileSyncLegacyCallbackLoopBindings(node, arr, i, len) {
    const bindings = [
      { name: 'index', val: `${i} + 1` },
      { name: 'index0', val: i },
      { name: 'revindex', val: `${len} - ${i}` },
      { name: 'revindex0', val: `${len} - ${i} - 1` },
      { name: 'first', val: `${i} === 0` },
      { name: 'last', val: `${i} === ${len} - 1` },
      { name: 'length', val: len },
    ];

    bindings.forEach((binding) => {
      this.compiler.emit.line(`frame.set("loop.${binding.name}", ${binding.val});`);
    });
  }

  _compileSyncLegacyCallbackLoop(node, frame, parallel) {
    let i, len, arr, asyncMethod;

    i = this.compiler._tmpid();
    len = this.compiler._tmpid();
    arr = this.compiler._tmpid();
    asyncMethod = parallel ? 'asyncAll' : 'asyncEach';

    frame = frame.push();
    this.compiler.emit.line('frame = frame.push();');

    this.compiler.emit('let ' + arr + ' = runtime.fromIterator(');
    this.compiler.compileExpression(node.arr, frame, node.arr, true);
    this.compiler.emit.line(');');

    if (node.name instanceof nodes.Array) {
      const arrayLen = node.name.children.length;
      this.compiler.emit(`runtime.${asyncMethod}(${arr}, ${arrayLen}, function(`);

      node.name.children.forEach((name) => {
        this.compiler.emit(`${name.value},`);
      });

      this.compiler.emit(i + ',' + len + ',next) {');

      node.name.children.forEach((name) => {
        const id = name.value;
        frame.set(id, id);
        this.compiler.emit.line(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this.compiler.emit.line(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      frame.set(id, id);
      this.compiler.emit.line(`frame.set("${id}", ${id});`);
    }

    this._compileSyncLegacyCallbackLoopBindings(node, arr, i, len);

    this.compiler.emit.withScopedSyntax(() => {
      if (parallel) {
        this.compiler.emit.withScopeCommandBuffer({
          frame,
          analysisNode: node.body,
          emitFunc: (managedFrame, buf) => {
            this.compiler.compile(node.body, managedFrame);
            this.compiler.emit.line('next(' + i + ',' + buf + ');');
          }
        });
      } else {
        this.compiler.compile(node.body, frame);
        this.compiler.emit.line('next(' + i + ');');
      }
    });

    const textResult = this.compiler._tmpid();
    this.compiler.emit.line('}, ' + this.compiler._makeCallback(textResult));
    this.compiler.emit.addScopeLevel();

    if (parallel) {
      this.compiler.emit.line(`${this.compiler.buffer.currentBuffer} += ${textResult};`);
    }

    if (node.else_) {
      this.compiler.emit.line('if (!' + arr + '.length) {');
      this.compiler.compile(node.else_, frame);
      this.compiler.emit.line('}');
    }

    this.compiler.emit.line('frame = frame.pop();');
    frame = frame.pop();
  }

  compileAsyncEach(node) {
    this._compileAsyncForCore(node, { sequentialLoopBody: true });
  }

  compileSyncAsyncEach(node, frame) {
    this._compileSyncLegacyCallbackLoop(node, frame, false);
  }

  compileAsyncAll(node) {
    this._compileAsyncForCore(node, { sequentialLoopBody: false });
  }

  compileSyncAsyncAll(node, frame) {
    this._compileSyncLegacyCallbackLoop(node, frame, true);
  }
}

export {CompileLoop};
