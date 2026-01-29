/**
 * CompileBuffer - Output buffer management module
 *
 * Handles all output buffering operations for Cascada's deferred output system.
 * Manages buffer stacks, async buffer operations, and output command compilation.
 */

const nodes = require('../nodes');

class CompileBuffer {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentBuffer = null;
    this.bufferStack = [];
    // Temp value ids for split buffer writes (asyncAddToBufferBegin/End), supports nesting.
    // @otodo - evaluate these buffers, we shall be able to store
    // the values in the frame, the only probblem is when node.isAsync
    // is false in asyncMode, then new frame is not created?
    this._bufferValueStack = [];
    this._bufferAddStack = [];
  }

  // === BUFFER STACK MANAGEMENT ===

  /**
   * Push a new buffer onto the stack and initialize it.
   * Returns the new buffer identifier.
   */
  push() {
    const id = this.compiler._tmpid();
    this.bufferStack.push(this.currentBuffer);
    this.currentBuffer = id;
    if (this.compiler.asyncMode) {
      this.compiler.emit.line(`let ${this.currentBuffer} = new runtime.CommandBuffer(context);`);
      this.compiler.emit.initOutputHandlers(this.currentBuffer);
    } else {
      this.compiler.emit.line(`let ${this.currentBuffer} = "";`);
    }
    return id;
  }

  /**
   * Restore the previous buffer from the stack.
   */
  pop() {
    this.currentBuffer = this.bufferStack.pop();
  }

  /**
   * Get the current buffer identifier
   */
  getCurrentBuffer() {
    return this.currentBuffer;
  }

  _getBufferAccess() {
    // In async mode, buffers are CommandBuffer instances (use .output).
    return this.compiler.asyncMode ? `${this.currentBuffer}.output` : this.currentBuffer;
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

      // Case 2: OutputCommand @handler.method() or @handler()
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
   * Compile output command: @handler.method(args)
   * Handles legacy @data, @text, and custom handler syntax
   */
  compileOutputCommand(node, frame) {
    // Extract static path once for both focus detection and compilation
    const staticPath = this.compiler.sequential._extractStaticPath(node.call.name);

    if (this.compiler.outputFocus) {//@todo - think this over
      //skip compiling commands that do not target the focued property
      let commandTarget;

      if (staticPath && staticPath.length >= 1) {
        commandTarget = staticPath[0]; // First segment is always the handler
      } /* else if (node.call.name.value === 'text') {
        // Special case for text command
        commandTarget = 'text';
      }*/

      // If we identified a specific target and it doesn't match the focus, skip compilation.
      if (commandTarget && this.compiler.outputFocus !== commandTarget) {
        return;
      }
      /*// If the focus is on 'data', we can safely skip all OutputCommands.
      if (this.compiler.outputFocus === 'data') {
        return;
      }*/
    }

    // Validate the static path
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid Method Command syntax. Expected format is @handler(...) or @handler.command(...) or @handler.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    // Extract handler, subpath, and command from static path
    const handler = staticPath[0];
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;

    const isAsync = node.isAsync;

    if (this.compiler.asyncMode) {
      this.compiler.async.updateOutputUsage(frame, handler);
    }

    // Use a wrapper to avoid duplicating the sync/async logic.
    const wrapper = (emitLogic) => {
      // Revert Command Interception
      if (command === '_revert') {
        if (subpath && subpath.length > 0) {
          this.compiler.fail('_revert() can only be called on the handler root (e.g. @data._revert())', node.lineno, node.colno, node);
        }
        // Special check for transpiled @data commands which move path to first argument
        if (handler === 'data' && node.call.args && node.call.args.children.length > 0) {
          const pathArg = node.call.args.children[0];
          // If pathArg is provided and is NOT a null literal, it means a subpath was provided
          // The transpiler generates Literal(null) for root calls like @data._revert()
          if (pathArg && !(pathArg instanceof nodes.Literal && pathArg.value === null)) {
            this.compiler.fail('_revert() can only be called on the handler root (e.g. @data._revert())', node.lineno, node.colno, node);
          }
        }
        const revertOutputs = new Set(['text', 'data', 'value']);
        if (frame.usedOutputs) {
          frame.usedOutputs.forEach(name => revertOutputs.add(name));
        }

        if (handler === '_') {
          revertOutputs.forEach((outputName) => {
            this.addToBuffer(node, frame, () => {
              this.compiler.emit(`{ handler: '_', command: '_revert', arguments: [], pos: { lineno: ${node.lineno}, colno: ${node.colno} } }`);
            }, node, outputName);
          });
          this.compiler.emit.line(`runtime.markBufferHasRevert(${this.currentBuffer}, ${JSON.stringify(Array.from(revertOutputs))});`);
          return;
        }

        this.addToBuffer(node, frame, () => {
          this.compiler.emit(`{ handler: '${handler}', command: '_revert', arguments: [], pos: { lineno: ${node.lineno}, colno: ${node.colno} } }`);
        }, node, handler);
        this.compiler.emit.line(`runtime.markBufferHasRevert(${this.currentBuffer}, ${JSON.stringify([handler])});`);
        return;
      }

      if (isAsync) {
        this.asyncAddToBuffer(node, frame, (resultVar, f) => {
          this.compiler.emit(`${resultVar} = `);
          emitLogic(f); // Pass the inner frame to the logic.
        }, node, handler, handler);
      } else {
        this.addToBuffer(node, frame, () => {
          emitLogic(frame); // Pass the current frame.
        }, node, handler);
      }
    };

    wrapper((f) => {
      this.compiler.emit(`{ handler: '${handler}', `);
      if (command) {
        this.compiler.emit(`command: '${command}', `);
      }
      if (subpath && subpath.length > 0) {
        this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }

      let argList = node.call.args;
      const asyncArgs = argList.isAsync;
      this.compiler.emit('arguments: ' + (asyncArgs ? 'await ' : ''));

      if (handler === 'data') {
        // For @data commands, we create a new "virtual" AST for the arguments.
        // where the first argument is a path like "user.posts[0].title" that
        // needs to be converted into a JavaScript array like ['user', 'posts', 0, 'title'].
        const originalArgs = node.call.args.children;
        if (originalArgs.length === 0) {
          this.compiler.fail(`@data command '${command}' requires at least a path argument.`, node.lineno, node.colno, node);
        }

        const pathArg = originalArgs[0];

        // Convert the path argument into a flat array of segments (Literal/Symbol)
        // expected by the runtime @data handlers.
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

      this.compiler.emit(`, pos: {lineno: ${node.lineno}, colno: ${node.colno}} }`);
    });
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, outputName = null) {
    if (this.compiler.asyncMode && outputName) {
      this.compiler.async.updateOutputUsage(frame, outputName);
    }
    if (this.compiler.asyncMode) {
      this.compiler.emit.line(`${this.currentBuffer}.add(`);
    } else {
      this.compiler.emit(`${this.currentBuffer} += `);
    }
    renderFunction.call(this.compiler, frame);
    if (this.compiler.asyncMode) {
      if (outputName) {
        this.compiler.emit(`, ${JSON.stringify(outputName)}`);
      }
      this.compiler.emit.line(');');
    } else {
      this.compiler.emit.line(';');
    }
  }

  /**
   * Add value to buffer (async mode with error handling)
   */
  asyncAddToBuffer(node, frame, renderFunction, positionNode = node, handlerName = null, outputName = null) {
    const returnId = this.compiler._tmpid();
    if (this.compiler.asyncMode && outputName) {
      this.compiler.async.updateOutputUsage(frame, outputName);
    }
    if (node.isAsync) {
      this.compiler.emit.asyncClosureDepth++;
      frame = frame.push(false, false);

      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);
      if (outputName) {
        this.compiler.emit.line(`let index = ${this.currentBuffer}.reserveSlot(${JSON.stringify(outputName)});`);
      } else {
        this.compiler.emit.line(`let index = ${this.currentBuffer}.reserveSlot();`);
      }

      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.compiler.emit.line(`try {`);
      }
      this.compiler.emit.line(`  let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(';');
      if (outputName) {
        this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(index, ${returnId}, ${JSON.stringify(outputName)});`);
      } else {
        this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(index, ${returnId});`);
      }

      if (handlerName) {
        // catch errors and poison the handler/buffer
        this.compiler.emit.line(`} catch(e) {`);
        // Convert ALL errors to error array
        this.compiler.emit.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
        // Add marker for handler-specific outputs
        this.compiler.emit.line(`  runtime.addPoisonMarkersToBuffer(${this.currentBuffer}, errors, [${JSON.stringify(handlerName)}], { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node, positionNode))}, path: context.path });`);
        this.compiler.emit.line(`}`);
      }

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
        if (outputName) {
          this.compiler.emit.line(`${this.currentBuffer}.add(${returnId}, ${JSON.stringify(outputName)});`);
        } else {
          this.compiler.emit.line(`${this.currentBuffer}.add(${returnId});`);
        }
      } else {
        this.compiler.emit.line(`${this.currentBuffer} += ${returnId};`);
      }
    }
  }

  /**
   * Begin async buffer addition (split pattern)
   */
  asyncAddToBufferBegin(node, frame, positionNode = node, handlerName = null, outputName = null) {
    if (this.compiler.asyncMode && outputName) {
      this.compiler.async.updateOutputUsage(frame, outputName);
    }
    if (node.isAsync) {
      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame) => {`);
      if (outputName) {
        this.compiler.emit.line(`let index = ${this.currentBuffer}.reserveSlot(${JSON.stringify(outputName)});`);
      } else {
        this.compiler.emit.line(`let index = ${this.currentBuffer}.reserveSlot();`);
      }
      const valueId = this.compiler._tmpid();
      this._bufferValueStack.push(valueId);
      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.compiler.emit.line(`try {`);
      }
      this.compiler.emit(`  let ${valueId} = `);
      this.compiler.emit.asyncClosureDepth++;
      // Store handlerName for End to use
      //this._pendingHandler = handlerName;
      return frame.push(false, false);
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
  asyncAddToBufferEnd(node, frame, positionNode = node, handlerName = null, outputName = null) {
    const valueId = this.compiler.asyncMode ? this._bufferValueStack.pop() : null;
    this.compiler.emit.line(';');
    if (node.isAsync) {
      //const handlerName = this._pendingHandler;
      //this._pendingHandler = null;

      if (outputName) {
        this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(index, ${valueId}, ${JSON.stringify(outputName)});`);
      } else {
        this.compiler.emit.line(`  ${this.currentBuffer}.fillSlot(index, ${valueId});`);
      }
      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.compiler.emit.line(`} catch(e) {`);
        this.compiler.emit.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
        // Handler-specific output - add poison marker to buffer
        this.compiler.emit.line(`  runtime.addPoisonMarkersToBuffer(${this.currentBuffer}, errors, [${JSON.stringify(handlerName)}], { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node, positionNode))}, path: context.path });`);
        this.compiler.emit.line(`}`);
      }

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs, outputArgs } = this.compiler.emit.getAsyncBlockArgs(frame, positionNode);
      this.compiler.emit.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${outputArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);
      return frame.pop();
    }
    if (this.compiler.asyncMode) {
      if (outputName) {
        this.compiler.emit.line(`${this.currentBuffer}.add(${valueId}, ${JSON.stringify(outputName)});`);
      } else {
        this.compiler.emit.line(`${this.currentBuffer}.add(${valueId});`);
      }
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
      const parentBuffer = this.currentBuffer;

      // Create a new buffer array for the nested block
      const newBuffer = this.compiler._tmpid();

      // Initialize the new buffer and its index inside the async closure
      this.compiler.emit.line(`let ${newBuffer} = new runtime.CommandBuffer(context);`);
      this.compiler.emit.initOutputHandlers(newBuffer);

      // Defer adding the buffer to the parent until we know which outputs were used.
      const addPos = this.compiler.codebuf.length;
      this.compiler.emit.line('');
      this._bufferAddStack.push({ pos: addPos, parentBuffer, newBuffer });

      // Update the buffer reference
      this.currentBuffer = newBuffer;
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
          this.compiler.emit.insertLine(addInfo.pos, `${addInfo.parentBuffer}.add(${addInfo.newBuffer}, ${JSON.stringify(outputName)});`);
        });
      }

      // End the async closure
      frame = this.compiler.emit.asyncBlockEnd(node, frame, createScope, sequential, positionNode);

      // Restore the previous buffer from the stack
      this.currentBuffer = this.bufferStack.pop();
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
