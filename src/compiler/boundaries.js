'use strict';

class CompileBoundaries {
  constructor(compiler) {
    this.compiler = compiler;
  }

  _withBoundaryBufferState(bufferCompiler, {
    bufferExpr,
    textChannelVar = null,
    textChannelName = bufferCompiler.currentTextChannelName
  }, emitBody) {
    bufferCompiler.withBufferState({
      currentBuffer: bufferExpr,
      currentTextChannelVar: textChannelVar,
      currentTextChannelName: textChannelName
    }, emitBody);
  }

  _emitTextChannelSnapshot(bufferExpr, channelName, positionNode, resultId) {
    this.compiler.emit.line(
      `let ${resultId} = ${bufferExpr}.addSnapshot("${channelName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`
    );
  }

  compileExpressionControlFlowBoundary(bufferCompiler, node, emitBody) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);

    // Reserve a structural child buffer synchronously before any async
    // condition/operand resolution so later sibling operands stay ordered.
    // Expression boundaries must return a value/rejection to their expression
    // consumer; control-flow boundaries report errors through cb instead.
    this.compiler.emit(`runtime.runValueBoundary(${parentBufferArg}, ${linkedChannelsArg}, async (currentBuffer) => {`);
    this.compiler.emit.asyncClosureDepth++;
    bufferCompiler.withBufferState({ currentBuffer: 'currentBuffer' }, () => {
      emitBody.call(this.compiler);
    });
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit('})');
  }

  compileValueBoundary(bufferCompiler, node, emitValue, positionNode = node) {
    const parentBufferArg = bufferCompiler.currentBuffer || 'null';
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const resultId = this.compiler._tmpid();

    this.compiler.emit.line(
      `runtime.runValueBoundary(${parentBufferArg}, ${linkedChannelsArg}, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    bufferCompiler.withBufferState({
      currentBuffer: 'currentBuffer',
      currentTextChannelVar: null
    }, () => {
      this.compiler.emit.line('try {');
      this.compiler.emit(`  let ${resultId} = `);
      emitValue.call(this.compiler, node);
      this.compiler.emit.line(';');
      this.compiler.emit.line(`  return await ${resultId};`);
      this.compiler.emit.line('} catch (e) {');
      this.compiler.emit.line(
        `  const err = runtime.isPoisonError(e) ? e : new runtime.PoisonError(e, ${positionNode.lineno}, ${positionNode.colno}, "${this.compiler._generateErrorContext(node, positionNode)}", context.path);`
      );
      this.compiler.emit.line('  throw err;');
      this.compiler.emit.line('}');
      this.compiler.emit.line('})');
    });
    this.compiler.emit.asyncClosureDepth--;
  }

  compileAsyncControlFlowBoundary(bufferCompiler, node, emitFunc = null) {
    if (bufferCompiler.currentWaitedChannelName) {
      return this._compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc);
    }

    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const controlFlowPromiseId = this.compiler._tmpid();

    this.compiler.emit(
      `let ${controlFlowPromiseId} = runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    bufferCompiler.withBufferState({
      currentBuffer: 'currentBuffer',
      currentWaitedChannelName: bufferCompiler.currentWaitedChannelName,
      currentWaitedOwnerBuffer: bufferCompiler.currentWaitedOwnerBuffer
    }, () => {
      if (emitFunc) {
        emitFunc();
      }
    });
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line('});');
    bufferCompiler.emitOwnWaitedConcurrencyResolve(controlFlowPromiseId, node);
    return {};
  }

  _compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc = null) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const controlFlowWaitedChannelName = `__waited__${this.compiler._tmpid()}`;
    const controlFlowPromiseId = this.compiler._tmpid();

    this.compiler.emit(
      `let ${controlFlowPromiseId} = runtime.runWaitedControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    bufferCompiler.withBufferState({
      currentBuffer: 'currentBuffer',
      currentWaitedChannelName: controlFlowWaitedChannelName,
      currentWaitedOwnerBuffer: 'currentBuffer'
    }, () => {
      this.compiler.emit.line(`runtime.declareBufferChannel(currentBuffer, "${controlFlowWaitedChannelName}", "var", context, null);`);

      if (emitFunc) {
        emitFunc();
      }
    });
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line(`}, "${controlFlowWaitedChannelName}");`);
    bufferCompiler.emitOwnWaitedConcurrencyResolve(controlFlowPromiseId, node);
    return {};
  }

  compileSyncControlFlowBoundary(bufferCompiler, node, frame, emitFunc = null) {
    if (typeof emitFunc === 'function') {
      emitFunc(frame, bufferCompiler.currentBuffer);
    }
    return { frame };
  }

  _compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, callbackName, positionNode = node) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    emitCompiler.line(`runtime.runRenderBoundary(context, cb, async (currentBuffer) =>{`);
    const resultId = this.compiler._tmpid();

    const textChannelName = this.compiler.buffer.currentTextChannelName;
    emitCompiler.line(`let ${resultId}_textChannelVar = runtime.declareBufferChannel(currentBuffer, "${textChannelName}", "text", context, null);`);

    const originalAsyncClosureDepth = emitCompiler.asyncClosureDepth;
    emitCompiler.asyncClosureDepth = 0;

    this._withBoundaryBufferState(this.compiler.buffer, {
      bufferExpr: 'currentBuffer',
      textChannelVar: `${resultId}_textChannelVar`,
      textChannelName
    }, () => {
      if (this.compiler.scriptMode) {
        this.compiler.return.emitDeclareChannel('currentBuffer');
        innerBodyFunction.call(this.compiler);
      } else {
        innerBodyFunction.call(this.compiler);
      }
    });

    emitCompiler.asyncClosureDepth = originalAsyncClosureDepth;

    if (this.compiler.scriptMode) {
      this.compiler.return.emitFinalSnapshot('currentBuffer', resultId);
    } else {
      this._emitTextChannelSnapshot('currentBuffer', textChannelName, positionNode, resultId);
    }

    emitCallbackResult(resultId);
    emitCompiler.line(`  return ${resultId};`);
    emitCompiler.line('})');
  }

  _compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    const { bufferId: id } = emitCompiler.managedBlock(frame, false, true, (blockFrame) => {
      innerBodyFunction.call(this.compiler, blockFrame);
    }, undefined, node);
    emitCallbackResult(id);
    emitCompiler.line(`return ${id};`);
  }

  compileAsyncRenderBoundary(emitCompiler, node, innerBodyFunction, positionNode = node) {
    return this._compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, null, positionNode);
  }

  compileAsyncCallbackRenderBoundary(emitCompiler, node, innerBodyFunction, callbackName, positionNode = node) {
    return this._compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, callbackName, positionNode);
  }

  compileSyncRenderBoundary(emitCompiler, node, frame, innerBodyFunction, positionNode = node) {
    return this._compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, null, positionNode);
  }

  compileSyncCallbackRenderBoundary(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    return this._compileSyncRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode);
  }

  _emitBoundaryTextCommand(
    bufferCompiler,
    resultId,
    positionNode,
    targetChannelName,
    targetBufferExpr = 'currentBuffer',
    normalizeTextArgs = false
  ) {
    const valueExpr = bufferCompiler._emitTemplateTextCommandExpression(resultId, positionNode, normalizeTextArgs);
    this.compiler.emit.line(`${targetBufferExpr}.add(${valueExpr}, "${targetChannelName}");`);
  }

  _compileAsyncTextBoundary(
    bufferCompiler,
    {
      parentBufferExpr = bufferCompiler.currentBuffer,
      linkedChannelsArg,
      callbackParams,
      targetChannelName,
      targetBufferExpr,
      positionNode,
      normalizeTextArgs = false,
      waitedPositionNode = null,
      emitBody
    }
  ) {
    const boundaryPromiseId = waitedPositionNode ? this.compiler._tmpid() : null;
    const boundaryPrefix = boundaryPromiseId ? `const ${boundaryPromiseId} = ` : '';

    this.compiler.emit.line(
      `${boundaryPrefix}runtime.runControlFlowBoundary(${parentBufferExpr}, ${linkedChannelsArg}, context, cb, async ${callbackParams} => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    emitBody();
    this._emitBoundaryTextCommand(
      bufferCompiler,
      emitBody.resultId,
      positionNode,
      targetChannelName,
      targetBufferExpr,
      normalizeTextArgs
    );

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line('});');

    if (boundaryPromiseId) {
      bufferCompiler.emitOwnWaitedConcurrencyResolve(boundaryPromiseId, waitedPositionNode);
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
    waitedPositionNode = positionNode
  } = {}) {
    const valueId = this.compiler._tmpid();
    const emitBody = () => {
      const emitBufferExpr = emitInCurrentBuffer ? 'currentBuffer' : bufferCompiler.currentBuffer;
      this._withBoundaryBufferState(bufferCompiler, {
        bufferExpr: emitBufferExpr,
        textChannelVar: null
      }, () => {
        this.compiler.emit(`let ${valueId} = `);
        emitValue(null, valueId);
        this.compiler.emit.line(';');
      });
    };
    emitBody.resultId = valueId;

    return this._compileAsyncTextBoundary(bufferCompiler, {
      parentBufferExpr: bufferCompiler.currentBuffer,
      linkedChannelsArg: this.compiler.emit.getLinkedChannelsArg(node),
      callbackParams: '(currentBuffer)',
      targetChannelName: bufferCompiler.currentTextChannelName,
      targetBufferExpr: 'currentBuffer',
      positionNode,
      normalizeTextArgs: true,
      waitedPositionNode,
      emitBody
    });
  }

  compileBlockTextBoundary(bufferCompiler, node, emitValue) {
    const positionNode = node;
    const valueId = this.compiler._tmpid();
    const emitBody = () => {
      this._withBoundaryBufferState(bufferCompiler, {
        bufferExpr: bufferCompiler.currentBuffer,
        textChannelVar: null
      }, () => {
        emitValue(valueId);
      });
    };
    emitBody.resultId = valueId;

    this._compileAsyncTextBoundary(bufferCompiler, {
      parentBufferExpr: bufferCompiler.currentBuffer,
      linkedChannelsArg: JSON.stringify([bufferCompiler.currentTextChannelName]),
      callbackParams: '(blockBuffer)',
      targetChannelName: bufferCompiler.currentTextChannelName,
      targetBufferExpr: 'blockBuffer',
      positionNode,
      normalizeTextArgs: false,
      waitedPositionNode: null,
      emitBody
    });
  }

  compileCaptureBoundary(bufferCompiler, node, innerBodyFunction, positionNode = node) {
    const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const outerParentBuffer = bufferCompiler.currentBuffer;

    this.compiler.emit(
      `runtime.runControlFlowBoundary(${outerParentBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    this._withBoundaryBufferState(bufferCompiler, {
      bufferExpr: 'currentBuffer',
      textChannelVar: 'output_textChannelVar',
      textChannelName: captureTextOutputName
    }, () => {
      // Capture owns a separate text tree. The child buffer exists for that
      // boundary, not because capture text values need pre-resolution.
      this.compiler.emit.line('let output = currentBuffer;');
      this.compiler.emit.line(`let output_textChannelVar = runtime.declareBufferChannel(currentBuffer, "${captureTextOutputName}", "text", context, null);`);

      innerBodyFunction.call(this.compiler);
      this._emitTextChannelSnapshot('currentBuffer', captureTextOutputName, positionNode, 'captureResult');
      this.compiler.emit.line('return captureResult;');
    });

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit('})');

  }
}

export default CompileBoundaries;
