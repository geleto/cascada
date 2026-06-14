
import {WAITED_CHAIN_NAME} from './reserved.js';

class CompileBoundaries {
  constructor(compiler) {
    this.compiler = compiler;
  }

  _withBoundaryBufferState(bufferCompiler, {
    bufferExpr,
    textChainVar = null,
    textChainName = bufferCompiler.currentTextChainName
  }, emitBody) {
    bufferCompiler.withBufferState({
      currentBuffer: bufferExpr,
      currentTextChainVar: textChainVar,
      currentTextChainName: textChainName
    }, emitBody);
  }

  _emitTextChainSnapshot(bufferExpr, chainName, positionNode, resultId) {
    this.compiler.emit.line(
      `let ${resultId} = ${bufferExpr}.addCommand(new runtime.SnapshotCommand({ chainName: "${chainName}", errorContext: ${this.compiler.emitErrorContext(positionNode)} }), "${chainName}");`
    );
  }

  _emitBoundaryCallback(prefix, callbackParams, emitBody, suffix, { asyncCallback = false } = {}) {
    const asyncPrefix = asyncCallback ? 'async ' : '';
    this.compiler.emit(`${prefix}${asyncPrefix}${callbackParams} => {`);
    emitBody();
    this.compiler.emit(suffix);
  }

