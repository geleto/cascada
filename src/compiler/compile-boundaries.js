'use strict';

const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
} = require('./validation');

class CompileBoundaries {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileControlFlowBoundary(bufferCompiler, node, frame, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = bufferCompiler.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
      const trackAsSingleWaitedUnit = this.compiler.asyncMode && !!bufferCompiler.currentWaitedChannelName;
      const controlFlowWaitedChannelName = trackAsSingleWaitedUnit ? `__waited__${this.compiler._tmpid()}` : null;
      const controlFlowPromiseId = this.compiler._tmpid();

      this.compiler.emit(
        `let ${controlFlowPromiseId} = runtime.runControlFlowBoundary(astate, ${parentBufferArg}, ${linkedChannelsArg}, frame, context, cb, async (astate, frame, currentBuffer) => {`
      );
      this.compiler.emit.asyncClosureDepth++;

      const newFrame = frame.push(false, false);
      trackCompileTimeFrameDepth(newFrame, frame);

      const prevBuffer = bufferCompiler.currentBuffer;
      const prevTextChannelVar = bufferCompiler.currentTextChannelVar;
      const prevTextChannelName = bufferCompiler.currentTextChannelName;
      const prevWaitedChannelName = bufferCompiler.currentWaitedChannelName;
      const prevWaitedOwnerBuffer = bufferCompiler.currentWaitedOwnerBuffer;
      bufferCompiler.currentBuffer = 'currentBuffer';
      if (trackAsSingleWaitedUnit) {
        bufferCompiler.currentWaitedChannelName = controlFlowWaitedChannelName;
        bufferCompiler.currentWaitedOwnerBuffer = 'currentBuffer';
        this.compiler.emit.line(`runtime.declareChannel(frame, currentBuffer, "${controlFlowWaitedChannelName}", "var", context, null);`);
      }

      const callbackValue = emitFunc ? emitFunc(newFrame, 'currentBuffer', prevBuffer) : undefined;
      this.compiler.emit.asyncClosureDepth--;
      const waitedChannelArg = controlFlowWaitedChannelName ? `"${controlFlowWaitedChannelName}"` : 'null';
      this.compiler.emit.line(`}, ${waitedChannelArg});`);
      bufferCompiler.currentBuffer = prevBuffer;
      bufferCompiler.currentTextChannelVar = prevTextChannelVar;
      bufferCompiler.currentTextChannelName = prevTextChannelName;
      bufferCompiler.currentWaitedChannelName = prevWaitedChannelName;
      bufferCompiler.currentWaitedOwnerBuffer = prevWaitedOwnerBuffer;
      if (controlFlowPromiseId) {
        bufferCompiler.emitOwnWaitedConcurrencyResolve(frame, controlFlowPromiseId, node);
      }
      validateCompileTimeFrameBalance(newFrame, this.compiler, node);

      const result = callbackValue && typeof callbackValue === 'object' &&
        Object.prototype.hasOwnProperty.call(callbackValue, 'result')
        ? callbackValue.result
        : callbackValue;
      return { frame: newFrame.pop(), result };
    }

    const result = typeof emitFunc === 'function' ? emitFunc(frame, bufferCompiler.currentBuffer, bufferCompiler.currentBuffer) : undefined;
    return { frame, result };
  }

  compileRenderBoundary(emitCompiler, node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const { bufferId: id } = emitCompiler.managedBlock(frame, false, true, (blockFrame) => {
        innerBodyFunction.call(this.compiler, blockFrame);
      }, undefined, node);
      if (this.compiler.asyncMode) {
        emitCompiler.line(`${id}.markFinishedAndPatchLinks();`);
      }
      if (callbackName) {
        emitCompiler.line(`${callbackName}(null, ${id});`);
      }
      emitCompiler.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);
    emitCompiler.line(`runtime.runRenderBoundary(astate, frame, context, cb, async (astate, frame, currentBuffer) =>{`);

    const id = this.compiler._tmpid();
    emitCompiler.line(`let ${id} = currentBuffer;`);

    const textChannelName = this.compiler.buffer.currentTextChannelName;
    emitCompiler.line(`let ${id}_textChannelVar = runtime.declareChannel(frame, ${id}, "${textChannelName}", "text", context, null);`);
    const prevBuffer = this.compiler.buffer.currentBuffer;
    const prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
    const prevTextChannelName = this.compiler.buffer.currentTextChannelName;
    this.compiler.buffer.currentBuffer = id;
    this.compiler.buffer.currentTextChannelVar = `${id}_textChannelVar`;
    this.compiler.buffer.currentTextChannelName = textChannelName;

    const originalAsyncClosureDepth = emitCompiler.asyncClosureDepth;
    emitCompiler.asyncClosureDepth = 0;

    if (this.compiler.scriptMode) {
      frame._seesRootScope = false;
      frame._returnWaitCount = 1;
      this.compiler.emitDeclareReturnChannel(frame, id);
      innerBodyFunction.call(this.compiler, frame);
    } else {
      innerBodyFunction.call(this.compiler, frame);
    }

    emitCompiler.asyncClosureDepth = originalAsyncClosureDepth;
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    this.compiler.buffer.currentTextChannelName = prevTextChannelName;

    if (this.compiler.scriptMode) {
      this.compiler.emitReturnChannelSnapshot(id, positionNode, id);
    } else {
      emitCompiler.line(`${id} = ${id}.addSnapshot("${textChannelName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`);
    }

    if (callbackName) {
      emitCompiler.line(`  ${callbackName}(null, ${id});`);
    }
    emitCompiler.line(`  return ${id};`);
    emitCompiler.line('})');
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
      `${boundaryPrefix}runtime.runControlFlowBoundary(astate, ${parentBufferExpr}, ${linkedChannelsArg}, frame, context, cb, async ${callbackParams} => {`
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
      callbackParams = '(astate, frame, currentBuffer, parentBuffer)',
      targetChannelName = bufferCompiler.currentTextChannelName,
      targetBufferExpr = 'currentBuffer',
      normalizeTextArgs = true,
      waitedPositionNode = positionNode,
      useParentBufferForEmit = false,
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

      if (useParentBufferForEmit) {
        bufferCompiler.currentBuffer = 'parentBuffer';
        bufferCompiler.currentTextChannelVar = null;
      }

      if (producerAssignsResult) {
        emitValue(innerFrame, valueId);
      } else {
        this.compiler.emit(`let ${valueId} = `);
        emitValue(innerFrame, valueId);
        this.compiler.emit.line(';');
      }

      if (useParentBufferForEmit) {
        bufferCompiler.currentBuffer = prevBuffer;
        bufferCompiler.currentTextChannelVar = prevTextChannelVar;
      }
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
      `runtime.runControlFlowBoundary(astate, ${outerParentBuffer}, ${linkedChannelsArg}, frame, context, cb, async (astate, frame, currentBuffer) => {`
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
