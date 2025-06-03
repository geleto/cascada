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

  Line(code) {
    this.emit(code + '\n');
  }

  Lines(...lines) {
    lines.forEach((line) => this.Line(line));
  }

  Insert(pos, code) {
    this.compiler.codebuf[pos] += code;
  }

  InsertLine(pos, code) {
    this.Insert(pos, code + '\n');
  }

  _addScopeLevel() {
    this.scopeClosers += '})';
  }

  _closeScopeLevels() {
    this.Line(this.scopeClosers + ';');
    this.scopeClosers = '';
  }

  _withScopedSyntax(func) {
    const _scopeClosers = this.scopeClosers;
    this.scopeClosers = '';

    func.call(this.compiler);

    this._closeScopeLevels();
    this.scopeClosers = _scopeClosers;
  }

  FuncBegin(node, name) {
    this.compiler.buffer = 'output';
    this.scopeClosers = '';
    if (this.compiler.asyncMode) {
      this.Line(`function ${name}(env, context, frame, runtime, astate, cb) {`);
    } else {
      this.Line(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this.Line(`let lineno = ${node.lineno};`);
      this.Line(`let colno = ${node.colno};`);
    }
    // this.Line(`let ${this.compiler.buffer} = "";`);
    if (this.compiler.asyncMode) {
      this.emit(`let ${this.compiler.buffer} = []; let ${this.compiler.buffer}_index = 0;`);
    } else {
      this.emit(`let ${this.compiler.buffer} = "";`);
    }
    this.Line('try {');
  }

  FuncEnd(node, noReturn) { // Added node parameter
    if (!noReturn) {
      this.Line('cb(null, ' + this.compiler.buffer + ');');
    }

    this._closeScopeLevels();
    this.Line('} catch (e) {');
    if (this.compiler.asyncMode) {
      // In async mode, use the static position from the node and handlePromise for internal errors
      // The top-level catch uses the function's start position as a fallback.
      this.Line(`  cb(runtime.handleError(e, ${node.lineno}, ${node.colno}${node ? `, "${this.compiler._generateErrorContext(node)}"` : ''}));`);
    } else {
      this.Line(`  cb(runtime.handleError(e, lineno, colno${node ? `, "${this.compiler._generateErrorContext(node)}"` : ''}));`);
    }
    //this.Line('  throw e;');//the returned promise should not resolve
    this.Line('}');
    this.Line('}');
    this.compiler.buffer = null;
  }

  //todo: use only simple async block if you know that:
  // - the block has no output
  // - this is the only async block child of the parent that has output
  // - there is only one active child (e.g. if/else) that has output
  //in all other cases, use AsyncBlockBufferNode
  //to make sure there are no race conditions for the buffer position
  AsyncBlock(node, frame, createScope, emitFunc, positionNode = node) {
    const aframe = this.AsyncBlockBegin(node, frame, createScope, positionNode);
    emitFunc(aframe);
    this.AsyncBlockEnd(node, aframe, createScope, false, positionNode); // Pass sequentialLoopBody=false by default
  }

  AsyncBlockBegin(node, frame, createScope, positionNode = node) {
    if (node.isAsync) {
      this.Line(`runtime.handlePromise((async (astate, frame) => {`);
      this.Line('try {');
      this.asyncClosureDepth++;
    }
    if (createScope && !node.isAsync) {
      this.Line('frame = frame.push();');
    }
    if (createScope || node.isAsync) {
      //unscoped frames are only used in async blocks
      return frame.push(false, createScope);
    }
    return frame;
  }

  AsyncBlockEnd(node, frame, createScope, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      if (sequentialLoopBody) {
        // Wait for child async blocks spawned within this iteration
        // before proceeding to finally/catch.
        this.Line('await astate.waitAllClosures(1);');
      }
      this.asyncClosureDepth--;
      this.Line('} finally {');
      this.Line('  astate.leaveAsyncBlock();');
      this.Line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);
    }
    if (createScope && !node.isAsync) {
      this.Line('frame = frame.pop();');
    }
    if (createScope || node.isAsync) {
      return frame.pop();
    }
    return frame;
  }

  AsyncBlockValue(node, frame, emitFunc, res, positionNode = node) {
    if (node.isAsync) {

      this.Line(`runtime.handlePromise((async (astate, frame) => {`);
      this.Line('try {');
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      if (res === undefined) {
        res = this.compiler._tmpid();
        this.Line(`  let ${res} = `);
      }
      emitFunc.call(this.compiler, node, frame);
      this.Line(';');
      //await ${res} to avoid unused vars throwing unhandled exceptions
      //and to make sure leaveAsyncBlock is called after the promise resolves
      this.Line(`return await ${res};`);

      this.Line('} finally {');
      this.Line('  astate.leaveAsyncBlock();');
      this.Line('}'); // Close inner finally
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(node, frame);
    }
  }

  AsyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const id = this.compiler._pushBuffer();
      innerBodyFunction.call(this.compiler, frame);
      this.compiler._popBuffer();
      if (callbackName) {
        this.Line(`${callbackName}(null, ${id});`);
      }
      this.Line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    this.Line(`runtime.handlePromise((async (astate, frame) =>{`);
    this.Line('try {');

    const id = this.compiler._pushBuffer();//@todo - better way to get the buffer, see compileCapture

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;


    innerBodyFunction.call(this.compiler, frame);

    this.asyncClosureDepth = originalAsyncClosureDepth;

    //this.Line(';');//this may be needed in some cases
    this.compiler._popBuffer();

    this.Line('await astate.waitAllClosures(1);');
    this.Line(`${id} = runtime.flattentBuffer(${id});`);

    //return via callback or directly
    if (callbackName) {
      this.Line(`  ${callbackName}(null, ${id});`);
    }
    this.Line(`  return ${id};`);
    this.Line('} finally {');
    this.Line('  astate.leaveAsyncBlock();');
    this.Line('}');
    const errorContext = this.compiler._generateErrorContext(node, positionNode);
    if (callbackName) {
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), ${callbackName}, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);
    } else {
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  AddToBuffer(node, frame, renderFunction, positionNode = node) {
    if (this.compiler.asyncMode) {
      this.Line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = `);
    } else {
      this.emit(`${this.compiler.buffer} += `);
    }
    renderFunction.call(this.compiler, frame);
    this.Line(';');
  }

  //@todo - use the Begin/End
  AsyncBlockAddToBuffer(node, frame, renderFunction, positionNode = node) {
    const returnId = this.compiler._tmpid();
    if (node.isAsync) {
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      this.Line(`runtime.handlePromise((async (astate, frame)=>{`);
      this.Line('try {');
      this.Line(`let index = ${this.compiler.buffer}_index++;`);

      this.Line(`let ${returnId};`);

      renderFunction.call(this.compiler, returnId, frame);
      this.Line(';');
      this.emit(`${this.compiler.buffer}[index] = ${returnId};`);

      this.asyncClosureDepth--;
      this.Line('} finally {');
      this.Line('  astate.leaveAsyncBlock();');
      this.Line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);

      frame = frame.pop();

    } else {
      this.Line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId);
      if (this.compiler.asyncMode) {
        this.emit(`${this.compiler.buffer}[index] = ${returnId};`);
      } else {
        this.emit(`${this.compiler.buffer} += ${returnId};`);
      }
    }
  }

  AsyncBlockAddToBufferBegin(node, frame, positionNode = node) {
    if (node.isAsync) {
      this.Line(`runtime.handlePromise((async (astate, frame) => {`);
      this.Line('try {');
      this.Line(`let index = ${this.compiler.buffer}_index++;`);
      this.emit(`${this.compiler.buffer}[index] = `);
      this.asyncClosureDepth++;
      return frame.push(false, false);
    }
    if (this.compiler.asyncMode) {
      this.Line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = `);
    } else {
      this.emit(`${this.compiler.buffer} += `);
    }
    return frame;
  }

  AsyncBlockAddToBufferEnd(node, frame, positionNode = node) {
    this.Line(';');
    if (node.isAsync) {
      this.asyncClosureDepth--;
      this.Line('} finally {');
      this.Line('  astate.leaveAsyncBlock();');
      this.Line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      this.Line(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);
      return frame.pop();
    }
    return frame;
  }

  AsyncBlockBufferNodeBegin(node, frame, createScope = false, positionNode = node) {
    if (node.isAsync) {
      // Start the async closure
      frame = this.AsyncBlockBegin(node, frame, createScope, positionNode);

      // Push the current buffer onto the stack
      this.compiler.bufferStack.push(this.compiler.buffer);

      // Create a new buffer array for the nested block
      const newBuffer = this.compiler._tmpid();

      // Initialize the new buffer and its index inside the async closure
      this.Line(`let ${newBuffer} = [];`);
      this.Line(`let ${newBuffer}_index = 0;`);

      // Append the new buffer to the parent buffer
      this.Line(`${this.compiler.buffer}[${this.compiler.buffer}_index++] = ${newBuffer};`);

      // Update the buffer reference
      this.compiler.buffer = newBuffer;
      // No need to update bufferIndex, we'll use `${this.compiler.buffer}_index` when needed
      return frame;
    } else if (createScope) {
      frame = frame.push();
      this.Line('frame = frame.push();');
      return frame;
    }
    return frame;
  }

  AsyncBlockBufferNodeEnd(node, frame, createScope = false, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      // End the async closure
      frame = this.AsyncBlockEnd(node, frame, createScope, sequentialLoopBody, positionNode);

      // Restore the previous buffer from the stack
      this.compiler.buffer = this.compiler.bufferStack.pop();
      return frame;
    } else if (createScope) {
      frame = frame.pop();
      this.Line('frame = frame.pop();');
      return frame;
    }
    return frame;
  }
  _getPushAsyncBlockCode(frame) {
    let reads = [];
    if (frame.readVars) {
      //add each read var to a list of vars to be snapshotted, with a few exceptions
      frame.readVars.forEach((name) => {
        //skip variables that are written to, they will be snapshotted anyway
        if (frame.writeCounts && frame.writeCounts[name]) {
          return;
        }
        //see if it's read by a parent and not written to there, then the parent snapshot is enough
        if (frame.parent.readVars && frame.parent.readVars.has(name) && !(frame.parent.writeCounts && !frame.parent.writeCounts[name])) {
          return;
        }
        if (frame.declaredVars && frame.declaredVars.has(name)) {
          // If the variable 'name' is declared in the *current* 'frame'
          throw new Error(`ReadVar ${name} in declaration scope, this indicates mismatch between compiler and runtime frame`);
        }
        reads.push(name);
      });
    }
    const readArgs = reads.length ? JSON.stringify(reads) : 'null';
    const writeArgs = frame.writeCounts ? ', ' + JSON.stringify(frame.writeCounts) : '';
    return `frame.pushAsyncBlock(${readArgs}${writeArgs})`;
  }
};
