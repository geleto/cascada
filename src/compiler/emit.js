import {DEFAULT_TEMPLATE_TEXT_CHANNEL} from './buffer.js';

class CompileEmit {
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

  capture(emitFunc) {
    const previousCodebuf = this.compiler.codebuf;
    const previousScopeClosers = this.scopeClosers;
    this.compiler.codebuf = [];
    this.scopeClosers = '';
    try {
      emitFunc.call(this.compiler);
      return this.compiler.codebuf.join('');
    } finally {
      this.compiler.codebuf = previousCodebuf;
      this.scopeClosers = previousScopeClosers;
    }
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

  beginEntryFunction(node, name, linkedChannels = null, extraParams = []) {
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
        this.line(`function ${name}(env, context, runtime, cb, compositionMode = false, parentBuffer = null, inheritanceState = null, componentMode = false) {`);
      } else {
        const extraParamSource = Array.isArray(extraParams) && extraParams.length > 0
          ? `, ${extraParams.join(', ')}`
          : '';
        this.line(`function ${name}(env, context, runtime, cb, parentBuffer = null${extraParamSource}) {`);
      }
    } else {
      this.line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.line(`let lineno = ${node.lineno};`);
      this.line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer.currentBuffer} = "";`);
    if (this.compiler.asyncMode && name === 'root') {
      const linkedChannelsArg = Array.isArray(linkedChannels) && linkedChannels.length > 0
        ? JSON.stringify(linkedChannels)
        : 'null';
      this.line(
        `let ${this.compiler.buffer.currentBuffer} = ` +
        `(compositionMode && parentBuffer)` +
        ` ? parentBuffer` +
        ` : new runtime.CommandBuffer(context, parentBuffer, ${linkedChannelsArg}, parentBuffer);`
      );
      if (!this.compiler.scriptMode) {
        this.line(
          `let ${this.compiler.buffer.currentTextChannelVar} = ` +
          `((compositionMode && parentBuffer && typeof ${this.compiler.buffer.currentBuffer}.getChannel === "function")` +
          ` ? ${this.compiler.buffer.currentBuffer}.getChannel("${this.compiler.buffer.currentTextChannelName}")` +
          ` : runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${this.compiler.buffer.currentTextChannelName}", "text", context, null));`
        );
      }
    } else {
      this.compiler.buffer.initManagedBuffer(
        this.compiler.buffer.currentBuffer,
        this.compiler.asyncMode ? 'parentBuffer' : null,
        this.compiler.buffer.currentTextChannelVar,
        linkedChannels
      );
    }
    this.line('try {');
  }

  endEntryFunction(node, noReturn) { // Added node parameter
    if (!noReturn) {
      if (this.compiler.asyncMode) {
        // In async mode, blocks return output directly (not via callback)
        // The callback is only used for error propagation
        this.line(this.compiler.buffer.currentBuffer + '.finish();');
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

  // Managed block for direct scope/frame handling (optionally with a scope-root buffer).
  // If createScopeRootBuffer=true, this is a sanctioned scope-root buffer creation
  // site. The callback body is compiled between initialization and caller-managed finalization.
  managedBlock(frame, createScope = false, createScopeRootBuffer = false, emitFunc = null, parentBufferOverride = undefined, analysisNode = null) {
    let nextFrame = frame;
    if (createScope) {
      nextFrame = frame.push();
      this.line('frame = frame.push();');
    }

    let parentBufferId = null;
    let bufferId = null;
    let linkedChannels = null;
    if (createScopeRootBuffer) {
      parentBufferId = parentBufferOverride !== undefined
        ? parentBufferOverride
        : (this.compiler.buffer.currentBuffer || null);
      if (parentBufferId && analysisNode && analysisNode._analysis) {
        linkedChannels = analysisNode._analysis.createsLinkedChildBuffer
          ? this.getLinkedChannels(analysisNode)
          : null;
      }
      bufferId = this.compiler._tmpid();
      this.compiler.buffer.withBufferState({
        currentBuffer: bufferId,
        currentTextChannelVar: `${bufferId}_textChannelVar`
      }, () => {
        this.compiler.buffer.initManagedBuffer(
          bufferId,
          parentBufferId,
          `${bufferId}_textOutputVar`,
          linkedChannels
        );
        if (typeof emitFunc === 'function') {
          emitFunc(nextFrame, bufferId);
        }
      });
    } else if (typeof emitFunc === 'function') {
      emitFunc(nextFrame, bufferId);
    }
    if (createScope) {
      this.line('frame = frame.pop();');
      return { frame: nextFrame.pop(), bufferId };
    }
    return { frame: nextFrame, bufferId };
  }

  _compileAsyncRenderBoundary(node, innerBodyFunction, positionNode = node) {
    return this.compiler.boundaries.compileAsyncRenderBoundary(this, node, innerBodyFunction, positionNode);
  }

  _compileAsyncCallbackRenderBoundary(node, innerBodyFunction, callbackName, positionNode = node) {
    return this.compiler.boundaries.compileAsyncCallbackRenderBoundary(
      this,
      node,
      innerBodyFunction,
      callbackName,
      positionNode
    );
  }

  _compileSyncRenderBoundary(node, frame, innerBodyFunction, positionNode = node) {
    return this.compiler.boundaries.compileSyncRenderBoundary(this, node, frame, innerBodyFunction, positionNode);
  }

  _compileSyncCallbackRenderBoundary(node, frame, innerBodyFunction, callbackName, positionNode = node) {
    return this.compiler.boundaries.compileSyncCallbackRenderBoundary(
      this,
      node,
      frame,
      innerBodyFunction,
      callbackName,
      positionNode
    );
  }

  getLinkedChannelsArg(node) {
    const linkedChannels = this.getLinkedChannels(node);
    return linkedChannels.length > 0 ? JSON.stringify(linkedChannels) : 'null';
  }

  getLinkedMutatedChannelsArg(node) {
    const linkedMutatedChannels = this.getLinkedMutatedChannels(node);
    return linkedMutatedChannels.length > 0 ? JSON.stringify(linkedMutatedChannels) : 'null';
  }

  _getAnalysis(node, helperName) {
    if (!node || !node._analysis) {
      const nodeType = node && (node.typename || node.constructor && node.constructor.name);
      throw new Error(`${helperName} requires analysis metadata for ${nodeType || 'unknown node'}`);
    }
    return node._analysis;
  }

  getLinkedChannels(node) {
    const analysis = this._getAnalysis(node, 'getLinkedChannels');
    // Do not link currentWaitedChannelName here.
    // __waited__ must stay flat: it tracks local WaitResolveCommand leaves, not child buffers.
    // Nested control-flow buffers are applied through their own channels/iterators.
    return Array.from(analysis.linkedChannels ?? []);
  }

  getLinkedMutatedChannels(node) {
    const analysis = this._getAnalysis(node, 'getLinkedMutatedChannels');
    return Array.from(analysis.linkedMutatedChannels ?? []);
  }

};

export {CompileEmit};
