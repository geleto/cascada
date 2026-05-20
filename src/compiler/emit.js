import {DEFAULT_TEMPLATE_TEXT_CHAIN} from './buffer.js';

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

  entryFunction(node, name, emitFunc, {
    linkedChains = null,
    extraParams = [],
    noReturn = false
  } = {}) {
    const rootTextChainName = (!this.compiler.scriptMode && node && node._analysis && node._analysis.textOutput)
      ? node._analysis.textOutput
      : DEFAULT_TEMPLATE_TEXT_CHAIN;
    this.compiler.buffer.withBufferState({
      currentBuffer: 'output',
      currentTextChainVar: 'output_textChainVar',
      currentTextChainName: this.compiler.scriptMode ? null : rootTextChainName,
      currentWaitedChainName: null,
      currentWaitedOwnerBuffer: null
    }, () => {
      this._beginEntryFunction(node, name, linkedChains, extraParams);
      emitFunc.call(this.compiler);
      this._endEntryFunction(node, noReturn);
    });
  }

  _beginEntryFunction(node, name, linkedChains = null, extraParams = []) {
    this.scopeClosers = '';
    if (this.compiler.asyncMode) {
      if (name === 'root') {
        this.line(`function ${name}(env, context, runtime, cb) {`);
        this.line('const __ec = getErrorContexts(runtime, context.path, cb);');
      } else {
        const extraParamSource = Array.isArray(extraParams) && extraParams.length > 0
          ? `, ${extraParams.join(', ')}`
          : '';
        this.line(`function ${name}(env, context, runtime, cb, parentBuffer = null${extraParamSource}, __ec = null) {`);
      }
    } else {
      this.line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.line(`let lineno = ${node.lineno};`);
      this.line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer.currentBuffer} = "";`);
    if (this.compiler.asyncMode && name === 'root') {
      const rootErrorContextArg = this.compiler.emitBufferErrorContext(node, { boundaryName: name });
      this.line(
        `let ${this.compiler.buffer.currentBuffer} = ` +
        `new runtime.CommandBuffer(context, null, null, null, null, ${rootErrorContextArg});`
      );
      if (!this.compiler.scriptMode) {
        this.line(
          `let ${this.compiler.buffer.currentTextChainVar} = ` +
          `runtime.declareBufferChain(${this.compiler.buffer.currentBuffer}, "${this.compiler.buffer.currentTextChainName}", "text", context, null);`
        );
      }
    } else {
      const managedBufferErrorContext = this.compiler.asyncMode
        ? this.compiler.emitBufferErrorContext(node, { boundaryName: name })
        : null;
      this.compiler.buffer.initManagedBuffer(
        this.compiler.buffer.currentBuffer,
        this.compiler.asyncMode ? 'parentBuffer' : null,
        this.compiler.buffer.currentTextChainVar,
        linkedChains,
        managedBufferErrorContext,
        this.compiler.asyncMode ? 'parentBuffer' : 'null'
      );
    }
    if (!this.compiler.asyncMode) {
      this.line('try {');
    }
  }

  _endEntryFunction(node, noReturn) {
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
    if (this.compiler.asyncMode) {
      this.line('}');
      return;
    }
    this.line('} catch (e) {');
    const errorContextLabel = node ? `"${this.compiler._generateErrorContext(node)}"` : 'null';
    this.line(`  var err = runtime.handleError(e, lineno, colno, ${errorContextLabel}, context.path);`); // Store and update the handled error
    this.line('  cb(err);'); // Pass the updated error to the callback
    //this.Line('  throw e;');//the returned promise should not resolve
    this.line('}');
    this.line('}');
  }

  // Managed block for direct scope/frame handling (optionally with a scope-root buffer).
  // If createScopeRootBuffer=true, this is a sanctioned scope-root buffer creation
  // site. The callback body is compiled between initialization and caller-managed finalization.
  managedBlock(frame, createScope = false, createScopeRootBuffer = false, emitFunc = null, parentBufferOverride = undefined, analysisNode = null, errorContextNode = analysisNode, traceParentOverride = undefined) {
    let nextFrame = frame;
    if (createScope) {
      nextFrame = frame.push();
      this.line('frame = frame.push();');
    }

    let parentBufferId = null;
    let bufferId = null;
    let linkedChains = null;
    if (createScopeRootBuffer) {
      parentBufferId = parentBufferOverride !== undefined
        ? parentBufferOverride
        : (this.compiler.buffer.currentBuffer || null);
      if (parentBufferId && analysisNode && analysisNode._analysis) {
        linkedChains = analysisNode._analysis.createsLinkedChildBuffer
          ? this.getLinkedChains(analysisNode)
          : null;
      }
      bufferId = this.compiler._tmpid();
      this.compiler.buffer.withBufferState({
        currentBuffer: bufferId,
        currentTextChainVar: `${bufferId}_textChainVar`
      }, () => {
        const traceParentArg = traceParentOverride !== undefined
          ? traceParentOverride
          : (parentBufferId || 'null');
        const managedBufferErrorContext = this.compiler.asyncMode
          ? this.compiler.emitBufferErrorContext(errorContextNode)
          : null;
        this.compiler.buffer.initManagedBuffer(
          bufferId,
          parentBufferId,
          `${bufferId}_textOutputVar`,
          linkedChains,
          managedBufferErrorContext,
          traceParentArg
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

  getLinkedChainsArg(node) {
    const linkedChains = this.getLinkedChains(node);
    return linkedChains.length > 0 ? JSON.stringify(linkedChains) : 'null';
  }

  getLinkedMutatedChainsArg(node) {
    const linkedMutatedChains = this.getLinkedMutatedChains(node);
    return linkedMutatedChains.length > 0 ? JSON.stringify(linkedMutatedChains) : 'null';
  }

  _getAnalysis(node, helperName) {
    if (!node || !node._analysis) {
      const nodeType = node && (node.typename || node.constructor && node.constructor.name);
      throw new Error(`${helperName} requires analysis metadata for ${nodeType || 'unknown node'}`);
    }
    return node._analysis;
  }

  getLinkedChains(node) {
    const analysis = this._getAnalysis(node, 'getLinkedChains');
    // Do not link currentWaitedChainName here.
    // __waited__ must stay flat: it tracks local WaitResolveCommand leaves, not child buffers.
    // Nested control-flow buffers are applied through their own chains/iterators.
    return Array.from(analysis.linkedChains ?? []);
  }

  getLinkedMutatedChains(node) {
    const analysis = this._getAnalysis(node, 'getLinkedMutatedChains');
    return Array.from(analysis.linkedMutatedChains ?? []);
  }

};

export {CompileEmit};
