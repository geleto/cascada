'use strict';

const parser = require('./parser');
const transformer = require('./transformer');
const nodes = require('./nodes');
const { TemplateError } = require('./lib');
const { Frame, AsyncFrame } = require('./runtime');
const { Obj } = require('./object');
const CompileSequential = require('./compile-sequential');
const CompileEmit = require('./compile-emit');

const OPTIMIZE_ASYNC = true;//optimize async operations

// PathFlags for path propagation
//@todo - use a variable instead of argument
const PathFlags = {
  NONE: 0,
  CALL: 1 << 0,
  CREATES_SEQUENCE_LOCK: 1 << 1,
  WAITS_FOR_SEQUENCE_LOCK: 1 << 2,
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
    this.inBlock = false;
    this.throwOnUndefined = throwOnUndefined;
    this.asyncMode = asyncMode;
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
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
      this.emit.Line(`let ${this.buffer} = []; let ${this.buffer}_index = 0;`);
    } else {
      this.emit.Line(`let ${this.buffer} = "";`);
    }
    return id;
  }

  _popBuffer() {
    this.buffer = this.bufferStack.pop();
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
      this.emit(`return ${funcName}(...${result})`);
    });
  }

  _compileAggregate(node, frame, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    let doResolve = resolveItems && this.asyncMode && node.isAsync && node.children.some(child => child.isAsync);
    if (doResolve) {
      switch (startChar) {
        case '[':
          if (node.children.length === 1) {
            //@todo - if compileThen resolveSingle and pass the value directly, similar with []
            this.emit('runtime.resolveSingleArr(');
            this._compileArguments(node, frame, expressionRoot, startChar);
            this.emit(')');
          } else if (node.children.length === 2) {
            this.emit('runtime.resolveDuo(');
            this._compileArguments(node, frame, expressionRoot, startChar);
            this.emit(')');
          } else {
            this.emit('runtime.resolveAll([');
            this._compileArguments(node, frame, expressionRoot, startChar);
            this.emit('])');
          }
          break;
        case '{':
          this.emit('runtime.resolveObjectProperties({');
          this._compileArguments(node, frame, expressionRoot, startChar);
          this.emit('})');
          break;
        case '(': {
          this.emit('runtime.resolveAll([');
          this._compileArguments(node, frame, expressionRoot, '[');
          this.emit(']).then(function(');
          const result = this._tmpid();
          this.emit(`${result}){ return (`);
          for (let i = 0; i < node.children.length; i++) {
            if (i > 0) {
              this.emit(',');
            }
            this.emit(`${result}[${i}]`);
          }
          this.emit('); })');
        }
          break;
      }

      if (compileThen) {
        const result = this._tmpid();
        this.emit(`.then(${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this.emit(' })');
      }
    } else {
      if (compileThen) {
        const result = this._tmpid();
        this.emit.Line(`(${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this.emit('})(');
        this.emit(startChar);
        this._compileArguments(node, frame, expressionRoot, startChar);
        this.emit(endChar + ')');
      } else {
        this.emit(startChar);
        this._compileArguments(node, frame, expressionRoot, startChar);
        this.emit(endChar);
      }
    }
  }

  _compileArguments(node, frame, expressionRoot, startChar) {
    node.children.forEach((child, i) => {
      if (i > 0) {
        this.emit(',');
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
      this.emit.Line(`let ${ext} = env.getExtension("${node.extName}");`);

      frame = this.emit.AsyncBlockAddToBufferBegin(node, frame, positionNode);
      this.emit(node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
      if (noExtensionCallback) {
        //the extension returns a value directly
        if (!resolveArgs) {
          //send the arguments as they are - promises or values
          this.emit(`${ext}["${node.prop}"](context`);
        }
        else {
          //resolve the arguments before calling the function
          this.emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
        }
      } else {
        //isAsync, the callback should be promisified
        if (!resolveArgs) {
          this.emit(`runtime.promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
        }
        else {
          this.emit(`runtime.resolveArguments(runtime.promisify(${ext}["${node.prop}"].bind(${ext})), 1)(context`);
        }
      }
    } else {
      //use the original nunjucks callback mechanism
      this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
    }

    if ((args && args.children.length) || contentArgs.length) {
      this.emit(',');
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
          this.emit(',');
        }
      });
    }

    if (contentArgs.length) {
      contentArgs.forEach((arg, i) => {
        if (i > 0) {
          this.emit(',');
        }

        if (arg) {
          if (node.isAsync && !resolveArgs) {
            //when args are not resolved, the contentArgs are promises
            this.emit.AsyncBlockRender(node, frame, function (f) {
              this.compile(arg, f);
            }, null, arg); // Use content arg node for position
          }
          else {
            //when not resolve args, the contentArgs are callback functions
            this.emit.Line('function(cb) {');
            this.emit.Line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this.emit._withScopedSyntax(() => {
              this.emit.AsyncBlockRender(node, frame, function (f) {
                this.compile(arg, f);
              }, 'cb', arg); // Use content arg node for position
              this.emit.Line(';');
            });

            this.emit.Line('}');//end callback
          }
        } else {
          this.emit('null');
        }
      });
    }

    if (noExtensionCallback || node.isAsync) {
      this.emit(`)`);//close the extension call
      this.emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
      frame = this.emit.AsyncBlockAddToBufferEnd(node, frame, positionNode);
    } else {
      const res = this._tmpid();
      this.emit.Line(', ' + this._makeCallback(res));
      frame = this.emit.AsyncBlockAddToBufferBegin(node, frame, positionNode);
      this.emit(`${node.isAsync ? 'await runtime.suppressValueAsync' : 'runtime.suppressValue'}(${res}, ${autoescape} && env.opts.autoescape);`);
      frame = this.emit.AsyncBlockAddToBufferEnd(node, frame, positionNode);

      this.emit._addScopeLevel();
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
      this.emit(`"${val}"`);
    } else if (node.value === null) {
      this.emit('null');
    } else {
      this.emit(node.value.toString());
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
      this.emit(v);
      return;
    }*/

    // Not in template scope, check context/frame with potential sequence lock
    if (this.asyncMode) {
      if (node.isCompilerInternal) {
        // This is a compiler-generated internal symbol (e.g., "hole_0").
        // Its `name` is the actual JavaScript variable name.
        // This variable might hold a Promise, which consuming code (like Output) will handle.
        this.emit(name);
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

      let nodeStaticPathKey = this.sequential._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame.sequenceLockFrame, nodeStaticPathKey)) {
        /*if (this._isDeclared(frame, node.value)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }*/
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
          this.emit(`runtime.sequencedContextLookup(context, frame, "${name}", ${JSON.stringify(nodeStaticPathKey)})`);
        };

        //if (!(pathFlags & (PathFlags.WAITS_FOR_SEQUENCE_LOCK | PathFlags.CALL))) {
        if (node.wrapInAsyncBlock) {
          // Wrap in an async block if pre-analysis determined it's necessary for contention.
          this.emit.AsyncBlockValue(node, frame, emitSequencedLookup, undefined, node);
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
        this.emit(v);
        return;
      }
    }
    this.emit('runtime.contextOrFrameLookup(' + 'context, frame, "' + name + '")');
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
    this.emit(': ');
    this._compileExpression(val, frame);
  }

  compileInlineIf(node, frame) {
    if (node.isAsync) {
      this.emit('runtime.resolveSingle');
    }
    this.emit('(');
    this.compile(node.cond, frame);
    if (node.isAsync) {
      this.emit(').then(async function(cond) { return cond');
    }
    this.emit('?');
    this.compile(node.body, frame);
    this.emit(':');
    if (node.else_ !== null) {
      this.compile(node.else_, frame);
    } else {
      this.emit('""');
    }
    this.emit(node.isAsync ? '})' : ')');
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
        this.emit.Line(`  const testFunc = ${testFunc};`);
        this.emit.Line(`  if (!testFunc) { throw runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}"); }`);
        this.emit.Line(`  const result = await testFunc.call(context, ${args}[0]`);
        if (node.right.args && node.right.args.children.length > 0) {
          this.emit.Line(`, ...${args}.slice(1)`);
        }
        this.emit.Line(');');
        this.emit.Line('  return result === true;');
      }, true);
    } else {
      this.emit(`(${testFunc} ? ${testFunc}.call(context, `);
      this.compile(node.left, frame);
      if (node.right.args) {
        this.emit(', ');
        this.compile(node.right.args, frame);
      }
      this.emit(`) : (() => { throw runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}"); })())`);
      this.emit(' === true');
    }
  }

  _binFuncEmitter(node, frame, funcName, separator = ',') {
    if (node.isAsync) {
      this.emit('(');
      this.emit('runtime.resolveDuo(');
      this.compile(node.left, frame);
      this.emit(',');
      this.compile(node.right, frame);
      this.emit(')');
      // Position node is tricky here, could be left or right. Use the main node.
      this.emit(`.then(function([left,right]){return ${funcName}(left${separator}right);}))`);
    } else {
      this.emit(`${funcName}(`);
      this.compile(node.left, frame);
      this.emit(separator);
      this.compile(node.right, frame);
      this.emit(')');
    }
  }

  _binOpEmitter(node, frame, str) {
    if (node.isAsync) {
      this.emit('runtime.resolveDuo(');
      this.compile(node.left, frame);
      this.emit(',');
      this.compile(node.right, frame);
      this.emit(')');
      // Position node is tricky here, could be left or right. Use the main node.
      this.emit('.then(function([left,right]){return left ' + str + ' right;})');
    } else {
      this.compile(node.left, frame);
      this.emit(str);
      this.compile(node.right, frame);
    }
  }

  _unaryOpEmitter(node, frame, operator) {
    if (node.isAsync) {
      this.emit('runtime.resolveSingle(');
      this.compile(node.target, frame);
      // Position node should be the target
      this.emit(`).then(function(target){return ${operator}target;})`);
    } else {
      this.emit(operator);
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
      this.emit('runtime.resolveDuo(');
      this.compile(node.expr, frame);
      this.emit(',');
      this.compile(node.ops[0].expr, frame);
      // Position node should be the first operation where the comparison happens
      this.emit(').then(async function([expr, ref1]){');
      this.emit(`return expr ${compareOps[node.ops[0].type]} ref1`);
      node.ops.forEach((op, index) => {
        if (index > 0) {
          this.emit(` ${compareOps[op.type]} `);
          this.compileAwaited(op.expr, frame);
        }
      });
      this.emit('})');
    } else {
      this.compile(node.expr, frame);

      node.ops.forEach((op) => {
        this.emit(` ${compareOps[op.type]} `);
        this.compile(op.expr, frame);
      });
    }
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
      let nodeStaticPathKey = this.sequential._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame.sequenceLockFrame, nodeStaticPathKey)) {
        /*const keyRoot = nodeStaticPathKey.substring(1, nodeStaticPathKey.indexOf('!', 1));
        if (this._isDeclared(frame, keyRoot)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }*/
        //const wrapInAsyncBlock = !(pathFlags & (PathFlags.WAITS_FOR_SEQUENCE_LOCK | PathFlags.CALL));
        pathFlags |= PathFlags.WAITS_FOR_SEQUENCE_LOCK;//do not wrap anymore
        const emitSequencedLookup = (f) => {
          //register the static path key as variable write so the next lock would wait for it
          //multiple static path keys can be in the same block
          this._updateFrameWrites(f, nodeStaticPathKey);
          // Use sequenced lookup as a lock for this node exists
          this.emit(`runtime.sequencedMemberLookupAsync(frame, (`);
          this.compile(node.target, f, pathFlags); // Mark target as part of a call path
          this.emit('),');
          this.compile(node.val, f); // Compile key expression
          this.emit(`, ${JSON.stringify(nodeStaticPathKey)})`); // Pass the key
        };
        if (node.wrapInAsyncBlock) {
          // Wrap in an async block if pre-analysis determined it's necessary for contention.
          // Use node.val as the positionNode for the async block value if it exists, else node.
          this.emit.AsyncBlockValue(node, frame, emitSequencedLookup, undefined, node.val || node);
        } else {
          emitSequencedLookup(frame);//emit without async block
        }
        return;
      }
    }

    // Standard member lookup (sync or async without sequence)
    this.emit(`runtime.memberLookup${node.isAsync ? 'Async' : ''}((`);
    this.compile(node.target, frame, pathFlags); // Mark target as part of a call path
    this.emit('),');
    this.compile(node.val, frame);
    this.emit(')');
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

  compileFunCall(node, frame, pathFlags) {
    // Keep track of line/col info at runtime by setting
    // variables within an expression (SYNC MODE ONLY).
    if (!this.asyncMode) {
      this.emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');
    }

    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');

    if (node.isAsync) {

      const sequenceLockKey = this.sequential._getSequenceKey(node.name, frame);
      if (sequenceLockKey) {
        let index = sequenceLockKey.indexOf('!', 1);
        const keyRoot = sequenceLockKey.substring(1, index === -1 ? sequenceLockKey.length : index);
        if (this._isDeclared(frame, keyRoot)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }
      }
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
        //@todo - not used for now
        //We probably need some static analysis to know for sure a name is not async
        // {% set asyncFunc = getAsyncFunction() %}
        // {{ asyncFunc(arg1, arg2) }}
        // Function name is not async, so resolve only the arguments.
        this._compileAggregate(node.args, frame, '[', ']', true, false, function (result) {
          if (!sequenceLockKey) {
            this.emit(`return runtime.callWrap(`);
            this.compile(node.name, frame, PathFlags.CALL);
            this.emit.Line(`, "${funcName}", context, ${result});`);
          } else {
            const emitCallback = (f) => {
              //we're not counting the writes here, this will be done from the key path lookupVal/symbol
              //this._updateFrameWrites(f, sequenceLockKey);//count the writes inside the async block
              //this.emit(`runtime.sequencedCallWrap(`);
              this.emit(`runtime.callWrap(`);
              this.compile(node.name, f, PathFlags.CALL);
              this.emit.Line(`, "${funcName}", context, ${result});`);//, frame, "${sequenceLockKey}");`);
            };
            this.emit('return ');
            if (node.wrapInAsyncBlock) {
              // Position node is the function call itself
              this.emit.AsyncBlockValue(node, frame, emitCallback, undefined, node);
            } else {
              emitCallback(frame);
            }
          }
        }); // Resolve arguments using _compileAggregate.
      } else {
        // Function name is dynamic, so resolve both function and arguments.
        node.name.pathFlags = PathFlags.CALL;

        if (!sequenceLockKey) {
          const mergedNode = {
            isAsync: node.name.isAsync || node.args.isAsync,
            children: (node.args.children.length > 0) ? [node.name, ...node.args.children] : [node.name]
          };
          this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
            this.emit(`return runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);
          });
        } else {
          // Create a merged node to resolve both function path and arguments
          // concurrently in a single resolveAll
          const mergedNode = {
            isAsync: node.name.isAsync || node.args.isAsync,
            children: (node.args.children.length > 0) ? [node.name, ...node.args.children] : [node.name]
          };
          this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
            const emitCallback = (f) => {
              //we're not counting the writes here, this will be done from the key path lookupVal/symbol
              //this._updateFrameWrites(f, sequenceLockKey);//count the writes inside the async block
              this.emit(`runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);//, frame, "${sequenceLockKey}");`);
            };
            this.emit('return ');
            if (node.wrapInAsyncBlock) {
              // Position node is the function call itself
              this.emit.AsyncBlockValue(node, frame, emitCallback, undefined, node);
            } else {
              emitCallback(frame);
            }
          });
        }

        delete node.name.pathFlags;


        // Position node for aggregate is the function call itself (node)
        /*this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
          if (!sequenceLockKey) {
            this.emit(`return runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);
          } else {
            const emitCallback = (f) => {
              //we're not counting the writes here, this will be done from the key path lookupVal/symbol
              //this._updateFrameWrites(f, sequenceLockKey);//count the writes inside the async block
              this.emit(`runtime.callWrap(${result}[0], "${funcName}", context, ${result}.slice(1));`);//, frame, "${sequenceLockKey}");`);
            };
            this.emit('return ');
            if (node.wrapInAsyncBlock) {
              // Position node is the function call itself
              this.emit.AsyncBlockValue(node, frame, emitCallback, undefined, node);
            } else {
              emitCallback(frame);
            }
          }
        });
        delete node.name.pathFlags;*/
      }
      // //(lineno, ... No closing parenthesis needed here for async mode
    } else {
      // In sync mode, compile as usual.
      this.emit('runtime.callWrap(');
      this.compile(node.name, frame);
      this.emit(', "' + funcName + '", context, ');
      this._compileAggregate(node.args, frame, '[', ']', false, false);
      this.emit('))');
    }
  }

  compileFilterGet(node, frame) {
    this.emit('env.getFilter("' + node.value + '")');//@todo I think this can not be async
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
        this.emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
      });
    } else {
      this.emit('env.getFilter("' + name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this.emit(')');
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
      this.emit.Line(`let ${symbol} = `);
      // Use node.args as the position node since it's what's being evaluated async
      this.emit.AsyncBlockValue(node, frame, (f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        //@todo - this should be done with _compileExpression in the future
        this._compileAggregate(node.args, f, '[', ']', true, false, function (result) {
          this.emit(`return env.getFilter("${name.value}").bind(env)(...${result});`);
        });
      }, undefined, node.args);
      this.emit(';');
    } else {
      this.emit('env.getFilter("' + name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this.emit.Line(', ' + this._makeCallback(symbol));
      this.emit._addScopeLevel();
    }

  }

  compileKeywordArgs(node, frame) {
    this.emit('runtime.makeKeywordArgs(');
    this.compileDict(node, frame);
    this.emit(')');
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
        this.emit.Line('let ' + id + ';');

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
      this.emit(ids.join(' = ') + ' = ');
      if (node.isAsync) {
        // Use node.value as the position node since it's the expression being evaluated
        this.emit.AsyncBlockValue(node, frame, (f) => {
          this.compile(node.value, f);
        }, undefined, node.value); // Pass value as code position
      } else {
        this._compileExpression(node.value, frame);
      }
    } else {
      // set block
      this.emit(ids.join(' = ') + ' = ');
      // Use node.body as the position node since it's the block being evaluated
      this.emit.AsyncBlockValue(node, frame, (f) => {
        this.compile(node.body, f);
      }, undefined, node.body); // Pass body as code position
    }
    this.emit.Line(';');

    node.targets.forEach((target, i) => {
      var id = ids[i];
      var name = target.value;

      // We are running this for every var, but it's very
      // uncommon to assign to multiple vars anyway
      this.emit.Line(`frame.set("${name}", ${id}, true);`);

      //if (!this.asyncMode) {
      //in async mode writing to the context is not possible
      //will use a separate input/output tags and attributes to
      //declare variable exports/imports
      this.emit.Line('if(frame.topLevel) {');
      this.emit.Line(`context.setVariable("${name}", ${id});`);
      this.emit.Line('}');
      //}

      if (name.charAt(0) !== '_') {
        this.emit.Line('if(frame.topLevel) {');
        this.emit.Line(`context.addExport("${name}", ${id});`);
        this.emit.Line('}');
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

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    // Use node.expr as the primary position node for the overall switch block
    frame = this.emit.AsyncBlockBufferNodeBegin(node, frame, false, node.expr);

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
    this.emit('switch (');
    this._compileAwaitedExpression(node.expr, frame);
    this.emit(') {');

    // Compile cases
    node.cases.forEach((c, i) => {
      this.emit('case ');
      this._compileAwaitedExpression(c.cond, frame);
      this.emit(': ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      if (c.body.children.length) {
        // Use case body 'c.body' as position node for this block
        this.emit.AsyncBlock(c, frame, false, (f) => {
          this.compile(c.body, f);
          branchWriteCounts.push(this.countsTo1(f.writeCounts) || {});
        }, c.body); // Pass body as code position
        this.emit.Line('break;');
      }
    });

    // Compile default case, if present
    if (node.default) {
      this.emit('default: ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      // Use default body 'node.default' as position node for this block
      this.emit.AsyncBlock(node, frame, false, (f) => {
        this.compile(node.default, f);
        branchWriteCounts.push(this.countsTo1(f.writeCounts) || {});
      }, node.default); // Pass default as code position
    }

    this.emit('}');

    // Combine writes from all branches
    const totalWrites = combineWriteCounts(branchWriteCounts);

    // Insert skip statements for each case, including default
    branchPositions.forEach((pos, i) => {
      const writesToSkip = excludeCurrentWrites(totalWrites, branchWriteCounts[i]);
      if (Object.keys(writesToSkip).length > 0) {
        this.emit.InsertLine(pos, `frame.skipBranchWrites(${JSON.stringify(writesToSkip)});`);
      }
    });

    // Use node.expr (passed earlier) for the end block
    frame = this.emit.AsyncBlockBufferNodeEnd(node, frame, false, false, node.expr);
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
    frame = this.emit.AsyncBlockBufferNodeBegin(node, frame, false, node.cond);

    let trueBranchWriteCounts, falseBranchWriteCounts;
    let trueBranchCodePos;

    this.emit('if(');
    this._compileAwaitedExpression(node.cond, frame);
    this.emit('){');

    if (this.asyncMode) {
      trueBranchCodePos = this.codebuf.length;
      this.emit('');
      // Use node.body as the position node for the true branch block
      this.emit.AsyncBlock(node, frame, false, (f) => {
        this.compile(node.body, f);
        trueBranchWriteCounts = this.countsTo1(f.writeCounts);
      }, node.body); // Pass body as code position
    }
    else {
      this.emit._withScopedSyntax(() => {
        this.compile(node.body, frame);
        if (async) {
          this.emit('cb()');
        }
      });
    }

    this.emit('} else {');

    if (trueBranchWriteCounts) {
      //skip the true branch writes in the false branch
      this.emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
    }

    if (node.else_) {
      if (this.asyncMode) {
        // Use node.else_ as the position node for the false branch block
        this.emit.AsyncBlock(node, frame, false, (f) => {
          this.compile(node.else_, f);
          falseBranchWriteCounts = this.countsTo1(f.writeCounts);
        }, node.else_); // Pass else as code position
      }
      else {
        this.emit._withScopedSyntax(() => {
          this.compile(node.else_, frame);
          if (async) {
            this.emit('cb()');
          }
        });
      }
    } else {
      if (async && !this.asyncMode) {
        this.emit('cb()');
      }
    }

    this.emit('}');

    if (falseBranchWriteCounts) {
      //skip the false branch writes in the true branch code
      this.emit.InsertLine(trueBranchCodePos, `frame.skipBranchWrites(${JSON.stringify(falseBranchWriteCounts)});`);
    }

    // Use node.cond (passed earlier) for the end block
    frame = this.emit.AsyncBlockBufferNodeEnd(node, frame, false, false, node.cond);
  }

  compileIfAsync(node, frame) {
    if (node.isAsync) {
      this.compileIf(node, frame);
    } else {
      this.emit('(function(cb) {');
      this.compileIf(node, frame, true);
      this.emit('})(' + this._makeCallback());
      this.emit._addScopeLevel();
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
    frame = this.emit.AsyncBlockBufferNodeBegin(node, frame, true, node.arr);

    // Evaluate the array expression
    const arr = this._tmpid();
    this.emit(`let ${arr} = `);
    this._compileAwaitedExpression(node.arr, frame);
    this.emit.Line(';');

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
    this.emit(`let ${loopBodyFunc} = `);

    if (node.isAsync) {
      this.emit('async function(');//@todo - think this over, does it need async block?
    } else {
      this.emit('function(');
    }

    // Function parameters
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.emit(', ');
      }
      this.emit(varName);
    });
    const loopIndex = this._tmpid();
    const loopLength = this._tmpid();
    const isLast = this._tmpid();
    this.emit(`, ${loopIndex}, ${loopLength}, ${isLast}) {`);

    // Use node.body as the position for the inner buffer block (loop body execution)
    frame = this.emit.AsyncBlockBufferNodeBegin(node, frame, false, node.body);

    const makeSequentialPos = this.codebuf.length;
    this.emit.Line(`runtime.setLoopBindings(frame, ${loopIndex}, ${loopLength}, ${isLast});`);

    // Handle array unpacking within the loop body
    if (loopVars.length === 2 && !Array.isArray(arr)) {
      // Object key/value iteration
      const [keyVar, valueVar] = loopVars;
      this.emit.Line(`frame.set("${keyVar}", ${keyVar});`);
      this.emit.Line(`frame.set("${valueVar}", ${valueVar});`);

      frame.set(keyVar, keyVar);
      frame.set(valueVar, valueVar);
      this._addDeclaredVar(frame, keyVar);
      this._addDeclaredVar(frame, valueVar);
    } else if (node.name instanceof nodes.Array) {
      // Array destructuring
      node.name.children.forEach((child, index) => {
        const varName = child.value;
        const tid = this._tmpid();
        this.emit.Line(`let ${tid} = Array.isArray(${varName}) ? ${varName}[${index}] : undefined;`);
        this.emit.Line(`frame.set("${varName}", ${tid});`);
        frame.set(varName, tid);
        this._addDeclaredVar(frame, varName);
      });
    } else {
      // Single variable loop
      const varName = node.name.value;
      this.emit.Line(`frame.set("${varName}", ${varName});`);
      frame.set(varName, varName);
      this._addDeclaredVar(frame, varName);
    }

    // Compile the loop body with the updated frame
    this.emit._withScopedSyntax(() => {
      this.compile(node.body, frame);
    });

    const bodyWriteCounts = frame.writeCounts;
    if (bodyWriteCounts) {
      sequential = true;//should be sequential to avoid write race conditions and long promise chains
    }
    if (sequential) {
      this.emit.InsertLine(makeSequentialPos, 'frame.sequentialLoopBody = true;');
    }

    // End buffer block for the loop body (using node.body position)
    frame = this.emit.AsyncBlockBufferNodeEnd(node, frame, false, true, node.body);

    // Close the loop body function
    this.emit.Line('};');

    // Define the else function if it exists
    let elseFuncId = 'null';
    if (node.else_) {
      elseFuncId = this._tmpid();
      this.emit(`let ${elseFuncId} = `);

      if (node.isAsync) {
        this.emit('async function() {');
      } else {
        this.emit('function() {');
      }

      // Use node.else_ as position for the else block buffer
      frame = this.emit.AsyncBlockBufferNodeBegin(node, frame, false, node.else_);
      this.compile(node.else_, frame);
      frame = this.emit.AsyncBlockBufferNodeEnd(node, frame, false, false, node.else_);

      this.emit.Line('};');
    }

    // Call the runtime iterate loop function
    this.emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFunc}, ${elseFuncId}, frame, ${JSON.stringify(bodyWriteCounts)}, [`);
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.emit(', ');
      }
      this.emit(`"${varName}"`);
    });
    this.emit(`], ${sequential}, ${node.isAsync});`);

    // End buffer block for the node (using node.arr position)
    frame = this.emit.AsyncBlockBufferNodeEnd(node, frame, true, false, node.arr);
  }

  _compileAsyncLoopBindings(node, arr, i, len) {
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
      this.emit.Line(`frame.set("loop.${b.name}", ${b.val});`);
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
    this.emit.Line('frame = frame.push();');

    this.emit('let ' + arr + ' = runtime.fromIterator(');
    this._compileExpression(node.arr, frame);
    this.emit.Line(');');

    if (node.name instanceof nodes.Array) {
      const arrayLen = node.name.children.length;
      this.emit(`runtime.${asyncMethod}(${arr}, ${arrayLen}, function(`);

      node.name.children.forEach((name) => {
        this.emit(`${name.value},`);
      });

      this.emit(i + ',' + len + ',next) {');

      node.name.children.forEach((name) => {
        const id = name.value;
        frame.set(id, id);
        this._addDeclaredVar(frame, id);
        this.emit.Line(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this.emit.Line(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      this._addDeclaredVar(frame, id);
      this.emit.Line('frame.set("' + id + '", ' + id + ');');
      frame.set(id, id);
    }

    this._compileAsyncLoopBindings(node, arr, i, len);

    this.emit._withScopedSyntax(() => {
      let buf;
      if (parallel) {
        buf = this._pushBuffer();
      }

      this.compile(node.body, frame);
      this.emit.Line('next(' + i + (buf ? ',' + buf : '') + ');');

      if (parallel) {
        this._popBuffer();
      }
    });

    const output = this._tmpid();
    this.emit.Line('}, ' + this._makeCallback(output));
    this.emit._addScopeLevel();

    if (parallel) {
      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this.emit(`${this.buffer}[index++] = ${output};`);
      } else {
        this.emit.Line(`${this.buffer} += ${output};`);
      }
    }

    if (node.else_) {
      this.emit.Line('if (!' + arr + '.length) {');
      this.compile(node.else_, frame);
      this.emit.Line('}');
    }

    this.emit.Line('frame = frame.pop();');
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
      currFrame = frame.new();
    }

    const oldIsCompilingMacroBody = this.sequential.isCompilingMacroBody; // Save previous state

    // If the macro being compiled is the anonymous 'caller' macro (generated for a {% call %} block),
    // its body's sequence operations should be evaluated against the call site's context,
    // not as if they are part of a regular macro definition's internal logic.
    // The `Caller` node (for `{{ caller() }}`) is a distinct typename.
    this.sequential.isCompilingMacroBody = node.typename !== 'Caller';

    this.emit.Lines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${argNames.join(', ')}], `,
      `[${kwargNames.join(', ')}], `,
      `function (${realNames.join(', ')}, astate) {`
    );
    if (!keepFrame) {
      this.emit.Line('let callerFrame = frame;');
    }
    this.emit.Lines(
      'frame = ' + ((keepFrame) ? 'frame.push(true);' : 'frame.new();'),
      'kwargs = kwargs || {};',
      'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      'frame.set("caller", kwargs.caller); }'
    );

    let err = this._tmpid();
    if (node.isAsync) {
      this.emit.Lines(
        `let ${err} = null;`,
        'function cb(err) {',
        `if(err) {${err} = err;}`,
        '}');
    }

    // Expose the arguments to the template. Don't need to use
    // random names because the function
    // will create a new run-time scope for us
    args.forEach((arg) => {
      this.emit.Line(`frame.set("${arg.value}", l_${arg.value});`);
      currFrame.set(arg.value, `l_${arg.value}`);
      this._addDeclaredVar(currFrame, arg.value);
    });

    // Expose the keyword arguments
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        this._addDeclaredVar(currFrame, name);
        this.emit(`frame.set("${name}", `);
        this.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
        this.emit(` ? kwargs["${name}"] : `);
        this._compileExpression(pair.value, currFrame);
        this.emit(');');
      });
    }

    this._addDeclaredVar(currFrame, 'caller');
    const bufferId = this._pushBuffer();

    this.emit._withScopedSyntax(() => {
      this.compile(node.body, currFrame);
    });

    this.emit.Line('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));
    //return the buffer, in async mode it may not be ready yet
    //this.emit.Line(`return ${node.isAsync?'runtime.newSafeStringAsync':'new runtime.SafeString'}(${bufferId});`);
    this.emit.Line('return ' + (
      node.isAsync ?
        `astate.waitAllClosures().then(() => {if (${err}) throw ${err}; return runtime.newSafeStringAsync(runtime.flattentBuffer(${bufferId}));}).catch(error => Promise.reject(error));` :
        `new runtime.SafeString(${bufferId})`
    )
    );

    if (node.isAsync) {
      this.emit.Line('}, astate);');
    } else {
      this.emit.Line('});');
    }
    this._popBuffer();

    this.sequential.isCompilingMacroBody = oldIsCompilingMacroBody; // Restore state

    return funcId;
  }

  compileMacro(node, frame) {
    var funcId = this._compileMacro(node, frame, false);

    // Expose the macro to the templates
    var name = node.name.value;
    frame.set(name, funcId);

    if (frame.parent) {
      this.emit.Line(`frame.set("${name}", ${funcId});`);
    } else {
      if (node.name.value.charAt(0) !== '_') {
        this.emit.Line(`context.addExport("${name}");`);
      }
      this.emit.Line(`context.setVariable("${name}", ${funcId});`);
    }
  }

  compileCaller(node, frame) {
    // basically an anonymous "macro expression"
    this.emit('(function (){');
    const funcId = this._compileMacro(node, frame, true);
    this.emit(`return ${funcId};})()`);
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
      this.emit.Line(`const ${getTemplateFunc} = runtime.promisify(env.getTemplate.bind(env));`);
      this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      if (wrapInAsyncBlock) {
        // Wrap the expression evaluation in an async block if needed, use template node position
        this.emit.AsyncBlockValue(node.template, frame, (f) => {
          this._compileExpression(node.template, f);
        }, undefined, positionNode);
      } else {
        this._compileExpression(node.template, frame);
      }
      this.emit.Line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    } else {
      const cb = this._makeCallback(parentTemplateId);
      this.emit('env.getTemplate(');
      this._compileExpression(node.template, frame);
      this.emit.Line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);
    }

    return parentTemplateId;
  }

  compileImport(node, frame) {
    const target = node.target.value;
    // Pass node.template for position in _compileGetTemplate
    const id = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this.emit(`${id} = `);
      // Use node as position node for the getExported part
      this.emit.AsyncBlockValue(node, frame, (f) => {
        this.emit.Line(`let ${res} = await ${id};`);
        this.emit.Line(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${node.withContext
          ? `context.getVariables(), frame, astate`
          : `null, null, astate`
        });`);
      }, res, node);
    } else {
      this.emit._addScopeLevel();
      this.emit.Line(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(id));
      this.emit._addScopeLevel();
    }

    frame.set(target, id);
    this._addDeclaredVar(frame, target);

    if (frame.parent) {
      this.emit.Line(`frame.set("${target}", ${id});`);
    } else {
      // AI:
      //if (node.name.value.charAt(0) !== '_') {
      //  this.emit.Line(`context.addExport("${target}");`);
      //}
      this.emit.Line(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    // Pass node.template for position in _compileGetTemplate
    const importedId = this._compileGetTemplate(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this.emit(`${importedId} = `);
      // Use node as position node for the getExported part
      this.emit.AsyncBlockValue(node, frame, (f) => {
        this.emit.Line(`let ${res} = await ${importedId};`);
        this.emit.Line(`${res} = await runtime.promisify(${res}.getExported.bind(${res}))(${node.withContext
          ? `context.getVariables(), frame, astate`
          : `null, null, astate`
        });`);
      }, res, node);
    } else {
      this.emit._addScopeLevel();//after _compileGetTemplate
      this.emit.Line(importedId + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(importedId));
      this.emit._addScopeLevel();
    }

    node.names.children.forEach((nameNode) => {
      let name;
      let alias;
      let id = this._tmpid();
      this.emit.Line(`let ${id};`);

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
        this.emit.Line(`${id} = (async () => { try { `); // Add try
        this.emit.Line(`  let exported = await ${importedId};`);
        this.emit.Line(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this.emit.Line(`    return exported["${name}"];`);
        this.emit.Line(`  } else {`);
        this.emit.Line(`    throw runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}");`);
        this.emit.Line(`  }`);
        this.emit.Line(`} catch(e) { throw runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}"); } })();`);
      } else {
        this.emit.Line(`if(Object.prototype.hasOwnProperty.call(${importedId}, "${name}")) {`);
        this.emit.Line(`${id} = ${importedId}.${name};`);
        this.emit.Line('} else {');
        this.emit.Line(`cb(runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}")); return;`);
        this.emit.Line('}');
      }

      frame.set(alias, id);
      this._addDeclaredVar(frame, alias);

      if (frame.parent) {
        this.emit.Line(`frame.set("${alias}", ${id});`);
      } else {
        this.emit.Line(`context.setVariable("${alias}", ${id});`);
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
      this.emit.AsyncBlockAddToBuffer(node, frame, (id, f) => {
        if (!this.inBlock) {
          this.emit(`if(parentTemplate) ${id}=""; else {`);
        }
        const blockFunc = this._tmpid();
        this.emit.Line(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        this.emit.Line(`${blockFunc} = runtime.promisify(${blockFunc}.bind(context));`);
        this.emit.Line(`${id} = await ${blockFunc}(env, context, frame, runtime, astate);`);
        if (!this.inBlock) {
          this.emit.Line('}');
        }
      }, node);
    }
    else {
      let id = this._tmpid();
      if (!this.inBlock) {
        this.emit('(parentTemplate ? function(e, c, f, r, cb) { cb(null, ""); } : ');
      }
      this.emit(`context.getBlock("${node.name.value}")`);
      if (!this.inBlock) {
        this.emit(')');
      }
      this.emit.Line('(env, context, frame, runtime, ' + this._makeCallback(id));

      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this.emit(`${this.buffer}[index++] = ${id};`);
      } else {
        this.emit.Line(`${this.buffer} += ${id};`);
      }
      this.emit._addScopeLevel();
    }
  }

  compileSuper(node, frame) {
    var name = node.blockName.value;
    var id = node.symbol.value;

    if (node.isAsync) {
      this.emit.Line(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);
    }
    else {
      const cb = this._makeCallback(id);
      this.emit.Line(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this.emit.Line(`${id} = runtime.markSafe(${id});`);

    if (!node.isAsync) {
      this.emit._addScopeLevel();
    }
    frame.set(id, id);
    this._addDeclaredVar(frame, id);
  }

  compileExtends(node, frame) {
    var k = this._tmpid();

    if (node.isAsync) {
      this.emit.Line('context.prepareForAsyncBlocks();');
    }

    // Pass node.template for position in _compileGetTemplate
    const parentTemplateId = this._compileGetTemplate(node, frame, true, false, true);

    // extends is a dynamic tag and can occur within a block like
    // `if`, so if this happens we need to capture the parent
    // template in the top-level scope

    if (node.isAsync) {
      // Use node.template as position for the block resolving the parent template
      frame = this.emit.AsyncBlockBegin(node, frame, false, node.template);
    }

    //isAsync: set the global parent template, compileRoot will use it after waitAllClosures
    this.emit.Line(`parentTemplate = ${node.isAsync ? 'await ' : ''}${parentTemplateId};`);
    this.emit.Line(`for(let ${k} in parentTemplate.blocks) {`);
    this.emit.Line(`context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
    this.emit.Line('}');

    if (!node.isAsync) {
      this.emit._addScopeLevel();
    }
    else {
      this.emit.Line('context.finsihsAsyncBlocks()');
      // Use node.template for the end block position
      frame = this.emit.AsyncBlockEnd(node, frame, false, false, node.template);
    }
  }

  compileInclude(node, frame) {
    if (!node.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    // Use node.template for position of getTemplate, node for render
    this.emit.AsyncBlockAddToBuffer(node, frame, (resultVar, f) => {
      // Get the template
      const templateVar = this._tmpid();
      const templateNameVar = this._tmpid();

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      this._compileExpression(node.template, f);
      this.emit.Line(';');

      // getTemplate
      this.emit.Line(`let ${templateVar} = await runtime.promisify(env.getTemplate.bind(env))(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // render
      this.emit.Line(`${resultVar} = await runtime.promisify(${templateVar}.render.bind(${templateVar}))(context.getVariables(), frame${node.isAsync ? ', astate' : ''});`);
    }, node);
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this.emit.Line('let tasks = [];');
    this.emit.Line('tasks.push(');
    this.emit.Line('function(callback) {');

    const id = this._compileGetTemplate(node, frame, false, node.ignoreMissing, false);
    this.emit.Line(`callback(null,${id});});`);

    this.emit.Line('});');

    const id2 = this._tmpid();
    this.emit.Line('tasks.push(');
    this.emit.Line('function(template, callback){');
    this.emit.Line('template.render(context.getVariables(), frame, ' + (node.isAsync ? 'astate,' : '') + this._makeCallback(id2));
    this.emit.Line('callback(null,' + id2 + ');});');
    this.emit.Line('});');

    this.emit.Line('tasks.push(');
    this.emit.Line('function(result, callback){');

    // Adding to buffer is synchronous here
    if (this.asyncMode) {
      //non-async node but in async mode -> use the proper buffer implementation
      this.emit.Line(`${this.buffer}[index++] = result;`);
    } else {
      this.emit.Line(`${this.buffer} += result;`);
    }
    this.emit.Line('callback(null);');
    this.emit.Line('});');
    this.emit.Line('env.waterfall(tasks, function(){');
    this.emit._addScopeLevel();
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
      this.emit.AsyncBlockValue(node, frame, (f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        this.emit.Line('let output = [];');

        this.compile(node.body, f);//write to output

        this.emit.Line('await astate.waitAllClosures(1)');
        this.emit.Line(`let ${res} = runtime.flattentBuffer(output);`);
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res, node.body);
    }
    else {
      this.emit.Line('(function() {');
      this.emit.Line('let output = "";');
      this.emit._withScopedSyntax(() => {
        this.compile(node.body, frame);
      });
      this.emit.Line('return output;');
      this.emit.Line('})()');
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
          this.emit.AddToBuffer(node, frame, function () {
            this.compileLiteral(child, frame);
          }, child); // Pass TemplateData as position
        }
      } else {
        // Use the specific child expression node for position
        frame = this.emit.AsyncBlockAddToBufferBegin(node, frame, child);
        this.emit(`${node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);

        if (this.throwOnUndefined) {
          this.emit(`${node.isAsync ? 'await runtime.ensureDefinedAsync(' : 'runtime.ensureDefined('}`);
        }
        this._compileExpression(child, frame);
        if (this.throwOnUndefined) {
          // Use child position for ensureDefined error
          this.emit(`,${child.lineno},${child.colno})`);
        }
        // Use child position for suppressValue error
        this.emit(', env.opts.autoescape);\n');
        frame = this.emit.AsyncBlockAddToBufferEnd(node, frame, child); // Pass Output node as op, child as pos
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
      const key = this.sequential._getSequenceKey(node.name, sequenceLockFrame);
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

    this.emit.FuncBegin(node, 'root');
    this.emit.Line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (node.isAsync) {
      this.emit.Line('let isIncluded = !!(frame.parent || frame.isIncluded);');
      this.emit.Line('if(!isIncluded){');
      this.emit.Line('astate.waitAllClosures().then(() => {');
      this.emit.Line('  if(parentTemplate) {');
      this.emit.Line('    parentTemplate.rootRenderFunc(env, context, frame, runtime, astate, cb);');
      this.emit.Line('  } else {');
      this.emit.Line(`    cb(null, runtime.flattentBuffer(${this.buffer}));`);
      this.emit.Line('  }');
      this.emit.Line('}).catch(e => {');
      // Use static node position for root catch in async mode
      // Do NOT pass errorContext here
      this.emit.Line(`cb(runtime.handleError(e, ${node.lineno}, ${node.colno}))`);
      this.emit.Line('});');
      this.emit.Line('} else {');
      this.emit.Line('if(parentTemplate) {');
      this.emit.Line('parentTemplate.rootRenderFunc(env, context, frame, runtime, astate, cb);');
      this.emit.Line('} else {');
      this.emit.Line(`cb(null, ${this.buffer});`);
      this.emit.Line('}');
      this.emit.Line('}');
    }
    else {
      this.emit.Line('if(parentTemplate) {');
      this.emit.Line(`parentTemplate.rootRenderFunc(env, context, frame, runtime, ${this.asyncMode ? 'astate, ' : ''}cb);`);
      this.emit.Line('} else {');
      if (this.asyncMode) {
        // This case (sync root in asyncMode) might be unlikely/problematic,
        // but keep flatten for consistency if it somehow occurs.
        this.emit.Line(`cb(null, runtime.flattentBuffer(${this.buffer}));`);
      } else {
        this.emit.Line(`cb(null, ${this.buffer});`);
      }
      this.emit.Line('}');
    }

    // Pass the node to _emitFuncEnd for error position info (used in sync catch)
    this.emit.FuncEnd(node, true);

    this.inBlock = true;

    const blockNames = [];

    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block, i) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);

      this.emit.FuncBegin(block, `b_${name}`);

      let tmpFrame = frame.new();//new Frame();
      this.emit.Line('var frame = frame.push(true);'); // Keep this as 'var', the codebase depends on the function-scoped nature of var for frame
      this.compile(block.body, tmpFrame);
      // Pass the block node to _emitFuncEnd
      this.emit.FuncEnd(block);
    });

    this.emit.Line('return {');

    blocks.forEach((block, i) => {
      const blockName = `b_${block.name.value}`;
      this.emit.Line(`${blockName}: ${blockName},`);
    });

    this.emit.Line('root: root\n};');
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
      this.emit('(await ');
      this.compile(node, frame);
      this.emit(')');
    } else {
      this.compile(node, frame);
    }
  }

  //todo - optimize, check for much more than literal
  _compileAwaitedExpression(node, frame) {
    if (node.isAsync) {
      this.emit('(await ');
      this._compileExpression(node, frame);
      this.emit(')');
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
    if (node.isAsync && this.emit.asyncClosureDepth === 0) {
      //this will change in the future - only if a child node need the frame
      this.fail('All expressions must be wrapped in an async IIFE', node.lineno, node.colno, node);
    }
    if (node.isAsync) {
      this.sequential.processExpression(node, frame);
    }
    this.compile(node, frame);
  }

  getCode() {
    return this.codebuf.join('');
  }

  compileDo(node, frame) {
    if (node.isAsync) {
      // Use the Do node itself for the outer async block position
      this.emit.AsyncBlock(node, frame, false, (f) => {
        const promisesVar = this._tmpid();
        this.emit.Line(`let ${promisesVar} = [];`);
        node.children.forEach((child) => {
          // Position node for individual expressions is the child itself
          const resultVar = this._tmpid();
          this.emit.Line(`let ${resultVar} = `);
          // Expressions inside DO shouldn't be wrapped in another IIFE,
          // but if they were async, their results (promises) need handling.
          // We compile them directly here.
          this._compileExpression(child, f);
          this.emit.Line(';');
          // We only push actual promises to the wait list
          this.emit.Line(`if (${resultVar} && typeof ${resultVar}.then === 'function') ${promisesVar}.push(${resultVar});`);
        });
        this.emit.Line(`if (${promisesVar}.length > 0) {`);
        this.emit.Line(`  await Promise.all(${promisesVar});`);
        this.emit.Line(`}`);
      }, node); // Pass Do node as positionNode for the overall block
      //this.emit.Line(';'); // Removed semicolon after block
    } else {
      node.children.forEach(child => {
        this._compileExpression(child, frame);
        this.emit.Line(';');
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
