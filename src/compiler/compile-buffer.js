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
    this._bufferIndexStack = [];
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

  _emitTemplateTextCommandExpression(valueExpression, positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `new runtime.TextCommand({ handler: "text", args: [${valueExpression}], pos: {lineno: ${lineno}, colno: ${colno}} })`;
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
        const staticPath = this.compiler.sequential._extractStaticPath(n.call.name);
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
    // Extract static path once for validation and compilation
    const staticPath = this.compiler.sequential._extractStaticPath(node.call.name);

    // Validate the static path
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is handler(...) or handler.command(...) or handler.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    // Extract handler, subpath, and command from static path
    const handler = staticPath[0];
    const outputDecl = this.compiler.async._getDeclaredOutput(frame, handler);
    const outputType = node.outputType || (outputDecl ? outputDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;

    const isAsync = node.isAsync;

    if (this.compiler.asyncMode) {
      this.compiler.async.updateOutputUsage(frame, handler);
    }

    const useExplicitOutputBuffer = outputDecl && !frame.outputScope;

    // Use a wrapper to avoid duplicating the sync/async logic.
    const wrapper = (emitLogic) => {
      if (isAsync) {
        if (useExplicitOutputBuffer) {
          const returnId = this.compiler._tmpid();
          const handlerVar = this.compiler._tmpid();
          const bufferVar = this.compiler._tmpid();
          this.compiler.emit.asyncClosureDepth++;
          const innerFrame = frame.push(false, false);
          this.compiler.async.updateOutputUsage(innerFrame, handler);
          this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);
          this.compiler.emit.line(`let ${handlerVar} = runtime.getOutputHandler(frame, "${handler}");`);
          this.compiler.emit.line(`let ${bufferVar} = (${handlerVar} && ${handlerVar}._frame && ${handlerVar}._frame._outputBuffer) ? ${handlerVar}._frame._outputBuffer : ${this.currentBuffer};`);
          this.compiler.emit.line(`let index = ${bufferVar}.reserveSlot("${handler}");`);
          this.compiler.emit.line('try {');
          this.compiler.emit.line(`  let ${returnId};`);
          this.compiler.emit(`${returnId} = `);
          emitLogic(innerFrame);
          this.compiler.emit.line(';');
          this.compiler.emit.line(`  ${bufferVar}.fillSlot(index, ${returnId}, "${handler}");`);
          this.compiler.emit.line('} catch(e) {');
          this.compiler.emit.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
          this.compiler.emit.line(`  const processedErrors = errors.map(err => runtime.handleError(err, ${node.lineno}, ${node.colno}, "${this.compiler._generateErrorContext(node, node)}", context.path));`);
          this.compiler.emit.line(`  ${bufferVar}.fillSlot(index, new runtime.ErrorCommand(processedErrors), "${handler}");`);
          this.compiler.emit.line('}');
          this.compiler.emit.asyncClosureDepth--;
          this.compiler.emit.line('}');
          const errorContext = this.compiler._generateErrorContext(node, node);
          const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(innerFrame, node);
          this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${node.lineno}, ${node.colno}, context, "${errorContext}");`);
        } else {
          this.asyncAddToBuffer(node, frame, (resultVar, f) => {
            this.compiler.emit(`${resultVar} = `);
            emitLogic(f); // Pass the inner frame to the logic.
          }, node, handler, handler);
        }
      } else {
        if (useExplicitOutputBuffer) {
          const handlerVar = this.compiler._tmpid();
          const bufferVar = this.compiler._tmpid();
          const valueId = this.compiler._tmpid();
          this.compiler.emit.line(`let ${handlerVar} = runtime.getOutputHandler(frame, "${handler}");`);
          this.compiler.emit.line(`let ${bufferVar} = (${handlerVar} && ${handlerVar}._frame && ${handlerVar}._frame._outputBuffer) ? ${handlerVar}._frame._outputBuffer : ${this.currentBuffer};`);
          this.compiler.emit(`let ${valueId} = `);
          emitLogic(frame);
          this.compiler.emit.line(';');
          this.compiler.emit.line(`${bufferVar}.add(${valueId}, "${handler}");`);
        } else {
          this.addToBuffer(node, frame, () => {
            emitLogic(frame); // Pass the current frame.
          }, node, handler);
        }
      }
    };

    wrapper((f) => {
      const commandClass = OUTPUT_COMMAND_CLASS[outputType];
      if (!commandClass) {
        this.compiler.fail(
          `Unsupported output command target '${handler}'. Output commands must target declared outputs (data/text/value/sink).`,
          node.lineno,
          node.colno,
          node
        );
      }

      this.compiler.emit(`new runtime.${commandClass}({ handler: '${handler}', `);
      if (command) {
        this.compiler.emit(`command: '${command}', `);
      }
      if (outputType === 'sink' && subpath && subpath.length > 0) {
        this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }

      let argList = node.call.args;
      const asyncArgs = argList.isAsync;
      if (outputType === 'text') {
        this.compiler.emit('args: runtime.normalizeScriptTextArgs(' + (asyncArgs ? 'await ' : ''));
      } else {
        this.compiler.emit('args: ' + (asyncArgs ? 'await ' : ''));
      }

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

      this.compiler._compileAggregate(argList, f, '[', ']', isAsync, true);
      if (outputType === 'text') {
        this.compiler.emit(', env.opts.autoescape)');
      }

      this.compiler.emit(`, pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`);
    });
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, outputName = 'text', emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      if (outputName) {
        this.compiler.async.updateOutputUsage(frame, outputName);
      }
      if (emitTextCommand) {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
        const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
        this.compiler.emit.line(`${this.currentBuffer}.addText(${valueId}, {lineno: ${lineno}, colno: ${colno}}, "${outputName}");`);
        return;
      } else {
        this.compiler.emit.line(`${this.currentBuffer}.add(`);
        renderFunction.call(this.compiler, frame);
      }
    } else {
      this.compiler.emit(`${this.currentBuffer} += `);
      renderFunction.call(this.compiler, frame);
    }
    if (this.compiler.asyncMode) {
      if (outputName) {
        this.compiler.emit(`, "${outputName}"`);
      }
      this.compiler.emit.line(');');
    } else {
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
        this.compiler.async.updateOutputUsage(frame, outputName);
      }

      const indexId = this.compiler._tmpid();
      this.compiler.emit.line(`let ${indexId} = ${this.currentBuffer}.reserveSlot("${outputName}");`);
      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);

      this.compiler.emit.line(`try {`);
      this.compiler.emit.line(`  let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(';');
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(returnId, positionNode)
        : returnId;
      this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(${indexId}, ${valueExpr}, "${outputName}");`);

      this.compiler.emit.line(`} catch(e) {`);
      this.compiler.emit.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
      this.compiler.emit.line(`  const processedErrors = errors.map(err => runtime.handleError(err, ${positionNode.lineno}, ${positionNode.colno}, "${this.compiler._generateErrorContext(node, positionNode)}", context.path));`);
      // For reserveSlot/fillSlot paths, always materialize failure in the reserved slot.
      // Avoid addPoison here: it uses buffer.add(), which can throw if the
      // child buffer finished before this async write settled.
      this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(${indexId}, new runtime.ErrorCommand(processedErrors), "${outputName}");`);
      this.compiler.emit.line(`}`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(frame, positionNode);
      this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);

      frame = frame.pop();

    } else {
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(returnId, positionNode)
        : returnId;
      if (this.compiler.asyncMode) {
        this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${outputName}");`);
      } else {
        this.compiler.emit.line(`${this.currentBuffer} += ${returnId};`);
      }
    }
  }

  /**
   * Begin async buffer addition (split pattern)
   */
  asyncAddToBufferBegin(node, frame, positionNode = node, handlerName = null, outputName = 'text') {
    if (node.isAsync) {
      const indexId = this.compiler._tmpid();
      this._bufferIndexStack.push(indexId);
      this.compiler.emit.line(`let ${indexId} = ${this.currentBuffer}.reserveSlot("${outputName}");`);
      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame) => {`);
      const valueId = this.compiler._tmpid();
      this._bufferValueStack.push(valueId);
      this.compiler.emit.line(`try {`);
      this.compiler.emit(`  let ${valueId} = `);
      this.compiler.emit.asyncClosureDepth++;
      // Store handlerName for End to use
      //this._pendingHandler = handlerName;
      const innerFrame = frame.push(false, false);
      if (outputName) {
        this.compiler.async.updateOutputUsage(innerFrame, outputName);
      }
      return innerFrame;
    }
    if (this.compiler.asyncMode) {
      const valueId = this.compiler._tmpid();
      this._bufferValueStack.push(valueId);
      this.compiler.emit(`let ${valueId} = `);
    } else {
      this.compiler.emit(`${this.currentBuffer} += `);
    }
    return frame;
  }

  /**
   * End async buffer addition (split pattern)
   */
  asyncAddToBufferEnd(node, frame, positionNode = node, handlerName = null, outputName = 'text', emitTextCommand = false) {
    const valueId = this.compiler.asyncMode ? this._bufferValueStack.pop() : null;
    this.compiler.emit.line(';');
    if (node.isAsync) {
      const indexId = this._bufferIndexStack.pop();
      //const handlerName = this._pendingHandler;
      //this._pendingHandler = null;

      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(valueId, positionNode)
        : valueId;
      this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(${indexId}, ${valueExpr}, "${outputName}");`);
      this.compiler.emit.line(`} catch(e) {`);
      this.compiler.emit.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
      this.compiler.emit.line(`  const processedErrors = errors.map(err => runtime.handleError(err, ${positionNode.lineno}, ${positionNode.colno}, "${this.compiler._generateErrorContext(node, positionNode)}", context.path));`);
      // Same reasoning as asyncAddToBuffer(): never use addPoison in
      // reserveSlot/fillSlot catch blocks; fill the reserved slot directly.
      this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(${indexId}, new runtime.ErrorCommand(processedErrors), "${outputName}");`);
      this.compiler.emit.line(`}`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(frame, positionNode);
      this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);
      return frame.pop();
    }
    if (this.compiler.asyncMode) {
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(valueId, positionNode)
        : valueId;
      this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${outputName}");`);
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
