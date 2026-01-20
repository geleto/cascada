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

  funcBegin(node, name) {
    this.compiler.buffer = 'output';
    this.scopeClosers = '';
    if (this.compiler.asyncMode) {
      if (name === 'root') {
        this.line(`function ${name}(env, context, frame, runtime, astate, cb, compositionMode = false) {`);
      } else {
        this.line(`function ${name}(env, context, frame, runtime, astate, cb) {`);
      }
    } else {
      this.line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.line(`let lineno = ${node.lineno};`);
      this.line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer} = "";`);
    if (this.compiler.asyncMode) {
      this.emit(`let ${this.compiler.buffer} = []; let ${this.compiler.buffer}_index = 0;`);
    } else {
      this.emit(`let ${this.compiler.buffer} = "";`);
    }
    this.line('try {');
  }

  funcEnd(node, noReturn) { // Added node parameter
    if (!noReturn) {
      if (this.compiler.asyncMode) {
        // In async mode, blocks return output directly (not via callback)
        // The callback is only used for error propagation
        this.line('return ' + this.compiler.buffer + ';');
      } else {
        // Sync mode blocks use callback for both success and error
        this.line('cb(null, ' + this.compiler.buffer + ');');
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
    this.compiler.buffer = null;
  }

  //todo: use only simple async block if you know that:
  // - the block has no output
  // - this is the only async block child of the parent that has output
  // - there is only one active child (e.g. if/else) that has output
  //in all other cases, use AsyncBlockBufferNode
  //to make sure there are no race conditions for the buffer position
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
      return frame.push(false, createScope);
    }
    return frame;
  }

  asyncBlockEnd(node, frame, createScope, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      if (sequentialLoopBody) {
        // Wait for child async blocks spawned within this iteration
        // before proceeding to finally/catch.
        this.line('await astate.waitAllClosures(1);');
        this.line('if (frame.writeCounters && Object.values(frame.writeCounters).some(v => v > 0)) { throw new runtime.RuntimeFatalError("Sequential loop iteration finished with pending writes: " + JSON.stringify(frame.writeCounters), ' + positionNode.lineno + ', ' + positionNode.colno + ', "sequential loop check", context.path); }');
      }
      this.asyncClosureDepth--;
      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);
    }
    if (createScope && !node.isAsync) {
      this.line('frame = frame.pop();');
    }
    if (createScope || node.isAsync) {
      return frame.pop();
    }
    return frame;
  }

  asyncBlockValue(node, frame, emitFunc, res, positionNode = node) {
    if (node.isAsync) {

      this.line(`astate.asyncBlock(async (astate, frame) => {`);
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      if (res === undefined) {
        res = this.compiler._tmpid();
        this.line(`  let ${res} = `);
      }
      emitFunc.call(this.compiler, node, frame);
      this.line(';');
      //await ${res} to avoid unused vars throwing unhandled exceptions
      //and to make sure _leaveAsyncBlock is called after the promise resolves
      this.line(`return await ${res};`);

      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}", true)`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(node, frame);
    }
  }

  asyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const id = this.compiler._pushBuffer();
      innerBodyFunction.call(this.compiler, frame);
      this.compiler._popBuffer();
      if (callbackName) {
        this.line(`${callbackName}(null, ${id});`);
      }
      this.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    this.line(`astate.asyncBlock(async (astate, frame) =>{`);

    const id = this.compiler._pushBuffer();//@todo - better way to get the buffer, see compileCapture

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;


    innerBodyFunction.call(this.compiler, frame);

    this.asyncClosureDepth = originalAsyncClosureDepth;

    //this.Line(';');//this may be needed in some cases
    this.compiler._popBuffer();

    this.line('await astate.waitAllClosures(1);');
    this.line(`${id} = runtime.flattenBuffer(${id});`);

    //return via callback or directly
    if (callbackName) {
      this.line(`  ${callbackName}(null, ${id});`);
    }
    this.line(`  return ${id};`);
    this.line('}');
    const errorContext = this.compiler._generateErrorContext(node, positionNode);
    const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame);
    if (callbackName) {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${callbackName}, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    } else {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  addToBuffer(node, frame, renderFunction, positionNode = node) {
    if (this.compiler.asyncMode) {
      this.line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = `);
    } else {
      this.emit(`${this.compiler.buffer} += `);
    }
    renderFunction.call(this.compiler, frame);
    this.line(';');
  }

  //@todo - use the Begin/End
  asyncBlockAddToBuffer(node, frame, renderFunction, positionNode = node, handlerName = null) {
    const returnId = this.compiler._tmpid();
    if (node.isAsync) {
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      this.line(`astate.asyncBlock(async (astate, frame)=>{`);
      this.line(`let index = ${this.compiler.buffer}_index++;`);

      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.line(`try {`);
      }
      this.line(`  let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.line(';');
      this.line(`  ${this.compiler.buffer}[index] = ${returnId};`);

      if (handlerName) {
        // catch errors and poison the handler/buffer
        this.line(`} catch(e) {`);
        // Convert ALL errors to error array
        this.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
        // Add marker for handler-specific outputs
        this.line(`  runtime.addPoisonMarkersToBuffer(${this.compiler.buffer}, errors, [${JSON.stringify(handlerName)}], { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node, positionNode))}, path: context.path });`);
        this.line(`}`);
      }

      this.asyncClosureDepth--;
      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);

      frame = frame.pop();

    } else {
      this.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      if (this.compiler.asyncMode) {
        this.line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = ${returnId};`);
      } else {
        this.line(`${this.compiler.buffer} += ${returnId};`);
      }
    }
  }

  asyncBlockAddToBufferBegin(node, frame, positionNode = node, handlerName = null) {
    if (node.isAsync) {
      this.line(`astate.asyncBlock(async (astate, frame) => {`);
      this.line(`let index = ${this.compiler.buffer}_index++;`);
      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.line(`try {`);
      }
      this.emit(`  ${this.compiler.buffer}[index] = `);
      this.asyncClosureDepth++;
      // Store handlerName for End to use
      //this._pendingHandler = handlerName;
      return frame.push(false, false);
    }
    if (this.compiler.asyncMode) {
      this.line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = `);
    } else {
      this.emit(`${this.compiler.buffer} += `);
    }
    return frame;
  }

  asyncBlockAddToBufferEnd(node, frame, positionNode = node, handlerName = null) {
    this.line(';');
    if (node.isAsync) {
      //const handlerName = this._pendingHandler;
      //this._pendingHandler = null;

      if (handlerName) {
        // if there is a handler, we need to catch errors and poison the handler/buffer
        this.line(`} catch(e) {`);
        this.line(`  const errors = runtime.isPoisonError(e) ? e.errors : [e];`);
        // Handler-specific output - add poison marker to buffer
        this.line(`  runtime.addPoisonMarkersToBuffer(${this.compiler.buffer}, errors, [${JSON.stringify(handlerName)}], { lineno: ${positionNode.lineno}, colno: ${positionNode.colno}, errorContextString: ${JSON.stringify(this.compiler._generateErrorContext(node, positionNode))}, path: context.path });`);
        this.line(`}`);
      }

      this.asyncClosureDepth--;
      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}");`);
      return frame.pop();
    }
    return frame;
  }

  asyncBlockBufferNodeBegin(node, frame, createScope = false, positionNode = node) {
    if (node.isAsync) {
      // Start the async closure
      frame = this.asyncBlockBegin(node, frame, createScope, positionNode);

      // Push the current buffer onto the stack
      this.compiler.bufferStack.push(this.compiler.buffer);

      // Create a new buffer array for the nested block
      const newBuffer = this.compiler._tmpid();

      // Initialize the new buffer and its index inside the async closure
      this.line(`let ${newBuffer} = [];`);
      this.line(`let ${newBuffer}_index = 0;`);

      // Append the new buffer to the parent buffer
      this.line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = ${newBuffer};`);

      // Update the buffer reference
      this.compiler.buffer = newBuffer;
      // No need to update bufferIndex, we'll use `${this.compiler.buffer}_index` when needed
      return frame;
    } else if (createScope) {
      frame = frame.push();
      this.line('frame = frame.push();');
      return frame;
    }
    return frame;
  }

  asyncBlockBufferNodeEnd(node, frame, createScope = false, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      // End the async closure
      frame = this.asyncBlockEnd(node, frame, createScope, sequentialLoopBody, positionNode);

      // Restore the previous buffer from the stack
      this.compiler.buffer = this.compiler.bufferStack.pop();
      return frame;
    } else if (createScope) {
      frame = frame.pop();
      this.line('frame = frame.pop();');
      return frame;
    }
    return frame;
  }
  // @todo - optimize this:
  // if a parent async block has the read and there are no writes
  // we can use the parent snapshot
  // similar for writes we can do some optimizations
  getAsyncBlockArgs(frame) {
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
    return { readArgs, writeArgs };
  }
};
