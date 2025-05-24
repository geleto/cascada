'use strict';

const parser = require('./parser');
const transformer = require('./transformer');
const nodes = require('./nodes');
const { TemplateError } = require('./lib');
const { Frame, AsyncFrame } = require('./runtime');
const { Obj } = require('./object');

const OPTIMIZE_ASYNC = true;//optimize async operations

// PathFlags for path propagation
const PathFlags = {
  NONE: 0,
  CALL: 1 << 0,
  CREATES_SEQUENCE_LOCK: 1 << 1,
  WAITS_FOR_SEQUENCE_LOCK: 1 << 2,
};

const SequenceOperationType = {
  PATH: 1,
  LOCK: 2,
  CONTENDED: 3//PATH + LOCK or LOCK + LOCK
};

// these are nodes that may perform async operations even if their children do not
const asyncOperationNodes = new Set([
  //expression nodes
  'LookupVal', 'Symbol', 'FunCall', 'Filter', 'Caller', 'CallExtension', 'CallExtensionAsync', 'Is',
  //control nodes
  'Extends', 'Include', 'Import', 'FromImport', 'Super'
]);

// These are all the same for now, but shouldn't be passed straight
// through
const compareOps = {
  '==': '==',
  '===': '===',
  '!=': '!=',
  '!==': '!==',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>='
};

class Compiler extends Obj {
  init(templateName, throwOnUndefined, asyncMode) {
    this.templateName = templateName;
    this.codebuf = [];
    this.lastId = 0;
    this.buffer = null;
    this.bufferStack = [];
    this._scopeClosers = '';
    this.inBlock = false;
    this.throwOnUndefined = throwOnUndefined;
    this.asyncMode = asyncMode;
    this.asyncClosureDepth = 0;
  }

  _generateErrorContext(node, positionNode) {
    if (!node || !positionNode) return 'UnknownContext'; // Basic fallback
    const nodeType = node.typename || 'Node';
    const posType = positionNode.typename || 'PosNode';
    if (node === positionNode || nodeType === posType) {
      return nodeType;
    }
    return `${nodeType}(${posType})`;
  }

  fail(msg, lineno, colno, node, positionNode) { // Added node and positionNode
    if (lineno !== undefined) {
      lineno += 1;
    }
    if (colno !== undefined) {
      colno += 1;
    }

    const errorContext = node ? this._generateErrorContext(node, positionNode || node) : undefined;

    // Pass context to TemplateError constructor
    throw new TemplateError(msg, lineno, colno, errorContext);
  }

  _pushBuffer() {
    const id = this._tmpid();
    this.bufferStack.push(this.buffer);
    this.buffer = id;
    if (this.asyncMode) {
      this._emitLine(`let ${this.buffer} = []; let ${this.buffer}_index = 0;`);
    } else {
      this._emitLine(`let ${this.buffer} = "";`);
    }
    return id;
  }

  _popBuffer() {
    this.buffer = this.bufferStack.pop();
  }

  _emit(code) {
    this.codebuf.push(code);
  }

  _emitLine(code) {
    this._emit(code + '\n');
  }

  _emitLines(...lines) {
    lines.forEach((line) => this._emitLine(line));
  }

  _emitInsert(pos, code) {
    this.codebuf[pos] += code;
  }

  _emitInsertLine(pos, code) {
    this._emitInsert(pos, code + '\n');
  }

  _emitFuncBegin(node, name) {
    this.buffer = 'output';
    this._scopeClosers = '';
    if (this.asyncMode) {
      this._emitLine(`function ${name}(env, context, frame, runtime, astate, cb) {`);
    } else {
      this._emitLine(`function ${name}(env, context, frame, runtime, cb) {`);
      // Declare lineno/colno vars only in sync mode
      this._emitLine(`let lineno = ${node.lineno};`);
      this._emitLine(`let colno = ${node.colno};`);
    }
    // this._emitLine(`let ${this.buffer} = "";`);
    if (this.asyncMode) {
      this._emit(`let ${this.buffer} = []; let ${this.buffer}_index = 0;`);
    } else {
      this._emit(`let ${this.buffer} = "";`);
    }
    this._emitLine('try {');
  }

  _emitFuncEnd(node, noReturn) { // Added node parameter
    if (!noReturn) {
      this._emitLine('cb(null, ' + this.buffer + ');');
    }

    this._closeScopeLevels();
    this._emitLine('} catch (e) {');
    if (this.asyncMode) {
      // In async mode, use the static position from the node and handlePromise for internal errors
      // The top-level catch uses the function's start position as a fallback.
      this._emitLine(`  cb(runtime.handleError(e, ${node.lineno}, ${node.colno}${node ? `, "${this._generateErrorContext(node)}"` : ''}));`);
    } else {
      this._emitLine(`  cb(runtime.handleError(e, lineno, colno${node ? `, "${this._generateErrorContext(node)}"` : ''}));`);
    }
    //this._emitLine('  throw e;');//the returned promise should not resolve
    this._emitLine('}');
    this._emitLine('}');
    this.buffer = null;
  }

  //todo: use only simple async block if you know that:
  // - the block has no output
  // - this is the only async block child of the parent that has output
  // - there is only one active child (e.g. if/else) that has output
  //in all other cases, use _emitAsyncBlockBufferNode
  //to make sure there are no race conditions for the buffer position
  _emitAsyncBlock(node, frame, createScope, emitFunc, positionNode = node) {
    const aframe = this._emitAsyncBlockBegin(node, frame, createScope, positionNode);
    emitFunc(aframe);
    this._emitAsyncBlockEnd(node, aframe, createScope, false, positionNode); // Pass sequentialLoopBody=false by default
  }

  _emitAsyncBlockBegin(node, frame, createScope, positionNode = node) {
    if (node.isAsync) {
      this._emitLine(`runtime.handlePromise((async (astate, frame) => {`);
      this._emitLine('try {');
      this.asyncClosureDepth++;
    }
    if (createScope && !node.isAsync) {
      this._emitLine('frame = frame.push();');
    }
    if (createScope || node.isAsync) {
      //unscoped frames are only used in async blocks
      return frame.push(false, createScope);
    }
    return frame;
  }