  compileExpressionControlFlowBoundary(bufferCompiler, node, emitBody, stackFields = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const {
      linkedChainsArg,
      linkedMutatedChainsArg
    } = this.compiler.emit.getBoundaryLinkedChainArgs(node);

    // Reserve a structural child buffer synchronously before any async
    // condition/operand resolution so later sibling operands stay ordered.
    // Expression boundaries must return a value/rejection to their expression
    // consumer; control-flow boundaries report errors through reportError instead.
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode: node,
      stackFields
    });
    this.compiler.emit(`runtime.runValueBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, async (currentBuffer) => {`);
    bufferCompiler.withBufferState({ currentBuffer: 'currentBuffer' }, () => {
      emitBody.call(this.compiler);
    });
    this.compiler.emit(`}, ${bufferStackErrorContextArg})`);
  }

  compileValueBoundary(bufferCompiler, node, emitValue, positionNode = node, stackFields = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer || 'null';
    const {
      linkedChainsArg,
      linkedMutatedChainsArg
    } = this.compiler.emit.getBoundaryLinkedChainArgs(node);
    const resultId = this.compiler._tmpid();
    const errorContextArg = this.compiler.emitErrorContext(positionNode);
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode: positionNode,
      stackFields
    });

    this.compiler.emit.line(
      `runtime.runValueBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, async (currentBuffer) => {`
    );

    bufferCompiler.withBufferState({
      currentBuffer: 'currentBuffer',
      currentTextChainVar: null
    }, () => {
      this.compiler.emit.line('try {');
      this.compiler.emit(`  let ${resultId} = `);
      emitValue.call(this.compiler, node);
      this.compiler.emit.line(';');
      this.compiler.emit.line(`  return await ${resultId};`);
      this.compiler.emit.line('} catch (e) {');
      this.compiler.emit.line(`  runtime.rethrowPoisonOrReport(e, ${errorContextArg});`);
      this.compiler.emit.line('}');
      this.compiler.emit.line(`}, ${bufferStackErrorContextArg})`);
    });
  }

  compileAsyncControlFlowBoundary(bufferCompiler, node, emitFunc = null, errorContextNode = node, stackFields = {}, options = {}) {
    if (bufferCompiler.currentWaitedChainName) {
      return this._compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc, errorContextNode, stackFields, options);
    }

    const parentBufferArg = bufferCompiler.currentBuffer;
    const {
      linkedChainsArg,
      linkedMutatedChainsArg
    } = this.compiler.emit.getBoundaryLinkedChainArgs(node);
    const controlFlowPromiseId = this.compiler._tmpid();
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode,
      stackFields,
      owned: true
    });

    this._emitBoundaryCallback(
      `let ${controlFlowPromiseId} = runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, `,
      '(currentBuffer)',
      () => {
        bufferCompiler.withBufferState({
          currentBuffer: 'currentBuffer',
          currentWaitedChainName: bufferCompiler.currentWaitedChainName,
          currentWaitedOwnerBuffer: bufferCompiler.currentWaitedOwnerBuffer
        }, () => {
          if (emitFunc) {
            emitFunc();
          }
        });
      },
      `}, ${bufferStackErrorContextArg});\n`,
      options
    );
    bufferCompiler.emitLimitedLoopCompletion(controlFlowPromiseId, node);
    return {};
  }

  _compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc = null, errorContextNode = node, stackFields = {}, options = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const {
      linkedChainsArg,
      linkedMutatedChainsArg
    } = this.compiler.emit.getBoundaryLinkedChainArgs(node);
    const controlFlowWaitedChainName = WAITED_CHAIN_NAME;
    const controlFlowWaitedOwnerBufferId = this.compiler._tmpid();
    const controlFlowPromiseId = this.compiler._tmpid();
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode,
      stackFields,
      owned: true
    });

    this._emitBoundaryCallback(
      `let ${controlFlowPromiseId} = runtime.runWaitedControlFlowBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, `,
      '(currentBuffer)',
      () => {
        bufferCompiler.withBufferState({
          currentBuffer: 'currentBuffer',
          currentWaitedChainName: controlFlowWaitedChainName,
          currentWaitedOwnerBuffer: controlFlowWaitedOwnerBufferId
        }, () => {
          this.compiler.emit.line(`runtime.declareBufferChain(currentBuffer, "${controlFlowWaitedChainName}", "var", context, null);`);
          this.compiler.emit.line(`const ${controlFlowWaitedOwnerBufferId} = currentBuffer;`);

          if (emitFunc) {
            emitFunc();
          }
        });
      },
      `}, "${controlFlowWaitedChainName}", ${bufferStackErrorContextArg});\n`,
      options
    );
    bufferCompiler.emitLimitedLoopCompletion(controlFlowPromiseId, node);
    return {};
  }

  _compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, callbackName, positionNode = node, stackFields = {}) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode: positionNode,
      stackFields
    });
    emitCompiler.line('runtime.runRenderBoundary(context, renderState, (currentBuffer) =>{');
    const resultId = this.compiler._tmpid();

    const textChainName = this.compiler.buffer.currentTextChainName;
    emitCompiler.line(`let ${resultId}_textChainVar = runtime.declareBufferChain(currentBuffer, "${textChainName}", "text", context, null);`);

    this._withBoundaryBufferState(this.compiler.buffer, {
      bufferExpr: 'currentBuffer',
      textChainVar: `${resultId}_textChainVar`,
      textChainName
    }, () => {
      if (this.compiler.scriptMode) {
        this.compiler.return.emitDeclareChain('currentBuffer');
        innerBodyFunction.call(this.compiler);
      } else {
        innerBodyFunction.call(this.compiler);
      }
    });

    if (this.compiler.scriptMode) {
      this.compiler.return.emitFinalSnapshot('currentBuffer', resultId);
    } else {
      this._emitTextChainSnapshot('currentBuffer', textChainName, positionNode, resultId);
    }

    emitCallbackResult(resultId);
    emitCompiler.line(`  return ${resultId};`);
    emitCompiler.line(`}, ${bufferStackErrorContextArg}, ${this.compiler.buffer.currentBuffer})`);
  }

  _compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    const { bufferId: id } = emitCompiler.withScopeCommandBuffer({
      frame,
      analysisNode: node,
      emitFunc: (blockFrame) => {
        innerBodyFunction.call(this.compiler, blockFrame);
      }
    });
    emitCallbackResult(id);
    emitCompiler.line(`return ${id};`);
  }

  compileAsyncRenderBoundary(emitCompiler, node, innerBodyFunction, positionNode = node, stackFields = {}) {
    return this._compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, null, positionNode, stackFields);
  }

  compileAsyncCallbackRenderBoundary(emitCompiler, node, innerBodyFunction, callbackName, positionNode = node, stackFields = {}) {
    return this._compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, callbackName, positionNode, stackFields);
  }

  compileSyncRenderBoundary(emitCompiler, node, frame, innerBodyFunction, positionNode = node) {
    return this._compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, null, positionNode);
  }

  compileSyncCallbackRenderBoundary(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    return this._compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode);
  }

  // Render boundaries create isolated render buffers. Their current text lane
  // is owned by the boundary even when the source fragment has no explicit text
  _emitBoundaryTextCommand(
    bufferCompiler,
    resultId,
    positionNode,
    targetChainName,
    targetBufferExpr = 'currentBuffer',
    normalizeTextArgs = false
  ) {
    const valueExpr = bufferCompiler._emitTemplateTextCommandExpression(resultId, positionNode, normalizeTextArgs);
    this.compiler.emit.line(`${targetBufferExpr}.addCommand(${valueExpr}, "${targetChainName}");`);
  }

  _compileAsyncTextBoundary(
    bufferCompiler,
    {
      parentBufferExpr = bufferCompiler.currentBuffer,
      linkedChainsArg,
      linkedMutatedChainsArg = 'null',
      callbackParams,
      targetChainName,
      targetBufferExpr,
      positionNode,
      normalizeTextArgs = false,
      waitedPositionNode = null,
      stackFields = {},
      emitBody
    }
  ) {
    const boundaryPromiseId = waitedPositionNode ? this.compiler._tmpid() : null;
    const boundaryPrefix = boundaryPromiseId ? `const ${boundaryPromiseId} = ` : '';
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode: positionNode,
      stackFields
    });

    this._emitBoundaryCallback(
      `${boundaryPrefix}runtime.runControlFlowBoundary(${parentBufferExpr}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, `,
      callbackParams,
      () => {
        emitBody();
        this._emitBoundaryTextCommand(
          bufferCompiler,
          emitBody.resultId,
          positionNode,
          targetChainName,
          targetBufferExpr,
          normalizeTextArgs
        );
      },
      `}, ${bufferStackErrorContextArg});\n`
    );

    if (boundaryPromiseId) {
      bufferCompiler.emitLimitedLoopCompletion(boundaryPromiseId, waitedPositionNode);
    }

    return null;
  }

  compileSyncTextBoundary(bufferCompiler, node, frame, positionNode = node, emitValue) {
    this.compiler.emit(`${bufferCompiler.currentBuffer} += `);
    emitValue(frame, null);
    this.compiler.emit.line(';');
    return frame;
  }

  compileAsyncTextBoundary(bufferCompiler, node, positionNode = node, emitValue, {
    emitInCurrentBuffer = false,
    waitedPositionNode = positionNode,
    stackFields = {}
  } = {}) {
    const valueId = this.compiler._tmpid();
    const emitBody = () => {
      const emitBufferExpr = emitInCurrentBuffer ? 'currentBuffer' : bufferCompiler.currentBuffer;
      this._withBoundaryBufferState(bufferCompiler, {
        bufferExpr: emitBufferExpr,
        textChainVar: null
      }, () => {
        this.compiler.emit(`let ${valueId} = `);
        emitValue(null, valueId);
        this.compiler.emit.line(';');
      });
    };
    emitBody.resultId = valueId;

    return this._compileAsyncTextBoundary(bufferCompiler, {
      parentBufferExpr: bufferCompiler.currentBuffer,
      ...this.compiler.emit.getBoundaryLinkedChainArgs(node),
      callbackParams: '(currentBuffer)',
      targetChainName: bufferCompiler.currentTextChainName,
      targetBufferExpr: 'currentBuffer',
      positionNode,
      normalizeTextArgs: true,
      waitedPositionNode,
      stackFields,
      emitBody
    });
  }

  compileCaptureBoundary(bufferCompiler, node, innerBodyFunction, positionNode = node, stackFields = {}) {
    const captureTextOutputName = node._analysis.textOutput;
    const {
      linkedChainsArg,
      linkedMutatedChainsArg
    } = this.compiler.emit.getBoundaryLinkedChainArgs(node);
    const outerParentBuffer = bufferCompiler.currentBuffer;
    const bufferStackErrorContextArg = this.compiler.emit.getBufferStackErrorContextArg({
      errorContextNode: positionNode,
      stackFields
    });

    this._emitBoundaryCallback(
      `runtime.runControlFlowBoundary(${outerParentBuffer}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, `,
      '(currentBuffer)',
      () => {
        this._withBoundaryBufferState(bufferCompiler, {
          bufferExpr: 'currentBuffer',
          textChainVar: 'output_textChainVar',
          textChainName: captureTextOutputName
        }, () => {
          // Capture owns a separate text tree. The child buffer exists for that
          // boundary, not because capture text values need pre-resolution.
          this.compiler.emit.line('let output = currentBuffer;');
          this.compiler.emit.line(`let output_textChainVar = runtime.declareBufferChain(currentBuffer, "${captureTextOutputName}", "text", context, null);`);

          innerBodyFunction.call(this.compiler);
          this._emitTextChainSnapshot('currentBuffer', captureTextOutputName, positionNode, 'captureResult');
          this.compiler.emit.line('return captureResult;');
        });
      },
      `}, ${bufferStackErrorContextArg})`
    );

  }

}

export {CompileBoundaries};
