/**
 * CompileBuffer - Output buffer management module
 *
 * Handles all output buffering operations for Cascada's deferred output system.
 * Manages buffer stacks, async buffer operations, and output command compilation.
 */

const nodes = require('../nodes');
const OUTPUT_COMMAND_CLASS = {
  data: 'DataCommand',
  sink: 'SinkCommand',
  sequence: 'SequenceCallCommand',
  text: 'TextCommand',
  value: 'ValueCommand'
};

class CompileBuffer {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentBuffer = null;
    this.currentTextOutput = null;
    this.bufferStack = [];
    this.textOutputStack = [];
    // Temp value ids for split buffer writes (asyncAddToBufferBegin/End), supports nesting.
    // @otodo - evaluate these buffers, we shall be able to store
    // the values in the frame, the only probblem is when node.isAsync
    // is false in asyncMode, then new frame is not created?
    this._bufferValueStack = [];
    this._bufferAddStack = [];
  }

  // === BUFFER STACK MANAGEMENT ===

  /**
   * Create a scope-root buffer and initialize output handlers.
   * This is one of the sanctioned creation points for CommandBuffer and is
   * used by root/managed non-async scope-root blocks.
   * It only allocates/initializes runtime variables; it does not push stack state.
   */
  createScopeRootBuffer(bufferId = this.currentBuffer, textOutputId = this.currentTextOutput) {
    if (this.compiler.asyncMode) {
      this.compiler.emit.line(`let ${bufferId} = runtime.createCommandBuffer(context, null);`);
      this.compiler.emit.initOutputHandlers(bufferId, textOutputId || `${bufferId}_textOutput`);
    } else {
      this.compiler.emit.line(`let ${bufferId} = "";`);
    }
  }

  /**
   * Push a new buffer identifier onto the stack.
   * Does not allocate/initialize the underlying buffer.
   * Pair with popBuffer() to keep compiler-side buffer tracking balanced.
   * Returns the new buffer identifier.
   */
  pushBuffer() {
    const id = this.compiler._tmpid();
    this.bufferStack.push(this.currentBuffer);
    this.textOutputStack.push(this.currentTextOutput);
    this.currentBuffer = id;
    this.currentTextOutput = `${id}_textOutput`;
    if (!this.compiler.asyncMode) {
      this.currentTextOutput = null;
    }
    return id;
  }

  /**
   * Restore the previous buffer from the stack.
   */
  popBuffer() {
    this.currentBuffer = this.bufferStack.pop();
    this.currentTextOutput = this.textOutputStack.pop();
  }

  setBufferAlias(bufferId, textOutputId = null) {
    const prev = {
      currentBuffer: this.currentBuffer,
      currentTextOutput: this.currentTextOutput
    };
    this.currentBuffer = bufferId;
    this.currentTextOutput = textOutputId;
    return prev;
  }

  restoreBufferAlias(prev) {
    if (!prev) {
      return;
    }
    this.currentBuffer = prev.currentBuffer;
    this.currentTextOutput = prev.currentTextOutput;
  }

  /**
   * Get the current buffer identifier
   */
  getCurrentBuffer() {
    return this.currentBuffer;
  }

  getCurrentTextOutput() {
    return this.currentTextOutput;
  }

  _getBufferAccess() {
    // In async mode, buffers are CommandBuffer instances (use .output).
    return this.compiler.asyncMode ? `${this.currentBuffer}.output` : this.currentBuffer;
  }

  _emitTemplateTextCommandExpression(valueExpression, positionNode, normalizeArgs = false) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `new runtime.TextCommand({ handler: "text", args: [${valueExpression}], normalizeArgs: ${normalizeArgs}, pos: {lineno: ${lineno}, colno: ${colno}} })`;
  }

  _emitPositionLiteral(positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `{lineno: ${lineno}, colno: ${colno}}`;
  }

  _compileCommandConstruction(node, frame) {
    const isCallNode = node.call instanceof nodes.FunCall;
    const staticPath = this.compiler.sequential._extractStaticPath(isCallNode ? node.call.name : node.call);
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is handler(...) or handler.command(...) or handler.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    const handler = staticPath[0];
    this.registerOutputUsage(frame, handler);
    const outputDecl = this.compiler.async._getDeclaredOutput(frame, handler);
    const outputType = node.outputType || (outputDecl ? outputDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;

    if (outputType === 'sequence') {
      if (isCallNode) {
        if (!command) {
          this.compiler.fail('Invalid sequence command syntax: expected sequenceOutput.method(...)', node.lineno, node.colno, node);
        }
        this.compiler.emit(`new runtime.SequenceCallCommand({ handler: '${handler}', command: '${command}', `);
        if (subpath && subpath.length > 0) {
          this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
        }
        this.compiler.emit('args: ');
        this.compiler._compileAggregate(node.call.args, frame, '[', ']', false, true);
        this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }

      if (!command) {
        this.compiler.fail('Invalid sequence read syntax: expected sequenceOutput.path', node.lineno, node.colno, node);
      }
      this.compiler.emit(`new runtime.SequenceGetCommand({ handler: '${handler}', command: '${command}', `);
      if (subpath && subpath.length > 0) {
        this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }
      this.compiler.emit(`pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    const commandClass = OUTPUT_COMMAND_CLASS[outputType];
    if (!commandClass) {
      this.compiler.fail(
        `Unsupported output command target '${handler}'. Output commands must target declared outputs (data/text/value/sink/sequence).`,
        node.lineno,
        node.colno,
        node
      );
    }

    this.compiler.emit(`new runtime.${commandClass}({ handler: '${handler}', `);
    if (command) {
      this.compiler.emit(`command: '${command}', `);
    }
    if (outputType === 'text') {
      this.compiler.emit('normalizeArgs: true, ');
    }
    if (outputType === 'sink' && subpath && subpath.length > 0) {
      this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
    }
    let argList = node.call.args;
    const asyncArgs = argList.isAsync;
    if (outputType === 'data') {
      // For data outputs, we create a new "virtual" AST for the arguments,
      // where the first argument is a path like "user.posts[0].title" that
      // needs to be converted into a JavaScript array like ['user', 'posts', 0, 'title'].
      const originalArgs = node.call.args.children;
      if (originalArgs.length === 0) {
        this.compiler.fail(`data command '${command}' requires at least a path argument.`, node.lineno, node.colno, node);
      }

      const pathArg = originalArgs[0];

      // Convert the path argument into a flat array of segments (Literal/Symbol)
      // @todo - move this to the transformer phase?
      // expected by the runtime data handlers.
      const pathNodeList = this.compiler._flattenPathToNodeList(pathArg);
      const dataPathNode = new nodes.Array(pathArg.lineno, pathArg.colno, pathNodeList.children);
      dataPathNode.isAsync = pathNodeList.isAsync;
      dataPathNode.mustResolve = true;

      // Our array node at the front.
      const newArgs = [dataPathNode, ...originalArgs.slice(1)];

      argList = new nodes.NodeList(node.call.args.lineno, node.call.args.colno, newArgs);
      argList.isAsync = asyncArgs;
    }

    this.compiler.emit('args: ');
    // Output commands are constructed with unresolved args; resolution/normalization
    // happens once in runtime right before command.apply().
    this.compiler._compileAggregate(argList, frame, '[', ']', false, true);
    this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
  }

  registerOutputUsage(frame, outputName) {
    if (!this.compiler.asyncMode || !outputName) {
      return;
    }

    let df = frame;
    while (df) {
      if (df.declaredOutputs && df.declaredOutputs.has(outputName)) {
        break;
      }
      // Outputs follow lexical scoping only (same as variables).
      df = df.parent;
    }

    let current = frame;
    while (current) {
      current.usedOutputs = current.usedOutputs || new Set();
      current.usedOutputs.add(outputName);
      if (current === df) {
        break;
      }
      current = current.parent;
    }
  }

  emitAddCommand(frame, outputName, valueExpr, positionNode = null, emitTextCommand = false) {
    if (this.compiler.asyncMode && outputName) {
      this.registerOutputUsage(frame, outputName);
    }
    if (emitTextCommand) {
      this.compiler.emit.line(
        `${this.currentBuffer}.addText(${valueExpr}, ${this._emitPositionLiteral(positionNode)}, "${outputName}")`
      );
      return;
    }
    if (outputName) {
      this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${outputName}");`);
    } else {
      this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr});`);
    }
  }

  emitAddSequenceGet(frame, outputName, commandName, subpath, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceGet("${outputName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSequenceCall(frame, outputName, commandName, subpath, argsExpr, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceCall("${outputName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${argsExpr}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSnapshot(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addSnapshot("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddIsError(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addIsError("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddGetError(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addGetError("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  // === HANDLER ANALYSIS ===

  /**
   * Recursively collect all output handlers written to within a node's subtree.
   * Used to determine which handlers need poison markers when branch is skipped.
   *
   * @param {Node} node - AST node to analyze
   * @returns {Set<string>} Set of handler names ('text', 'data', etc.)
   */
  collectBranchHandlers(node) {
    const handlers = new Set();

    const traverse = (n) => {
      if (!n) return;

      // Case 1: Regular output {{ ... }} uses implicit 'text' handler
      if (n instanceof nodes.Output) {
        handlers.add('text');
      }

      // Case 2: OutputCommand handler.method() or handler()
      if (n instanceof nodes.OutputCommand) {
        const pathNode = n.call instanceof nodes.FunCall ? n.call.name : n.call;
        const staticPath = this.compiler.sequential._extractStaticPath(pathNode);
        if (staticPath && staticPath.length > 0) {
          const handlerName = staticPath[0]; // First segment is always handler name
          handlers.add(handlerName);
        }
      }

      // Recurse into all children
      const children = this.compiler._getImmediateChildren(n);
      children.forEach(child => traverse(child));
    };

    traverse(node);
    return handlers;
  }

  // === OUTPUT COMMAND COMPILATION ===

  /**
   * Compile output command: handler.method(args)
   * Handles output variables (data/text/value/sink) and custom sinks
   */
  compileOutputCommand(node, frame) {
    // Preserve output routing in asyncAddToBuffer; validation remains in _compileCommandConstruction.
    const pathNode = node.call instanceof nodes.FunCall ? node.call.name : node.call;
    let current = pathNode;
    while (current instanceof nodes.LookupVal) {
      current = current.target;
    }
    const handler = current instanceof nodes.Symbol
      ? current.value
      : (current instanceof nodes.Literal && typeof current.value === 'string' ? current.value : null);

    this.asyncAddValueToBuffer(node, frame, (resultVar, f) => {
      this.compiler.emit(`${resultVar} = `);
      this._compileCommandConstruction(node, f);
    }, node, handler);
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, outputName = 'text', emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      if (emitTextCommand) {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, outputName, valueId, positionNode, true);
        return;
      } else {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, outputName, valueId);
        return;
      }
    } else {
      this.compiler.emit(`${this.currentBuffer} += `);
      renderFunction.call(this.compiler, frame);
    }
    if (!this.compiler.asyncMode) {
      this.compiler.emit.line(';');
    }
  }

  /**
   * Add value to buffer (async mode with error handling)
   */
  asyncAddToBuffer(node, frame, renderFunction, positionNode = node, handlerName = null, outputName = 'text', emitTextCommand = false) {
    const returnId = this.compiler._tmpid();
    if (this.compiler.asyncMode) {
      this.compiler.emit.asyncClosureDepth++;
      frame = frame.push(false, false);
      if (outputName) {
        this.registerOutputUsage(frame, outputName);
      }

      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);
      this.compiler.emit.line(`await ${this.currentBuffer}.addAsyncArgsCommand("${outputName}", (async () => {`);
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(';');
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(returnId, positionNode)
        : returnId;
      this.compiler.emit.line(`return ${valueExpr};`);
      this.compiler.emit.line(`})(), cb);`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(frame, positionNode);
      this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);

      frame = frame.pop();

    } else {
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      if (this.compiler.asyncMode) {
        this.emitAddCommand(frame, outputName, returnId, positionNode, emitTextCommand);
      } else {
        this.compiler.emit.line(`${this.currentBuffer} += ${returnId};`);
      }
    }
  }

  /**
   * Add a value to the buffer without producer slot-fill wrapping.
   * Use when value construction does not require addAsyncArgsCommand producer semantics.
   * The value is added directly to the current buffer (no extra async block).
   */
  asyncAddValueToBuffer(node, frame, renderFunction, positionNode = node, outputName = 'text', emitTextCommand = false) {
    void node;
    const returnId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${returnId};`);
    renderFunction.call(this.compiler, returnId, frame);
    this.compiler.emit.line(';');
    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(returnId, positionNode)
      : returnId;
    this.emitAddCommand(frame, outputName, valueExpr);
  }

  /**
   * Begin async buffer addition (split pattern)
   */
  asyncAddToBufferBegin(node, frame, positionNode = node, handlerName = null, outputName = 'text') {
    if (this.compiler.asyncMode) {
      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame) => {`);
      const valueId = this.compiler._tmpid();
      this._bufferValueStack.push(valueId);
      this.compiler.emit.line(`await ${this.currentBuffer}.addAsyncArgsCommand("${outputName}", (async () => {`);
      this.compiler.emit(`let ${valueId} = `);
      this.compiler.emit.asyncClosureDepth++;
      // Store handlerName for End to use
      //this._pendingHandler = handlerName;
      const innerFrame = frame.push(false, false);
      if (outputName) {
        this.registerOutputUsage(innerFrame, outputName);
      }
      return innerFrame;
    }
    /*if (this.compiler.asyncMode) {
      if (outputName) { this.registerOutputUsage(frame, outputName); }
      const valueId = this.compiler._tmpid();
      this._bufferValueStack.push(valueId);
      this.compiler.emit(`let ${valueId} = `);
    } */else {
      this.compiler.emit(`${this.currentBuffer} += `);
    }
    return frame;
  }

  /**
   * End async buffer addition (split pattern)
   */
  asyncAddToBufferEnd(node, frame, positionNode = node, handlerName = null, outputName = 'text', emitTextCommand = false, normalizeTextArgs = false) {
    void handlerName;
    void outputName;
    const valueId = this.compiler.asyncMode ? this._bufferValueStack.pop() : null;
    this.compiler.emit.line(';');
    if (this.compiler.asyncMode) {
      // Enqueue the command with unresolved arguments.
      // Argument resolution and error handling are performed at apply-time.
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(valueId, positionNode, normalizeTextArgs)
        : valueId;
      this.compiler.emit.line(`return ${valueExpr};`);
      this.compiler.emit.line(`})(), cb);`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(frame, positionNode);
      this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);
      return frame.pop();
    }
    return frame;
  }

  // === NESTED BUFFER MANAGEMENT ===

  /**
   * Create nested buffer for async block to avoid race conditions
   */
  asyncBufferNodeBegin(node, frame, createScope = false, positionNode = node) {
    if (node.isAsync) {
      // Start the async closure
      frame = this.compiler.emit.asyncBlockBegin(node, frame, createScope, positionNode);

      // Push the current buffer onto the stack
      this.bufferStack.push(this.currentBuffer);
      this.textOutputStack.push(this.currentTextOutput);
      const parentBuffer = this.currentBuffer;

      // Create a new buffer reference for this nested block.
      const newBuffer = this.compiler._tmpid();
      this.compiler.emit.line(`let ${newBuffer} = frame._outputBuffer || ${parentBuffer};`);

      // Defer parent-child buffer linking until async block body is emitted.
      const addPos = this.compiler.codebuf.length;
      this.compiler.emit.line('');
      this._bufferAddStack.push({ pos: addPos, parentBuffer, newBuffer });

      // Update the buffer reference
      this.currentBuffer = newBuffer;
      this.currentTextOutput = null;
      return frame;
    } else if (createScope) {
      frame = frame.push();
      this.compiler.emit.line('frame = frame.push();');
      return frame;
    }
    return frame;
  }

  /**
   * Restore parent buffer after async block
   */
  asyncBufferNodeEnd(node, frame, createScope = false, sequential = false, positionNode = node) {
    if (node.isAsync) {
      const addInfo = this._bufferAddStack.pop();
      if (addInfo) {
        const usedOutputs = frame.usedOutputs ? Array.from(frame.usedOutputs) : [];
        usedOutputs.forEach((outputName) => {
          // Do not bubble outputs declared in this async block's lexical scope.
          if (frame.declaredOutputs && frame.declaredOutputs.has(outputName)) {
            return;
          }
          this.compiler.emit.insertLine(
            addInfo.pos,
            `if (${addInfo.newBuffer} !== ${addInfo.parentBuffer}) { ${addInfo.parentBuffer}.addBuffer(${addInfo.newBuffer}, "${outputName}"); }`
          );
        });
      }

      // End the async closure
      frame = this.compiler.emit.asyncBlockEnd(node, frame, createScope, sequential, positionNode);

      // Restore the previous buffer from the stack
      this.currentBuffer = this.bufferStack.pop();
      this.currentTextOutput = this.textOutputStack.pop();
      return frame;
    } else if (createScope) {
      frame = frame.pop();
      this.compiler.emit.line('frame = frame.pop();');
      return frame;
    }
    return frame;
  }
}

module.exports = CompileBuffer;

