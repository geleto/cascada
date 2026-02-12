const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance,
  ENABLE_READVARS_VALIDATION,
  ensureReadValidationState,
  validateReadVarsConsistency
} = require('./validation');

module.exports = class CompileEmit {
  constructor(compiler) {
    this.scopeClosers = '';
    this.compiler = compiler;
    this.asyncClosureDepth = 0;
    this._managedRootBufferStack = [];
    const callable = (code) => this.emit(code);
    Object.setPrototypeOf(callable, CompileEmit.prototype);
    Object.assign(callable, this);
    return callable;
  }

  emit(code) {
    this.compiler.codebuf.push(code);
  }

  line(code) {
    this.emit(code + '\n');
  }

  lines(...lines) {
    lines.forEach((line) => this.line(line));
  }

  insert(pos, code) {
    this.compiler.codebuf[pos] += code;
  }

  insertLine(pos, code) {
    this.insert(pos, code + '\n');
  }

  addScopeLevel() {
    this.scopeClosers += '})';
  }

  closeScopeLevels() {
    this.line(this.scopeClosers + ';');
    this.scopeClosers = '';
  }

  withScopedSyntax(func) {
    const _scopeClosers = this.scopeClosers;
    this.scopeClosers = '';

    func.call(this.compiler);

    this.closeScopeLevels();
    this.scopeClosers = _scopeClosers;
  }

  initOutputHandlers(bufferVar, textOutputVar = null) {
    this.line(`frame._outputBuffer = ${bufferVar};`);
    const outputVar = textOutputVar || `${bufferVar}_textOutput`;
    this.line(`let ${outputVar} = runtime.declareOutput(frame, "text", "text", context, null);`);
  }

  //todo: use only simple async block if you know that:
  // - the block has no output
  // - this is the only async block child of the parent that has output
  // - there is only one active child (e.g. if/else) that has output
  //in all other cases, use AsyncBlockBufferNode
  //to make sure there are no race conditions for the buffer position
  // Managed block for non-astate paths (scope/frame + optional scope-root buffer).
  // If createScopeRootBuffer=true, this is a sanctioned scope-root buffer
  // creation site and must be paired with endManagedBlock(..., true).
  beginManagedBlock(frame, createScope = false, createScopeRootBuffer = false) {
    let nextFrame = frame;
    if (createScope) {
      this.line('frame = frame.push();');
      nextFrame = frame.push();
    }
    let bufferId = null;
    if (createScopeRootBuffer) {
      bufferId = this.compiler.buffer.pushBuffer();
      if (this.compiler.asyncMode) {
        const usedOutputsVar = this.compiler._tmpid();
        this.line(`let ${usedOutputsVar} = null;`);
        const usedOutputsPos = this.compiler.codebuf.length;
        this.compiler.buffer.createScopeRootBuffer(bufferId, `${bufferId}_textOutput`, usedOutputsVar);
        this._managedRootBufferStack.push({ usedOutputsVar, usedOutputsPos });
      } else {
        this.compiler.buffer.createScopeRootBuffer(bufferId, `${bufferId}_textOutput`);
      }
    }
    return { frame: nextFrame, bufferId };
  }

  endManagedBlock(frame, createScope = false, createScopeRootBuffer = false) {
    if (createScopeRootBuffer) {
      if (this.compiler.asyncMode) {
        const current = this._managedRootBufferStack.pop();
        if (current) {
          this.insertLine(current.usedOutputsPos, `${current.usedOutputsVar} = ${this.compiler.buffer.serializeUsedOutputs(frame)};`);
        }
        // Managed scope-root buffers are lifecycle-owned by this block and must
        // be finalized before detaching from the compiler buffer stack.
        this.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      }
      this.compiler.buffer.popBuffer();
    }
    if (createScope) {
      this.line('frame = frame.pop();');
      return frame.pop();
    }
    return frame;
  }

  asyncBlock(node, frame, createScope, emitFunc, positionNode = node) {
    const aframe = this.asyncBlockBegin(node, frame, createScope, positionNode);
    emitFunc(aframe);
    this.asyncBlockEnd(node, aframe, createScope, false, positionNode); // Pass sequentialLoopBody=false by default
  }

  asyncBlockBegin(node, frame, createScope, positionNode = node) {
    if (node.isAsync) {
      this.line(`astate.asyncBlock(async (astate, frame) => {`);
      this.asyncClosureDepth++;
    }
    if (createScope && !node.isAsync) {
      this.line('frame = frame.push();');
    }
    if (createScope || node.isAsync) {
      //unscoped frames are only used in async blocks
      const newFrame = frame.push(false, createScope);
      trackCompileTimeFrameDepth(newFrame, frame);
      if (ENABLE_READVARS_VALIDATION && node.isAsync) {
        ensureReadValidationState(newFrame);
      }
      return newFrame;
    }
    return frame;
  }

  asyncBlockEnd(node, frame, createScope, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      if (sequentialLoopBody) {
        // Wait for child async blocks spawned within this iteration
        // before proceeding to finally/catch.
        this.line('await astate.waitAllClosures(1);');
      }
      this.asyncClosureDepth--;
      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.getAsyncBlockArgs(frame, positionNode);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}", false, ${sequentialLoopBody})`);
      this.line(';');
    }
    if (createScope && !node.isAsync) {
      this.line('frame = frame.pop();');
    }

    // Validate frame balance before popping
    if (createScope || node.isAsync) {
      validateCompileTimeFrameBalance(frame, this.compiler, positionNode);
      return frame.pop();
    }
    return frame;
  }

  asyncBlockValue(node, frame, emitFunc, res, positionNode = node, createScope = false) {
    if (node.isAsync) {

      this.line(`astate.asyncBlock(async (astate, frame) => {`);
      this.asyncClosureDepth++;
      frame = frame.push(false, createScope);

      if (res === undefined) {
        res = this.compiler._tmpid();
        this.line(`  let ${res}; try {`);
        this.line(`  ${res} = `);
      } else {
        this.line(`  try {`);
      }
      emitFunc.call(this.compiler, node, frame);
      this.line(';');
      //await ${res} to avoid unused vars throwing unhandled exceptions
      //and to make sure _leaveAsyncBlock is called after the promise resolves
      this.line(`return await ${res};`);
      this.line('} catch (e) {');//@todo - temp var
      this.line(`  const err = runtime.isPoisonError(e) ? e : new runtime.PoisonError(e, ${positionNode.lineno}, ${positionNode.colno}, "${this.compiler._generateErrorContext(node, positionNode)}", context.path);`);
      if (frame.writeCounts) {
        // If the block owns writes, we must clear them on error to prevent
        // "Async block finished with pending writes" fatal error.
        this.line(`  frame.poisonBranchWrites(err, ${JSON.stringify(frame.writeCounts)});`);
      }
      this.line('  throw err;');
      // this.line(`  return runtime.createPoison(err);`);
      this.line('}');

      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.getAsyncBlockArgs(frame, positionNode);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}", true)`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(node, frame);
    }
  }

  asyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const { frame: blockFrame, bufferId: id } = this.beginManagedBlock(frame, false, true);
      innerBodyFunction.call(this.compiler, blockFrame);
      this.endManagedBlock(blockFrame, false, true);
      if (callbackName) {
        this.line(`${callbackName}(null, ${id});`);
      }
      this.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    // asyncBlockRender always materializes text output; ensure async block
    // allocates an output buffer via usedOutputs.
    this.compiler.async.updateOutputUsage(frame, 'text');
    this.line(`astate.asyncBlock(async (astate, frame) =>{`);

    const id = this.compiler._tmpid();
    // IMPORTANT: no createScopeRootBuffer() here.
    // For async blocks, CommandBuffer is owned/created by AsyncState.asyncBlock.
    this.line(`let ${id} = frame._outputBuffer;`);
    this.line(`if (!${id}) { throw new Error("asyncBlockRender requires async block output buffer"); }`);
    this.line(`let ${id}_textOutput = runtime.declareOutput(frame, "text", "text", context, null);`);
    const prevBufferState = this.compiler.buffer.setBufferAlias(id, `${id}_textOutput`);

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;

    if (this.compiler.scriptMode) {
      // Call blocks in script mode return values via explicit/implicit return.
      frame._seesRootScope = false;
      frame._returnWaitCount = 1;
      this.line(`${id} = (async function(frame) {`);
      innerBodyFunction.call(this.compiler, frame);
      this.line('}).call(this, frame);');
    } else {
      innerBodyFunction.call(this.compiler, frame);
    }

    this.asyncClosureDepth = originalAsyncClosureDepth;
    this.compiler.buffer.restoreBufferAlias(prevBufferState);

    if (!this.compiler.scriptMode) {
      this.line('await astate.waitAllClosures(1);');
      this.line(`${id} = runtime.flattenBuffer(${id}_textOutput, context);`);
    }
    /*this.line(`let ${id}_flat = runtime.flattenBuffer(${id});`);
    this.line(`if (${id}_flat && typeof ${id}_flat.then === 'function') { ${id}_flat = await ${id}_flat; }`);
    this.line(`${id} = ${id}_flat;`);*/

    //return via callback or directly
    if (callbackName) {
      this.line(`  ${callbackName}(null, ${id});`);
    }
    this.line(`  return ${id};`);
    this.line('}');
    const errorContext = this.compiler._generateErrorContext(node, positionNode);
    const { readArgs, writeArgs, outputArgs } = this.getAsyncBlockArgs(frame, positionNode);
    if (callbackName) {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, ${callbackName}, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    } else {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  // @todo - optimize this:
  // if a parent async block has the read and there are no writes
  // we can use the parent snapshot
  // similar for writes we can do some optimizations
  getAsyncBlockArgs(frame, positionNode = null) {
    if (ENABLE_READVARS_VALIDATION) {
      ensureReadValidationState(frame);
      validateReadVarsConsistency(frame, this.compiler, positionNode);
    }
    let reads = [];
    if (frame.readVars) {
      //add each read var to a list of vars to be snapshotted, with a few exceptions
      frame.readVars.forEach((name) => {
        //skip variables that are written to, they will be snapshotted anyway
        if (frame.writeCounts && frame.writeCounts[name]) {
          return;
        }
        //see if it's read by a parent and not written to there, then the parent snapshot is enough
        //but for this to work we have to check only async block frames and it's good to check up the chain
        //@todo - implement this
        //@todo - similar for writes!!!!
        /*if (frame.parent.readVars && frame.parent.readVars.has(name) && !(frame.parent.writeCounts && !frame.parent.writeCounts[name])) {
          return;
        }*/
        if (frame.declaredVars && frame.declaredVars.has(name)) {
          // If the variable 'name' is declared in the *current* 'frame'
          throw new Error(`ReadVar ${name} in declaration scope, this indicates mismatch between compiler and runtime frame`);
        }
        reads.push(name);
      });
    }
    const readArgs = reads.length ? JSON.stringify(reads) : 'null';
    const writeArgs = frame.writeCounts ? JSON.stringify(frame.writeCounts) : 'null';
    const outputArgs = this.compiler.buffer.serializeUsedOutputs(frame);
    return { readArgs, writeArgs, outputArgs };
  }
};
