
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

  compileExpressionControlFlowBoundary(bufferCompiler, node, emitBody, stackFields = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChainsArg = this.compiler.emit.getLinkedChainsArg(node);
    const linkedMutatedChainsArg = this.compiler.emit.getLinkedMutatedChainsArg(node);

    // Reserve a structural child buffer synchronously before any async
    // condition/operand resolution so later sibling operands stay ordered.
    // Expression boundaries must return a value/rejection to their expression
    // consumer; control-flow boundaries report errors through reportError instead.
    const bufferStackErrorContextArg = this.compiler.emitErrorContext(node, stackFields);
    this.compiler.emit(`runtime.runValueBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, async (currentBuffer) => {`);
    this.compiler.emit.asyncClosureDepth++;
    bufferCompiler.withBufferState({ currentBuffer: 'currentBuffer' }, () => {
      emitBody.call(this.compiler);
    });
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit(`}, ${bufferStackErrorContextArg})`);
  }

  compileValueBoundary(bufferCompiler, node, emitValue, positionNode = node, stackFields = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer || 'null';
    const linkedChainsArg = this.compiler.emit.getLinkedChainsArg(node);
    const linkedMutatedChainsArg = this.compiler.emit.getLinkedMutatedChainsArg(node);
    const resultId = this.compiler._tmpid();
    const errorContextArg = this.compiler.emitErrorContext(positionNode);
    const bufferStackErrorContextArg = this.compiler.emitErrorContext(positionNode, stackFields);

    this.compiler.emit.line(
      `runtime.runValueBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

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
    this.compiler.emit.asyncClosureDepth--;
  }

  compileAsyncControlFlowBoundary(bufferCompiler, node, emitFunc = null, errorContextNode = node, stackFields = {}) {
    if (bufferCompiler.currentWaitedChainName) {
      return this._compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc, errorContextNode, stackFields);
    }

    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChainsArg = this.compiler.emit.getLinkedChainsArg(node);
    const linkedMutatedChainsArg = this.compiler.emit.getLinkedMutatedChainsArg(node);
    const controlFlowPromiseId = this.compiler._tmpid();
    const bufferStackErrorContextArg = this.compiler.emitClonedErrorContext(errorContextNode, stackFields);

    this.compiler.emit(
      `let ${controlFlowPromiseId} = runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    bufferCompiler.withBufferState({
      currentBuffer: 'currentBuffer',
      currentWaitedChainName: bufferCompiler.currentWaitedChainName,
      currentWaitedOwnerBuffer: bufferCompiler.currentWaitedOwnerBuffer
    }, () => {
      if (emitFunc) {
        emitFunc();
      }
    });
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line(`}, ${bufferStackErrorContextArg});`);
    bufferCompiler.emitLimitedLoopCompletion(controlFlowPromiseId, node);
    return {};
  }

  _compileAsyncWaitedControlFlowBoundary(bufferCompiler, node, emitFunc = null, errorContextNode = node, stackFields = {}) {
    const parentBufferArg = bufferCompiler.currentBuffer;
    const linkedChainsArg = this.compiler.emit.getLinkedChainsArg(node);
    const linkedMutatedChainsArg = this.compiler.emit.getLinkedMutatedChainsArg(node);
    const controlFlowWaitedChainName = `__waited__${this.compiler._tmpid()}`;
    const controlFlowWaitedOwnerBufferId = this.compiler._tmpid();
    const controlFlowPromiseId = this.compiler._tmpid();
    const bufferStackErrorContextArg = this.compiler.emitClonedErrorContext(errorContextNode, stackFields);

    this.compiler.emit(
      `let ${controlFlowPromiseId} = runtime.runWaitedControlFlowBoundary(${parentBufferArg}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

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
    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line(`}, "${controlFlowWaitedChainName}", ${bufferStackErrorContextArg});`);
    bufferCompiler.emitLimitedLoopCompletion(controlFlowPromiseId, node);
    return {};
  }

  compileSyncControlFlowBoundary(bufferCompiler, node, frame, emitFunc = null) {
    if (typeof emitFunc === 'function') {
      emitFunc(frame, bufferCompiler.currentBuffer);
    }
    return { frame };
  }

  // Branch/control-flow selector failures poison the chains
  //  that the skipped region could have written.
  emitBranchPoisonCatch(bufferCompiler, poisonChains, errorContextExpr, emitCatchTail = null) {
    this.compiler.emit('} catch (e) {');
    this.compiler.emit.line('  if (!runtime.isPoisonError(e)) {');
    this.compiler.emit.line(`    runtime.RuntimeError.reportAndThrow(e, ${errorContextExpr});`);
    this.compiler.emit.line('  }');
    if (poisonChains.length > 0) {
      const contextualErrorVar = this.compiler._tmpid();
      this.compiler.emit(`  const ${contextualErrorVar} = e;`);
      for (const chainName of poisonChains) {
        this.compiler.emit.line(
          `    ${bufferCompiler.currentBuffer}.addCommand(new runtime.ErrorCommand(${contextualErrorVar}, ${errorContextExpr}), "${chainName}");`
        );
      }
    }
    if (emitCatchTail) {
      emitCatchTail();
    }
    this.compiler.emit('}');
  }

  _compileAsyncRenderBoundaryImpl(emitCompiler, node, innerBodyFunction, callbackName, positionNode = node, stackFields = {}) {
    const emitCallbackResult = (resultExpr) => {
      if (callbackName) {
        emitCompiler.line(`  ${callbackName}(null, ${resultExpr});`);
      }
    };

    const bufferStackErrorContextArg = this.compiler.emitErrorContext(positionNode, stackFields);
    emitCompiler.line('runtime.runRenderBoundary(context, renderState, async (currentBuffer) =>{');
    const resultId = this.compiler._tmpid();

    const textChainName = this.compiler.buffer.currentTextChainName;
    emitCompiler.line(`let ${resultId}_textChainVar = runtime.declareBufferChain(currentBuffer, "${textChainName}", "text", context, null);`);

    const originalAsyncClosureDepth = emitCompiler.asyncClosureDepth;
    emitCompiler.asyncClosureDepth = 0;

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

    emitCompiler.asyncClosureDepth = originalAsyncClosureDepth;

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

    const { bufferId: id } = emitCompiler.managedBlock({
      frame,
      createScopeRootBuffer: true,
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
    const bufferStackErrorContextArg = this.compiler.emitErrorContext(positionNode, stackFields);

    this.compiler.emit.line(
      `${boundaryPrefix}runtime.runControlFlowBoundary(${parentBufferExpr}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, async ${callbackParams} => {`
    );
    this.compiler.emit.asyncClosureDepth++;

    emitBody();
    this._emitBoundaryTextCommand(
      bufferCompiler,
      emitBody.resultId,
      positionNode,
      targetChainName,
      targetBufferExpr,
      normalizeTextArgs
    );

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line(`}, ${bufferStackErrorContextArg});`);

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
      linkedChainsArg: this.compiler.emit.getLinkedChainsArg(node),
      linkedMutatedChainsArg: this.compiler.emit.getLinkedMutatedChainsArg(node),
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
    const linkedChainsArg = this.compiler.emit.getLinkedChainsArg(node);
    const linkedMutatedChainsArg = this.compiler.emit.getLinkedMutatedChainsArg(node);
    const outerParentBuffer = bufferCompiler.currentBuffer;
    const bufferStackErrorContextArg = this.compiler.emitErrorContext(positionNode, stackFields);

    this.compiler.emit(
      `runtime.runControlFlowBoundary(${outerParentBuffer}, ${linkedChainsArg}, ${linkedMutatedChainsArg}, context, renderState, async (currentBuffer) => {`
    );
    this.compiler.emit.asyncClosureDepth++;

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

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit(`}, ${bufferStackErrorContextArg})`);

  }

}

export {CompileBoundaries};
