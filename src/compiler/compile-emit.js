const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
} = require('./validation');
const { DEFAULT_TEMPLATE_TEXT_CHANNEL } = require('./compile-buffer');

module.exports = class CompileEmit {
  constructor(compiler) {
    this.scopeClosers = '';
    this.compiler = compiler;
    this.asyncClosureDepth = 0;
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

  beginEntryFunction(node, name, frame = null) {
    const rootTextChannelName = (!this.compiler.scriptMode && node && node._analysis && node._analysis.textOutput)
      ? node._analysis.textOutput
      : DEFAULT_TEMPLATE_TEXT_CHANNEL;
    this.compiler.buffer.currentBuffer = 'output';
    this.compiler.buffer.currentTextChannelVar = 'output_textChannelVar';
    this.compiler.buffer.currentTextChannelName = this.compiler.scriptMode ? null : rootTextChannelName;
    this.compiler.buffer.currentWaitedChannelName = null;
    this.scopeClosers = '';
    if (this.compiler.asyncMode) {
      if (name === 'root') {
        this.line(`function ${name}(env, context, frame, runtime, astate, cb, compositionMode = false) {`);
      } else {
        this.line(`function ${name}(env, context, frame, runtime, astate, cb, parentBuffer = null) {`);
      }
    } else {
      this.line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.line(`let lineno = ${node.lineno};`);
      this.line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer.currentBuffer} = "";`);
    this.compiler.buffer.initManagedBuffer(
      this.compiler.buffer.currentBuffer,
      (this.compiler.asyncMode && name !== 'root') ? 'parentBuffer' : null,
      this.compiler.buffer.currentTextChannelVar
    );
    this.line('try {');
  }

  endEntryFunction(node, noReturn) { // Added node parameter
    if (!noReturn) {
      if (this.compiler.asyncMode) {
        // In async mode, blocks return output directly (not via callback)
        // The callback is only used for error propagation
        this.line(this.compiler.buffer.currentBuffer + '.markFinishedAndPatchLinks();');
        this.line('return ' + this.compiler.buffer.currentBuffer + ';');
      } else {
        // Sync mode blocks use callback for both success and error
        this.line('cb(null, ' + this.compiler.buffer.currentBuffer + ');');
      }
    }

    this.closeScopeLevels();
    this.line('} catch (e) {');
    if (this.compiler.asyncMode) {
      // In async mode, use the static position from the node and handlePromise for internal errors
      // The top-level catch uses the function's start position as a fallback.
      this.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}${node ? `, "${this.compiler._generateErrorContext(node)}"` : ''}, context.path);`); // Store and update the handled error
      this.line('  cb(err);'); // Pass the updated error to the callback
    } else {
      this.line(`  var err = runtime.handleError(e, lineno, colno${node ? `, "${this.compiler._generateErrorContext(node)}"` : ''}, context.path);`); // Store and update the handled error
      this.line('  cb(err);'); // Pass the updated error to the callback
    }
    //this.Line('  throw e;');//the returned promise should not resolve
    this.line('}');
    this.line('}');
    this.compiler.buffer.currentBuffer = null;
    this.compiler.buffer.currentTextChannelVar = null;
    this.compiler.buffer.currentTextChannelName = this.compiler.scriptMode
      ? null
      : (((node && node._analysis && node._analysis.textOutput)));
    this.compiler.buffer.currentWaitedChannelName = null;
  }

  //todo: use only simple async block if you know that:
  // - the block has no output
  // - this is the only async block child of the parent that has output
  // - there is only one active child (e.g. if/else) that has output
  //in all other cases, use AsyncBlockBufferNode
  //to make sure there are no race conditions for the buffer position
  // Managed block for non-astate paths (scope/frame + optional scope-root buffer).
  // If createScopeRootBuffer=true, this is a sanctioned scope-root buffer creation
  // site. The callback body is compiled between initialization and caller-managed finalization.
  managedBlock(frame, createScope = false, createScopeRootBuffer = false, emitFunc = null, parentBufferOverride = undefined, analysisNode = null) {
    let nextFrame = frame;
    if (createScope) {
      this.line('frame = frame.push();');
      nextFrame = frame.push();
    }

    let linkInsertPos = null;
    let parentBufferId = null;
    let bufferId = null;
    let prevBuffer = null;
    let prevTextChannelVar = null;
    if (createScopeRootBuffer) {
      parentBufferId = parentBufferOverride !== undefined
        ? parentBufferOverride
        : (this.compiler.buffer.currentBuffer || null);
      bufferId = this.compiler._tmpid();
      prevBuffer = this.compiler.buffer.currentBuffer;
      prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
      this.compiler.buffer.currentBuffer = bufferId;
      this.compiler.buffer.currentTextChannelVar = `${bufferId}_textChannelVar`;
      this.compiler.buffer.initManagedBuffer(
        bufferId,
        parentBufferId,
        `${bufferId}_textOutputVar`
      );
      linkInsertPos = this.compiler.codebuf.length;
      this.line('');
    }

    if (typeof emitFunc === 'function') {
      emitFunc(nextFrame, bufferId);
    }

    if (createScopeRootBuffer && parentBufferId && analysisNode && analysisNode._analysis) {
      const used = Array.from(analysisNode._analysis.usedChannels || []);
      const declared = new Set((analysisNode._analysis.declaredChannels || new Map()).keys());
      const foreignUsed = used.filter((name) => {
        if (name === this.compiler.buffer.currentTextChannelName) {
          return false;
        }
        const decl = this.compiler.analysis && this.compiler.analysis.findDeclaration
          ? this.compiler.analysis.findDeclaration(analysisNode._analysis, name)
          : null;
        if (name === '__return__' || (decl && decl.runtimeName === '__return__')) {
          return false;
        }
        return !declared.has(name);
      });
      if (foreignUsed.length > 0) {
        // Use the shared runtime prelink helper to keep boundary-linking behavior
        // consistent with include/block prelink paths.
        const linkLine = `runtime.linkWithParentCompositionBuffer(${parentBufferId}, ${bufferId}, ${JSON.stringify(foreignUsed)}, ${bufferId}._channels);\n`;
        this.insert(linkInsertPos, linkLine);
      }
    }

    if (createScopeRootBuffer) {
      this.compiler.buffer.currentBuffer = prevBuffer;
      this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    }
    if (createScope) {
      this.line('frame = frame.pop();');
      return { frame: frame.pop(), bufferId };
    }
    return { frame: nextFrame, bufferId };
  }

  asyncBlock(node, frame, createScope, emitFunc, positionNode = node) {
    const aframe = this.asyncBlockBegin(node, frame, createScope, positionNode);
    emitFunc(aframe);
    this.asyncBlockEnd(node, aframe, createScope, positionNode, null, false, false);
  }

  asyncBlockBegin(node, frame, createScope, positionNode = node) {
    if (node.isAsync) {
      this.line(`astate.asyncBlock(async (astate, frame, currentBuffer) => {`);
      this.asyncClosureDepth++;
    }
    if (createScope && !node.isAsync) {
      this.line('frame = frame.push();');
    }
    if (createScope || node.isAsync) {
      //unscoped frames are only used in async blocks
      const newFrame = frame.push(false, createScope);
      trackCompileTimeFrameDepth(newFrame, frame);
      return newFrame;
    }
    return frame;
  }

  asyncBlockEnd(node, frame, createScope, positionNode = node, parentBufferArg, createOutputBuffer) {
    if (node.isAsync) {
      this.asyncClosureDepth--;
      this.line('}');
      const asyncMetaArg = this.getAsyncBlockArgs(node, frame);
      const resolvedParentBufferArg = parentBufferArg || this.compiler.buffer.currentBuffer || 'null';
      const createOutputBufferArg = createOutputBuffer ? 'true' : 'false';
      this.line(`, runtime, frame, ${asyncMetaArg}, ${resolvedParentBufferArg}, ${createOutputBufferArg}, cb)`);
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

  asyncBlockValue(
    node,
    frame,
    emitFunc,
    res,
    positionNode = node,
    createScope = false,
    createOutputBuffer = false,
    // Capture-only override. Other asyncBlockValue call sites should rely on
    // compiler.currentBuffer. Remove this override once capture is removed.
    parentBufferArgOverride = null
  ) {
    if (node.isAsync) {

      this.line(`astate.asyncBlock(async (astate, frame, currentBuffer) => {`);
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
      this.line('  throw err;');
      // this.line(`  return runtime.createPoison(err);`);
      this.line('}');

      this.line('}');
      const asyncMetaArg = this.getAsyncBlockArgs(node, frame);
      const createOutputBufferArg = createOutputBuffer ? 'true' : 'false';
      // Capture compilation may temporarily point compiler.currentBuffer at
      // the async callback parameter ("currentBuffer") so body writes target
      // the capture buffer. Parent linkage, however, must still use the
      // outer composition buffer, so capture passes an explicit override.
      // TODO(var-removal): remove override path when capture is removed.
      const parentBufferArg = parentBufferArgOverride || this.compiler.buffer.currentBuffer || 'null';
      this.line(`, runtime, frame, ${asyncMetaArg}, ${parentBufferArg}, ${createOutputBufferArg}, cb, false)`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(node, frame);
    }
  }

  asyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const { bufferId: id } = this.managedBlock(frame, false, true, (blockFrame) => {
        innerBodyFunction.call(this.compiler, blockFrame);
      }, undefined, node);
      if (this.compiler.asyncMode) {
        this.line(`${id}.markFinishedAndPatchLinks();`);
      }
      if (callbackName) {
        this.line(`${callbackName}(null, ${id});`);
      }
      this.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    // asyncBlockRender always materializes text output; ensure async block
    // allocates a channel buffer via usedChannels.
    //this.compiler.buffer.registerOutputUsage(frame, 'text');
    this.line(`astate.asyncBlock(async (astate, frame, currentBuffer) =>{`);

    const id = this.compiler._tmpid();
    // IMPORTANT: no managed-buffer initialization here.
    // For async blocks, CommandBuffer is owned/created by AsyncState.asyncBlock.
    this.line(`let ${id} = currentBuffer;`);
    //this.line(`if (!${id}) { throw new Error("asyncBlockRender requires async block output buffer"); }`);

    //text only? Why not just use currentBuffer?
    const textChannelName = this.compiler.buffer.currentTextChannelName;
    this.line(`let ${id}_textChannelVar = runtime.declareChannel(frame, ${id}, "${textChannelName}", "text", context, null);`);
    const prevBuffer = this.compiler.buffer.currentBuffer;
    const prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
    const prevTextChannelName = this.compiler.buffer.currentTextChannelName;
    this.compiler.buffer.currentBuffer = id;
    this.compiler.buffer.currentTextChannelVar = `${id}_textChannelVar`;
    this.compiler.buffer.currentTextChannelName = textChannelName;

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;

    if (this.compiler.scriptMode) {
      // Call blocks in script mode return values via explicit/implicit return.
      frame._seesRootScope = false;
      frame._returnWaitCount = 1;
      this.compiler.emitDeclareReturnChannel(frame, id);
      innerBodyFunction.call(this.compiler, frame);
    } else {
      innerBodyFunction.call(this.compiler, frame);
    }

    this.asyncClosureDepth = originalAsyncClosureDepth;
    this.compiler.buffer.currentBuffer = prevBuffer;
    this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
    this.compiler.buffer.currentTextChannelName = prevTextChannelName;

    if (this.compiler.scriptMode) {
      this.compiler.emitReturnChannelSnapshot(id, positionNode, id);
    } else {
      this.line(`${id} = ${id}.addSnapshot("${textChannelName}", {lineno: ${positionNode.lineno}, colno: ${positionNode.colno}});`);
    }

    //return via callback or directly
    if (callbackName) {
      this.line(`  ${callbackName}(null, ${id});`);
    }
    this.line(`  return ${id};`);
    this.line('}');
    const asyncMetaArg = this.getAsyncBlockArgs(node, frame);
    // asyncBlockRender materializes its own text snapshot and returns it to the caller.
    // Linking this temporary render buffer into the parent text stream would duplicate
    // content (once via parent traversal, once via returned snapshot).
    const parentBufferArg = 'null';
    if (callbackName) {
      this.line(`, runtime, frame, ${asyncMetaArg}, ${parentBufferArg}, true, ${callbackName})`);
    } else {
      this.line(`, runtime, frame, ${asyncMetaArg}, ${parentBufferArg}, true, cb)`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  // @todo - optimize this:
  // similar for writes we can do some optimizations
  getLinkedChannelsArg(node, frame) {
    void frame;
    const usedChannels = Array.from(node._analysis.usedChannels || []);
    const declaredChannels = new Set((node._analysis.declaredChannels || new Map()).keys());
    const linkedChannels = usedChannels.filter((name) => {
      if (name === this.compiler.buffer.currentTextChannelName) {
        return true;
      }
      const decl = this.compiler.analysis && this.compiler.analysis.findDeclaration
        ? this.compiler.analysis.findDeclaration(node._analysis, name)
        : null;
      if (name === '__return__' || (decl && decl.runtimeName === '__return__')) {
        return false;
      }
      return !declaredChannels.has(name);
    });
    // Do not link currentWaitedChannelName here.
    // __waited__ must stay flat: it tracks local WaitResolveCommand leaves, not child buffers.
    // Nested control-flow buffers are applied through their own channels/iterators.
    return linkedChannels.length > 0 ? JSON.stringify(linkedChannels) : 'null';
  }

  getAsyncBlockArgs(node, frame) {
    const channelArgs = this.getLinkedChannelsArg(node, frame);
    return `({ usedChannels: ${channelArgs} })`;
  }
};
