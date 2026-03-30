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

  beginEntryFunction(node, name, frame = null, linkedChannels = null) {
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
        this.line(`function ${name}(env, context, runtime, cb, compositionMode = false) {`);
      } else {
        this.line(`function ${name}(env, context, runtime, cb, parentBuffer = null) {`);
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
      this.compiler.buffer.currentTextChannelVar,
      linkedChannels
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
  // Managed block for direct scope/frame handling (optionally with a scope-root buffer).
  // If createScopeRootBuffer=true, this is a sanctioned scope-root buffer creation
  // site. The callback body is compiled between initialization and caller-managed finalization.
  managedBlock(frame, createScope = false, createScopeRootBuffer = false, emitFunc = null, parentBufferOverride = undefined, analysisNode = null) {
    let nextFrame = frame;
    if (createScope) {
      this.line('frame = frame.push();');
      nextFrame = frame.push();
    }

    let parentBufferId = null;
    let bufferId = null;
    let prevBuffer = null;
    let prevTextChannelVar = null;
    let linkedChannels = null;
    if (createScopeRootBuffer) {
      parentBufferId = parentBufferOverride !== undefined
        ? parentBufferOverride
        : (this.compiler.buffer.currentBuffer || null);
      if (parentBufferId && analysisNode && analysisNode._analysis) {
        // For locally-created scope-root buffers, structural parent-visible lanes
        // should be attached at buffer creation time rather than in a later
        // runtime prelink step.
        const used = Array.from(analysisNode._analysis.usedChannels || []);
        const declared = new Set((analysisNode._analysis.declaredChannels || new Map()).keys());
        linkedChannels = used.filter((name) => {
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
      }
      bufferId = this.compiler._tmpid();
      prevBuffer = this.compiler.buffer.currentBuffer;
      prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
      this.compiler.buffer.currentBuffer = bufferId;
      this.compiler.buffer.currentTextChannelVar = `${bufferId}_textChannelVar`;
      this.compiler.buffer.initManagedBuffer(
        bufferId,
        parentBufferId,
        `${bufferId}_textOutputVar`,
        linkedChannels
      );
    }

    if (typeof emitFunc === 'function') {
      emitFunc(nextFrame, bufferId);
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

  _compileRenderBoundary(node, frame, innerBodyFunction, positionNode = node) {
    return this.compiler.boundaries.compileRenderBoundary(this, node, frame, innerBodyFunction, positionNode);
  }

  _compileCallbackRenderBoundary(node, frame, innerBodyFunction, callbackName, positionNode = node) {
    return this.compiler.boundaries.compileCallbackRenderBoundary(
      this,
      node,
      frame,
      innerBodyFunction,
      callbackName,
      positionNode
    );
  }

  // @todo - optimize this:
  // similar for writes we can do some optimizations
  getLinkedChannelsArg(node) {
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

};
