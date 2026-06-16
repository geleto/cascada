import {DEFAULT_TEMPLATE_TEXT_CHAIN} from './buffer.js';

class CompileEmit {
  constructor(compiler) {
    this.scopeClosers = '';
    this.compiler = compiler;
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
    boundaryLinkedChains = null,
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
      this._beginEntryFunction(node, name, boundaryLinkedChains, extraParams);
      emitFunc.call(this.compiler);
      this._endEntryFunction(node, noReturn);
    });
  }

  _beginEntryFunction(node, name, boundaryLinkedChains = null, extraParams = []) {
    this.scopeClosers = '';
    if (this.compiler.asyncMode) {
      if (name === 'root') {
        this.line(`function ${name}(ownerState, context) {`);
      } else {
        const extraParamSource = Array.isArray(extraParams) && extraParams.length > 0
          ? `, ${extraParams.join(', ')}`
          : '';
        this.line(`function ${name}(ownerState, context, parentBuffer = null${extraParamSource}) {`);
      }
      this.line('const env = ownerState.env;');
      this.line('const runtime = ownerState.runtime;');
      this.line('const renderState = ownerState.renderState;');
      if (name === 'root') {
        this.line('const __ec = ownerState.errorContextTable;');
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
        boundaryLinkedChains,
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
      boundaryLinkedChains,
      boundaryLinkedMutatedChains
    } = this.getScopeBufferBoundaryLinkedChains(analysisNode, parentBufferId);
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
        boundaryLinkedChains,
        boundaryLinkedMutatedChains,
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

  getBoundaryLinkedChainsArg(node) {
    const boundaryLinkedChains = this.getBoundaryLinkedChains(node);
    return boundaryLinkedChains.length > 0 ? JSON.stringify(boundaryLinkedChains) : 'null';
  }

  getBoundaryLinkedMutatedChainsArg(node) {
    const boundaryLinkedMutatedChains = this.getBoundaryLinkedMutatedChains(node);
    return boundaryLinkedMutatedChains.length > 0 ? JSON.stringify(boundaryLinkedMutatedChains) : 'null';
  }

  getBoundaryLinkedChainArgs(node) {
    return {
      boundaryLinkedChainsArg: this.getBoundaryLinkedChainsArg(node),
      boundaryLinkedMutatedChainsArg: this.getBoundaryLinkedMutatedChainsArg(node)
    };
  }

  getScopeBufferBoundaryLinkedChains(node, parentBufferId) {
    const hasAnalysis = parentBufferId && node && node._analysis;
    return {
      boundaryLinkedChains: hasAnalysis ? this.getBoundaryLinkedChains(node) : null,
      boundaryLinkedMutatedChains: hasAnalysis ? this.getBoundaryLinkedMutatedChains(node) : null
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

  getBoundaryLinkedChains(node) {
    const analysis = this._getAnalysis(node, 'getBoundaryLinkedChains');
    // Do not link currentWaitedChainName here.
    // __waited__ must stay flat: it tracks local WaitResolveCommand leaves, not child buffers.
    // Nested control-flow buffers are applied through their own chains/iterators.
    if (!analysis.boundaryLinkedChains) {
      return [];
    }
    return Array.from(analysis.boundaryLinkedChains);
  }

  getBoundaryLinkedMutatedChains(node) {
    const analysis = this._getAnalysis(node, 'getBoundaryLinkedMutatedChains');
    if (!analysis.boundaryLinkedMutatedChains) {
      return [];
    }
    return Array.from(analysis.boundaryLinkedMutatedChains);
  }

};

export {CompileEmit};
