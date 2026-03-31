'use strict';

const nodes = require('../nodes');

class CompileLoop {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileWhile(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileAsyncWhile(node, frame);
      return;
    }
    this._compileSyncWhile(node, frame);
  }

  _compileSyncWhile(node, frame) {
    this.compiler.emit('while (');
    this.compiler.compileExpression(node.cond, frame, node.cond, true);
    this.compiler.emit(') {');
    this.compiler.compile(node.body, frame);
    this.compiler.emit('}');
  }

  _compileAsyncWhile(node, frame) {
    const iteratorCompiler = (arrNode, loopFrame, arrVarName) => {
      this.compiler.emit.line(`let ${arrVarName} = runtime.whileIterator();`);
    };

    this._compileAsyncForCore(node, frame, {
      sequentialLoopBody: true,
      iteratorCompiler,
      whileConditionNode: node.cond,
      loopVarNames: ['iterationCount'],
      sourcePositionNode: node.cond
    });
  }

  compileFor(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileAsyncFor(node, frame);
      return;
    }
    this._compileSyncFor(node, frame);
  }

  _compileAsyncFor(node, frame, options = {}) {
    this._compileAsyncForCore(node, frame, options);
  }

  _compileSyncFor(node, frame, options = {}) {
    this._compileSyncForCore(node, frame, options);
  }

  _compileAsyncForCore(node, frame, options = {}) {
    const sequentialLoopBody = !!options.sequentialLoopBody;
    const iteratorCompiler = options.iteratorCompiler || null;
    const whileConditionNode = options.whileConditionNode || null;
    const loopVarNames = Array.isArray(options.loopVarNames) ? options.loopVarNames : null;
    const sourcePositionNode = options.sourcePositionNode || node.arr;
    const parentWaitedChannelName = this.compiler.buffer.currentWaitedChannelName;

    const forResult = this.compiler.buffer._compileControlFlowBoundary(node, frame, (blockFrame) => {
      const innerFrame = blockFrame;
      const arr = this.compiler._tmpid();

      if (iteratorCompiler) {
        iteratorCompiler(sourcePositionNode, innerFrame, arr);
      } else {
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler.emit(`let ${arr} = `);
          this.compiler.compileExpression(node.arr, innerFrame, node.arr, true);
          this.compiler.emit.line(';');
        });
      }

      const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
      if (node.concurrentLimit) {
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler.emit(`let ${limitVar} = `);
          this.compiler.compileExpression(node.concurrentLimit, innerFrame, node.concurrentLimit, true);
          this.compiler.emit.line(';');
        });
      }

      const loopVars = this._collectLoopVars(node, loopVarNames);
      const loopBodyFuncId = this.compiler._tmpid();
      this.compiler.emit(`let ${loopBodyFuncId} = `);
      const hasConcurrentLimit = Boolean(node.concurrentLimit);
      this._compileAsyncLoopBody(
        node,
        innerFrame,
        loopVars,
        sequentialLoopBody,
        hasConcurrentLimit,
        whileConditionNode,
        loopVarNames
      );

      const bodyChannels = new Set(node.body._analysis.usedChannels || []);
      let elseFuncId = 'null';
      let elseChannels = null;

      if (node.else_) {
        elseFuncId = this.compiler._tmpid();
        this.compiler.emit(`let ${elseFuncId} = `);
        this._compileAsyncLoopElse(node, innerFrame);
        elseChannels = new Set(node.else_._analysis.usedChannels || []);
      }

      const asyncOptionsCode = `{
        sequential: ${sequentialLoopBody},
        bodyChannels: ${JSON.stringify(Array.from(bodyChannels))},
        elseChannels: ${JSON.stringify(elseChannels ? Array.from(elseChannels) : [])},
        concurrentLimit: ${node.concurrentLimit ? limitVar : 'null'},
        errorContext: { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: "${this.compiler._generateErrorContext(node)}", path: context.path }
      }`;

      const loopOwnsWaitedCompletion = sequentialLoopBody || hasConcurrentLimit;
      const shouldTrackNestedLoopCompletion = loopOwnsWaitedCompletion && !!parentWaitedChannelName;
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
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(iteratePromiseId, node);
      }
      this.compiler.emit.line(`await ${iteratePromiseId};`);
    });

    frame = forResult.frame;
  }

  _compileSyncForCore(node, frame, options = {}) {
    const iteratorCompiler = options.iteratorCompiler || null;
    const whileConditionNode = options.whileConditionNode || null;
    const loopVarNames = Array.isArray(options.loopVarNames) ? options.loopVarNames : null;
    const sourcePositionNode = options.sourcePositionNode || node.arr;

    const forResult = this.compiler.buffer._compileControlFlowBoundary(node, frame, (blockFrame) => {
      const innerFrame = this.compiler.frameOps.pushFrame(blockFrame);

      const arr = this.compiler._tmpid();
      if (iteratorCompiler) {
        iteratorCompiler(sourcePositionNode, innerFrame, arr);
      } else {
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler.emit(`let ${arr} = `);
          this.compiler.compileExpression(node.arr, innerFrame, node.arr, true);
          this.compiler.emit.line(';');
        });
      }

      const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
      if (node.concurrentLimit) {
        this.compiler.buffer.skipOwnWaitedChannel(() => {
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
        elseFuncId = this.compiler._tmpid();
        this.compiler.emit(`let ${elseFuncId} = `);
        this._compileSyncLoopElse(node, innerFrame);
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
      this.compiler.frameOps.popFrame(innerFrame);
    });

    frame = forResult.frame;
  }

  _compileAsyncLoopBody(node, frame, loopVars, sequentialLoopBody, hasConcurrencyLimit = false, whileConditionNode = null, loopVarNames = null) {
    this.compiler.emit('(async function(');
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

    const shouldAwaitLoopBody = sequentialLoopBody || hasConcurrencyLimit;
    const parentBufferArg = this.compiler.buffer.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    this.compiler.emit(
      `return runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    const prevBuffer = this.compiler.buffer.currentBuffer;
    const prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.compiler.buffer.currentTextChannelVar = null;

    const limitedWaitedChannelName = (hasConcurrencyLimit || sequentialLoopBody)
      ? (node.body && node.body._analysis && node.body._analysis.waitedOutputName)
      : null;
    if (limitedWaitedChannelName) {
      this.compiler.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${limitedWaitedChannelName}", "var", context, null);`);
    }

    const compileIterationBody = () => {
      this._emitAsyncLoopBindings(node, loopVars, loopIndex, loopLength, isLast);
      this._emitLoopIterationBindings(node, loopVars, loopVarNames, (varName, valueExpr) => {
        this._emitAsyncLoopVarIterationBinding(node, varName, valueExpr);
      });

      let catchPoisonPos = null;
      let whileCondId;

      if (whileConditionNode) {
        whileCondId = this.compiler._tmpid();
        this.compiler.emit(`let ${whileCondId};`);
        this.compiler.emit('try {');
        this.compiler.emit(`${whileCondId} = `);
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler._compileAwaitedExpression(whileConditionNode, frame);
        });
        this.compiler.emit.line(';');
        const whileErrorContext = this.compiler._createErrorContext(node, whileConditionNode);
        this.compiler.emit('} catch (e) {');
        this.compiler.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${whileErrorContext.lineno}, ${whileErrorContext.colno}, "${whileErrorContext.errorContextString}", context.path);`);
        catchPoisonPos = this.compiler.codebuf.length;
        this.compiler.emit.line('');
        this.compiler.emit(`  ${whileCondId} = false;`);
        this.compiler.emit('}');
        this.compiler.emit(`if (!${whileCondId}) {`);
        this.compiler.emit.line('  return false;');
        this.compiler.emit.line('}');
      }

      this.compiler.emit.withScopedSyntax(() => {
        this.compiler.compile(node.body, frame);
      });

      if (whileConditionNode && catchPoisonPos !== null) {
        const bodyChannels = new Set(node.body._analysis.usedChannels || []);
        for (const channelName of bodyChannels) {
          this.compiler.emit.insertLine(catchPoisonPos, `  ${this.compiler.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`);
        }
      }

      if (shouldAwaitLoopBody) {
        const waitedSnapshotId = this.compiler._tmpid();
        this.compiler.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.compiler.emit.line(`const ${waitedSnapshotId} = ${this.compiler.buffer.currentBuffer}.getChannel("${limitedWaitedChannelName}").finalSnapshot();`);
        if (whileConditionNode) {
          this.compiler.emit.line(`await ${waitedSnapshotId};`);
          this.compiler.emit.line('return true;');
        } else {
          this.compiler.emit.line(`return ${waitedSnapshotId};`);
        }
      }
    };

    if ((sequentialLoopBody || hasConcurrencyLimit) && !limitedWaitedChannelName) {
      this.compiler.fail('compileFor: limited/sequential loop body has no waited channel вЂ” compiler analysis bug', node.lineno, node.colno, node);
    }

    if (!limitedWaitedChannelName) {
      compileIterationBody();
    } else {
      this.compiler.buffer.withOwnWaitedChannel(limitedWaitedChannelName, compileIterationBody);
    }

    this.compiler.buffer.currentBuffer = prevBuffer;
    this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line('});');
    this.compiler.emit.line('}).bind(context);');

    return frame;
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
      bodyFrame = this.compiler.frameOps.pushFrame(frame);
    }

    this._emitSyncLoopBindings(loopIndex, loopLength, isLast);
    this._emitLoopIterationBindings(node, loopVars, loopVarNames, (varName, valueExpr) => {
      this._emitSyncLoopVarIterationBinding(varName, valueExpr);
    });

    if (whileConditionNode) {
      const whileCondId = this.compiler._tmpid();
      this.compiler.emit(`const ${whileCondId} = `);
      this.compiler.buffer.skipOwnWaitedChannel(() => {
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
      bodyFrame = this.compiler.frameOps.popFrame(bodyFrame);
    }

    this.compiler.emit.line('};');
    return bodyFrame;
  }

  _compileAsyncLoopElse(node, frame) {
    this.compiler.emit('(async function() {');
    this.compiler.compile(node.else_, frame);
    this.compiler.emit.line('}).bind(context);');
    return frame;
  }

  _compileSyncLoopElse(node, frame) {
    const elseCreatesScope = !!(node.else_ && node.else_._analysis && node.else_._analysis.createScope);
    this.compiler.emit('function() {');
    let elseFrame = frame;
    if (elseCreatesScope) {
      elseFrame = this.compiler.frameOps.pushFrame(frame);
    }

    this.compiler.compile(node.else_, elseFrame);

    if (elseCreatesScope) {
      elseFrame = this.compiler.frameOps.popFrame(elseFrame);
    }

    this.compiler.emit.line('};');
    return elseFrame;
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

  _emitLoopValueDeclarations(node, loopVars) {
    const buffer = this.compiler.buffer.currentBuffer;
    loopVars.forEach((name) => {
      this.compiler.emit.line(`runtime.declareBufferChannel(${buffer}, "${name}", "var", context, null);`);
    });
    if (node.loopRuntimeName) {
      this.compiler.emit.line(`runtime.declareBufferChannel(${buffer}, "${node.loopRuntimeName}", "var", context, null);`);
    }
  }

  _emitLoopValueAssignment(node, channelName, valueExpr) {
    this.compiler.emit.line(
      `${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${channelName}', args: [${valueExpr}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${channelName}');`
    );
  }

  _emitAsyncLoopBindings(node, loopVars, loopIndex, loopLength, isLast) {
    this._emitLoopValueDeclarations(node, loopVars);
    if (node.loopRuntimeName) {
      this._emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast);
    }
  }

  _emitSyncLoopBindings(loopIndex, loopLength, isLast) {
    this.compiler.emit.line(`frame.setLoopBindings(${loopIndex}, ${loopLength}, ${isLast});`);
  }

  _emitAsyncLoopVarIterationBinding(node, varName, valueExpr) {
    this._emitLoopValueAssignment(node, varName, valueExpr);
  }

  _emitSyncLoopVarIterationBinding(varName, valueExpr) {
    this.compiler.frameOps.emitFrameSet(varName, valueExpr);
  }

  _emitSyncLegacyLoopParamBinding(name, valueExpr, frame) {
    this.compiler.frameOps.setFrameValue(frame, name, name);
    this.compiler.frameOps.emitFrameSet(name, valueExpr);
  }

  _emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast) {
    this.compiler.emit.line(
      `${this.compiler.buffer.currentBuffer}.add(runtime.setLoopValueBindings('${node.loopRuntimeName}', ${loopIndex}, ${loopLength}, ${isLast}, {lineno: ${node.lineno}, colno: ${node.colno}}), '${node.loopRuntimeName}');`
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

    bindings.forEach((b) => {
      this._emitSyncLegacyLoopMetaBinding(b.name, b.val);
    });
  }

  _emitSyncLegacyLoopMetaBinding(name, valueExpr) {
    this.compiler.frameOps.emitFrameSet(`loop.${name}`, valueExpr);
  }

  _compileSyncLegacyCallbackLoop(node, frame, parallel) {
    let i, len, arr, asyncMethod;

    i = this.compiler._tmpid();
    len = this.compiler._tmpid();
    arr = this.compiler._tmpid();
    asyncMethod = parallel ? 'asyncAll' : 'asyncEach';

    frame = this.compiler.frameOps.pushFrame(frame);

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
        this._emitSyncLegacyLoopParamBinding(id, id, frame);
      });
    } else {
      const id = node.name.value;
      this.compiler.emit.line(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      this._emitSyncLegacyLoopParamBinding(id, id, frame);
    }

    this._compileSyncLegacyCallbackLoopBindings(node, arr, i, len);

    this.compiler.emit.withScopedSyntax(() => {
      if (parallel) {
        this.compiler.emit.managedBlock(frame, false, true, (managedFrame, buf) => {
          this.compiler.compile(node.body, managedFrame);
          this.compiler.emit.line('next(' + i + ',' + buf + ');');
        }, undefined, node.body);
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

    frame = this.compiler.frameOps.popFrame(frame);
  }

  compileAsyncEach(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileAsyncForCore(node, frame, { sequentialLoopBody: true });
      return;
    }
    this._compileSyncLegacyCallbackLoop(node, frame, false);
  }

  compileAsyncAll(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileAsyncForCore(node, frame, { sequentialLoopBody: false });
      return;
    }
    this._compileSyncLegacyCallbackLoop(node, frame, true);
  }
}

module.exports = CompileLoop;