  _emitAsyncBlockEnd(node, frame, createScope, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      if (sequentialLoopBody) {
        // Wait for child async blocks spawned within this iteration
        // before proceeding to finally/catch.
        this._emitLine('await astate.waitAllClosures(1);');
      }
      this.asyncClosureDepth--;
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      const errorContext = this._generateErrorContext(node, positionNode);
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);
    }
    if (createScope && !node.isAsync) {
      this._emitLine('frame = frame.pop();');
    }
    if (createScope || node.isAsync) {
      return frame.pop();
    }
    return frame;
  }

  _emitAsyncBlockValue(node, frame, emitFunc, res, positionNode = node) {
    if (node.isAsync) {

      this._emitLine(`runtime.handlePromise((async (astate, frame) => {`);
      this._emitLine('try {');
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      if (res === undefined) {
        res = this._tmpid();
        this._emitLine(`  let ${res} = `);
      }
      emitFunc.call(this, frame);
      this._emitLine(';');
      //await ${res} to avoid unused vars throwing unhandled exceptions
      //and to make sure leaveAsyncBlock is called after the promise resolves
      this._emitLine(`return await ${res};`);

      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}'); // Close inner finally
      const errorContext = this._generateErrorContext(node, positionNode);
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);

      this.asyncClosureDepth--;
      frame = frame.pop();

    } else {
      emitFunc(frame);
    }
  }

  _emitAsyncBlockRender(node, frame, innerBodyFunction, callbackName = null, positionNode = node) {
    if (!node.isAsync) {
      const id = this._pushBuffer();
      innerBodyFunction.call(this, frame);
      this._popBuffer();
      if (callbackName) {
        this._emitLine(`${callbackName}(null, ${id});`);
      }
      this._emitLine(`return ${id};`);
      return;
    }

    frame = frame.push(false, false);//unscoped frame for the async block
    this._emitLine(`runtime.handlePromise((async (astate, frame) =>{`);
    this._emitLine('try {');

    const id = this._pushBuffer();//@todo - better way to get the buffer, see compileCapture

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;


    innerBodyFunction.call(this, frame);

    this.asyncClosureDepth = originalAsyncClosureDepth;

    //this._emitLine(';');//this may be needed in some cases
    this._popBuffer();

    this._emitLine('await astate.waitAllClosures(1);');
    this._emitLine(`${id} = runtime.flattentBuffer(${id});`);

    //return via callback or directly
    if (callbackName) {
      this._emitLine(`  ${callbackName}(null, ${id});`);
    }
    this._emitLine(`  return ${id};`);
    this._emitLine('} finally {');
    this._emitLine('  astate.leaveAsyncBlock();');
    this._emitLine('}');
    const errorContext = this._generateErrorContext(node, positionNode);
    if (callbackName) {
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), ${callbackName}, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);
    } else {
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}")`);
    }

    frame = frame.pop();
    //in the non-callback case, using the rendered buffer will throw the error
  }

  _emitAddToBuffer(node, frame, renderFunction, positionNode = node) {
    if (this.asyncMode) {
      this._emitLine(`${this.buffer}[${this.buffer}_index++] = `);
    } else {
      this._emit(`${this.buffer} += `);
    }
    renderFunction.call(this, frame);
    this._emitLine(';');
  }

  //@todo - use the Begin/End
  _emitAsyncBlockAddToBuffer(node, frame, renderFunction, positionNode = node) {
    const returnId = this._tmpid();
    if (node.isAsync) {
      this.asyncClosureDepth++;
      frame = frame.push(false, false);

      this._emitLine(`runtime.handlePromise((async (astate, frame)=>{`);
      this._emitLine('try {');
      this._emitLine(`let index = ${this.buffer}_index++;`);

      this._emitLine(`let ${returnId};`);

      renderFunction.call(this, returnId, frame);
      this._emitLine(';');
      this._emit(`${this.buffer}[index] = ${returnId};`);

      this.asyncClosureDepth--;
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      const errorContext = this._generateErrorContext(node, positionNode);
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);

      frame = frame.pop();

    } else {
      this._emitLine(`let ${returnId};`);
      renderFunction.call(this, returnId);
      if (this.asyncMode) {
        this._emit(`${this.buffer}[index] = ${returnId};`);
      } else {
        this._emit(`${this.buffer} += ${returnId};`);
      }
    }
  }

  _emitAsyncBlockAddToBufferBegin(node, frame, positionNode = node) {
    if (node.isAsync) {
      this._emitLine(`runtime.handlePromise((async (astate, frame) => {`);
      this._emitLine('try {');
      this._emitLine(`let index = ${this.buffer}_index++;`);
      this._emit(`${this.buffer}[index] = `);
      this.asyncClosureDepth++;
      return frame.push(false, false);
    }
    if (this.asyncMode) {
      this._emitLine(`${this.buffer}[${this.buffer}_index++] = `);
    } else {
      this._emit(`${this.buffer} += `);
    }
    return frame;
  }

  _emitAsyncBlockAddToBufferEnd(node, frame, positionNode = node) {
    this._emitLine(';');
    if (node.isAsync) {
      this.asyncClosureDepth--;
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      const errorContext = this._generateErrorContext(node, positionNode);
      this._emitLine(`})(astate.enterAsyncBlock(), ${this._getPushAsyncBlockCode(frame)}), cb, ${positionNode.lineno}, ${positionNode.colno}, "${errorContext}");`);
      return frame.pop();
    }
    return frame;
  }

  _emitAsyncBlockBufferNodeBegin(node, frame, createScope = false, positionNode = node) {
    if (node.isAsync) {
      // Start the async closure
      frame = this._emitAsyncBlockBegin(node, frame, createScope, positionNode);

      // Push the current buffer onto the stack
      this.bufferStack.push(this.buffer);

      // Create a new buffer array for the nested block
      const newBuffer = this._tmpid();

      // Initialize the new buffer and its index inside the async closure
      this._emitLine(`let ${newBuffer} = [];`);
      this._emitLine(`let ${newBuffer}_index = 0;`);

      // Append the new buffer to the parent buffer
      this._emitLine(`${this.buffer}[${this.buffer}_index++] = ${newBuffer};`);

      // Update the buffer reference
      this.buffer = newBuffer;
      // No need to update bufferIndex, we'll use `${this.buffer}_index` when needed
      return frame;
    } else if (createScope) {
      frame = frame.push();
      this._emitLine('frame = frame.push();');
      return frame;
    }
    return frame;
  }

  _emitAsyncBlockBufferNodeEnd(node, frame, createScope = false, sequentialLoopBody = false, positionNode = node) {
    if (node.isAsync) {
      // End the async closure
      frame = this._emitAsyncBlockEnd(node, frame, createScope, sequentialLoopBody, positionNode);

      // Restore the previous buffer from the stack
      this.buffer = this.bufferStack.pop();
      return frame;
    } else if (createScope) {
      frame = frame.pop();
      this._emitLine('frame = frame.pop();');
      return frame;
    }
    return frame;
  }

  _addScopeLevel() {
    this._scopeClosers += '})';
  }

  _closeScopeLevels() {
    this._emitLine(this._scopeClosers + ';');
    this._scopeClosers = '';
  }

  _withScopedSyntax(func) {
    const _scopeClosers = this._scopeClosers;
    this._scopeClosers = '';

    func.call(this);

    this._closeScopeLevels();
    this._scopeClosers = _scopeClosers;
  }

  _makeCallback(res) {
    const err = this._tmpid();

    return 'function(' + err + (res ? ',' + res : '') + ') {\n' +
      'if(' + err + ') { cb(' + err + '); return; }';
  }

  _tmpid() {
    this.lastId++;
    return 't_' + this.lastId;
  }

  _templateName() {
    return this.templateName === null ? 'undefined' : JSON.stringify(this.templateName);
  }

  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  //todo
  _compileFunctionAggregate(node, frame, funcName) {
    this._compileAggregate(node, frame, '[', ']', true, true, function (result) {
      this._emit(`return ${funcName}(...${result})`);
    });
  }

  _compileAggregate(node, frame, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    let doResolve = resolveItems && this.asyncMode && node.isAsync && node.children.some(child => child.isAsync);
    if (doResolve) {
      switch (startChar) {
        case '[':
          if (node.children.length === 1) {
            //@todo - if compileThen resolveSingle and pass the value directly, similar with []
            this._emit('runtime.resolveSingleArr(');
            this._emitArguments(node, frame, expressionRoot, startChar);
            this._emit(')');
          } else if (node.children.length === 2) {
            this._emit('runtime.resolveDuo(');
            this._emitArguments(node, frame, expressionRoot, startChar);
            this._emit(')');
          } else {
            this._emit('runtime.resolveAll([');
            this._emitArguments(node, frame, expressionRoot, startChar);
            this._emit('])');
          }
          break;
        case '{':
          this._emit('runtime.resolveObjectProperties({');
          this._emitArguments(node, frame, expressionRoot, startChar);
          this._emit('})');
          break;
        case '(': {
          this._emit('runtime.resolveAll([');
          this._emitArguments(node, frame, expressionRoot, '[');
          this._emit(']).then(function(');
          const result = this._tmpid();
          this._emit(`${result}){ return (`);
          for (let i = 0; i < node.children.length; i++) {
            if (i > 0) {
              this._emit(',');
            }
            this._emit(`${result}[${i}]`);
          }
          this._emit('); })');
        }
          break;
      }

      if (compileThen) {
        const result = this._tmpid();
        this._emit(`.then(${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this._emit(' })');
      }
    } else {
      if (compileThen) {
        const result = this._tmpid();
        this._emitLine(`(${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this._emit('})(');
        this._emit(startChar);
        this._emitArguments(node, frame, expressionRoot, startChar);
        this._emit(endChar + ')');
      } else {
        this._emit(startChar);
        this._emitArguments(node, frame, expressionRoot, startChar);
        this._emit(endChar);
      }
    }
  }

  _emitArguments(node, frame, expressionRoot, startChar) {
    node.children.forEach((child, i) => {
      if (i > 0) {
        this._emit(',');
      }
      if (expressionRoot && startChar !== '{') {
        this._compileExpression(child, frame);
      } else {
        this.compile(child, frame);
      }
    });
  }

  assertType(node, ...types) {
    if (!types.some(t => node instanceof t)) {
      this.fail(`assertType: invalid type: ${node.typename}`, node.lineno, node.colno, node);
    }
  }

  compileCallExtension(node, frame) {
    this._compileCallExtension(node, frame, false);
  }

  /**
   * CallExtension - no callback, can return either value or promise
   * CallExtensionAsync - uses callback, async = true. This was the way to handle the old nunjucks async
   * @todo - rewrite with _emitAggregate
   */
  _compileCallExtension(node, frame, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async;//assign the return value directly, no callback
    var resolveArgs = node.resolveArgs && node.isAsync;
    const positionNode = args || node; // Prefer args position if available

    if (noExtensionCallback || node.isAsync) {
      const ext = this._tmpid();
      this._emitLine(`let ${ext} = env.getExtension("${node.extName}");`);

      frame = this._emitAsyncBlockAddToBufferBegin(node, frame, positionNode);
      this._emit(node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
      if (noExtensionCallback) {
        //the extension returns a value directly
        if (!resolveArgs) {
          //send the arguments as they are - promises or values
          this._emit(`${ext}["${node.prop}"](context`);
        }
        else {
          //resolve the arguments before calling the function
          this._emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
        }
      } else {
        //isAsync, the callback should be promisified
        if (!resolveArgs) {
          this._emit(`runtime.promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
        }
        else {
          this._emit(`runtime.resolveArguments(runtime.promisify(${ext}["${node.prop}"].bind(${ext})), 1)(context`);
        }
      }
    } else {
      //use the original nunjucks callback mechanism
      this._emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
    }

    if ((args && args.children.length) || contentArgs.length) {
      this._emit(',');
    }

    if (args) {
      if (!(args instanceof nodes.NodeList)) {
        this.fail('compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`', node.lineno, node.colno, node);
      }

      args.children.forEach((arg, i) => {
        // Tag arguments are passed normally to the call. Note
        // that keyword arguments are turned into a single js
        // object as the last argument, if they exist.
        this.compile(arg, frame);

        if (i !== args.children.length - 1 || contentArgs.length) {
          this._emit(',');
        }
      });
    }

    if (contentArgs.length) {
      contentArgs.forEach((arg, i) => {
        if (i > 0) {
          this._emit(',');
        }

        if (arg) {
          if (node.isAsync && !resolveArgs) {
            //when args are not resolved, the contentArgs are promises
            this._emitAsyncBlockRender(node, frame, function (f) {
              this.compile(arg, f);
            }, null, arg); // Use content arg node for position
          }
          else {
            //when not resolve args, the contentArgs are callback functions
            this._emitLine('function(cb) {');
            this._emitLine('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this._withScopedSyntax(() => {
              this._emitAsyncBlockRender(node, frame, function (f) {
                this.compile(arg, f);
              }, 'cb', arg); // Use content arg node for position
              this._emitLine(';');
            });

            this._emitLine('}');//end callback
          }
        } else {
          this._emit('null');
        }
      });
    }

    if (noExtensionCallback || node.isAsync) {
      this._emit(`)`);//close the extension call
      this._emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
      frame = this._emitAsyncBlockAddToBufferEnd(node, frame, positionNode);
    } else {
      const res = this._tmpid();
      this._emitLine(', ' + this._makeCallback(res));
      frame = this._emitAsyncBlockAddToBufferBegin(node, frame, positionNode);
      this._emit(`${node.isAsync ? 'await runtime.suppressValueAsync' : 'runtime.suppressValue'}(${res}, ${autoescape} && env.opts.autoescape);`);
      frame = this._emitAsyncBlockAddToBufferEnd(node, frame, positionNode);

      this._addScopeLevel();
    }
  }

  compileCallExtensionAsync(node, frame) {
    this._compileCallExtension(node, frame, true);
  }

  compileNodeList(node, frame) {
    this._compileChildren(node, frame);
  }

  compileLiteral(node) {
    if (typeof node.value === 'string') {
      let val = node.value.replace(/\\/g, '\\\\');
      val = val.replace(/"/g, '\\"');
      val = val.replace(/\n/g, '\\n');
      val = val.replace(/\r/g, '\\r');
      val = val.replace(/\t/g, '\\t');
      val = val.replace(/\u2028/g, '\\u2028');
      this._emit(`"${val}"`);
    } else if (node.value === null) {
      this._emit('null');
    } else {
      this._emit(node.value.toString());
    }
  }

  compileSymbol(node, frame, pathFlags = PathFlags.NONE) {

    let name = node.value;
    let v = frame.lookup(name);
    // @todo - omit this for function calls?
    // (parent instanceof nodes.FunCall && parent.name === node)

    /*if (v) {
      //we are using a local variable, this is currently used only for:
      //the async filter, super(), set var
      this._emit(v);
      return;
    }*/

    // Not in template scope, check context/frame with potential sequence lock
    if (this.asyncMode) {
      if (node.isCompilerInternal) {
        // This is a compiler-generated internal symbol (e.g., "hole_0").
        // Its `name` is the actual JavaScript variable name.
        // This variable might hold a Promise, which consuming code (like Output) will handle.
        this._emit(name);
        return;
      }

      if (node.sequenced) {
        if (!(pathFlags & PathFlags.CALL)) {
          this.fail('Sequence marker (!) is not allowed in non-call paths', node.lineno, node.colno, node);
        }
        if (pathFlags & PathFlags.CREATES_SEQUENCE_LOCK) {
          this.fail('Can not use more than one sequence marker (!) in a path', node.lineno, node.colno, node);
        }
      }

      this._updateFrameReads(frame, name);//will register the name as read if it's a frame variable only

      let nodeStaticPathKey = this._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame.sequenceLockFrame, nodeStaticPathKey)) {
        if (this._isDeclared(frame, node.value)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }
        // This node accesses a declared sequence lock path.
        const emitSequencedLookup = (f) => {
          //register the static path key as variable write so the next lock would wait for it
          //multiple static path keys can be in the same block
          //@todo - optimization: if there are no further funCalls with lock on the path
          //we can use _updateFrameReads. The last funCall can record false in the lock value
          //to indicate all further paths locked by it that they don't need to make a lock for further funCalls
          //hence we can use _updateFrameReads for all of them
          this._updateFrameWrites(f, nodeStaticPathKey);
          //use the sequenced lookup
          this._emit(`runtime.sequencedContextLookup(context, frame, "${name}", ${JSON.stringify(nodeStaticPathKey)})`);
        };

        //if (!(pathFlags & (PathFlags.WAITS_FOR_SEQUENCE_LOCK | PathFlags.CALL))) {
        if (node.wrapInAsyncBlock) {
          // Wrap in an async block if pre-analysis determined it's necessary for contention.
          this._emitAsyncBlockValue(node, frame, emitSequencedLookup, undefined, node);
        } else {
          // Emit without an additional async block wrapper.
          emitSequencedLookup(frame);
        }
        return;
      }
    }
    else {//not async mode
      if (v) {
        //we are using a local variable, this is currently used only for:
        //the async filter, super(), set var
        this._emit(v);
        return;
      }
    }
    this._emit('runtime.contextOrFrameLookup(' + 'context, frame, "' + name + '")');
  }

  //todo - do not resolve, instead resolve it at the point of use: output or argument to functions, filters. Add tests
  // or better - return a promise
  //maybe resolve the unused/not-last elements?
  compileGroup(node, frame) {
    this._compileAggregate(node, frame, '(', ')', true, true);
  }

  //todo - do not resolve, instead resolve it at the point of use: output or argument to functions, filters. Add tests
  //do not return a promise for the whole thing so that resolved elements can be used as soon as possible
  compileArray(node, frame) {
    this._compileAggregate(node, frame, '[', ']', false, true);
  }

  //todo - Add other usage tests - function argument, filter argument, output
  compileDict(node, frame) {
    //do not resolve dictionary values, this is handled by memberLookupAsync
    this._compileAggregate(node, frame, '{', '}', false, true);
  }

  compilePair(node, frame) {
    var key = node.key;
    var val = node.value;

    if (key instanceof nodes.Symbol) {
      key = new nodes.Literal(key.lineno, key.colno, key.value);
    } else if (!(key instanceof nodes.Literal &&
      typeof key.value === 'string')) {
      this.fail('compilePair: Dict keys must be strings or names',
        key.lineno,
        key.colno,
        node,
        key);
    }

    this.compile(key, frame);
    this._emit(': ');
    this._compileExpression(val, frame);
  }

  compileInlineIf(node, frame) {
    if (node.isAsync) {
      this._emit('runtime.resolveSingle');
    }
    this._emit('(');
    this.compile(node.cond, frame);
    if (node.isAsync) {
      this._emit(').then(async function(cond) { return cond');
    }
    this._emit('?');
    this.compile(node.body, frame);
    this._emit(':');
    if (node.else_ !== null) {
      this.compile(node.else_, frame);
    } else {
      this._emit('""');
    }
    this._emit(node.isAsync ? '})' : ')');
  }

  compileIn(node, frame) {
    this._binFuncEmitter(node, frame, 'runtime.inOperator');
  }

  compileIs(node, frame) {
    const testName = node.right.name ? node.right.name.value : node.right.value;
    const testFunc = `env.getTest("${testName}")`;
    const failMsg = `test not found: ${testName}`.replace(/"/g, '\\"');
    // Generate error context within the compiler
    const errorContext = this._generateErrorContext(node, node.right);
    // Ensure failMsg is properly escaped for embedding in the generated string

    if (node.isAsync) {
      const mergedNode = {
        isAsync: node.left.isAsync || node.right.isAsync,
        // Use node.right for position if args exist, else node.left
        positionNode: (node.right.args && node.right.args.children.length > 0) ? node.right : node.left,
        children: (node.right.args && node.right.args.children.length > 0) ? [node.left, ...node.right.args.children] : [node.left]
      };
      // Resolve the left-hand side and arguments (if any)
      this._compileAggregate(mergedNode, frame, '[', ']', true, true, function (args) {
        this._emitLine(`  const testFunc = ${testFunc};`);
        this._emitLine(`  if (!testFunc) { throw runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}"); }`);
        this._emitLine(`  const result = await testFunc.call(context, ${args}[0]`);
        if (node.right.args && node.right.args.children.length > 0) {
          this._emitLine(`, ...${args}.slice(1)`);
        }
        this._emitLine(');');
        this._emitLine('  return result === true;');
      }, true);
    } else {
      this._emit(`(${testFunc} ? ${testFunc}.call(context, `);
      this.compile(node.left, frame);
      if (node.right.args) {
        this._emit(', ');
        this.compile(node.right.args, frame);
      }
      this._emit(`) : (() => { throw runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}"); })())`);
      this._emit(' === true');
    }
  }

  _binFuncEmitter(node, frame, funcName, separator = ',') {
    if (node.isAsync) {
      this._emit('(');
      this._emit('runtime.resolveDuo(');
      this.compile(node.left, frame);
      this._emit(',');
      this.compile(node.right, frame);
      this._emit(')');
      // Position node is tricky here, could be left or right. Use the main node.
      this._emit(`.then(function([left,right]){return ${funcName}(left${separator}right);}))`);
    } else {
      this._emit(`${funcName}(`);
      this.compile(node.left, frame);
      this._emit(separator);
      this.compile(node.right, frame);
      this._emit(')');
    }
  }

  _binOpEmitter(node, frame, str) {
    if (node.isAsync) {
      this._emit('runtime.resolveDuo(');
      this.compile(node.left, frame);
      this._emit(',');
      this.compile(node.right, frame);
      this._emit(')');
      // Position node is tricky here, could be left or right. Use the main node.
      this._emit('.then(function([left,right]){return left ' + str + ' right;})');
    } else {
      this.compile(node.left, frame);
      this._emit(str);
      this.compile(node.right, frame);
    }
  }

  _unaryOpEmitter(node, frame, operator) {
    if (node.isAsync) {
      this._emit('runtime.resolveSingle(');
      this.compile(node.target, frame);
      // Position node should be the target
      this._emit(`).then(function(target){return ${operator}target;})`);
    } else {
      this._emit(operator);
      this.compile(node.target, frame);
    }
  }

  // ensure concatenation instead of addition
  // by adding empty string in between
  compileOr(node, frame) {
    return this._binOpEmitter(node, frame, ' || ');
  }

  compileAnd(node, frame) {
    return this._binOpEmitter(node, frame, ' && ');
  }

  compileAdd(node, frame) {
    return this._binOpEmitter(node, frame, ' + ');
  }

  compileConcat(node, frame) {
    return this._binOpEmitter(node, frame, ' + "" + ');
  }

  compileSub(node, frame) {
    return this._binOpEmitter(node, frame, ' - ');
  }

  compileMul(node, frame) {
    return this._binOpEmitter(node, frame, ' * ');
  }

  compileDiv(node, frame) {
    return this._binOpEmitter(node, frame, ' / ');
  }

  compileMod(node, frame) {
    return this._binOpEmitter(node, frame, ' % ');
  }

  compileNot(node, frame) {
    return this._unaryOpEmitter(node, frame, '!');
  }

  compileFloorDiv(node, frame) {
    this._binFuncEmitter(node, frame, 'Math.floor', ' / ');
  }

  //@use add test
  compilePow(node, frame) {
    this._binFuncEmitter(node, frame, 'Math.pow');
  }

  compileNeg(node, frame) {
    return this._unaryOpEmitter(node, frame, '-');
  }

  compilePos(node, frame) {
    return this._unaryOpEmitter(node, frame, '+');
  }

  compileCompare(node, frame) {
    if (node.isAsync) {
      //use resolveDuo for expr and the first op, optionally await the rest
      this._emit('runtime.resolveDuo(');
      this.compile(node.expr, frame);
      this._emit(',');
      this.compile(node.ops[0].expr, frame);
      // Position node should be the first operation where the comparison happens
      this._emit(').then(async function([expr, ref1]){');
      this._emit(`return expr ${compareOps[node.ops[0].type]} ref1`);
      node.ops.forEach((op, index) => {
        if (index > 0) {
          this._emit(` ${compareOps[op.type]} `);
          this.compileAwaited(op.expr, frame);
        }
      });
      this._emit('})');
    } else {
      this.compile(node.expr, frame);

      node.ops.forEach((op) => {
        this._emit(` ${compareOps[op.type]} `);
        this.compile(op.expr, frame);
      });
    }
  }

  //@todo - directly to string
  _extractStaticPathKey(node) {
    // Check if the input node itself is valid to start a path extraction
    if (!node || (node.typename !== 'LookupVal' && node.typename !== 'Symbol')) {
      return null;
    }

    const parts = [];
    let current = node;

    while (current) {
      if (current.typename === 'LookupVal') {
        const valNode = current.val;
        if (valNode.typename === 'Symbol') {
          parts.unshift(valNode.value);
        } else if (valNode.typename === 'Literal' && typeof valNode.value === 'string') {
          parts.unshift(valNode.value);
        } else {
          return null; // Dynamic segment
        }
        current = current.target;
      } else if (current.typename === 'Symbol') {
        parts.unshift(current.value);
        current = null; // Stop traversal
      } else {
        return null; // Unexpected node type in path
      }
    }
    return '!' + parts.join('!');
  }

  compileLookupVal(node, frame, pathFlags = PathFlags.NONE) {
    if (node.isAsync) {
      // Check if sequenced flag is used inappropriately
      if (node.sequenced) {
        if (!(pathFlags & PathFlags.CALL)) {
          this.fail('Sequence marker (!) is not allowed in non-call paths', node.lineno, node.colno, node);
        }
        if (pathFlags & PathFlags.CREATES_SEQUENCE_LOCK) {
          this.fail('Can not use more than one sequence marker (!) in a path', node.lineno, node.colno, node);
        }
      }

      // Add SEQUENCED flag if node is marked
      if (node.sequenced) {
        pathFlags |= PathFlags.CREATES_SEQUENCE_LOCK;
      }
      let nodeStaticPathKey = this._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame.sequenceLockFrame, nodeStaticPathKey)) {
        const keyRoot = nodeStaticPathKey.substring(1, nodeStaticPathKey.indexOf('!', 1));
        if (this._isDeclared(frame, keyRoot)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }
        //const wrapInAsyncBlock = !(pathFlags & (PathFlags.WAITS_FOR_SEQUENCE_LOCK | PathFlags.CALL));
        pathFlags |= PathFlags.WAITS_FOR_SEQUENCE_LOCK;//do not wrap anymore
        const emitSequencedLookup = (f) => {
          //register the static path key as variable write so the next lock would wait for it
          //multiple static path keys can be in the same block
          this._updateFrameWrites(f, nodeStaticPathKey);
          // Use sequenced lookup as a lock for this node exists
          this._emit(`runtime.sequencedMemberLookupAsync(frame, (`);
          this.compile(node.target, f, pathFlags); // Mark target as part of a call path
          this._emit('),');
          this.compile(node.val, f); // Compile key expression
          this._emit(`, ${JSON.stringify(nodeStaticPathKey)})`); // Pass the key
        };
        if (node.wrapInAsyncBlock) {
          // Wrap in an async block if pre-analysis determined it's necessary for contention.
          // Use node.val as the positionNode for the async block value if it exists, else node.
          this._emitAsyncBlockValue(node, frame, emitSequencedLookup, undefined, node.val || node);
        } else {
          emitSequencedLookup(frame);//emit without async block
        }
        return;
      }
    }

    // Standard member lookup (sync or async without sequence)
    this._emit(`runtime.memberLookup${node.isAsync ? 'Async' : ''}((`);
    this.compile(node.target, frame, pathFlags); // Mark target as part of a call path
    this._emit('),');
    this.compile(node.val, frame);
    this._emit(')');
  }

  _getNodeName(node) {
    switch (node.typename) {
      case 'Symbol':
        return node.value;
      case 'FunCall':
        return 'the return value of (' + this._getNodeName(node.name) + ')';
      case 'LookupVal':
        return this._getNodeName(node.target) + '["' +
          this._getNodeName(node.val) + '"]';
      case 'Literal':
        return node.value.toString();
      default:
        return '--expression--';
    }
  }

  _getSequenceKey(node, frame) {
    let path = this._getSequencedPath(node, frame);
    return path ? '!' + path.join('!') : null;
  }

  _isDeclared(frame, name) {
    while (frame) {
      if (frame.declaredVars && frame.declaredVars.has(name)) {
        return true;
      }
      frame = frame.parent;
    }
    return false;
  }

  _addDeclaredVar(frame, varName) {
    if (!frame.declaredVars) {
      frame.declaredVars = new Set();
    }
    frame.declaredVars.add(varName);
  }

  // @todo - inline in _getSequenceKey
  _getSequencedPath(node, frame) {
    let path = [];
    let current = node;
    let sequencedCount = 0;
    // Flag to track if any dynamic segment (non-static key) was found
    // in the path *before* the segment marked with '!'.
    let dynamicFoundInPrefix = false;
    // Stores the node where '!' was actually found (either LookupVal or Symbol).
    let sequenceMarkerNode = null;
    // Stores the static string value of the segment marked with '!'
    let sequenceSegmentValue = null;

    // Helper: Checks if a key node represents a static string key.
    // This is the crucial check for sequencing requirements.
    // We ONLY allow Literal strings for bracket access sequencing.
    // Dot access (`a.b`) is assumed to be handled elsewhere or not subject
    // to this specific sequencing mechanism if it doesn't use LookupVal
    // with Literal keys.
    function isStaticStringKey(keyNode) {
      return keyNode && keyNode.typename === 'Literal' && typeof keyNode.value === 'string';
    }

    // --- Step 1: Handle FunCall with ! FIRST (e.g., a.method!()) ---
    // This path analysis focuses on object paths (LookupVal chains and root Symbols).
    // FunCall sequencing (`method!()`) needs separate validation logic *before*
    // this path traversal if it's intended to work differently.
    // Assuming the current logic focuses on `path!.segment` or `root!`.
    if (current.typename === 'FunCall' /* && current.sequenced */) {
      // If FunCall sequencing is desired, its validation (static method name, etc.)
      // should happen *before* or integrated carefully here.
      // For now, let's assume '!' on FunCall itself isn't processed by *this* path logic.
      // If the *target* of the FunCall has '!', that will be caught below.
      // e.g., in obj.path!.method(), the path logic runs on 'obj.path!'
      // If you need obj.method!(), it requires different handling.
      // current = current.name.target; // Need to adjust 'current' if handling FunCall!
    }


    // --- Step 2: Traverse the Object Path upwards, searching for '!' ---
    // We iterate from the end of the potential path backwards (up towards the root).
    let nodeToAnalyze = current;
    while (nodeToAnalyze && nodeToAnalyze.typename === 'LookupVal') {
      const isCurrentKeyStatic = isStaticStringKey(nodeToAnalyze.val);

      if (nodeToAnalyze.sequenced) {
        sequencedCount++;
        if (sequencedCount > 1) {
          this.fail(
            'Syntax Error: Using two sequence markers \'!\' in the same path is not supported.',
            nodeToAnalyze.lineno, nodeToAnalyze.colno, nodeToAnalyze
          );
        }
        // CRITICAL CHECK: The segment with '!' MUST use a static string key.
        if (!isCurrentKeyStatic) {
          this.fail(
            'Sequence Error: The sequence marker \'!\' can only be applied after a static string literal key (e.g., obj["key"]!). It cannot be used with dynamic keys like variable indices (obj[i]!), numeric indices (obj[1]!), or other expression results.',
            nodeToAnalyze.lineno, nodeToAnalyze.colno, nodeToAnalyze
          );
        }
        sequenceMarkerNode = nodeToAnalyze;
        sequenceSegmentValue = nodeToAnalyze.val.value; // Store the static key
        current = nodeToAnalyze.target; // 'current' now points to the node *before* the '!' segment
        break; // Found '!', stop searching
      }

      // If this segment doesn't have '!', check if it's dynamic.
      // This contributes to the 'dynamicFoundInPrefix' check later.
      if (!isCurrentKeyStatic) {
        dynamicFoundInPrefix = true;
      }
      nodeToAnalyze = nodeToAnalyze.target; // Move up the chain
    } // End while loop searching for '!' in LookupVal chain

    // --- Step 3: Handle Root Node (if '!' wasn't found in the chain) ---
    // Check if the root node itself has '!' (e.g., contextVar!)
    let rootNode = nodeToAnalyze; // Whatever node we stopped at
    if (!sequenceMarkerNode && rootNode && rootNode.typename === 'Symbol' && rootNode.sequenced) {
      sequencedCount++;
      if (sequencedCount > 1) { /* Should be caught above if chain existed */
        this.fail('Syntax Error: Using two sequence markers \'!\' in the same path is not supported.', rootNode.lineno, rootNode.colno, rootNode);
      }
      // Root node itself is sequenced.
      sequenceMarkerNode = rootNode;
      sequenceSegmentValue = rootNode.value; // The symbol's value is the key
      current = null; // No 'current' before the root
      // `dynamicFoundInPrefix` should be false here, as there was no preceding path.
    }

    // --- Step 4: Validate Prefix and Collect Full Path if '!' was found ---
    if (sequenceMarkerNode) {
      // We found '!' (either on a LookupVal or the root Symbol).
      // We already validated that the key *at* the '!' was a static string (or it was the root Symbol).
      // Now, validate that no segment *before* the '!' was dynamic.
      if (dynamicFoundInPrefix) {
        this.fail(
          'Sequence Error: The sequence marker \'!\' requires the entire path preceding it to consist of static string literal segments (e.g., root["a"]["b"]!). A dynamic segment (like a variable index) was found earlier in the path.',
          sequenceMarkerNode.lineno, // Error reported at the node with '!'
          sequenceMarkerNode.colno,
          sequenceMarkerNode // Pass the node with '!'
        );
      }

      // --- Prefix is valid, collect the full path string ---
      // Start with the segment that had '!'
      path.push(sequenceSegmentValue);

      // Traverse upwards from 'current' (the part before '!')
      while (current && current.typename === 'LookupVal') {
        // All segments here MUST be static string keys due to the dynamicFoundInPrefix check.
        if (!isStaticStringKey(current.val)) {
          // This should theoretically not happen if dynamicFoundInPrefix logic is correct.
          this.fail(
            `Internal Compiler Error: Dynamic segment found in sequence path prefix after validation. Path segment key type: ${current.val.typename}`,
            current.lineno, current.colno, current // Pass the problematic node
          );
        }
        path.unshift(current.val.value); // Add static key to the front
        current = current.target;
      }

      // --- Handle and Validate the final Root Node of the collected path ---
      rootNode = current; // Update rootNode to the final node after traversal
      if (rootNode && rootNode.typename === 'Symbol') {
        path.unshift(rootNode.value); // Add the root symbol identifier
      } else if (rootNode) {
        // Path doesn't start with a simple variable (e.g., started with func() or literal)
        this.fail(
          'Sequence Error: Sequenced paths marked with \'!\' must originate from a context variable (e.g., contextVar["key"]!). The path starts with a dynamic or non-variable element.',
          rootNode.lineno, rootNode.colno, rootNode // Report error at the problematic root
        );
      } else if (path.length === 0) {
        // This should not happen if sequenceSegmentValue was set.
        this.fail(`Internal Compiler Error: Sequence path collection resulted in empty path.`, node.lineno, node.colno, node);
      }
      // If !rootNode but path has elements, it means the sequence started mid-expression,
      // which is invalid for context variable sequencing. This is caught by the rootNode type check above.


      // --- Final Validation: Check Root Origin (Context vs. Scope) ---
      // Ensure the path doesn't start with a variable declared in the template scope.
      if (path.length > 0 && this._isDeclared(frame, path[0])) {
        // Path starts with a template variable (e.g., {% set myVar = {} %}{{ myVar!['key'].call() }})
        // Sequencing is only for context variables.
        return null;
      }

      // Path is fully validated for sequencing!
      return path; // Return the array of static string segments.

    } // End if (sequenceMarkerNode)

    // No valid sequence marker ('!') found according to the rules.
    return null;
  }

  compileFunCall(node, frame, pathFlags) {
    // Keep track of line/col info at runtime by setting
    // variables within an expression (SYNC MODE ONLY).
    if (!this.asyncMode) {
      this._emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');
    }

    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');

    if (node.isAsync) {

      const sequenceLockKey = this._getSequenceKey(node.name, frame);
      /*if (sequenceLockKey) {
        this._updateFrameWrites(frame, sequenceLockKey);
      }*/

      //Wrap in async block if a sequence lock is declared
      //because if the call is part of an expression, it will may be wrapped in the same async block
      // with other calls that have their own sequence locks
      //const wrapInAsyncBlock = sequenceLockKey && !(pathFlags & PathFlags.WAITS_FOR_SEQUENCE_LOCK);//if waiting for the lock, it will be already wrapped

      //@todo - node.name? or only in compileLookup and compileSymbol?

      //@todo - finish async name handling
      let asyncName = node.name.isAsync;
      if (node.name.typename === 'Symbol' && !frame.lookup(node.name.value)) {
        asyncName = false;
      }
      asyncName = true;
      if (!asyncName) {
        //We probably need some static analysis to know for sure a name is not async
        // {% set asyncFunc = getAsyncFunction() %}
        // {{ asyncFunc(arg1, arg2) }}
        // Function name is not async, so resolve only the arguments.
        this._compileAggregate(node.args, frame, '[', ']', true, false, function (result) {
          if (!sequenceLockKey) {
            this._emit(`return runtime.callWrap(`);
            this.compile(node.name, frame, PathFlags.CALL);
            this._emitLine(`, "${funcName}", context, ${result});`);
          } else {
            const emitCallback = (f) => {
              this._updateFrameWrites(f, sequenceLockKey);//count the writes inside the async block
              this._emit(`runtime.sequencedCallWrap(`);
              this.compile(node.name, f, PathFlags.CALL);
              this._emitLine(`, "${funcName}", context, ${result}, frame, "${sequenceLockKey}");`);
            };
            this._emit('return ');
            if (node.wrapInAsyncBlock) {
              // Position node is the function call itself
              this._emitAsyncBlockValue(node, frame, emitCallback, undefined, node);
            } else {
              emitCallback(frame);
            }
          }
        }); // Resolve arguments using _compileAggregate.
      } else {
        // Function name is dynamic, so resolve both function and arguments.
        // In async mode, resolve the function and arguments in parallel.

        const mergedNode = {
          isAsync: node.name.isAsync || node.args.isAsync,
          children: (node.args.children.length > 0) ? [node.name, ...node.args.children] : [node.name]
        };

        node.name.pathFlags = PathFlags.CALL;
        // Position node for aggregate is the function call itself (node)
        this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
          if (!sequenceLockKey) {
            this._emit(`return runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);
          } else {
            const emitCallback = (f) => {
              this._updateFrameWrites(f, sequenceLockKey);//count the writes inside the async block
              this._emit(`runtime.sequencedCallWrap(${result}[0], "${funcName}", context, ${result}.slice(1), frame, "${sequenceLockKey}");`);
            };
            this._emit('return ');
            if (node.wrapInAsyncBlock) {
              // Position node is the function call itself
              this._emitAsyncBlockValue(node, frame, emitCallback, undefined, node);
            } else {
              emitCallback(frame);
            }
          }
        });
        delete node.name.pathFlags;
      }
      // //(lineno, ... No closing parenthesis needed here for async mode
    } else {
      // In sync mode, compile as usual.
      this._emit('runtime.callWrap(');
      this.compile(node.name, frame);
      this._emit(', "' + funcName + '", context, ');
      this._compileAggregate(node.args, frame, '[', ']', false, false);
      this._emit('))');
    }
  }

  compileFilterGet(node, frame) {
    this._emit('env.getFilter("' + node.value + '")');//@todo I think this can not be async
  }

  compileFilter(node, frame) {
    var name = node.name;

    this.assertType(name, nodes.Symbol);

    if (node.isAsync) {
      const filterGetNode = { value: name.value, typename: 'FilterGet' };
      const mergedNode = {
        isAsync: true,
        children: [filterGetNode, ...node.args.children]
      };
      this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
        this._emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
      });
    } else {
      this._emit('env.getFilter("' + name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this._emit(')');
    }
  }

  compileFilterAsync(node, frame) {
    /*if(!this.insideExpression){
      //async filters set a frame var with the result and often precede the control node that uses them
      this._compileExpression(node, frame);
      return;
    }*/

    let name = node.name;
    let symbol = node.symbol.value;

    this.assertType(name, nodes.Symbol);

    frame.set(symbol, symbol);

    if (node.isAsync) {
      this._emitLine(`let ${symbol} = `);
      // Use node.args as the position node since it's what's being evaluated async
      this._emitAsyncBlockValue(node, frame, (f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        //@todo - this should be done with _compileExpression in the future
        this._compileAggregate(node.args, f, '[', ']', true, false, function (result) {
          this._emit(`return env.getFilter("${name.value}").bind(env)(...${result});`);
        });
      }, undefined, node.args);
      this._emit(';');
    } else {
      this._emit('env.getFilter("' + name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this._emitLine(', ' + this._makeCallback(symbol));
      this._addScopeLevel();
    }

  }

  compileKeywordArgs(node, frame) {
    this._emit('runtime.makeKeywordArgs(');
    this.compileDict(node, frame);
    this._emit(')');
  }

  compileSet(node, frame) {
    var ids = [];

    // Lookup the variable names for each identifier and create
    // new ones if necessary
    node.targets.forEach((target) => {
      var name = target.value;
      var id = frame.lookup(name);

      if (id === null || id === undefined) {
        id = this._tmpid();

        // Note: This relies on js allowing scope across
        // blocks, in case this is created inside an `if`
        this._emitLine('let ' + id + ';');

        //@bug from nunjucks, the temporary variable is not added to the frame
        //leave it as is because we need to use node.get to handle async scenarios
        //frame.set(name, id);
      }

      ids.push(id);

      if (this.asyncMode) {
        this._updateFrameWrites(frame, name);
      }
    });

    if (node.value) {
      this._emit(ids.join(' = ') + ' = ');
      if (node.isAsync) {
        // Use node.value as the position node since it's the expression being evaluated
        this._emitAsyncBlockValue(node, frame, (f) => {
          this.compile(node.value, f);
        }, undefined, node.value); // Pass value as code position
      } else {
        this._compileExpression(node.value, frame);
      }
    } else {
      // set block
      this._emit(ids.join(' = ') + ' = ');
      // Use node.body as the position node since it's the block being evaluated
      this._emitAsyncBlockValue(node, frame, (f) => {
        this.compile(node.body, f);
      }, undefined, node.body); // Pass body as code position
    }
    this._emitLine(';');

    node.targets.forEach((target, i) => {
      var id = ids[i];
      var name = target.value;

      // We are running this for every var, but it's very
      // uncommon to assign to multiple vars anyway
      this._emitLine(`frame.set("${name}", ${id}, true);`);

      //if (!this.asyncMode) {
      //in async mode writing to the context is not possible
      //will use a separate input/output tags and attributes to
      //declare variable exports/imports
      this._emitLine('if(frame.topLevel) {');
      this._emitLine(`context.setVariable("${name}", ${id});`);
      this._emitLine('}');
      //}

      if (name.charAt(0) !== '_') {
        this._emitLine('if(frame.topLevel) {');
        this._emitLine(`context.addExport("${name}", ${id});`);
        this._emitLine('}');
      }
    });
  }

  //@todo - do not store writes that will not be read by the parents
  _updateFrameWrites(frame, name) {
    //store the writes and variable declarations down the scope chain
    //search for the var in the scope chain
    let vf = frame;
    if (name.startsWith('!')) {
      // Sequence keys are conceptually declared at the root for propagation purposes.
      // We add them in a separate pass with _propagateIsAsyncAndDeclareSequentialLocks
      /*vf = frame.sequenceLockFrame;
      if (!vf.declaredVars) {
        vf.declaredVars = new Set();
      }
      vf.declaredVars.add(name);*/
      while (vf.parent) {
        vf = vf.parent;
      }
    } else {
      do {
        if (vf.declaredVars && vf.declaredVars.has(name)) {
          break;//found the var in vf
        }
        if (vf.isolateWrites) {
          vf = null;
          break;
        }
        vf = vf.parent;
      }
      while (vf);

      if (!vf) {
        //the variable did not exist
        //declare a new variable in the current frame (or a parent if !createScope)
        vf = frame;
        while (!vf.createScope) {
          vf = vf.parent;//skip the frames that can not create a new scope
        }
        this._addDeclaredVar(vf, name);
      }
    }

    //count the sets in the current frame/async block, propagate the first write down the chain
    //do not count for the frame where the variable is declared
    while (frame != vf) {
      if (!frame.writeCounts || !frame.writeCounts[name]) {
        frame.writeCounts = frame.writeCounts || {};
        frame.writeCounts[name] = 1;//first write, countiune to the parent frames (only 1 write per async block is propagated)
      } else {
        frame.writeCounts[name]++;
        break;//subsequent writes are not propagated
      }
      frame = frame.parent;
    }
  }

  //@todo - handle included parent frames properly
  _updateFrameReads(frame, name) {
    //find the variable declaration in the scope chain
    //let declared = false;
    let df = frame;
    do {
      if (df.declaredVars && df.declaredVars.has(name)) {
        //declared = true;
        break;//found the var declaration
      }
      df = df.parent;
    }
    while (df);//&& !df.isolateWrites );

    if (!df) {
      //a context variable
      return;
    }

    while (frame != df) {
      if ((frame.readVars && frame.readVars.has(name)) || (frame.writeCounts && frame.writeCounts[name])) {
        //found the var
        //if it's already in readVars - skip
        //if it's set here or by children - it will be snapshotted anyway, don't add
        break;
      }
      frame.readVars = frame.readVars || new Set();
      frame.readVars.add(name);
      frame = frame.parent;
    }
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
        reads.push(name);
      });
    }
    const readArgs = reads.length ? JSON.stringify(reads) : 'null';
    const writeArgs = frame.writeCounts ? ', ' + JSON.stringify(frame.writeCounts) : '';
    return `frame.pushAsyncBlock(${readArgs}${writeArgs})`;
  }

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    // Use node.expr as the primary position node for the overall switch block
    frame = this._emitAsyncBlockBufferNodeBegin(node, frame, false, node.expr);

    const branchPositions = [];
    const branchWriteCounts = [];

    // Helper to combine all write counts
    const combineWriteCounts = (counts) => {
      const combined = {};
      counts.forEach((count) => {
        if (!count) return;
        Object.entries(count).forEach(([key, value]) => {
          combined[key] = (combined[key] || 0) + value;
        });
      });
      return combined;
    };

    // Helper to exclude current branch writes from combined writes
    const excludeCurrentWrites = (combined, current) => {
      const filtered = { ...combined };
      if (current) {
        Object.keys(current).forEach((key) => {
          if (filtered[key]) {
            filtered[key] -= current[key];
            if (filtered[key] <= 0) {
              delete filtered[key];
            }
          }
        });
      }
      return filtered;
    };

    // Emit switch statement
    this._emit('switch (');
    this._compileAwaitedExpression(node.expr, frame);
    this._emit(') {');

    // Compile cases
    node.cases.forEach((c, i) => {
      this._emit('case ');
      this._compileAwaitedExpression(c.cond, frame);
      this._emit(': ');

      branchPositions.push(this.codebuf.length);
      this._emit('');

      if (c.body.children.length) {
        // Use case body 'c.body' as position node for this block
        this._emitAsyncBlock(c, frame, false, (f) => {
          this.compile(c.body, f);
          branchWriteCounts.push(this.countsTo1(f.writeCounts) || {});
        }, c.body); // Pass body as code position
        this._emitLine('break;');
      }
    });

    // Compile default case, if present
    if (node.default) {
      this._emit('default: ');

      branchPositions.push(this.codebuf.length);
      this._emit('');

      // Use default body 'node.default' as position node for this block
      this._emitAsyncBlock(node, frame, false, (f) => {
        this.compile(node.default, f);
        branchWriteCounts.push(this.countsTo1(f.writeCounts) || {});
      }, node.default); // Pass default as code position
    }

    this._emit('}');

    // Combine writes from all branches
    const totalWrites = combineWriteCounts(branchWriteCounts);

    // Insert skip statements for each case, including default
    branchPositions.forEach((pos, i) => {
      const writesToSkip = excludeCurrentWrites(totalWrites, branchWriteCounts[i]);
      if (Object.keys(writesToSkip).length > 0) {
        this._emitInsertLine(pos, `frame.skipBranchWrites(${JSON.stringify(writesToSkip)});`);
      }
    });

    // Use node.expr (passed earlier) for the end block
    frame = this._emitAsyncBlockBufferNodeEnd(node, frame, false, false, node.expr);
  }

  //within an async block, each set is counted, but when propagating the writes to the parent async block
  //only the first write is propagated
  countsTo1(writeCounts) {
    if (!writeCounts) {
      return undefined;
    }
    let firstWritesOnly = {};
    for (let key in writeCounts) {
      firstWritesOnly[key] = 1;
    }
    return firstWritesOnly;
  }

  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if (this.asyncMode && node.isAsync) {
      async = false;//old type of async
    }

    // Use node.cond as the position node for the overarching If block
    frame = this._emitAsyncBlockBufferNodeBegin(node, frame, false, node.cond);

    let trueBranchWriteCounts, falseBranchWriteCounts;
    let trueBranchCodePos;

    this._emit('if(');
    this._compileAwaitedExpression(node.cond, frame);
    this._emit('){');

    if (this.asyncMode) {
      trueBranchCodePos = this.codebuf.length;
      this._emit('');
      // Use node.body as the position node for the true branch block
      this._emitAsyncBlock(node, frame, false, (f) => {
        this.compile(node.body, f);
        trueBranchWriteCounts = this.countsTo1(f.writeCounts);
      }, node.body); // Pass body as code position
    }
    else {
      this._withScopedSyntax(() => {
        this.compile(node.body, frame);
        if (async) {
          this._emit('cb()');
        }
      });
    }

    this._emit('} else {');

    if (trueBranchWriteCounts) {
      //skip the true branch writes in the false branch
      this._emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
    }

    if (node.else_) {
      if (this.asyncMode) {
        // Use node.else_ as the position node for the false branch block
        this._emitAsyncBlock(node, frame, false, (f) => {
          this.compile(node.else_, f);
          falseBranchWriteCounts = this.countsTo1(f.writeCounts);
        }, node.else_); // Pass else as code position
      }
      else {
        this._withScopedSyntax(() => {
          this.compile(node.else_, frame);
          if (async) {
            this._emit('cb()');
          }
        });
      }
    } else {
      if (async && !this.asyncMode) {
        this._emit('cb()');
      }
    }

    this._emit('}');

    if (falseBranchWriteCounts) {
      //skip the false branch writes in the true branch code
      this._emitInsertLine(trueBranchCodePos, `frame.skipBranchWrites(${JSON.stringify(falseBranchWriteCounts)});`);
    }

    // Use node.cond (passed earlier) for the end block
    frame = this._emitAsyncBlockBufferNodeEnd(node, frame, false, false, node.cond);
  }

  compileIfAsync(node, frame) {
    if (node.isAsync) {
      this.compileIf(node, frame);
    } else {
      this._emit('(function(cb) {');
      this.compileIf(node, frame, true);
      this._emit('})(' + this._makeCallback());
      this._addScopeLevel();
    }
  }

  compileFor(node, frame) {
    this._compileFor(node, frame, false);
  }

  _compileFor(node, frame, sequential = false) {
    // Some of this code is ugly, but it keeps the generated code
    // as fast as possible. ForAsync also shares some of this, but
    // not much.

    // Use node.arr as the position for the outer async block (evaluating the array)
    frame = this._emitAsyncBlockBufferNodeBegin(node, frame, true, node.arr);

    // Evaluate the array expression
    const arr = this._tmpid();
    this._emit(`let ${arr} = `);
    this._compileAwaitedExpression(node.arr, frame);
    this._emitLine(';');

    // Determine loop variable names
    const loopVars = [];
    if (node.name instanceof nodes.Array) {
      node.name.children.forEach((child) => {
        loopVars.push(child.value);
        frame.set(child.value, child.value);
        this._addDeclaredVar(frame, child.value);
      });
    } else {
      loopVars.push(node.name.value);
      frame.set(node.name.value, node.name.value);
      this._addDeclaredVar(frame, node.name.value);
    }

    // Define the loop body function
    const loopBodyFunc = this._tmpid();
    this._emit(`let ${loopBodyFunc} = `);

    if (node.isAsync) {
      this._emit('async function(');//@todo - think this over, does it need async block?
    } else {
      this._emit('function(');
    }

    // Function parameters
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this._emit(', ');
      }
      this._emit(varName);
    });
    const loopIndex = this._tmpid();
    const loopLength = this._tmpid();
    const isLast = this._tmpid();
    this._emit(`, ${loopIndex}, ${loopLength}, ${isLast}) {`);

    // Use node.body as the position for the inner buffer block (loop body execution)
    frame = this._emitAsyncBlockBufferNodeBegin(node, frame, false, node.body);

    const makeSequentialPos = this.codebuf.length;
    this._emitLine(`runtime.setLoopBindings(frame, ${loopIndex}, ${loopLength}, ${isLast});`);

    // Handle array unpacking within the loop body
    if (loopVars.length === 2 && !Array.isArray(arr)) {
      // Object key/value iteration
      const [keyVar, valueVar] = loopVars;
      this._emitLine(`frame.set("${keyVar}", ${keyVar});`);
      this._emitLine(`frame.set("${valueVar}", ${valueVar});`);
    } else if (node.name instanceof nodes.Array) {
      // Array destructuring
      node.name.children.forEach((child, index) => {
        const varName = child.value;
        const tid = this._tmpid();
        this._emitLine(`let ${tid} = Array.isArray(${varName}) ? ${varName}[${index}] : undefined;`);
        this._emitLine(`frame.set("${child.value}", ${tid});`);
      });
    } else {
      // Single variable loop
      const varName = node.name.value;
      this._emitLine(`frame.set("${varName}", ${varName});`);
    }

    // Compile the loop body with the updated frame
    this._withScopedSyntax(() => {
      this.compile(node.body, frame);
    });

    const bodyWriteCounts = frame.writeCounts;
    if (bodyWriteCounts) {
      sequential = true;//should be sequential to avoid write race conditions and long promise chains
    }
    if (sequential) {
      this._emitInsertLine(makeSequentialPos, 'frame.sequentialLoopBody = true;');
    }

    // End buffer block for the loop body (using node.body position)
    frame = this._emitAsyncBlockBufferNodeEnd(node, frame, false, true, node.body);

    // Close the loop body function
    this._emitLine('};');

    // Define the else function if it exists
    let elseFuncId = 'null';
    if (node.else_) {
      elseFuncId = this._tmpid();
      this._emit(`let ${elseFuncId} = `);

      if (node.isAsync) {
        this._emit('async function() {');
      } else {
        this._emit('function() {');
      }

      // Use node.else_ as position for the else block buffer
      frame = this._emitAsyncBlockBufferNodeBegin(node, frame, false, node.else_);
      this.compile(node.else_, frame);
      frame = this._emitAsyncBlockBufferNodeEnd(node, frame, false, false, node.else_);

      this._emitLine('};');
    }

    // Call the runtime iterate loop function
    this._emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFunc}, ${elseFuncId}, frame, ${JSON.stringify(bodyWriteCounts)}, [`);
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this._emit(', ');
      }
      this._emit(`"${varName}"`);
    });
    this._emit(`], ${sequential}, ${node.isAsync});`);

    // End buffer block for the node (using node.arr position)
    frame = this._emitAsyncBlockBufferNodeEnd(node, frame, true, false, node.arr);
  }

  _emitAsyncLoopBindings(node, arr, i, len) {
    const bindings = [
      { name: 'index', val: `${i} + 1` },
      { name: 'index0', val: i },
      { name: 'revindex', val: `${len} - ${i}` },
      { name: 'revindex0', val: `${len} - ${i} - 1` },
      { name: 'first', val: `${i} === 0` },
      { name: 'last', val: `${i} === ${len} - 1` },
      { name: 'length', val: len },
    ];

    bindings.forEach((b) => {
      this._emitLine(`frame.set("loop.${b.name}", ${b.val});`);
    });
  }

  _compileAsyncLoop(node, frame, parallel) {
    if (node.isAsync) {
      this._compileFor(node, frame, true);
      return;
    }
    // This shares some code with the For tag, but not enough to
    // worry about. This iterates across an object asynchronously,
    // but not in parallel.
    let i, len, arr, asyncMethod;

    i = this._tmpid();
    len = this._tmpid();
    arr = this._tmpid();
    asyncMethod = parallel ? 'asyncAll' : 'asyncEach';

    frame = frame.push();
    this._emitLine('frame = frame.push();');

    this._emit('let ' + arr + ' = runtime.fromIterator(');
    this._compileExpression(node.arr, frame);
    this._emitLine(');');

    if (node.name instanceof nodes.Array) {
      const arrayLen = node.name.children.length;
      this._emit(`runtime.${asyncMethod}(${arr}, ${arrayLen}, function(`);

      node.name.children.forEach((name) => {
        this._emit(`${name.value},`);
      });

      this._emit(i + ',' + len + ',next) {');

      node.name.children.forEach((name) => {
        const id = name.value;
        frame.set(id, id);
        this._addDeclaredVar(frame, id);
        this._emitLine(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this._emitLine(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      this._addDeclaredVar(frame, id);
      this._emitLine('frame.set("' + id + '", ' + id + ');');
      frame.set(id, id);
    }

    this._emitAsyncLoopBindings(node, arr, i, len);

    this._withScopedSyntax(() => {
      let buf;
      if (parallel) {
        buf = this._pushBuffer();
      }

      this.compile(node.body, frame);
      this._emitLine('next(' + i + (buf ? ',' + buf : '') + ');');

      if (parallel) {
        this._popBuffer();
      }
    });

    const output = this._tmpid();
    this._emitLine('}, ' + this._makeCallback(output));
    this._addScopeLevel();

    if (parallel) {
      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this._emit(`${this.buffer}[index++] = ${output};`);
      } else {
        this._emitLine(`${this.buffer} += ${output};`);
      }
    }

    if (node.else_) {
      this._emitLine('if (!' + arr + '.length) {');
      this.compile(node.else_, frame);
      this._emitLine('}');
    }

    this._emitLine('frame = frame.pop();');
    //frame = frame.pop();// - not in nunjucks (a bug?)
  }

  compileAsyncEach(node, frame) {
    this._compileAsyncLoop(node, frame);
  }

  compileAsyncAll(node, frame) {
    this._compileAsyncLoop(node, frame, true);
  }

  _compileMacro(node, frame, keepFrame) {
    var args = [];
    var kwargs = null;
    var funcId = 'macro_' + this._tmpid();
    //var keepFrame = (frame !== undefined);

    // Type check the definition of the args
    node.args.children.forEach((arg, i) => {
      if (i === node.args.children.length - 1 && arg instanceof nodes.Dict) {
        kwargs = arg;
      } else {
        this.assertType(arg, nodes.Symbol);
        args.push(arg);
      }
    });

    const realNames = [...args.map((n) => `l_${n.value}`), 'kwargs'];

    // Quoted argument names
    const argNames = args.map((n) => `"${n.value}"`);
    const kwargNames = ((kwargs && kwargs.children) || []).map((n) => `"${n.key.value}"`);

    // We pass a function to makeMacro which destructures the
    // arguments so support setting positional args with keywords
    // args and passing keyword args as positional args
    // (essentially default values). See runtime.js.
    let currFrame;
    if (keepFrame) {
      currFrame = frame.push(true);
    } else {
      currFrame = frame.new();//node.isAsync ? new AsyncFrame() : new Frame();//
    }
    this._emitLines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${argNames.join(', ')}], `,
      `[${kwargNames.join(', ')}], `,
      `function (${realNames.join(', ')}, astate) {`
    );
    if (!keepFrame) {
      this._emitLine('let callerFrame = frame;');//@todo - only if !keepFrame
    }
    this._emitLines(
      'frame = ' + ((keepFrame) ? 'frame.push(true);' : 'frame.new();'),
      'kwargs = kwargs || {};',
      'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      'frame.set("caller", kwargs.caller); }'
    );

    let err = this._tmpid();
    if (node.isAsync) {
      this._emitLines(
        `let ${err} = null;`,
        'function cb(err) {',
        `if(err) {${err} = err;}`,
        '}');
    }

    // Expose the arguments to the template. Don't need to use
    // random names because the function
    // will create a new run-time scope for us
    args.forEach((arg) => {
      this._emitLine(`frame.set("${arg.value}", l_${arg.value});`);
      currFrame.set(arg.value, `l_${arg.value}`);
      this._addDeclaredVar(currFrame, arg.value);
    });

    // Expose the keyword arguments
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        this._addDeclaredVar(currFrame, name);
        this._emit(`frame.set("${name}", `);
        this._emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
        this._emit(` ? kwargs["${name}"] : `);
        this._compileExpression(pair.value, currFrame);
        this._emit(');');
      });
    }

    this._addDeclaredVar(currFrame, 'caller');
    const bufferId = this._pushBuffer();

    this._withScopedSyntax(() => {
      this.compile(node.body, currFrame);
    });

    this._emitLine('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));
    //return the buffer, in async mode it may not be ready yet
    //this._emitLine(`return ${node.isAsync?'runtime.newSafeStringAsync':'new runtime.SafeString'}(${bufferId});`);
    this._emitLine('return ' + (
      node.isAsync ?
        `astate.waitAllClosures().then(() => {if (${err}) throw ${err}; return runtime.newSafeStringAsync(runtime.flattentBuffer(${bufferId}));}).catch(error => Promise.reject(error));` :
        `new runtime.SafeString(${bufferId})`
    )
    );

    if (node.isAsync) {
      this._emitLine('}, astate);');
    } else {
      this._emitLine('});');
    }
    this._popBuffer();

    return funcId;
  }

  compileMacro(node, frame) {
    var funcId = this._compileMacro(node, frame, false);

    // Expose the macro to the templates
    var name = node.name.value;
    frame.set(name, funcId);

    if (frame.parent) {
      this._emitLine(`frame.set("${name}", ${funcId});`);
    } else {
      if (node.name.value.charAt(0) !== '_') {
        this._emitLine(`context.addExport("${name}");`);
      }
      this._emitLine(`context.setVariable("${name}", ${funcId});`);
    }
  }

  compileCaller(node, frame) {
    // basically an anonymous "macro expression"
    this._emit('(function (){');
    const funcId = this._compileMacro(node, frame, true);
    this._emit(`return ${funcId};})()`);
  }

  _compileGetTemplate(node, frame, eagerCompile, ignoreMissing, wrapInAsyncBlock) {
    const parentTemplateId = this._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    if (node.isAsync) {
      const getTemplateFunc = this._tmpid();
      this._emitLine(`const ${getTemplateFunc} = runtime.promisify(env.getTemplate.bind(env));`);
      this._emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      if (wrapInAsyncBlock) {
        // Wrap the expression evaluation in an async block if needed, use template node position
        this._emitAsyncBlockValue(node.template, frame, (f) => {
          this._compileExpression(node.template, f);
        }, undefined, positionNode);
      } else {
        this._compileExpression(node.template, frame);
      }
      this._emitLine(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    } else {
      const cb = this._makeCallback(parentTemplateId);
      this._emit('env.getTemplate(');
      this._compileExpression(node.template, frame);
      this._emitLine(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);
    }

    return parentTemplateId;
  }

  compileImport(node, frame) {
    const target = node.target.value;
    // Pass node.template for position in _compileGetTemplate
    const id = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this._emit(`${id} = `);
      // Use node as position node for the getExported part
      this._emitAsyncBlockValue(node, frame, (f) => {
        this._emitLine(`let ${res} = await ${id};`);
        this._emitLine(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${node.withContext
          ? `context.getVariables(), frame, astate`
          : `null, null, astate`
        });`);
      }, res, node);
    } else {
      this._addScopeLevel();
      this._emitLine(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(id));
      this._addScopeLevel();
    }

    frame.set(target, id);
    this._addDeclaredVar(frame, target);

    if (frame.parent) {
      this._emitLine(`frame.set("${target}", ${id});`);
    } else {
      // AI:
      //if (node.name.value.charAt(0) !== '_') {
      //  this._emitLine(`context.addExport("${target}");`);
      //}
      this._emitLine(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    // Pass node.template for position in _compileGetTemplate
    const importedId = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this._emit(`${importedId} = `);
      // Use node as position node for the getExported part
      this._emitAsyncBlockValue(node, frame, (f) => {
        this._emitLine(`let ${res} = await ${importedId};`);
        this._emitLine(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${node.withContext
          ? `context.getVariables(), frame, astate`
          : `null, null, astate`
        });`);
      }, res, node);
    } else {
      this._addScopeLevel();//after _compileGetTemplate
      this._emitLine(importedId + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(importedId));
      this._addScopeLevel();
    }

    node.names.children.forEach((nameNode) => {
      let name;
      let alias;
      let id = this._tmpid();
      this._emitLine(`let ${id};`);

      if (nameNode instanceof nodes.Pair) {
        name = nameNode.key.value;
        alias = nameNode.value.value;
      } else {
        name = nameNode.value;
        alias = name;
      }

      // Generate context within the compiler scope
      const errorContext = this._generateErrorContext(node, nameNode);
      const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

      if (node.isAsync) {
        //@todo - error handling in the async() function - This manual IIFE still bypasses handlePromise wrapper.
        // The async IIFE here doesn't use our helpers, error pos comes from JS runtime
        // @todo This needs refactoring to use handlePromise for proper context reporting via catch handler
        this._emitLine(`${id} = (async () => { try { `); // Add try
        this._emitLine(`  let exported = await ${importedId};`);
        this._emitLine(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this._emitLine(`    return exported["${name}"];`);
        this._emitLine(`  } else {`);
        this._emitLine(`    throw runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}");`);
        this._emitLine(`  }`);
        this._emitLine(`} catch(e) { throw runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}"); } })();`);
      } else {
        this._emitLine(`if(Object.prototype.hasOwnProperty.call(${importedId}, "${name}")) {`);
        this._emitLine(`${id} = ${importedId}.${name};`);
        this._emitLine('} else {');
        this._emitLine(`cb(runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}")); return;`);
        this._emitLine('}');
      }

      frame.set(alias, id);
      this._addDeclaredVar(frame, alias);

      if (frame.parent) {
        this._emitLine(`frame.set("${alias}", ${id});`);
      } else {
        this._emitLine(`context.setVariable("${alias}", ${id});`);
      }
    });
  }

  compileBlock(node, frame) {
    //var id = this._tmpid();

    // If we are executing outside a block (creating a top-level
    // block), we really don't want to execute its code because it
    // will execute twice: once when the child template runs and
    // again when the parent template runs. Note that blocks
    // within blocks will *always* execute immediately *and*
    // wherever else they are invoked (like used in a parent
    // template). This may have behavioral differences from jinja
    // because blocks can have side effects, but it seems like a
    // waste of performance to always execute huge top-level
    // blocks twice

    if (node.isAsync) {
      // Use the block node itself for position
      this._emitAsyncBlockAddToBuffer(node, frame, (id, f) => {
        if (!this.inBlock) {
          this._emit(`if(parentTemplate) ${id}=""; else {`);
        }
        const blockFunc = this._tmpid();
        this._emitLine(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        this._emitLine(`${blockFunc} = runtime.promisify(${blockFunc}.bind(context));`);
        this._emitLine(`${id} = await ${blockFunc}(env, context, frame, runtime, astate);`);
        if (!this.inBlock) {
          this._emitLine('}');
        }
      }, node);
    }
    else {
      let id = this._tmpid();
      if (!this.inBlock) {
        this._emit('(parentTemplate ? function(e, c, f, r, cb) { cb(null, ""); } : ');
      }
      this._emit(`context.getBlock("${node.name.value}")`);
      if (!this.inBlock) {
        this._emit(')');
      }
      this._emitLine('(env, context, frame, runtime, ' + this._makeCallback(id));

      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this._emit(`${this.buffer}[index++] = ${id};`);
      } else {
        this._emitLine(`${this.buffer} += ${id};`);
      }
      this._addScopeLevel();
    }
  }

  compileSuper(node, frame) {
    var name = node.blockName.value;
    var id = node.symbol.value;

    if (node.isAsync) {
      this._emitLine(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);
    }
    else {
      const cb = this._makeCallback(id);
      this._emitLine(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this._emitLine(`${id} = runtime.markSafe(${id});`);

    if (!node.isAsync) {
      this._addScopeLevel();
    }
    frame.set(id, id);
    this._addDeclaredVar(frame, id);
  }

  compileExtends(node, frame) {
    var k = this._tmpid();

    if (node.isAsync) {
      this._emitLine('context.prepareForAsyncBlocks();');
    }

    // Pass node.template for position in _compileGetTemplate
    const parentTemplateId = this._compileGetTemplate(node, frame, true, false, true);

    // extends is a dynamic tag and can occur within a block like
    // `if`, so if this happens we need to capture the parent
    // template in the top-level scope

    if (node.isAsync) {
      // Use node.template as position for the block resolving the parent template
      frame = this._emitAsyncBlockBegin(node, frame, false, node.template);
    }

    //isAsync: set the global parent template, compileRoot will use it after waitAllClosures
    this._emitLine(`parentTemplate = ${node.isAsync ? 'await ' : ''}${parentTemplateId};`);
    this._emitLine(`for(let ${k} in parentTemplate.blocks) {`);
    this._emitLine(`context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this._emitLine('}');

    if (!node.isAsync) {
      this._addScopeLevel();
    }
    else {
      this._emitLine('context.finsihsAsyncBlocks()');
      // Use node.template for the end block position
      frame = this._emitAsyncBlockEnd(node, frame, false, false, node.template);
    }
  }

  compileInclude(node, frame) {
    if (!node.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    // Use node.template for position of getTemplate, node for render
    this._emitAsyncBlockAddToBuffer(node, frame, (resultVar, f) => {
      // Get the template
      const templateVar = this._tmpid();
      const templateNameVar = this._tmpid();

      // Get the template name expression
      this._emit(`let ${templateNameVar} = `);
      this._compileExpression(node.template, f);
      this._emitLine(';');

      // getTemplate
      this._emitLine(`let ${templateVar} = await runtime.promisify(env.getTemplate.bind(env))(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // render
      this._emitLine(`${resultVar} = await runtime.promisify(${templateVar}.render.bind(${templateVar}))(context.getVariables(), frame${node.isAsync ? ', astate' : ''});`);
    }, node);
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this._emitLine('let tasks = [];');
    this._emitLine('tasks.push(');
    this._emitLine('function(callback) {');

    const id = this._compileGetTemplate(node, frame, false, node.ignoreMissing, false);
    this._emitLine(`callback(null,${id});});`);

    this._emitLine('});');

    const id2 = this._tmpid();
    this._emitLine('tasks.push(');
    this._emitLine('function(template, callback){');
    this._emitLine('template.render(context.getVariables(), frame, ' + (node.isAsync ? 'astate,' : '') + this._makeCallback(id2));
    this._emitLine('callback(null,' + id2 + ');});');
    this._emitLine('});');

    this._emitLine('tasks.push(');
    this._emitLine('function(result, callback){');

    // Adding to buffer is synchronous here
    if (this.asyncMode) {
      //non-async node but in async mode -> use the proper buffer implementation
      this._emitLine(`${this.buffer}[index++] = result;`);
    } else {
      this._emitLine(`${this.buffer} += result;`);
    }
    this._emitLine('callback(null);');
    this._emitLine('});');
    this._emitLine('env.waterfall(tasks, function(){');
    this._addScopeLevel();
  }

  compileTemplateData(node, frame) {
    this.compileLiteral(node, frame);
  }

  compileCapture(node, frame) {
    // we need to temporarily override the current buffer id as 'output'
    // so the set block writes to the capture output instead of the buffer
    const buffer = this.buffer;
    this.buffer = 'output';
    if (node.isAsync) {
      const res = this._tmpid();
      // Use node.body as position node for the capture block evaluation
      this._emitAsyncBlockValue(node, frame, (f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        this._emitLine('let output = [];');

        this.compile(node.body, f);//write to output

        this._emitLine('await astate.waitAllClosures(1)');
        this._emitLine(`let ${res} = runtime.flattentBuffer(output);`);
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res, node.body);
    }
    else {
      this._emitLine('(function() {');
      this._emitLine('let output = "";');
      this._withScopedSyntax(() => {
        this.compile(node.body, frame);
      });
      this._emitLine('return output;');
      this._emitLine('})()');
    }

    // and of course, revert back to the old buffer id
    this.buffer = buffer;
  }

  compileOutput(node, frame) {
    const children = node.children;
    children.forEach(child => {
      // TemplateData is a special case because it is never
      // autoescaped, so simply output it for optimization
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          // Position node is the TemplateData node itself
          this._emitAddToBuffer(node, frame, function () {
            this.compileLiteral(child, frame);
          }, child); // Pass TemplateData as position
        }
      } else {
        // Use the specific child expression node for position
        frame = this._emitAsyncBlockAddToBufferBegin(node, frame, child);
        this._emit(`${node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);

        if (this.throwOnUndefined) {
          this._emit(`${node.isAsync ? 'await runtime.ensureDefinedAsync(' : 'runtime.ensureDefined('}`);
        }
        this._compileExpression(child, frame);
        if (this.throwOnUndefined) {
          // Use child position for ensureDefined error
          this._emit(`,${child.lineno},${child.colno})`);
        }
        // Use child position for suppressValue error
        this._emit(', env.opts.autoescape);\n');
        frame = this._emitAsyncBlockAddToBufferEnd(node, frame, child); // Pass Output node as op, child as pos
      }
    });
  }

  // Retrieves the direct child AST nodes of a given node in their
  // semantically significant order, as defined by the node's `fields` property
  // which is also the order they are rendered
  /*_getImmediateChildren(node) {
    const children = [];
    for (const fieldName of node.fields) { // For NodeList, fieldName will be 'children'
      const fieldValue = node[fieldName];  // fieldValue will be the actual array of child nodes

      if (fieldValue instanceof nodes.Node) {
        children.push(fieldValue);
      } else if (Array.isArray(fieldValue)) {
        // If the field is an array, iterate through it and add any Node instances.
        // This handles cases like NodeList.children or Compare.ops
        for (const item of fieldValue) {
          if (item instanceof nodes.Node) {
            children.push(item);
          }
        }
      }
    }
    return children;
  }*/

  // Retrieves the direct child AST nodes of a given nodebby iterating over all properties
  // and checking if they are instances of nodes.Node or arrays of nodes.Node
  _getImmediateChildren(node) {
    const children = [];

    for (const key in node) {
      if (Array.isArray(node[key])) {
        // If the field is an array, iterate through it and add any Node instances
        node[key].forEach(item => {
          if (item instanceof nodes.Node) {
            children.push(item);
          }
        });
      }
      else if (node[key] instanceof nodes.Node) {
        // If the field is a Node instance, add it
        children.push(node[key]);
      }
    }

    return children;
  }

  //in async mode: store node.isAsync=true if the node or a child node performs async operations
  //when !OPTIMIZE_ASYNC - all nodes are treated as async
  /*_propagateIsAsync(node) {
    let hasAsync = this.asyncMode ? !OPTIMIZE_ASYNC || asyncOperationNodes.has(node.typename) : false;

    for (const key in node) {
      if (Array.isArray(node[key])) {
        node[key].forEach(item => {
          if (item && typeof item === 'object') {
            const childHasAsync = this.propagateIsAsync(item);
            hasAsync = this.asyncMode ? hasAsync || childHasAsync : false;
          }
        });
      }
      else if (typeof node[key] === 'object' && node[key] !== null) {
        const childHasAsync = this.propagateIsAsync(node[key]);
        hasAsync = this.asyncMode ? hasAsync || childHasAsync : false;
      }
    }

    if (node.typename) {
      node.isAsync = hasAsync;
    }
    return hasAsync;
  }*/

  //when !OPTIMIZE_ASYNC - all nodes are treated as async
  _propagateIsAsync(node) {
    let hasAsync = this.asyncMode ? !OPTIMIZE_ASYNC || asyncOperationNodes.has(node.typename) : false;

    // Get immediate children using the _getImmediateChildren method
    const children = this._getImmediateChildren(node);

    // Process each child node
    for (const child of children) {
      const childHasAsync = this._propagateIsAsync(child);
      hasAsync = this.asyncMode ? hasAsync || childHasAsync : false;
    }

    node.isAsync = hasAsync;
    return hasAsync;
  }

  _declareSequentialLocks(node, sequenceLockFrame) {
    // Get immediate children using the _getImmediateChildren method
    const children = this._getImmediateChildren(node);

    // Process each child node
    for (const child of children) {
      this._declareSequentialLocks(child, sequenceLockFrame);
    }

    if (node.typename === 'FunCall') {
      const key = this._getSequenceKey(node.name, sequenceLockFrame);
      if (key) {
        this._addDeclaredVar(sequenceLockFrame, key);
      }
    }
  }

  compileRoot(node, frame) {

    if (frame) {
      this.fail('compileRoot: root node can\'t have frame', node.lineno, node.colno, node);
    }

    frame = this.asyncMode ? new AsyncFrame() : new Frame();

    if (this.asyncMode) {
      this._propagateIsAsync(node);
      this._declareSequentialLocks(node, frame.sequenceLockFrame);
    }

    this._emitFuncBegin(node, 'root');
    this._emitLine('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (node.isAsync) {
      this._emitLine('let isIncluded = !!(frame.parent || frame.isIncluded);');
      this._emitLine('if(!isIncluded){');
      this._emitLine('astate.waitAllClosures().then(() => {');
      this._emitLine('  if(parentTemplate) {');
      this._emitLine('    parentTemplate.rootRenderFunc(env, context, frame, runtime, astate, cb);');
      this._emitLine('  } else {');
      this._emitLine(`    cb(null, runtime.flattentBuffer(${this.buffer}));`);
      this._emitLine('  }');
      this._emitLine('}).catch(e => {');
      // Use static node position for root catch in async mode
      // Do NOT pass errorContext here
      this._emitLine(`cb(runtime.handleError(e, ${node.lineno}, ${node.colno}))`);
      this._emitLine('});');
      this._emitLine('} else {');
      this._emitLine('if(parentTemplate) {');
      this._emitLine('parentTemplate.rootRenderFunc(env, context, frame, runtime, astate, cb);');
      this._emitLine('} else {');
      this._emitLine(`cb(null, ${this.buffer});`);
      this._emitLine('}');
      this._emitLine('}');
    }
    else {
      this._emitLine('if(parentTemplate) {');
      this._emitLine(`parentTemplate.rootRenderFunc(env, context, frame, runtime, ${this.asyncMode ? 'astate, ' : ''}cb);`);
      this._emitLine('} else {');
      if (this.asyncMode) {
        // This case (sync root in asyncMode) might be unlikely/problematic,
        // but keep flatten for consistency if it somehow occurs.
        this._emitLine(`cb(null, runtime.flattentBuffer(${this.buffer}));`);
      } else {
        this._emitLine(`cb(null, ${this.buffer});`);
      }
      this._emitLine('}');
    }

    // Pass the node to _emitFuncEnd for error position info (used in sync catch)
    this._emitFuncEnd(node, true);

    this.inBlock = true;

    const blockNames = [];

    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block, i) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);

      this._emitFuncBegin(block, `b_${name}`);

      let tmpFrame = frame.new();//new Frame();
      this._emitLine('var frame = frame.push(true);'); // Keep this as 'var', the codebase depends on the function-scoped nature of var for frame
      this.compile(block.body, tmpFrame);
      // Pass the block node to _emitFuncEnd
      this._emitFuncEnd(block);
    });

    this._emitLine('return {');

    blocks.forEach((block, i) => {
      const blockName = `b_${block.name.value}`;
      this._emitLine(`${blockName}: ${blockName},`);
    });

    this._emitLine('root: root\n};');
  }

  compile(node, frame, pathFlags = PathFlags.NONE) {
    var _compile = this['compile' + node.typename];
    if (_compile) {
      _compile.call(this, node, frame, pathFlags | node.pathFlags);
    } else {
      this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno, node);
    }
  }

  compileAwaited(node, frame) {
    if (node.isAsync) {
      this._emit('(await ');
      this.compile(node, frame);
      this._emit(')');
    } else {
      this.compile(node, frame);
    }
  }

  //todo - optimize, check for much more than literal
  _compileAwaitedExpression(node, frame) {
    if (node.isAsync) {
      this._emit('(await ');
      this._compileExpression(node, frame);
      this._emit(')');
    } else {
      this._compileExpression(node, frame);
    }
  }

  _compileExpression(node, frame) {
    // TODO: I'm not really sure if this type check is worth it or
    // not.
    this.assertType(
      node,
      nodes.Literal,
      nodes.Symbol,
      nodes.Group,
      nodes.Array,
      nodes.Dict,
      nodes.FunCall,
      nodes.Caller,
      nodes.Filter,
      nodes.LookupVal,
      nodes.Compare,
      nodes.InlineIf,
      nodes.In,
      nodes.Is,
      nodes.And,
      nodes.Or,
      nodes.Not,
      nodes.Add,
      nodes.Concat,
      nodes.Sub,
      nodes.Mul,
      nodes.Div,
      nodes.FloorDiv,
      nodes.Mod,
      nodes.Pow,
      nodes.Neg,
      nodes.Pos,
      nodes.Compare,
      nodes.NodeList
    );
    if (node.isAsync && this.asyncClosureDepth === 0) {
      //this will change in the future - only if a child node need the frame
      this.fail('All expressions must be wrapped in an async IIFE', node.lineno, node.colno, node);
    }
    if (node.isAsync) {
      const f = new AsyncFrame();
      // copy declaredVars from frame to f, but only properties that start with `!`
      // these are the keys of the active sequence locks
      // copy because we don't want any added sequence lock keys to be used in the compilation
      //@todo - do we still add sequence lock keys? Don't think so but we need to check @todo
      if (frame.declaredVars) {
        f.declaredVars = new Set();
        for (const item of frame.declaredVars) {
          if (item.startsWith('!')) {
            f.declaredVars.add(item);
          }
        }
      }
      this._assignAsyncBlockWrappers(node, f);
      this._pushAsyncWrapDownTree(node);
    }
    this.compile(node, frame);
  }

  _assignAsyncBlockWrappers(node, frame) {
    node.sequenceOperations = new Map();
    if (node instanceof nodes.Symbol || node instanceof nodes.LookupVal) {
      //path - Determine if currentNode has a sequence locked static path
      let pathKey = this._extractStaticPathKey(node);
      if (pathKey) {
        // currentNode is a Symbol or LookupVal accessing a potentially locked path.
        // This represents the *read* operation on that path.
        node.sequencePathKey = pathKey;
        node.sequenceOperations.set(pathKey, SequenceOperationType.PATH);
      }
    } else if (node instanceof nodes.FunCall) {
      //call - Determin if the call has a sequence lock (`!` in the path)
      let lockKey = this._getSequenceKey(node.name, frame);
      if (lockKey) {
        // currentNode is a FunCall with '!'
        // This represents the *write* operation on that lock.
        node.sequenceLockKey = lockKey;
        node.sequenceOperations.set(lockKey, SequenceOperationType.LOCK);
      }
    }

    const children = this._getImmediateChildren(node);
    for (const child of children) {
      this._assignAsyncBlockWrappers(child, frame);
      if (!child.sequenceOperations) {
        continue;
      }
      for (const [key, childValue] of child.sequenceOperations) {
        //if any operation has a lock (including 2 locks) - it is contended
        const parentValue = node.sequenceOperations.get(key);
        if (parentValue === undefined || (parentValue === childValue && parentValue !== SequenceOperationType.LOCK)) {
          node.sequenceOperations.set(key, childValue);
        } else {
          node.sequenceOperations.set(key, SequenceOperationType.CONTENDED);
        }
      }
    }

    if (node.sequenceOperations.size === 0) {
      node.sequenceOperations = null;
      return;
    }

    //wrap the contended keys in async blocks at child nodes that are not contended
    for (const [key, value] of node.sequenceOperations) {
      if (value === SequenceOperationType.CONTENDED) {
        for (const child of children) {
          if (child.sequenceOperations && child.sequenceOperations.has(key)) {
            this._asyncWrapKey(child, key);
          }
        }
      }
    }
  };

  //wrap the first child nodes where the key is not contended
  _asyncWrapKey(node, key) {
    const type = node.sequenceOperations.get(key);
    if (type !== SequenceOperationType.CONTENDED) {
      node.wrapInAsyncBlock = true;
      return;
    }
    for (const child of this._getImmediateChildren(node)) {
      if (child.sequenceOperations && child.sequenceOperations.has(key)) {
        this._asyncWrapKey(child, key);
      }
    }
    node.sequenceOperations.delete(key);
    if (node.sequenceOperations.size === 0) {
      delete node.sequenceOperations;
    }
  }

  //if the node has no lock or path of it's own and only one child has all the same keys
  //move the async wrap to that child
  _pushAsyncWrapDownTree(node) {
    const children = this._getImmediateChildren(node);
    if (node.sequenceOperations && node.wrapInAsyncBlock && !node.sequenceLockKey && !node.sequencePathKey) {
      let childWithKeys = null;
      let childWithKeysCount = 0;
      for (const child of children) {
        const sop = child.sequenceOperations;
        if (!sop) {
          continue;
        }
        for (const key of node.sequenceOperations.keys()) {
          if (sop.has(key)) {
            childWithKeys = child;
            childWithKeysCount++;
            break;
          }
        }
        if (childWithKeysCount > 1) {
          childWithKeys = null;
          break;
        }
      }
      if (childWithKeys) {
        //only one child has all the same keys
        //move the async wrap to that child (it may already be wrapped)
        node.wrapInAsyncBlock = false;
        childWithKeys.wrapInAsyncBlock = true;
      }
    }
    for (const child of children) {
      this._pushAsyncWrapDownTree(child);
    }
  }

  getCode() {
    return this.codebuf.join('');
  }

  compileDo(node, frame) {
    if (node.isAsync) {
      // Use the Do node itself for the outer async block position
      this._emitAsyncBlock(node, frame, false, (f) => {
        const promisesVar = this._tmpid();
        this._emitLine(`let ${promisesVar} = [];`);
        node.children.forEach((child) => {
          // Position node for individual expressions is the child itself
          const resultVar = this._tmpid();
          this._emitLine(`let ${resultVar} = `);
          // Expressions inside DO shouldn't be wrapped in another IIFE,
          // but if they were async, their results (promises) need handling.
          // We compile them directly here.
          this._compileExpression(child, f);
          this._emitLine(';');
          // We only push actual promises to the wait list
          this._emitLine(`if (${resultVar} && typeof ${resultVar}.then === 'function') ${promisesVar}.push(${resultVar});`);
        });
        this._emitLine(`if (${promisesVar}.length > 0) {`);
        this._emitLine(`  await Promise.all(${promisesVar});`);
        this._emitLine(`}`);
      }, node); // Pass Do node as positionNode for the overall block
      //this._emitLine(';'); // Removed semicolon after block
    } else {
      node.children.forEach(child => {
        this._compileExpression(child, frame);
        this._emitLine(';');
      });
    }
  }
}

module.exports = {
  compile: function compile(src, asyncFilters, extensions, name, isAsync, opts = {}) {
    AsyncFrame.inCompilerContext = true;
    if (typeof isAsync === 'object') {
      opts = isAsync;
      isAsync = false;
    }
    const c = new Compiler(name, opts.throwOnUndefined, isAsync);

    // Run the extension preprocessors against the source.
    const preprocessors = (extensions || []).map(ext => ext.preprocess).filter(f => !!f);

    const processedSrc = preprocessors.reduce((s, processor) => processor(s), src);

    c.compile(transformer.transform(
      parser.parse(processedSrc, extensions, opts),
      asyncFilters,
      name
    ));
    AsyncFrame.inCompilerContext = false;
    return c.getCode();
  },

  Compiler: Compiler
};
