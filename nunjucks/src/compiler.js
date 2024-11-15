'use strict';

const parser = require('./parser');
const transformer = require('./transformer');
const nodes = require('./nodes');
const {TemplateError} = require('./lib');
const {Frame, AsyncFrame} = require('./runtime');
const {Obj} = require('./object');

const CONDITIONAL_AWAIT = true;//awaiting a non-promise value is slow and should be avoided

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
  init(templateName, throwOnUndefined, isAsync) {
    this.templateName = templateName;
    this.codebuf = [];
    this.lastId = 0;
    this.buffer = null;
    this.bufferStack = [];
    this._scopeClosers = '';
    this.inBlock = false;
    this.throwOnUndefined = throwOnUndefined;
    this.isAsync = isAsync;
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
    if (this.isAsync) {
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

  _emitFuncBegin(node, name) {
    this.buffer = 'output';
    this._scopeClosers = '';
    if (this.isAsync) {
      this._emitLine(`function ${name}(env, context, frame, runtime, astate, cb) {`);
    } else {
      this._emitLine(`function ${name}(env, context, frame, runtime, cb) {`);
    }
    this._emitLine(`let lineno = ${node.lineno};`);
    this._emitLine(`let colno = ${node.colno};`);
    // this._emitLine(`let ${this.buffer} = "";`);
    if (this.isAsync) {
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

  // wrap await calls in this, maybe we should only astate.enterClosure(frame)/leaveClosure()
  // the async blocks
  _emitAwait(emitFunc) {
    if (this.isAsync) {
      this._emit('(await ');
    }
    emitFunc();
    if (this.isAsync) {
      this._emit(')');
    }
  }

  // an async block that does not have a value should be wrapped in this
  _emitAsyncBlockBegin() {
    if (this.isAsync) {
      this._emitLine(`(async (astate)=>{`);
      this._emitLine('let frame = astate.snapshotFrame;');
      this.asyncClosureDepth++;
    }
  }

  _emitAsyncBlockEnd(finalBlockFunction = null) {
    if (this.isAsync) {
      this._emitLine('astate.leaveClosure();');
      if(finalBlockFunction) {
        finalBlockFunction.call(this);
      }
      this.asyncClosureDepth--;
      this._emitLine(`})(astate.enterClosure(frame.snapshot()))`);
      this._emitLine('.catch(e=>{cb(runtime.handleError(e, lineno, colno))});');
    }
  }

  //@todo - option whether it's ok to return a promise
  _emitAsyncValue(emitFunc, res) {
    if (this.isAsync) {
      //this._emitLine(`${this.asyncClosureDepth > 0 ? 'await ' : ''}`);//do not await if not in an async block
      this._emitLine(`(async (astate)=>{`);
      this._emitLine('let frame = astate.snapshotFrame;');
      if(res===undefined) {
        res = this._tmpid();
        this._emitLine(`let ${res} = `);
      }

      this.asyncClosureDepth++;

      emitFunc();

      this._emitLine(';');
      this._emitLine('astate.leaveClosure();');
      this._emitLine(`return ${res};`);
      this._emitLine(`})(astate.enterClosure(frame.snapshot()))`);
      this.asyncClosureDepth--;
      // The error will be re-thrown when the ewturned value is awaited:
      //this._emitLine('.catch(e=>{cb(runtime.handleError(e, lineno, colno))})');
    }
    else {
      emitFunc();
    }
  }

  _emitAsyncRenderClosure(innerBodyFunction, callbackName = null) {
    if(!this.isAsync) {
      const id = this._pushBuffer();
      innerBodyFunction.call(this);
      this._popBuffer();
      if(callbackName) {
        this._emitLine(`${callbackName}(null, ${id});`);
      }
      this._emitLine(`return ${id};`);
      return;
    }

    this._emitLine(`(async (astate)=>{`);
    this._emitLine('let frame = astate.snapshotFrame;');

    const id = this._pushBuffer();//@todo - probably not needed after snapshots?

    const originalAsyncClosureDepth = this.asyncClosureDepth;
    this.asyncClosureDepth = 0;

    innerBodyFunction.call(this);

    this.asyncClosureDepth = originalAsyncClosureDepth;

    //this._emitLine(';');
    this._popBuffer();

    this._emitLine('astate.leaveClosure();');
    this._emitLine('await astate.waitAllClosures();');
    this._emitLine(`${id} = runtime.flattentBuffer(${id});`);

    //return via callback or directly
    if(callbackName) {
      this._emitLine(`${callbackName}(null, ${id});`);
    }
    this._emitLine(`return ${id};`);

    this._emitLine(`})(astate.enterClosure(frame.snapshot()))`);

    if(callbackName){
      this._emitLine(`.catch(e=>{${callbackName}(runtime.handleError(e, lineno, colno))});`);
    }
    //in the non-callback case, using the rendered buffer will throw the error
  }

  _emitAddToBuffer(renderFunction) {
    const returnId = this._tmpid();
    if (this.isAsync) {
        this.asyncClosureDepth++;
        this._emitLine(`(async (astate)=>{`);
        this._emitLine('let frame = astate.snapshotFrame;');
        this._emitLine(`let index = ${this.buffer}_index++;`);

        this._emitLine(`let ${returnId};`);
        renderFunction.call(this, returnId);
        this._emitLine(';');
        this._emit(`${this.buffer}[index] = ${returnId};`);

        this.asyncClosureDepth--;
        this._emitLine(';astate.leaveClosure();');
        this._emitLine(`})(astate.enterClosure(frame.snapshot()))`);
        this._emitLine('.catch(e=>{cb(runtime.handleError(e, lineno, colno))});');

    } else {
      this._emitLine(`let ${returnId};`);
      renderFunction.call(this, returnId);
      this._emit(`${this.buffer} += ${returnId};`);
    }
  }

  _emitAddToBufferBegin(addClosure = true) {
    if (this.isAsync) {
      if (addClosure) {
        this._emitLine(`(async (astate)=>{`);
        this._emitLine('let frame = astate.snapshotFrame;');

        this._emitLine(`let index = ${this.buffer}_index++;`);
        this._emit(`${this.buffer}[index] = `);//@todo - ${this.buffer}[${this.buffer}_index++], else line
        this.asyncClosureDepth++;
      } else {
        this._emitLine(`${this.buffer}[${this.buffer}_index++] = `);
      }
    } else {
      this._emit(`${this.buffer} += `);
    }
  }

  _emitAddToBufferEnd(addClosure = true) {
    this._emitLine(';');
    if (this.isAsync && addClosure) {
      this.asyncClosureDepth--;
      this._emitLine('astate.leaveClosure();');
      this._emitLine(`})(astate.enterClosure(frame.snapshot()))`);
      this._emitLine('.catch(e=>{cb(runtime.handleError(e, lineno, colno))});');
    }
  }

  _emitBufferBlockBegin() {
    if (this.isAsync) {
      // Start the async closure
      this._emitAsyncBlockBegin();

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
      // No need to update bufferIndex; we'll use `${this.buffer}_index` when needed
    }
  }

  _emitBufferBlockEnd() {
    if (this.isAsync) {
      // End the async closure
      this._emitAsyncBlockEnd();

      // Restore the previous buffer from the stack
      this.buffer = this.bufferStack.pop();
    }
  }

  //awaiting a non-promise value is slow and should be avoided
  _emitAwaitIfPromiseVar(varName) {
    if(CONDITIONAL_AWAIT) {
      this._emitLine(`\n((${varName} && typeof ${varName}.then === 'function') ? await ${varName} : ${varName})`);
    } else {
      this._emitLine(`\nawait ${varName}`);
    }
  }

  _emitAwaitIfPromiseVoid(code) {
    if (CONDITIONAL_AWAIT) {
        const tempVar = this._tmpid();  // Generate a unique temporary variable
        // Start a block to handle the conditional await logic
        this._emitLine(`{ let ${tempVar} = ${code};`);
        this._emitLine(`if (${tempVar} && typeof ${tempVar}.then === 'function') { await ${tempVar}; }`);
    } else {
        // In case of regular await, emit the standard await directly
        this._emitLine(`await ${code}`);
    }
  }

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

  _compileAggregate(node, frame, startChar, endChar) {
    if (startChar) {
      this._emit(startChar);
    }

    node.children.forEach((child, i) => {
      if (i > 0) {
        this._emit(',');
      }

      this.compile(child, frame);
    });

    if (endChar) {
      this._emit(endChar);
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
    this.compile(node, frame);
  }

  assertType(node, ...types) {
    if (!types.some(t => node instanceof t)) {
      this.fail(`assertType: invalid type: ${node.typename}`, node.lineno, node.colno);
    }
  }

  /**
   * CallExtension - no callback, can return either value or promise
   * CallExtensionAsync - uses callback, async = true
   * CallExtensionParallel - parameters can be promises, can return either value or promise, parallel = true
   */
  compileCallExtension(node, frame, async, parallel) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async || parallel;//assign the return value directly, no callback

    parallel = parallel && this.isAsync;

    if (noExtensionCallback || this.isAsync) {
      const ext = this._tmpid();
      this._emitLine(`let ${ext} = env.getExtension("${node.extName}");`);

      this._emitAddToBufferBegin();
      this._emit(this.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
      if(noExtensionCallback) {
        //the extension returns a value directly
        if(!this.isAsync || parallel) {
          //send the arguments as they are - promises or values
          this._emit(`${ext}["${node.prop}"](context`);
        }
        else {
          //async but not parallel - resolve the arguments before calling the function
          this._emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
        }
      } else {
        //isAsync, the callback should be promisified
        this._emit(`runtime.promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
      }
    } else {
      //use the original nunjucks callback mechanism
      this._emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
    }

    if (args || contentArgs) {
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
        this._compileExpression(arg, frame);

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
          if(parallel) {
            //in parallel mode, the contentArgs are promises
            this._emitAsyncRenderClosure( function() {
              this.compile(arg, frame);
            });
          }
          else {
            //in non-paralle mode, the contentArgs are callback functions
            this._emitLine('function(cb) {');
            this._emitLine('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this._withScopedSyntax(() => {
              this._emitAsyncRenderClosure( function() {
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

    if (noExtensionCallback || this.isAsync) {
      this._emit(`)`);//close the extension call
      this._emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
      this._emitAddToBufferEnd();
    } else {
      const res = this._tmpid();
      this._emitLine(', ' + this._makeCallback(res));
      this._emitAddToBufferBegin();
      this._emit(`${this.isAsync ? 'await runtime.suppressValueAsync' : 'runtime.suppressValue'}(${res}, ${autoescape} && env.opts.autoescape);`);
      this._emitAddToBufferEnd();

      this._addScopeLevel();
    }
  }

  compileCallExtensionAsync(node, frame) {
    this.compileCallExtension(node, frame, true);
  }

  compileCallExtensionParallel(node, frame) {
    this.compileCallExtension(node, frame, true, true);
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
      if(this.isAsync) {
        this._emit(`(await ${v})`);
      } else {
        this._emit(v);
      }
    } else {
      // @todo - omit this for function calls?
      // (parent instanceof nodes.FunCall && parent.name === node)
      this._emitAwait( ()=>{
        this._emit('runtime.contextOrFrameLookup(' +
          'context, frame, "' + name + '")');
      });
    }
  }

  compileGroup(node, frame) {
    this._compileAggregate(node, frame, '(', ')');
  }

  compileArray(node, frame) {
    this._compileAggregate(node, frame, '[', ']');
  }

  compileDict(node, frame) {
    this._compileAggregate(node, frame, '{', '}');
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
    this._emit('(');
    this.compile(node.cond, frame);
    this._emit('?');
    this.compile(node.body, frame);
    this._emit(':');
    if (node.else_ !== null) {
      this.compile(node.else_, frame);
    } else {
      this._emit('""');
    }
    this._emit(')');
  }

  compileIn(node, frame) {
    this._emit('runtime.inOperator(');
    this.compile(node.left, frame);
    this._emit(',');
    this.compile(node.right, frame);
    this._emit(')');
  }

  compileIs(node, frame) {
    // first, we need to try to get the name of the test function, if it's a
    // callable (i.e., has args) and not a symbol.
    var right = node.right.name
      ? node.right.name.value
      // otherwise go with the symbol value
      : node.right.value;
    this._emit('env.getTest("' + right + '").call(context, ');
    this.compile(node.left, frame);
    // compile the arguments for the callable if they exist
    if (node.right.args) {
      this._emit(',');
      this.compile(node.right.args, frame);
    }
    this._emit(') === true');
  }

  _binOpEmitter(node, frame, str) {
    this.compile(node.left, frame);
    this._emit(str);
    this.compile(node.right, frame);
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
    this._emit('!');
    this.compile(node.target, frame);
  }

  compileFloorDiv(node, frame) {
    this._emit('Math.floor(');
    this.compile(node.left, frame);
    this._emit(' / ');
    this.compile(node.right, frame);
    this._emit(')');
  }

  compilePow(node, frame) {
    this._emit('Math.pow(');
    this.compile(node.left, frame);
    this._emit(', ');
    this.compile(node.right, frame);
    this._emit(')');
  }

  compileNeg(node, frame) {
    this._emit('-');
    this.compile(node.target, frame);
  }

  compilePos(node, frame) {
    this._emit('+');
    this.compile(node.target, frame);
  }

  compileCompare(node, frame) {
    this.compile(node.expr, frame);

    node.ops.forEach((op) => {
      this._emit(` ${compareOps[op.type]} `);
      this.compile(op.expr, frame);
    });
  }

  compileLookupVal(node, frame) {
    this._emitAwait( ()=>{
      this._emit('runtime.memberLookup((');
      this._compileExpression(node.target, frame);
      this._emit('),');
      this._compileExpression(node.val, frame);
      this._emit(')');
    });
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
    // Keep track of line/col info at runtime by settings
    // variables within an expression. An expression in javascript
    // like (x, y, z) returns the last value, and x and y can be
    // anything
    //this._emitAsyncValue(()=>{
      this._emit('(lineno = ' + node.lineno +
        ', colno = ' + node.colno + ', ');

      this._emitAwait( ()=>{
        this._emit('runtime.callWrap(');
        // Compile it as normal.
        this._compileExpression(node.name, frame);

        // Output the name of what we're calling so we can get friendly errors
        // if the lookup fails.
        this._emit(', "' + this._getNodeName(node.name).replace(/"/g, '\\"') + '", context, ');

        this._compileAggregate(node.args, frame, '[', '])');

        this._emit(')');
      });
    //});
  }

  //@todo - in isAsync mode, the filter may return a promise
  compileFilter(node, frame) {
    var name = node.name;

    //this._emitAwaitBegin();
    this.assertType(name, nodes.Symbol);

    this._emit('env.getFilter("' + name.value + '").call(context, ');
    this._compileAggregate(node.args, frame);
    this._emit(')');

    //this._emitAwaitEnd();
  }

  compileFilterAsync(node, frame) {
    var name = node.name;
    var symbol = node.symbol.value;

    this.assertType(name, nodes.Symbol);

    frame.set(symbol, symbol);

    if (this.isAsync) {
        const res = this._tmpid();
        this._emit(`let ${symbol} = `);
        this._emitAsyncValue( () => {
          const argsArray = this._tmpid();
          this._emitLine(`let ${argsArray} = `);

          //@todo - do not resolve if only literal
          this._compileAggregate(node.args, frame, '[', ']');//todo - short path for 1 argument - 99% of the cases, test multiarg, incl async
          this._emitLine(';');
          this._emitLine(`await runtime.resolveAll(${argsArray});`);

          // Promisify the filter call
          this._emitLine(`let ${res} = await runtime.promisify(env.getFilter("${name.value}").bind(env))(...${argsArray});`);

        }, res);
        this._emitLine(';');
    } else {
        this._emit('env.getFilter("' + name.value + '").call(context, ');
        this._compileAggregate(node.args, frame);
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
      }

      ids.push(id);
    });

    if (node.value) {
      this._emit(ids.join(' = ') + ' = ');
      if(this.isAsync) {
        this._emitAsyncValue( () => {
          this._compileExpression(node.value, frame);
        });
      }
      else{
        this._compileExpression(node.value, frame);
      }
      this._emitLine(';');
    } else {
      // set block
      this._emit(ids.join(' = ') + ' = ');
      this._emitAsyncValue( () => {
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

  compileSwitch(node, frame) {
    this._emitBufferBlockBegin();

    this._emit('switch (');
    this.compile(node.expr, frame);
    this._emit(') {');
    node.cases.forEach((c, i) => {
      this._emit('case ');
      this.compile(c.cond, frame);
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

    this._emitBufferBlockEnd();
  }

  compileIf(node, frame, async) {
    this._emitBufferBlockBegin();

    this._emit('if(');
    this._compileExpression(node.cond, frame);
    this._emitLine(') {');

    this._withScopedSyntax(() => {
      this.compile(node.body, frame);

      if (async) {
        this._emit('cb()');
      }
    });

    if (node.else_) {
      this._emitLine('}\nelse {');

      this._withScopedSyntax(() => {
        this.compile(node.else_, frame);

        if (async) {
          this._emit('cb()');
        }
      });
    } else if (async) {
      this._emitLine('}\nelse {');
      this._emit('cb()');
    }

    this._emitLine('}');

    this._emitBufferBlockEnd();
  }

  compileIfAsync(node, frame) {
    if(this.isAsync) {
      this.compileIf(node, frame);
    } else {
      this._emit('(function(cb) {');
      this.compileIf(node, frame, true);
      this._emit('})(' + this._makeCallback());
      this._addScopeLevel();
    }
  }

  _emitLoopBindings(node, arr, i, len) {
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

  compileFor(node, frame, serialAsync=false) {
    // Some of this code is ugly, but it keeps the generated code
    // as fast as possible. ForAsync also shares some of this, but
    // not much.

    this._emitBufferBlockBegin();

    const i = this._tmpid();
    const len = this._tmpid();
    const arr = this._tmpid();
    frame = frame.push();

    this._emitLine('frame = frame.push();');

    this._emit(`let ${arr} = `);
    this._compileExpression(node.arr, frame);
    this._emitLine(';');
    this._emitLine(`let ${len};`);

    this._emit(`if(${arr}) {`);
    this._emitLine(arr + ' = runtime.fromIterator(' + arr + ');');

    // If multiple names are passed, we need to bind them
    // appropriately
    if (node.name instanceof nodes.Array) {
      this._emitLine(`let ${i};`);

      // The object could be an array or object. Note that the
      // body of the loop is duplicated for each condition, but
      // we are optimizing for speed over size.
      this._emitLine(`if(runtime.isArray(${arr})) {`);
      this._emitLine(`${len} = ${arr}.length;`);
      this._emitLine(`for(${i}=0; ${i} < ${arr}.length; ${i}++) {`);

      if (this.isAsync && !serialAsync) {
        this._emitLine('frame = frame.push();');
        this._emitBufferBlockBegin();
      }

      // Bind each declared var
      node.name.children.forEach((child, u) => {
        let tid = this._tmpid();
        this._emitLine(`let ${tid} = ${arr}[${i}][${u}];`);
        this._emitLine(`frame.set("${child.value}", ${tid});`);// fixed nunjucks bug with array unpacking
        frame.set(node.name.children[u].value, tid);
      });

      this._emitLoopBindings(node, arr, i, len);
      this._withScopedSyntax(() => {
        this.compile(node.body, frame);
      });

      if (this.isAsync && !serialAsync) {
        this._emitBufferBlockEnd();
        this._emitLine('frame = frame.pop();');
      }

      this._emitLine('}');
      this._emitLine('} else {');
      // Iterate over the key/values of an object
      const [key, val] = node.name.children;
      const k = this._tmpid();
      const v = this._tmpid();
      frame.set(key.value, k);
      frame.set(val.value, v);

      this._emitLine(`${i} = -1;`);
      this._emitLine(`${len} = runtime.keys(${arr}).length;`);
      this._emitLine(`for(let ${k} in ${arr}) {`);

      if (this.isAsync) {
        this._emitLine('frame = frame.push();');
        this._emitBufferBlockBegin();
      }

      this._emitLine(`${i}++;`);
      this._emitLine(`let ${v} = ${arr}[${k}];`);
      this._emitLine(`frame.set("${key.value}", ${k});`);
      this._emitLine(`frame.set("${val.value}", ${v});`);

      this._emitLoopBindings(node, arr, i, len);
      this._withScopedSyntax(() => {
        this.compile(node.body, frame);
      });

      if (this.isAsync) {
        this._emitBufferBlockEnd();
        this._emitLine('frame = frame.pop();');
      }

      this._emitLine('}');

      this._emitLine('}');
    } else {
      // Generate a typical array iteration
      const v = this._tmpid();
      frame.set(node.name.value, v);

      this._emitLine(`${len} = ${arr}.length;`);
      this._emitLine(`for(let ${i}=0; ${i} < ${arr}.length; ${i}++) {`);

      if (this.isAsync) {
        this._emitLine('frame = frame.push();');
        this._emitBufferBlockBegin();
      }

      this._emitLine(`let ${v} = ${arr}[${i}];`);
      this._emitLine(`frame.set("${node.name.value}", ${v});`);

      this._emitLoopBindings(node, arr, i, len);

      this._withScopedSyntax(() => {
        this.compile(node.body, frame);
      });

      if (this.isAsync) {
        this._emitBufferBlockEnd();
        this._emitLine('frame = frame.pop();');
      }

      this._emitLine('}');
    }

    this._emitLine('}');
    if (node.else_) {
      this._emitLine(`if (!${len}) {`);
      this._emitBufferBlockBegin();
      this.compile(node.else_, frame);
      this._emitBufferBlockEnd();
      this._emitLine('}');
    }

    this._emitLine('frame = frame.pop();');
    this._emitBufferBlockEnd();
  }

  _compileAsyncLoop(node, frame, parallel) {
    if(this.isAsync) {
      this.compileFor(node, frame, true);
      return;
    }
    // This shares some code with the For tag, but not enough to
    // worry about. This iterates across an object asynchronously,
    // but not in parallel.
    let i, len, arr, asyncMethod;

    if( this.isAsync ) {
      this.compileFor(node, frame);//, !parallel); - @todo - implement serialAsync
      return;
    }

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

    this._emitLoopBindings(node, arr, i, len);

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
      this._emitLine(this.buffer + ' += ' + output + ';');
    }

    if (node.else_) {
      this._emitLine('if (!' + arr + '.length) {');
      this.compile(node.else_, frame);
      this._emitLine('}');
    }

    this._emitLine('frame = frame.pop();');
  }

  compileAsyncEach(node, frame) {
    this._compileAsyncLoop(node, frame);
  }

  compileAsyncAll(node, frame) {
    this._compileAsyncLoop(node, frame, true);
  }

  _compileMacro(node, frame) {
    var args = [];
    var kwargs = null;
    var funcId = 'macro_' + this._tmpid();
    var keepFrame = (frame !== undefined);

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
      currFrame = this.isAsync ? new AsyncFrame() : new Frame();
    }
    this._emitLines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${argNames.join(', ')}], `,
      `[${kwargNames.join(', ')}], `,
      `function (${realNames.join(', ')}) {`,
      'let callerFrame = frame;',
      'frame = ' + ((keepFrame) ? 'frame.push(true);' : 'frame.new();'),
      'kwargs = kwargs || {};',
      'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      'frame.set("caller", kwargs.caller); }');

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
    this._emitLine(`return ${this.isAsync?'runtime.newSafeStringAsync':'new runtime.SafeString'}(${bufferId});`);
    this._emitLine('});');
    this._popBuffer();

    return funcId;
  }

  compileMacro(node, frame) {
    var funcId = this._compileMacro(node);

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
    const funcId = this._compileMacro(node, frame);
    this._emit(`return ${funcId};})()`);
  }

  //todo - detect when _compileExpression outputs a literal and _emitAsyncValue is not needed
  _compileGetTemplate(node, frame, eagerCompile, ignoreMissing) {
    const parentTemplateId = this._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    if (this.isAsync) {
      const getTemplateFunc = this._tmpid();
      this._emitLine(`const ${getTemplateFunc} = runtime.promisify(env.getTemplate.bind(env));`);
      this._emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);

      //getTemplate accepts promise names, todo - optimize for literals
      this._emitAsyncValue( () => {
        this._compileExpression(node.template, frame);
      });

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
    const id = this._compileGetTemplate(node, frame, false, false);

    if (this.isAsync) {
      const res = this._tmpid();
      this._emit(`${id} = `);
      this._emitAsyncValue( () => {
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
    const importedId = this._compileGetTemplate(node, frame, false, false);

    if (this.isAsync) {
      const res = this._tmpid();
      this._emit(`${importedId} = `);
      this._emitAsyncValue(() => {
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

      if (this.isAsync) {
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

  compileBlock(node) {
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

    if(this.isAsync) {
      this._emitAddToBuffer( (id)=> {
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
      this._emitLine(`${this.buffer} += ${id};`);
      this._addScopeLevel();
    }
  }

  compileSuper(node, frame) {
    var name = node.blockName.value;
    var id = node.symbol.value;

    if(this.isAsync) {
      this._emitLine(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);
    }
    else{
      const cb = this._makeCallback(id);
      this._emitLine(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this._emitLine(`${id} = runtime.markSafe(${id});`);

    if(!this.isAsync) {
      this._addScopeLevel();
    }
    frame.set(id, id);
  }

  compileExtends(node, frame) {
    var k = this._tmpid();

    if(this.isAsync) {
      this._emitLine('context.prepareForAsyncBlocks();');
    }

    const parentTemplateId = this._compileGetTemplate(node, frame, true, false);

    // extends is a dynamic tag and can occur within a block like
    // `if`, so if this happens we need to capture the parent
    // template in the top-level scope

    if(this.isAsync) {
      this._emitAsyncBlockBegin();
    }

    //isAsync: set the global parent template, compileRoot will use it after waitAllClosures
    this._emitLine(`parentTemplate = ${this.isAsync?'await ':''}${parentTemplateId};`);

    this._emitLine(`for(let ${k} in parentTemplate.blocks) {`);
    this._emitLine(`context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this._emitLine('}');

    if (!this.isAsync) {
      this._addScopeLevel();
    }
    else {
      this._emitLine('context.finsihsAsyncBlocks()');
      this._emitAsyncBlockEnd();
    }
  }

  compileInclude(node, frame) {
    if(!this.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    this._emitAddToBuffer( (resultVar)=> {
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
      this._emitLine(`${resultVar} = await runtime.promisify(${templateVar}.render.bind(${templateVar}))(context.getVariables(), frame${this.isAsync ? ', astate' : ''});`);
    });
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this._emitLine('let tasks = [];');
    this._emitLine('tasks.push(');
    this._emitLine('function(callback) {');

    this._emitAsyncBlockBegin();
    const id = this._compileGetTemplate(node, frame, false, node.ignoreMissing);
    this._emitLine(`callback(null,${id});});`);
    this._emitAsyncBlockEnd();

    this._emitLine('});');

    const id2 = this._tmpid();
    this._emitLine('tasks.push(');
    this._emitLine('function(template, callback){');
    this._emitLine('template.render(context.getVariables(), frame, ' + (this.isAsync ? 'astate,' : '') + this._makeCallback(id2));
    this._emitLine('callback(null,' + id2 + ');});');
    this._emitLine('});');

    this._emitLine('tasks.push(');
    this._emitLine('function(result, callback){');
    this._emitAddToBufferBegin(false);
    // this._emitLine(`${this.buffer} += result;`);
    this._emitLine(`result;`);
    this._emitAddToBufferEnd(false);
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
    if(this.isAsync) {
      this._emitAsyncBlockBegin();
      this._emitLine('let output = [];');
      this.compile(node.body, frame);
      this._emitAsyncBlockEnd(()=>{
        this._emitLine('await astate.waitAllClosures()');
        this._emitLine(`return runtime.flattentBuffer(output);`);
        //todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      });
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
          this._emitAddToBufferBegin(false);
          // this._emit(`${this.buffer} += `);
          this.compileLiteral(child, frame);
          this._emitAddToBufferEnd(false);
          this._emitLine(';');
        }
      } else {
        this._emitAddToBufferBegin();
        this._emit(`${this.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);

        if (this.throwOnUndefined) {
          this._emit(`${this.isAsync ? 'await runtime.ensureDefinedAsync(' : 'runtime.ensureDefined('}`);
        }
        this.compile(child, frame);
        if (this.throwOnUndefined) {
          this._emit(`,${node.lineno},${node.colno})`);
        }
        this._emit(', env.opts.autoescape);\n');
        this._emitAddToBufferEnd();
      }
    });
  }

  compileRoot(node, frame) {
    if (frame) {
      this.fail('compileRoot: root node can\'t have frame');
    }

    frame = new Frame();

    this._emitFuncBegin(node, 'root');
    this._emitLine('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (this.isAsync) {
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
      this._emitLine('parentTemplate.rootRenderFunc(env, context, frame, runtime, cb);');
      this._emitLine('} else {');
      this._emitLine(`cb(null, ${this.buffer});`);
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

      let tmpFrame = new Frame();
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

  getCode() {
    return this.codebuf.join('');
  }
}

module.exports = {
  compile: function compile(src, asyncFilters, extensions, name, isAsync, opts = {}) {
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
    return c.getCode();
  },

  Compiler: Compiler
};
