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
    emitFunc.call(this.compiler);
    const captured = this.compiler.codebuf.join('');
    this.compiler.codebuf = previousCodebuf;
    this.scopeClosers = previousScopeClosers;
    return captured;
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
        this.line(`function ${name}(env, context, runtime, renderState) {`);
        this.line('const __ec = getErrorContexts(runtime, context.path, renderState);');
      } else {
        const extraParamSource = Array.isArray(extraParams) && extraParams.length > 0
          ? `, ${extraParams.join(', ')}`
          : '';
        this.line(`function ${name}(env, context, runtime, renderState, parentBuffer = null${extraParamSource}) {`);
      }
    } else {
      this.line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.line(`let lineno = ${node.lineno};`);
      this.line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer.currentBuffer} = "";`);
    if (this.compiler.asyncMode && name === 'root') {
      const rootBufferStackErrorContext = this.compiler.emitErrorContext(node, { entryName: name });
      this.compiler.buffer.emitScopeCommandBuffer({
        bufferId: this.compiler.buffer.currentBuffer,
        textChainVar: this.compiler.buffer.currentTextChainVar,
        bufferStackErrorContextArg: rootBufferStackErrorContext
      });
    } else {
      const scopeBufferStackErrorContext = this.compiler.asyncMode
        ? this.compiler.emitErrorContext(node, { entryName: name })
        : null;
      this.compiler.buffer.emitScopeCommandBuffer({
        bufferId: this.compiler.buffer.currentBuffer,
        parentBufferId: this.compiler.asyncMode ? 'parentBuffer' : null,
        textChainVar: this.compiler.buffer.currentTextChainVar,
        linkedChains,
        bufferStackErrorContextArg: scopeBufferStackErrorContext,
        traceParentArg: this.compiler.asyncMode ? 'parentBuffer' : 'null'
      });
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
    this.line(`  var err = runtime.createSyncRuntimeError(e, lineno, colno, ${errorContextLabel}, context.path);`); // Store and update the handled error
    this.line('  cb(err);'); // Pass the updated error to the callback
    //this.Line('  throw e;');//the returned promise should not resolve
    this.line('}');
    this.line('}');
  }

  withScopeCommandBuffer({
    frame,
    emitFunc = null,
    parentBufferOverride = undefined,
    analysisNode = null,
    errorContextNode = analysisNode,
    traceParentOverride = undefined,
    bufferStackErrorContextFields = null,
    declareTextChain = true,
    autoFinish = false
  }) {
    const parentBufferId = parentBufferOverride !== undefined
      ? parentBufferOverride
      : (this.compiler.buffer.currentBuffer || null);
    const {
      linkedChains,
      linkedMutatedChains
    } = this.getScopeBufferLinkedChains(analysisNode, parentBufferId);
    const bufferId = this.compiler._tmpid();

    const emitScope = () => this.compiler.buffer.withBufferState({
      currentBuffer: bufferId,
      currentTextChainVar: declareTextChain ? `${bufferId}_textChainVar` : null
    }, () => {
      const traceParentArg = traceParentOverride !== undefined
        ? traceParentOverride
        : (parentBufferId || 'null');
      const scopeBufferStackErrorContext = this.getBufferStackErrorContextArg({
        errorContextNode,
        stackFields: bufferStackErrorContextFields,
        owned: false
      });
      this.compiler.buffer.emitScopeCommandBuffer({
        bufferId,
        parentBufferId,
        textChainVar: `${bufferId}_textOutputVar`,
        linkedChains,
        linkedMutatedChains,
        bufferStackErrorContextArg: scopeBufferStackErrorContext,
        traceParentArg,
        declareTextChain
      });
      if (typeof emitFunc === 'function') {
        emitFunc(frame, bufferId);
      }
      if (autoFinish && this.compiler.asyncMode) {
        this.line(`${bufferId}.finish();`);
      }
    });
    // Detached scope buffers start a fresh lexical runtime surface, so the
    // special loop binding from an enclosing loop must not be captured.
    if (parentBufferOverride === null) {
      this.compiler.withCurrentLoopVar(null, emitScope);
    } else {
      emitScope();
    }

    return { frame, bufferId };
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

  getBoundaryLinkedChainArgs(node) {
    return {
      linkedChainsArg: this.getLinkedChainsArg(node),
      linkedMutatedChainsArg: this.getLinkedMutatedChainsArg(node)
    };
  }

  getScopeBufferLinkedChains(node, parentBufferId) {
    const hasAnalysis = parentBufferId && node && node._analysis;
    return {
      linkedChains: hasAnalysis ? this.getLinkedChains(node) : null,
      linkedMutatedChains: hasAnalysis ? this.getLinkedMutatedChains(node) : null
    };
  }

  getBufferStackErrorContextArg({
    errorContextNode,
    stackFields = null,
    owned = false
  }) {
    if (!this.compiler.asyncMode) {
      return null;
    }
    return this.compiler.emitBufferStackErrorContext(errorContextNode, stackFields, { owned });
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
    if (!analysis.linkedChains) {
      return [];
    }
    return Array.from(analysis.linkedChains);
  }

  getLinkedMutatedChains(node) {
    const analysis = this._getAnalysis(node, 'getLinkedMutatedChains');
    if (!analysis.linkedMutatedChains) {
      return [];
    }
    return Array.from(analysis.linkedMutatedChains);
  }

};

export {CompileEmit};
