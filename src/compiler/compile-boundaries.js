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
    const prevBuffer = bufferCompiler.currentBuffer;
    const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
    const prevTextChannelName = bufferCompiler.currentTextChannelName;

    bufferCompiler.currentBuffer = bufferExpr;
    bufferCompiler.currentTextChannelVar = textChannelVar;
    bufferCompiler.currentTextChannelName = textChannelName;

    emitBody();

    bufferCompiler.currentBuffer = prevBuffer;
    bufferCompiler.currentTextChannelVar = prevTextChannelVar;
    bufferCompiler.currentTextChannelName = prevTextChannelName;
  }

  _emitTextChannelSnapshot(bufferExpr, channelName, positionNode, resultId) {
    this.compiler.emit.line(
      `let ${resultId} = ${bufferExpr}.addSnapshot("${channelName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`
    );
  }

  compileExpressionControlFlowBoundary(bufferCompiler, node, emitBody) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const prevBuffer = bufferCompiler.currentBuffer;

    // Reserve a structural child buffer synchronously before any async
    // condition/operand resolution so later sibling operands stay ordered.
    this.compiler.emit(`runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`);
    this.compiler.emit.asyncClosureDepth++;
    bufferCompiler.currentBuffer = 'currentBuffer';

    emitBody.call(this.compiler);

    bufferCompiler.currentBuffer = prevBuffer;
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

    const prevBuffer = bufferCompiler.currentBuffer;
    const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
    bufferCompiler.currentBuffer = 'currentBuffer';
    bufferCompiler.currentTextChannelVar = null;

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

    bufferCompiler.currentBuffer = prevBuffer;
    bufferCompiler.currentTextChannelVar = prevTextChannelVar;
    this.compiler.emit.asyncClosureDepth--;
  }

  compileControlFlowBoundary(bufferCompiler, node, frame, emitFunc = null) {
    if (this.compiler.asyncMode) {
      const parentBufferArg = bufferCompiler.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
      const trackAsSingleWaitedUnit = this.compiler.asyncMode && !!bufferCompiler.currentWaitedChannelName;
      const controlFlowWaitedChannelName = trackAsSingleWaitedUnit ? `__waited__${this.compiler._tmpid()}` : null;
      const controlFlowPromiseId = this.compiler._tmpid();
      const boundaryRunner = controlFlowWaitedChannelName
        ? 'runtime.runWaitedControlFlowBoundary'
        : 'runtime.runControlFlowBoundary';

      this.compiler.emit(
        `let ${controlFlowPromiseId} = ${boundaryRunner}(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
      );
      this.compiler.emit.asyncClosureDepth++;

      const newFrame = frame;

      const prevBuffer = bufferCompiler.currentBuffer;
      const prevWaitedChannelName = bufferCompiler.currentWaitedChannelName;
      const prevWaitedOwnerBuffer = bufferCompiler.currentWaitedOwnerBuffer;
      bufferCompiler.currentBuffer = 'currentBuffer';
      if (trackAsSingleWaitedUnit) {
        bufferCompiler.currentWaitedChannelName = controlFlowWaitedChannelName;
        bufferCompiler.currentWaitedOwnerBuffer = 'currentBuffer';
        this.compiler.emit.line(`runtime.declareBufferChannel(currentBuffer, "${controlFlowWaitedChannelName}", "var", context, null);`);
      }

      if (emitFunc) {
        emitFunc(newFrame, 'currentBuffer');
      }
      this.compiler.emit.asyncClosureDepth--;
      if (controlFlowWaitedChannelName) {
        this.compiler.emit.line(`}, "${controlFlowWaitedChannelName}");`);
      } else {
        this.compiler.emit.line('});');
      }
      bufferCompiler.currentBuffer = prevBuffer;
      bufferCompiler.currentWaitedChannelName = prevWaitedChannelName;
      bufferCompiler.currentWaitedOwnerBuffer = prevWaitedOwnerBuffer;
      if (controlFlowPromiseId) {
        bufferCompiler.emitOwnWaitedConcurrencyResolve(controlFlowPromiseId, node);
      }
      return { frame: newFrame };
    }

    if (typeof emitFunc === 'function') {
      emitFunc(frame, bufferCompiler.currentBuffer);
    }
    return { frame };
  }

  _compileRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    if (!this.compiler.asyncMode) {
      const { bufferId: id } = emitCompiler.managedBlock(frame, false, true, (blockFrame) => {
        innerBodyFunction.call(this.compiler, blockFrame);
      }, undefined, node);
      emitCallbackResult(id);
      emitCompiler.line(`return ${id};`);
      return;
    }

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
        this.compiler.emitDeclareReturnChannel(frame, 'currentBuffer');
        innerBodyFunction.call(this.compiler, frame);
      } else {
        innerBodyFunction.call(this.compiler, frame);
      }
    });

    emitCompiler.asyncClosureDepth = originalAsyncClosureDepth;

    if (this.compiler.scriptMode) {
      this.compiler.emitReturnChannelSnapshot('currentBuffer', positionNode, resultId);
    } else {
      this._emitTextChannelSnapshot('currentBuffer', textChannelName, positionNode, resultId);
    }

    emitCallbackResult(resultId);
    emitCompiler.line(`  return ${resultId};`);
    emitCompiler.line('})');
  }

  compileRenderBoundary(emitCompiler, node, frame, innerBodyFunction, positionNode = node) {
    return this._compileRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, null, positionNode);
  }

  compileCallbackRenderBoundary(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode = node) {
    return this._compileRenderBoundaryImpl(emitCompiler, node, frame, innerBodyFunction, callbackName, positionNode);
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
    frame,
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

    const innerFrame = frame;
    emitBody(innerFrame);
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

    return innerFrame;
  }

  compileTextBoundary(bufferCompiler, node, frame, positionNode = node, emitValue, {
    emitInCurrentBuffer = false,
    waitedPositionNode = positionNode
  } = {}) {
    if (!this.compiler.asyncMode) {
      this.compiler.emit(`${bufferCompiler.currentBuffer} += `);
      emitValue(frame, null);
      this.compiler.emit.line(';');
      return frame;
    }

    const valueId = this.compiler._tmpid();
    const emitBody = (innerFrame) => {
      const emitBufferExpr = emitInCurrentBuffer ? 'currentBuffer' : bufferCompiler.currentBuffer;
      this._withBoundaryBufferState(bufferCompiler, {
        bufferExpr: emitBufferExpr,
        textChannelVar: null
      }, () => {
        this.compiler.emit(`let ${valueId} = `);
        emitValue(innerFrame, valueId);
        this.compiler.emit.line(';');
      });
    };
    emitBody.resultId = valueId;

    return this._compileAsyncTextBoundary(bufferCompiler, frame, {
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

  compileBlockTextBoundary(bufferCompiler, node, frame, emitValue) {
    const positionNode = node;
    const valueId = this.compiler._tmpid();
    const emitBody = (innerFrame) => {
      this._withBoundaryBufferState(bufferCompiler, {
        bufferExpr: bufferCompiler.currentBuffer,
        textChannelVar: null
      }, () => {
        emitValue(innerFrame, valueId);
      });
    };
    emitBody.resultId = valueId;

    return this._compileAsyncTextBoundary(bufferCompiler, frame, {
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

  compileCaptureBoundary(bufferCompiler, node, frame, innerBodyFunction, positionNode = node) {
    const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
    const outerParentBuffer = bufferCompiler.currentBuffer;

    this.compiler.emit(
      `runtime.runControlFlowBoundary(${outerParentBuffer}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame;
    this._withBoundaryBufferState(bufferCompiler, {
      bufferExpr: 'currentBuffer',
      textChannelVar: 'output_textChannelVar',
      textChannelName: captureTextOutputName
    }, () => {
      // Capture owns a separate text tree. The child buffer exists for that
      // boundary, not because capture text values need pre-resolution.
      this.compiler.emit.line('let output = currentBuffer;');
      this.compiler.emit.line(`let output_textChannelVar = runtime.declareBufferChannel(currentBuffer, "${captureTextOutputName}", "text", context, null);`);

      innerBodyFunction.call(this.compiler, innerFrame);
      this._emitTextChannelSnapshot('currentBuffer', captureTextOutputName, positionNode, 'captureResult');
      this.compiler.emit.line('return captureResult;');
    });

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit('})');

    return { frame: innerFrame };
  }
}

module.exports = CompileBoundaries;
