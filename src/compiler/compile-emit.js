const {
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance,
  ENABLE_READVARS_VALIDATION,
  ensureReadValidationState,
  validateReadVarsConsistency
} = require('./validation');

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
    this.compiler.buffer.currentBuffer = 'output';
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
    // this.Line(`let ${this.compiler.buffer.currentBuffer} = "";`);
    if (this.compiler.asyncMode) {
      this.emit(`let ${this.compiler.buffer.currentBuffer} = []; let ${this.compiler.buffer.currentBuffer}_index = 0;`);
    } else {
      this.emit(`let ${this.compiler.buffer.currentBuffer} = "";`);
    }
    this.line('try {');
  }

  funcEnd(node, noReturn) { // Added node parameter
    if (!noReturn) {
      if (this.compiler.asyncMode) {
        // In async mode, blocks return output directly (not via callback)
        // The callback is only used for error propagation
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
      const newFrame = frame.push(false, createScope);
      trackCompileTimeFrameDepth(newFrame, frame);
      if (ENABLE_READVARS_VALIDATION && node.isAsync) {
        ensureReadValidationState(newFrame);
      }
      return newFrame;
    }
    return frame;
  }

  asyncBlockEnd(node, frame, createScope, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      if (sequentialLoopBody) {
        // Wait for child async blocks spawned within this iteration
        // before proceeding to finally/catch.
        this.line('await astate.waitAllClosures(1);');
      }
      this.asyncClosureDepth--;
      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame, positionNode);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}", false, ${sequentialLoopBody})`);
      this.line(';');
    }
    if (createScope && !node.isAsync) {
      this.line('frame = frame.pop();');
    }

    // Validate frame balance before popping
    if (createScope || node.isAsync) {
      validateCompileTimeFrameBalance(frame, this.compiler, positionNode);
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
        this.line(`  let ${res}; try {`);
        this.line(`  ${res} = `);
      } else {
        this.line(`  try {`);
      }
      emitFunc.call(this.compiler, node, frame);
      this.line(';');
      //await ${res} to avoid unused vars throwing unhandled exceptions
      //and to make sure _leaveAsyncBlock is called after the promise resolves
      this.line(`return await ${res};`);
      this.line('} catch (e) {');//@todo - temp var
      this.line(`  const err = runtime.isPoisonError(e) ? e : new runtime.PoisonError(e, ${positionNode.lineno}, ${positionNode.colno}, "${this.compiler._generateErrorContext(node, positionNode)}", context.path);`);
      if (frame.writeCounts) {
        // If the block owns writes, we must clear them on error to prevent
        // "Async block finished with pending writes" fatal error.
        this.line(`  frame.poisonBranchWrites(err, ${JSON.stringify(frame.writeCounts)});`);
      }
      this.line('  throw err;');
      // this.line(`  return runtime.createPoison(err);`);
      this.line('}');

      this.line('}');
      const errorContext = this.compiler._generateErrorContext(node, positionNode);
      const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame, positionNode);
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}", true)`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(node, frame);
    }
  }

  asyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const id = this.compiler.buffer.push();
      innerBodyFunction.call(this.compiler, frame);
      this.compiler.buffer.pop();
      if (callbackName) {
        this.line(`${callbackName}(null, ${id});`);
      }
      this.line(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    this.line(`astate.asyncBlock(async (astate, frame) =>{`);

    const id = this.compiler.buffer.push();//@todo - better way to get the buffer, see compileCapture

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;


    innerBodyFunction.call(this.compiler, frame);

    this.asyncClosureDepth = originalAsyncClosureDepth;

    //this.Line(';');//this may be needed in some cases
    this.compiler.buffer.pop();

    this.line('await astate.waitAllClosures(1);');
    this.line(`${id} = runtime.flattenBuffer(${id});`);

    //return via callback or directly
    if (callbackName) {
      this.line(`  ${callbackName}(null, ${id});`);
    }
    this.line(`  return ${id};`);
    this.line('}');
    const errorContext = this.compiler._generateErrorContext(node, positionNode);
    const { readArgs, writeArgs } = this.getAsyncBlockArgs(frame, positionNode);
    if (callbackName) {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, ${callbackName}, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    } else {
      this.line(`, runtime, frame, ${readArgs}, ${writeArgs}, cb, ${positionNode.lineno}, ${positionNode.colno}, context, "${errorContext}")`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  // @todo - optimize this:
  // if a parent async block has the read and there are no writes
  // we can use the parent snapshot
  // similar for writes we can do some optimizations
  getAsyncBlockArgs(frame, positionNode = null) {
    if (ENABLE_READVARS_VALIDATION) {
      ensureReadValidationState(frame);
      validateReadVarsConsistency(frame, this.compiler, positionNode);
    }
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
