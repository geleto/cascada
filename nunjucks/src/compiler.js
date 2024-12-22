'use strict';

const parser = require('./parser');
const transformer = require('./transformer');
const nodes = require('./nodes');
const {TemplateError} = require('./lib');
const {Frame, AsyncFrame} = require('./runtime');
const {Obj} = require('./object');

const OPTIMIZE_ASYNC = true;//optimize async operations

// these are nodes that may perform async operations even if their children do not
const asyncOperationNodes = new Set([
  //expression nodes
  'LookupVal', 'Symbol', 'FunCall', 'Filter', 'Caller', 'CallExtension', 'CallExtensionAsync', 'Is',
  //control nodes that can be async even if their children are not
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

  fail(msg, lineno, colno) {
    if (lineno !== undefined) {
      lineno += 1;
    }
    if (colno !== undefined) {
      colno += 1;
    }

    throw new TemplateError(msg, lineno, colno);
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
    this.codebuf.splice(pos, 0, code);
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
    }
    this._emitLine(`let lineno = ${node.lineno};`);
    this._emitLine(`let colno = ${node.colno};`);
    // this._emitLine(`let ${this.buffer} = "";`);
    if (this.asyncMode) {
      this._emit(`let ${this.buffer} = []; let ${this.buffer}_index = 0;`);
    } else {
      this._emit(`let ${this.buffer} = "";`);
    }
    this._emitLine('try {');
  }

  _emitFuncEnd(noReturn) {
    if (!noReturn) {
      this._emitLine('cb(null, ' + this.buffer + ');');
    }

    this._closeScopeLevels();
    this._emitLine('} catch (e) {');
    this._emitLine('  cb(runtime.handleError(e, lineno, colno));');
    this._emitLine('}');
    this._emitLine('}');
    this.buffer = null;
  }

  _emitAsyncBlock( node, frame, createScope, emitFunc){
    const aframe = this._emitAsyncBlockBegin(node, frame, createScope);
    emitFunc(aframe);
    this._emitAsyncBlockEnd(node, aframe, createScope);
  }

  // an async block that does not have a value should be wrapped in this
  //@todo - maybe this should be replced by _emitBufferBlockBegin, so that each async block has a buffer
  _emitAsyncBlockBegin( node, frame, createScope ) {
    if (node.isAsync) {
      this._emitLine(`(async (astate) => {`);
      this._emitLine('try {');
      this._emitLine('let frame = astate.asyncBlockFrame;');
      this.asyncClosureDepth++;
    }
    if(createScope && !node.isAsync){
      this._emitLine('frame = frame.push();');
    }
    if(createScope || node.isAsync){
      //unscoped frames are only used in async blocks
      return frame.push(false, createScope);
    }
    return frame;
  }

  _emitAsyncBlockEnd( node, frame, createScope ) {
    if (node.isAsync) {
      this.asyncClosureDepth--;
      this._emitLine(`} catch (e) {`);
      this._emitLine(`  cb(runtime.handleError(e, lineno, colno));`);
      this._emitLine(`} finally {`);
      this._emitLine('  astate.leaveAsyncBlock();');

      this._emitLine(`}`);
      this._emitLine(`})(astate.enterAsyncBlock(frame.pushAsyncBlock(${this._getSnapshotArguments(frame)})));`);
    }
    if(createScope && !node.isAsync){
      this._emitLine('frame = frame.pop();');
    }
    if(createScope || node.isAsync){
      return frame.pop();
    }
    return frame;
  }

  //@todo - do this only if a child is using frame
  _emitAsyncValue( node, frame, emitFunc, res) {
    if (node.isAsync) {
      frame = this._emitAsyncValueBegin( node, frame );
      if (res === undefined) {
        res = this._tmpid();
        this._emitLine(`  let ${res} = `);
      }
      emitFunc(frame);
      this._emitLine(';');
      this._emitLine('  return ' + res + ';');
      this._emitAsyncValueEnd( node, frame );
    } else {
      emitFunc(frame);
    }
  }

  _emitAsyncValueBegin( node, frame ) {
    if (node.isAsync) {
      this._emitLine(`(async (astate) => {`);
      this._emitLine('try {');
      this._emitLine('  let frame = astate.asyncBlockFrame;');
      this.asyncClosureDepth++;
      return frame.push(false, false);
    }
    return frame;
  }

  _emitAsyncValueEnd( node, frame ) {
    if (node.isAsync) {
      this._emitLine(`} catch (e) {`);
      this._emitLine('  cb(runtime.handleError(e, lineno, colno));');
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      this._emitLine(`})(astate.enterAsyncBlock(frame.pushAsyncBlock(${this._getSnapshotArguments(frame)})))`);
      this.asyncClosureDepth--;
      return frame.pop();
    }
    return frame;
  }

  _emitAsyncRenderClosure( node, frame, innerBodyFunction, callbackName = null) {
    if(!node.isAsync) {
      const id = this._pushBuffer();
      innerBodyFunction.call(this, frame);
      this._popBuffer();
      if(callbackName) {
        this._emitLine(`${callbackName}(null, ${id});`);
      }
      this._emitLine(`return ${id};`);
      return;
    }

    this._emitLine(`(async (astate)=>{`);
    this._emitLine('try {');
    this._emitLine('let frame = astate.asyncBlockFrame;');

    const id = this._pushBuffer();//@todo - better way to get the buffer, see compileCapture

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;

    frame = frame.push(false, false);//unscoped frame for the async block
    innerBodyFunction.call(this, frame);
    frame = frame.pop();

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
    this._emitLine(`} catch (e) {`);
    if (callbackName) {
      this._emitLine(`  ${callbackName}(runtime.handleError(e, lineno, colno));`);
    } else {
      this._emitLine('  cb(runtime.handleError(e, lineno, colno));');
    }
    this._emitLine('} finally {');
    this._emitLine('  astate.leaveAsyncBlock();');
    this._emitLine('}');
    this._emitLine(`})(astate.enterAsyncBlock(frame.pushAsyncBlock(${this._getSnapshotArguments(frame)})))`);
    //in the non-callback case, using the rendered buffer will throw the error
  }

  _emitAddToBuffer( node, frame, renderFunction) {
    const returnId = this._tmpid();
    if (node.isAsync) {
      this.asyncClosureDepth++;
      this._emitLine(`(async (astate)=>{`);
      this._emitLine('try {');
      this._emitLine('let frame = astate.asyncBlockFrame;');
      this._emitLine(`let index = ${this.buffer}_index++;`);

      this._emitLine(`let ${returnId};`);
      renderFunction.call(this, returnId);
      this._emitLine(';');
      this._emit(`${this.buffer}[index] = ${returnId};`);

      this.asyncClosureDepth--;
      this._emitLine('} catch (e) {');
      this._emitLine('  cb(runtime.handleError(e, lineno, colno));');
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      this._emitLine(`})(astate.enterAsyncBlock(frame.pushAsyncBlock(${this._getSnapshotArguments(frame)})));`);

    } else {
      this._emitLine(`let ${returnId};`);
      renderFunction.call(this, returnId);
      if(this.asyncMode) {
        this._emit(`${this.buffer}[index] = ${returnId};`);
      } else {
        this._emit(`${this.buffer} += ${returnId};`);
      }
    }
  }

  _emitAddToBufferBegin(node, frame, addClosure = true) {
    if (node.isAsync) {
      if (addClosure) {
        this._emitLine(`(async (astate)=>{`);
        this._emitLine('try {');
        this._emitLine('let frame = astate.asyncBlockFrame;');
        this._emitLine(`let index = ${this.buffer}_index++;`);
        this._emit(`${this.buffer}[index] = `);
        this.asyncClosureDepth++;
      } else {
        this._emitLine(`${this.buffer}[${this.buffer}_index++] = `);
      }
    } else {
      if(this.asyncMode) {
        this._emitLine(`${this.buffer}[${this.buffer}_index++] = `);
      } else {
        this._emit(`${this.buffer} += `);
      }
    }
  }

  _emitAddToBufferEnd(node, frame, addClosure = true) {
    this._emitLine(';');
    if (node.isAsync && addClosure) {
      this.asyncClosureDepth--;
      this._emitLine('} catch (e) {');
      this._emitLine('  cb(runtime.handleError(e, lineno, colno));');
      this._emitLine('} finally {');
      this._emitLine('  astate.leaveAsyncBlock();');
      this._emitLine('}');
      this._emitLine(`})(astate.enterAsyncBlock(frame.pushAsyncBlock(${this._getSnapshotArguments(frame)})))`);
    }
  }

  _emitBufferBlockBegin(node, frame, createScope) {
    if (node.isAsync) {
      // Start the async closure
      frame = this._emitAsyncBlockBegin( node, frame, createScope );

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
    return null;
  }

  _emitBufferBlockEnd(node, frame, createScope) {
    if (node.isAsync) {
      // End the async closure
      frame = this._emitAsyncBlockEnd( node, frame, createScope );

      // Restore the previous buffer from the stack
      this.buffer = this.bufferStack.pop();
      return frame;
    } else if (createScope){
      frame = frame.pop();
      this._emitLine('frame = frame.pop();');
      return frame;
    }
    return null;
  }

  //awaiting a non-promise value is slow and should be avoided
  /*_emitAwaitIfPromiseVar(varName) {
    if(OPTIMIZE_ASYNC) {
      this._emitLine(`\n((${varName} && typeof ${varName}.then === 'function') ? await ${varName} : ${varName})`);
    } else {
      this._emitLine(`\nawait ${varName}`);
    }
  }

  _emitAwaitIfPromiseVoid(code) {
    if (OPTIMIZE_ASYNC) {
        const tempVar = this._tmpid();  // Generate a unique temporary variable
        // Start a block to handle the conditional await logic
        this._emitLine(`{ let ${tempVar} = ${code};`);
        this._emitLine(`if (${tempVar} && typeof ${tempVar}.then === 'function') { await ${tempVar}; }`);
    } else {
        // In case of regular await, emit the standard await directly
        this._emitLine(`await ${code}`);
    }
  }*/

  _addScopeLevel() {
    this._scopeClosers += '})';
  }

  _closeScopeLevels() {
    this._emitLine(this._scopeClosers + ';');
    this._scopeClosers = '';
  }

  _withScopedSyntax(func) {
    var _scopeClosers = this._scopeClosers;
    this._scopeClosers = '';


    func.call(this);

    this._closeScopeLevels();
    this._scopeClosers = _scopeClosers;
  }

  _makeCallback(res) {
    var err = this._tmpid();

    return 'function(' + err + (res ? ',' + res : '') + ') {\n' +
      'if(' + err + ') { cb(' + err + '); return; }';
  }

  _tmpid() {
    this.lastId++;
    return 't_' + this.lastId;
  }

  _templateName() {
    return this.templateName == null ? 'undefined' : JSON.stringify(this.templateName);
  }

  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  //todo
  _compileFunctionAggregate(node, frame, funcName) {
    this._compileAggregate(node, frame, '[', ']', true, true, function(result) {
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
            for(let i = 0; i < node.children.length; i++) {
              if(i > 0) {
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
        this._emit(`.then(${asyncThen?'async ':''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this._emit(' })');
      }
    } else {
      if (compileThen) {
        const result = this._tmpid();
        this._emitLine(`(${asyncThen?'async ':''}function(${result}){`);
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
      this.fail(`assertType: invalid type: ${node.typename}`, node.lineno, node.colno);
    }
  }

  /**
   * CallExtension - no callback, can return either value or promise
   * CallExtensionAsync - uses callback, async = true. This was the way to handle the old nunjucks async
   * @todo - rewrite with _emitAggregate
   */
  compileCallExtension(node, frame, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async;//assign the return value directly, no callback
    var resolveArgs = node.resolveArgs && node.isAsync;

    if (noExtensionCallback || node.isAsync) {
      const ext = this._tmpid();
      this._emitLine(`let ${ext} = env.getExtension("${node.extName}");`);

      this._emitAddToBufferBegin( node, frame );
      this._emit(node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
      if(noExtensionCallback) {
        //the extension returns a value directly
        if(!resolveArgs) {
          //send the arguments as they are - promises or values
          this._emit(`${ext}["${node.prop}"](context`);
        }
        else {
          //resolve the arguments before calling the function
          this._emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
        }
      } else {
        //isAsync, the callback should be promisified
        if(!resolveArgs) {
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
        this.fail('compileCallExtension: arguments must be a NodeList, ' +
          'use `parser.parseSignature`');
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
          if(node.isAsync && !resolveArgs) {
            //when args are not resolved, the contentArgs are promises
            this._emitAsyncRenderClosure( node, frame, function() {
              this.compile(arg, frame);
            });
          }
          else {
            //when not resolve args, the contentArgs are callback functions
            this._emitLine('function(cb) {');
            this._emitLine('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this._withScopedSyntax(() => {
              this._emitAsyncRenderClosure( node, frame, function() {
                this.compile(arg, frame);
              }, 'cb');
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
      this._emitAddToBufferEnd(node, frame);
    } else {
      const res = this._tmpid();
      this._emitLine(', ' + this._makeCallback(res));
      this._emitAddToBufferBegin( node, frame );
      this._emit(`${node.isAsync ? 'await runtime.suppressValueAsync' : 'runtime.suppressValue'}(${res}, ${autoescape} && env.opts.autoescape);`);
      this._emitAddToBufferEnd(node, frame);

      this._addScopeLevel();
    }
  }

  compileCallExtensionAsync(node, frame) {
    this.compileCallExtension(node, frame, true);
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

  compileSymbol(node, frame) {
    var name = node.value;
    var v = frame.lookup(name);

    if (v) {
      //for now the only places that set async symbol are the async filter and super()
      this._emit(v);
    } else {
      // @todo - omit this for function calls?
      // (parent instanceof nodes.FunCall && parent.name === node)
      this._emit('runtime.contextOrFrameLookup(' +
        'context, frame, "' + name + '")');
    }
  }

  compileGroup(node, frame) {
    this._compileAggregate(node, frame, '(', ')', true, true);
  }

  compileArray(node, frame) {
    this._compileAggregate(node, frame, '[', ']', true, true);
  }

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
        key.colno);
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
    this._emit(node.isAsync ? '})'  : ')');
  }

  compileIn(node, frame) {
    this._binFuncEmitter(node, frame, 'runtime.inOperator');
  }

  compileIs(node, frame) {
    const testName = node.right.name ? node.right.name.value : node.right.value;
    const testFunc = `env.getTest("${testName}")`;

    if (node.isAsync) {
      const mergedNode = {
        isAsync: node.left.isAsync || node.right.isAsync,
        children: (node.right.args && node.right.args.children.length > 0) ? [node.left, ...node.right.args.children] : [node.left]
      };
      // Resolve the left-hand side and arguments (if any)
      this._compileAggregate(mergedNode, frame, '[', ']', true, true, function(args){
        this._emitLine(`  const testFunc = ${testFunc};`);
        this._emitLine(`  if (!testFunc) { throw new Error("test not found: ${testName}"); }`);
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
      this._emit(`) : (function() { throw new Error("test not found: ${testName}"); })())`);
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
      this._emit(').then(async function([expr, ref1]){');
      this._emit(`return expr ${compareOps[node.ops[0].type]} ref1`);
      node.ops.forEach((op, index) => {
        if(index>0) {
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

  compileLookupVal(node, frame) {
    this._emit(`runtime.memberLookup${node.isAsync?'Async':''}((`);
    this.compile(node.target, frame);
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

  compileFunCall(node, frame) {
    // Keep track of line/col info at runtime by setting
    // variables within an expression. An expression in JavaScript
    // like (x, y, z) returns the last value, and x and y can be
    // anything.
    this._emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');

    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');

    if (node.isAsync) {
      let asyncName = node.name.isAsync;
      if(node.name.typename === 'Symbol' && !frame.lookup(node.name.value)) {
        asyncName = false;
      }
      asyncName = true;
      if (!asyncName) {
        //this probably never happens because the name of the function can come from a variable
        //which is set to async value and it's very hard to know if this is the case at compile time
        // {% set asyncFunc = getAsyncFunction() %}
        // {{ asyncFunc(arg1, arg2) }}
        // Function name is not async, so resolve only the arguments.
        this._compileAggregate(node.args, frame, '[', ']', true, false, function(result){
          this._emit(`return runtime.callWrap(`);
          this.compile(node.name, frame);
          this._emitLine(`, "${funcName}", context, ${result});`);
        }); // Resolve arguments using _compileAggregate.
      } else {
        // Function name is dynamic, so resolve both function and arguments.
        // In async mode, resolve the function and arguments in parallel.

        const mergedNode = {
          isAsync: node.name.isAsync || node.args.isAsync,
          children: (node.args.children.length > 0) ? [node.name, ...node.args.children] : [node.name]
        };

        this._compileAggregate(mergedNode, frame, '[', ']', true, false, function(result){
          this._emit(`return runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);
        });
      }
      this._emitLine(')');//(lineno, ...
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
      const filterGetNode = {value:name.value, typename:'FilterGet'};
      const mergedNode = {
        isAsync: true,
        children: [filterGetNode, ...node.args.children]
      };
      this._compileAggregate(mergedNode, frame, '[', ']', true, false, function(result){
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
      this._emitAsyncValue( node.args, frame, () => {
        //@todo - do this only if a child uses frame, from within _emitAsyncValue
        //@todo - this should be done with _compileExpression in the future
        this._compileAggregate(node.args, frame, '[', ']', true, false, function(result){
          this._emit(`return runtime.promisify(env.getFilter("${name.value}").bind(env))(...${result});`);
        });
      });
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

      if(this.asyncMode) {
        this._updateFrameWrites(frame, name);
      }
    });

    if (node.value) {
      this._emit(ids.join(' = ') + ' = ');
      if(node.isAsync) {
        this._emitAsyncValue( node.value, frame, () => {
          //@todo - do this only if a child uses frame, from within _emitAsyncValue
          this.compile(node.value, frame);
          this._emitLine(';');
        });
      } else {
        this._compileExpression(node.value, frame);
        this._emitLine(';');
      }
    } else {
      // set block
      this._emit(ids.join(' = ') + ' = ');
      this._emitAsyncValue( node.body, frame, () => {
        this.compile(node.body, frame);
        this._emitLine(';');
      });
    }

    node.targets.forEach((target, i) => {
      var id = ids[i];
      var name = target.value;

      // We are running this for every var, but it's very
      // uncommon to assign to multiple vars anyway
      this._emitLine(`frame.set("${name}", ${id}, true);`);

      this._emitLine('if(frame.topLevel) {');
      this._emitLine(`context.setVariable("${name}", ${id});`);
      this._emitLine('}');

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
    do {
      if( vf.declaredVars && vf.declaredVars.has(name) ) {
        break;//found the var in vf
      }
      if(vf.isolateWrites) {
        vf = null;
        break;
      }
      vf = vf.parent;
    }
    while( vf );

    if(!vf) {
      //declare a new variable in the current frame
      if(!frame.declaredVars) {
        frame.declaredVars = new Set();
      }
      frame.declaredVars.add(name);
      vf = frame;
    }

    //store the writes down the scope chain, but stop before the vf frame
    while( frame!==vf ) {
      frame.writeCounts = frame.writeCounts || {};//@todo - only async block pushAsyncBlock frames
      frame.writeCounts[name] = frame.writeCounts[name]? frame.writeCounts[name] + 1 : 1;

      frame = frame.parent;
    }
  }

  //returns the arguments as string
  //@todo - reenterWriteCounters
  _getSnapshotArguments(frame) {
    return frame.writeCounts? JSON.stringify(frame.writeCounts) : '';
  }

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    this._emitBufferBlockBegin(node, frame);

    this._emit('switch (');
    this._compileAwaitedExpression(node.expr, frame);
    this._emit(') {');
    node.cases.forEach((c, i) => {
      this._emit('case ');
      this._compileAwaitedExpression(c.cond, frame);
      this._emit(': ');
      this.compile(c.body, frame);
      // preserve fall-throughs
      if (c.body.children.length) {
        this._emitLine('break;');
      }
    });
    if (node.default) {
      this._emit('default:');
      this.compile(node.default, frame);
    }
    this._emit('}');

    this._emitBufferBlockEnd(node, frame);
  }

  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if(this.asyncMode && node.isAsync) {
      async = false;//old type of async
    }

    frame = this._emitBufferBlockBegin(node, frame);

    let trueBranchWriteCounts, falseBranchWriteCounts;
    let trueBranchCodePos;

    this._emit('if(');
    this._compileAwaitedExpression(node.cond, frame);
    this._emit('){');

    if(this.asyncMode) {
      this._emitAsyncBlock(node.body, frame, false, (f)=>{
        this.compile(node.body, f);
        trueBranchWriteCounts = f.writeCounts;
      })
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

    if (node.else_) {
      if(this.asyncMode) {
        this._emitAsyncBlock(node.else_, frame, false, (f)=>{
          if(trueBranchWriteCounts) {
            //skip the true branch writes in the false branch
            this._emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
          }
          falseBranchWriteCounts = f.writeCounts;
          this.compile(node.else_, f);
        })
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
      if(this.asyncMode && trueBranchWriteCounts) {
        this._emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
      }
      if (async && !this.asyncMode) {
        this._emit('cb()');
      }
    }

    this._emit('}');

    if(falseBranchWriteCounts){
      //skip the false branch writes in the true branch code
      this._emitInsertLine(trueBranchCodePos, `runtime.skipBranchWrites(${JSON.stringify(falseBranchWriteCounts)});`);
    }

    frame = this._emitBufferBlockEnd(node, frame);
  }

  compileIfAsync(node, frame) {
    if(node.isAsync) {
      this.compileIf(node, frame);
    } else {
      this._emit('(function(cb) {');
      this.compileIf(node, frame, true);
      this._emit('})(' + this._makeCallback());
      this._addScopeLevel();
    }
  }

  //@todo - in asyncMode each loop body is in separate context even if !node.isAsync
  compileFor(node, frame) {
    // Some of this code is ugly, but it keeps the generated code
    // as fast as possible. ForAsync also shares some of this, but
    // not much.

    //@todo - if node.arr is not async - we can create the buffer block without async block in it and just push the frame
    //each iteration will creates it's own pushAsyncBlock anyway
    frame = this._emitBufferBlockBegin(node, frame, true);

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
      });
    } else {
      loopVars.push(node.name.value);
      frame.set(node.name.value, node.name.value);
    }

    // Define the loop body function
    const loopBodyFunc = this._tmpid();
    this._emit(`let ${loopBodyFunc} = `);

    // Function declaration based on async mode
    if (node.isAsync) {
      this._emit('async function(');
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
    this._emit(`, ${loopIndex}, ${loopLength}) {`);

    // Begin buffer block for the loop body
    this._emitBufferBlockBegin(node, frame);

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

    // Set loop bindings
    this._emitLoopBindings(loopIndex, loopLength);

    // Compile the loop body with the updated frame
    this._withScopedSyntax(() => {
      this.compile(node.body, frame);
    });

    // End buffer block for the loop body
    this._emitBufferBlockEnd(node, frame);

    // Close the loop body function
    this._emitLine('};');

    // Define the else function if it exists
    let elseFuncId = 'null';
    if (node.else_) {
      elseFuncId = this._tmpid();
      this._emit(`let ${elseFuncId} = `);

      // Function declaration based on async mode
      if (node.isAsync) {
        this._emit('async function() {');
      } else {
        this._emit('function() {');
      }

      // Begin buffer block for the else block
      this._emitBufferBlockBegin(node, frame);
      this.compile(node.else_, frame);
      this._emitBufferBlockEnd(node, frame);

      this._emitLine('};');
    }

    // Call the runtime loop function
    this._emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFunc}, ${elseFuncId}, frame, {loopVars: [`);
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this._emit(', ');
      }
      this._emit(`"${varName}"`);
    });
    this._emit(`], async: ${node.isAsync}});`);

    // End buffer block for the node
    frame = this._emitBufferBlockEnd(node, frame, true);
  }

  _emitAsyncLoopBindings(node, arr, i, len) {
    const bindings = [
      {name: 'index', val: `${i} + 1`},
      {name: 'index0', val: i},
      {name: 'revindex', val: `${len} - ${i}`},
      {name: 'revindex0', val: `${len} - ${i} - 1`},
      {name: 'first', val: `${i} === 0`},
      {name: 'last', val: `${i} === ${len} - 1`},
      {name: 'length', val: len},
    ];

    bindings.forEach((b) => {
      this._emitLine(`frame.set("loop.${b.name}", ${b.val});`);
    });
  }

  _emitLoopBindings(i, len) {
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
    if(node.isAsync) {
      this.compileFor(node, frame, true);
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
        this._emitLine(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this._emitLine(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
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
      if(this.asyncMode) {
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
    if(!keepFrame) {
      this._emitLine('let callerFrame = frame;');//@todo - only if !keepFrame
    }
    this._emitLines(
      'frame = ' + ((keepFrame) ? 'frame.push(true);' : 'frame.new();'),
      'kwargs = kwargs || {};',
      'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      'frame.set("caller", kwargs.caller); }'
    );

    let err = this._tmpid();
    if(node.isAsync) {
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
    });

    // Expose the keyword arguments
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        this._emit(`frame.set("${name}", `);
        this._emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
        this._emit(` ? kwargs["${name}"] : `);
        this._compileExpression(pair.value, currFrame);
        this._emit(');');
      });
    }

    const bufferId = this._pushBuffer();

    this._withScopedSyntax(() => {
      this.compile(node.body, currFrame);
    });

    this._emitLine('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));
    //return the buffer, in async mode it may not be ready yet
    //this._emitLine(`return ${node.isAsync?'runtime.newSafeStringAsync':'new runtime.SafeString'}(${bufferId});`);
    this._emitLine('return ' + (
      node.isAsync?
      `astate.waitAllClosures().then(() => {if (${err}) throw ${err}; return runtime.newSafeStringAsync(${bufferId});}).catch(error => Promise.reject(error));`:
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

  _compileGetTemplate(node, frame, eagerCompile, ignoreMissing, asyncWrap) {
    const parentTemplateId = this._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    if (node.isAsync) {
      const getTemplateFunc = this._tmpid();
      this._emitLine(`const ${getTemplateFunc} = runtime.promisify(env.getTemplate.bind(env));`);
      this._emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      if (asyncWrap) {
        this._emitAsyncValue( node.template, frame, () => {
          this._compileExpression(node.template, frame);
        });
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
    const id = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this._emit(`${id} = `);
      this._emitAsyncValue( node, frame, () => {
        this._emitLine(`let ${res} = await ${id};`);
        this._emitLine(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${
          node.withContext
            ? `context.getVariables(), frame, astate`
            : `null, null, astate`
        });`);
      }, res);
    } else {
      this._addScopeLevel();
      this._emitLine(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(id));
      this._addScopeLevel();
    }

    frame.set(target, id);

    if (frame.parent) {
      this._emitLine(`frame.set("${target}", ${id});`);
    } else {
      this._emitLine(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    const importedId = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this._emit(`${importedId} = `);
      this._emitAsyncValue( node, frame, () => {
        this._emitLine(`let ${res} = await ${importedId};`);
        this._emitLine(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${
          node.withContext
            ? `context.getVariables(), frame, astate`
            : `null, null, astate`
        });`);
      }, res);
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

      if (node.isAsync) {
        //@todo - error handling in the async() function
        this._emitLine(`${id} = (async () => {`);
        this._emitLine(`  let exported = await ${importedId};`);
        this._emitLine(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this._emitLine(`    return exported["${name}"];`);
        this._emitLine(`  } else {`);
        this._emitLine(`    throw new Error("cannot import '${name}'");`);
        this._emitLine(`  }`);
        this._emitLine(`})();`);
      } else {
        this._emitLine(`if(Object.prototype.hasOwnProperty.call(${importedId}, "${name}")) {`);
        this._emitLine(`${id} = ${importedId}.${name};`);
        this._emitLine('} else {');
        this._emitLine(`cb(new Error("cannot import '${name}'")); return;`);
        this._emitLine('}');
      }

      frame.set(alias, id);

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

    if(node.isAsync) {
      this._emitAddToBuffer( node, frame, (id)=> {
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
      });
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

      if(this.asyncMode) {
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

    if(node.isAsync) {
      this._emitLine(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);
    }
    else{
      const cb = this._makeCallback(id);
      this._emitLine(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this._emitLine(`${id} = runtime.markSafe(${id});`);

    if(!node.isAsync) {
      this._addScopeLevel();
    }
    frame.set(id, id);
  }

  compileExtends(node, frame) {
    var k = this._tmpid();

    if(node.isAsync) {
      this._emitLine('context.prepareForAsyncBlocks();');
    }

    const parentTemplateId = this._compileGetTemplate(node, frame, true, false, true);

    // extends is a dynamic tag and can occur within a block like
    // `if`, so if this happens we need to capture the parent
    // template in the top-level scope

    if(node.isAsync) {
      this._emitAsyncBlockBegin( node, frame );
    }

    //isAsync: set the global parent template, compileRoot will use it after waitAllClosures
    this._emitLine(`parentTemplate = ${node.isAsync?'await ':''}${parentTemplateId};`);

    this._emitLine(`for(let ${k} in parentTemplate.blocks) {`);
    this._emitLine(`context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this._emitLine('}');

    if (!node.isAsync) {
      this._addScopeLevel();
    }
    else {
      this._emitLine('context.finsihsAsyncBlocks()');
      this._emitAsyncBlockEnd( node, frame );
    }
  }

  compileInclude(node, frame) {
    if(!node.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    this._emitAddToBuffer( node, frame, (resultVar)=> {
      // Get the template
      const templateVar = this._tmpid();
      const templateNameVar = this._tmpid();

      // Get the template name expression
      this._emit(`let ${templateNameVar} = `);
      this._compileExpression(node.template, frame);
      this._emitLine(';');

      // getTemplate
      this._emitLine(`let ${templateVar} = await runtime.promisify(env.getTemplate.bind(env))(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // render
      this._emitLine(`${resultVar} = await runtime.promisify(${templateVar}.render.bind(${templateVar}))(context.getVariables(), frame${node.isAsync ? ', astate' : ''});`);
    });
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
    this._emitAddToBufferBegin(node, frame, false);
    // this._emitLine(`${this.buffer} += result;`);
    this._emitLine(`result;`);
    this._emitAddToBufferEnd(node, frame, false);
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
    var buffer = this.buffer;
    this.buffer = 'output';
    if(node.isAsync) {
      let res = this._tmpid();
      this._emitAsyncValue( node.body, frame, () => {
        this._emitLine('let output = [];');

        this.compile(node.body, frame);//write to output

        this._emitLine('await astate.waitAllClosures(1)');
        this._emitLine(`let ${res} = runtime.flattentBuffer(output);`);
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res);
    }
    else{
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
          this._emitAddToBufferBegin(node, frame, false);
          // this._emit(`${this.buffer} += `);
          this.compileLiteral(child, frame);
          this._emitAddToBufferEnd(node, frame, false);
          this._emitLine(';');
        }
      } else {
        this._emitAddToBufferBegin(node, frame);
        this._emit(`${node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);

        if (this.throwOnUndefined) {
          this._emit(`${node.isAsync ? 'await runtime.ensureDefinedAsync(' : 'runtime.ensureDefined('}`);
        }
        this._compileExpression(child, frame);
        if (this.throwOnUndefined) {
          this._emit(`,${node.lineno},${node.colno})`);
        }
        this._emit(', env.opts.autoescape);\n');
        this._emitAddToBufferEnd(node, frame);
      }
    });
  }

  //in async mode: store node.isAsync=true if the node or a child node performs async operations
  //when !OPTIMIZE_ASYNC - all nodes are treated as async
  propagateIsAsync(node) {
    let hasAsync = this.asyncMode ? !OPTIMIZE_ASYNC || asyncOperationNodes.has(node.typename) : false;

    for (const key in node) {
      if (Array.isArray(node[key])) {
        node[key].forEach(item => {
          if(item && typeof item === 'object') {
            const childHasAsync = this.propagateIsAsync(item);
            hasAsync = this.asyncMode ? hasAsync || childHasAsync : false;
          }
        });
      }
      else if (typeof node[key] === 'object' && node[key] !== null) {
        const childHasAsync = this.propagateIsAsync(node[key]);
        hasAsync = this.asyncMode? hasAsync || childHasAsync : false;
      }
    }

    if(node.typename) {
      node.isAsync = hasAsync;
    }
    return hasAsync;
  }

  compileRoot(node, frame) {
    if(this.asyncMode) {
      this.propagateIsAsync(node);
    }

    if (frame) {
      this.fail('compileRoot: root node can\'t have frame');
    }

    frame = this.asyncMode? new AsyncFrame() : new Frame();

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
      this._emitLine('cb(runtime.handleError(e, lineno, colno))');
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
      this._emitLine(`parentTemplate.rootRenderFunc(env, context, frame, runtime, ${this.asyncMode?'astate, ':''}cb);`);
      this._emitLine('} else {');
      if(this.asyncMode) {
        this._emitLine(`cb(null, runtime.flattentBuffer(${this.buffer}));`);
      } else {
        this._emitLine(`cb(null, ${this.buffer});`);
      }
      this._emitLine('}');
    }

    this._emitFuncEnd(true);

    this.inBlock = true;

    const blockNames = [];

    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block, i) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        throw new Error(`Block "${name}" defined more than once.`);
      }
      blockNames.push(name);

      this._emitFuncBegin(block, `b_${name}`);

      let tmpFrame = frame.new();//new Frame();
      this._emitLine('var frame = frame.push(true);'); // Keep this as 'var', the codebase depends on the function-scoped nature of var for frame
      this.compile(block.body, tmpFrame);
      this._emitFuncEnd();
    });

    this._emitLine('return {');

    blocks.forEach((block, i) => {
      const blockName = `b_${block.name.value}`;
      this._emitLine(`${blockName}: ${blockName},`);
    });

    this._emitLine('root: root\n};');
  }

  compile(node, frame) {
    var _compile = this['compile' + node.typename];
    if (_compile) {
      _compile.call(this, node, frame);
    } else {
      this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno);
    }
  }

  compileAwaited(node, frame) {
    if(node.isAsync) {
      this._emit('(await ');
      this.compile(node, frame);
      this._emit(')');
    } else {
      this.compile(node, frame);
    }
  }

  //todo - optimize, check for much more than literal
  _compileAwaitedExpression(node, frame) {
    if(node.isAsync) {
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
    if(node.isAsync && this.asyncClosureDepth===0) {
      //this will change in the future - only if a child node need the frame
      throw new Error('All expressions must be wrapped in an async IIFE');
    }
    this.compile(node, frame, true);
  }

  getCode() {
    return this.codebuf.join('');
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
