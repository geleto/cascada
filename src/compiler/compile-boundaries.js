'use strict';

const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
} = require('./validation');

class CompileBoundaries {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileExpressionControlFlowBoundary(bufferCompiler, node, frame, emitBody) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
    const prevBuffer = bufferCompiler.currentBuffer;

    // Reserve a structural child buffer synchronously before any async
    // condition/operand resolution so later sibling operands stay ordered.
    this.compiler.emit(`runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, frame, context, cb, async (frame, currentBuffer) => {`);
    this.compiler.emit.asyncClosureDepth++;
    bufferCompiler.currentBuffer = 'currentBuffer';

    emitBody.call(this.compiler, frame);

    bufferCompiler.currentBuffer = prevBuffer;
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit('})');
  }

  compileValueBoundary(bufferCompiler, node, frame, emitValue, positionNode = node) {
    const parentBufferArg = bufferCompiler.currentBuffer || 'null';
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
    const resultId = this.compiler._tmpid();

    this.compiler.emit.line(
      `runtime.runValueBoundary(${parentBufferArg}, ${linkedChannelsArg}, frame, cb, async (frame, currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame.push(false, false);
    trackCompileTimeFrameDepth(innerFrame, frame);
    const prevBuffer = bufferCompiler.currentBuffer;
    const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
    bufferCompiler.currentBuffer = 'currentBuffer';
    bufferCompiler.currentTextChannelVar = null;

    this.compiler.emit.line('try {');
    this.compiler.emit(`  let ${resultId} = `);
    emitValue.call(this.compiler, node, innerFrame);
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
    validateCompileTimeFrameBalance(innerFrame, this.compiler, positionNode);
  }

  compileControlFlowBoundary(bufferCompiler, node, frame, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = bufferCompiler.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
      const trackAsSingleWaitedUnit = this.compiler.asyncMode && !!bufferCompiler.currentWaitedChannelName;
      const controlFlowWaitedChannelName = trackAsSingleWaitedUnit ? `__waited__${this.compiler._tmpid()}` : null;
      const controlFlowPromiseId = this.compiler._tmpid();
      const boundaryRunner = controlFlowWaitedChannelName
        ? 'runtime.runWaitedControlFlowBoundary'
        : 'runtime.runControlFlowBoundary';

      this.compiler.emit(
        `let ${controlFlowPromiseId} = ${boundaryRunner}(${parentBufferArg}, ${linkedChannelsArg}, frame, context, cb, async (frame, currentBuffer) => {`
      );
      this.compiler.emit.asyncClosureDepth++;

      const newFrame = frame.push(false, false);
      trackCompileTimeFrameDepth(newFrame, frame);

      const prevBuffer = bufferCompiler.currentBuffer;
      const prevWaitedChannelName = bufferCompiler.currentWaitedChannelName;
      const prevWaitedOwnerBuffer = bufferCompiler.currentWaitedOwnerBuffer;
      bufferCompiler.currentBuffer = 'currentBuffer';
      if (trackAsSingleWaitedUnit) {
        bufferCompiler.currentWaitedChannelName = controlFlowWaitedChannelName;
        bufferCompiler.currentWaitedOwnerBuffer = 'currentBuffer';
        this.compiler.emit.line(`runtime.declareChannel(frame, currentBuffer, "${controlFlowWaitedChannelName}", "var", context, null);`);
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
        bufferCompiler.emitOwnWaitedConcurrencyResolve(frame, controlFlowPromiseId, node);
      }
      validateCompileTimeFrameBalance(newFrame, this.compiler, node);
      return { frame: newFrame.pop() };
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

    if (!node.isAsync) {
      const { bufferId: id } = emitCompiler.managedBlock(frame, false, true, (blockFrame) => {
        innerBodyFunction.call(this.compiler, blockFrame);
      }, undefined, node);
      if (this.compiler.asyncMode) {
        emitCompiler.line(`${id}.markFinishedAndPatchLinks();`);
      }
      emitCallbackResult(id);
      emitCompiler.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);
    emitCompiler.line(`runtime.runRenderBoundary(frame, context, cb, async (frame, currentBuffer) =>{`);
    const resultId = this.compiler._tmpid();

    const textChannelName = this.compiler.buffer.currentTextChannelName;
    emitCompiler.line(`let ${resultId}_textChannelVar = runtime.declareChannel(frame, currentBuffer, "${textChannelName}", "text", context, null);`);
    const prevBuffer = this.compiler.buffer.currentBuffer;
    const prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
    const prevTextChannelName = this.compiler.buffer.currentTextChannelName;
    this.compiler.buffer.currentBuffer = 'currentBuffer';
    this.compiler.buffer.currentTextChannelVar = `${resultId}_textChannelVar`;
    this.compiler.buffer.currentTextChannelName = textChannelName;

    const originalAsyncClosureDepth = emitCompiler.asyncClosureDepth;
    emitCompiler.asyncClosureDepth = 0;

    if (this.compiler.scriptMode) {
      frame._seesRootScope = false;
      frame._returnWaitCount = 1;
      this.compiler.emitDeclareReturnChannel(frame, 'currentBuffer');
      innerBodyFunction.call(this.compiler, frame);
    } else {
      innerBodyFunction.call(this.compiler, frame);
    }

    emitCompiler.asyncClosureDepth = originalAsyncClosureDepth;
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    this.compiler.buffer.currentTextChannelName = prevTextChannelName;

    if (this.compiler.scriptMode) {
      this.compiler.emitReturnChannelSnapshot('currentBuffer', positionNode, resultId);
    } else {
      emitCompiler.line(`let ${resultId} = currentBuffer.addSnapshot("${textChannelName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`);
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
      `${boundaryPrefix}runtime.runControlFlowBoundary(${parentBufferExpr}, ${linkedChannelsArg}, frame, context, cb, async ${callbackParams} => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame.push(false, false);
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
      bufferCompiler.emitOwnWaitedConcurrencyResolve(frame, boundaryPromiseId, waitedPositionNode);
    }

    return innerFrame.pop();
  }

  compileTextBoundary(
    bufferCompiler,
    node,
    frame,
    positionNode = node,
    emitValue,
    {
      parentBufferExpr = bufferCompiler.currentBuffer,
      linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame),
      callbackParams = '(frame, currentBuffer)',
      targetChannelName = bufferCompiler.currentTextChannelName,
      targetBufferExpr = 'currentBuffer',
      normalizeTextArgs = true,
      waitedPositionNode = positionNode,
      emitInCurrentBuffer = false,
      producerAssignsResult = false
    } = {}
  ) {
    if (!this.compiler.asyncMode) {
      this.compiler.emit(`${bufferCompiler.currentBuffer} += `);
      emitValue(frame, null);
      this.compiler.emit.line(';');
      return frame;
    }

    const valueId = this.compiler._tmpid();
    const emitBody = (innerFrame) => {
      const prevBuffer = bufferCompiler.currentBuffer;
      const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
      const emitBufferExpr = emitInCurrentBuffer ? 'currentBuffer' : prevBuffer;

      bufferCompiler.currentBuffer = emitBufferExpr;
      bufferCompiler.currentTextChannelVar = null;

      if (producerAssignsResult) {
        emitValue(innerFrame, valueId);
      } else {
        this.compiler.emit(`let ${valueId} = `);
        emitValue(innerFrame, valueId);
        this.compiler.emit.line(';');
      }

      bufferCompiler.currentBuffer = prevBuffer;
      bufferCompiler.currentTextChannelVar = prevTextChannelVar;
    };
    emitBody.resultId = valueId;

    return this._compileAsyncTextBoundary(bufferCompiler, frame, {
      parentBufferExpr,
      linkedChannelsArg,
      callbackParams,
      targetChannelName,
      targetBufferExpr,
      positionNode,
      normalizeTextArgs,
      waitedPositionNode,
      emitBody
    });
  }

  compileCaptureBoundary(bufferCompiler, node, frame, innerBodyFunction, positionNode = node) {
    const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
    const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
    const outerParentBuffer = bufferCompiler.currentBuffer;

    this.compiler.emit(
      `runtime.runControlFlowBoundary(${outerParentBuffer}, ${linkedChannelsArg}, frame, context, cb, async (frame, currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame.push(false, true);
    const prevBuffer = bufferCompiler.currentBuffer;
    const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
    const prevTextChannelName = bufferCompiler.currentTextChannelName;

    bufferCompiler.currentBuffer = 'currentBuffer';
    bufferCompiler.currentTextChannelVar = 'output_textChannelVar';
    bufferCompiler.currentTextChannelName = captureTextOutputName;

    // Capture owns a separate text tree. The child buffer exists for that
    // boundary, not because capture text values need pre-resolution.
    this.compiler.emit.line('let output = currentBuffer;');
    this.compiler.emit.line(`let output_textChannelVar = runtime.declareChannel(frame, currentBuffer, "${captureTextOutputName}", "text", context, null);`);

    innerBodyFunction.call(this.compiler, innerFrame);
    this.compiler.emit.line(`return currentBuffer.addSnapshot("${captureTextOutputName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`);

    bufferCompiler.currentBuffer = prevBuffer;
    bufferCompiler.currentTextChannelVar = prevTextChannelVar;
    bufferCompiler.currentTextChannelName = prevTextChannelName;

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit('})');

    return { frame: innerFrame.pop() };
  }
}

module.exports = CompileBoundaries;
