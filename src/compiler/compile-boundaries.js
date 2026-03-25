'use strict';

const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
} = require('./validation');

class CompileBoundaries {
  constructor(compiler) {
    this.compiler = compiler;
  }

  _compileControlFlowBlock(bufferCompiler, node, frame, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = bufferCompiler.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
      const trackAsSingleWaitedUnit = this.compiler.asyncMode && !!bufferCompiler.currentWaitedChannelName;
      const controlFlowWaitedChannelName = trackAsSingleWaitedUnit ? `__waited__${this.compiler._tmpid()}` : null;
      const controlFlowPromiseId = this.compiler._tmpid();

      this.compiler.emit(
        `let ${controlFlowPromiseId} = runtime.runControlFlowBlock(astate, ${parentBufferArg}, ${linkedChannelsArg}, frame, context, cb, async (astate, frame, currentBuffer) => {`
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

  _compileRenderBoundary(emitCompiler, node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
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
}

module.exports = CompileBoundaries;
