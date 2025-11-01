'use strict';

const nodes = require('../nodes');
const { TemplateError } = require('../lib');
// const { Frame, AsyncFrame } = require('./runtime'); // Not used in base class
const { Obj } = require('../object');

// Moved from the main compiler as it's used by compileCompare (expression)
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

/**
 * CompilerBase - Base class for expression compilation
 *
 * Handles the compilation of expressions - nodes that evaluate to JavaScript values.
 * Provides the foundation for expression compilation
 * The main Compiler extends this class and provides full
 * template compilation including statements and control flow.
 * @param {Object} options - Compiler options
 * @param {boolean} options.throwOnUndefined - Whether to throw on undefined values
 * @param {boolean} options.asyncMode - Whether to compile in async mode
 * @param {boolean} options.scriptMode - Whether to compile in script mode
 * @returns {void}
 */
class CompilerBase extends Obj {
  init(options) {
    // Properties essential for any compilation, including expressions
    this.codebuf = [];
    this.lastId = 0;
    this.throwOnUndefined = options.throwOnUndefined || false;
    this.asyncMode = options.asyncMode || false;
    this.scriptMode = options.scriptMode || false;

    // These will be instantiated by the derived Compiler class
    // and are essential for expression compilation.
    this.sequential = null;
    this.emit = null;
    this.async = null;
  }

  compile(node, frame) {
    var _compile = this['compile' + node.typename];
    if (_compile) {
      if (node.wrapInAsyncBlock) {
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          _compile.call(this, n, f);
        }, undefined, node);
      } else {
        _compile.call(this, node, frame);
      }
    } else {
      this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno, node);
    }
  }

  // --- Core Utilities (Needed by Expressions) ---

  _generateErrorContext(node, positionNode) {
    if (!node) return 'UnknownContext';
    // Special case for OutputCommand for more descriptive errors
    if (node.typename === 'OutputCommand' && node.call && node.call.name) {
      const staticPath = this.sequential._extractStaticPath(node.call.name);
      if (staticPath) {
        return '@' + staticPath.join('.');
      }
    }
    const nodeType = node.typename || 'Node';
    const posType = (positionNode && positionNode.typename) || 'PosNode';
    if (node === positionNode || nodeType === posType) {
      return nodeType;
    }
    return `${nodeType}(${posType})`;
  }


  _createErrorContext(node, positionNode) {
    positionNode = positionNode || node;
    const { ErrorContext } = require('../runtime/errors');
    return new ErrorContext(
      positionNode.lineno + 1,
      positionNode.colno,
      this.templateName, // At runtime, context.path will be used
      this._generateErrorContext(node, positionNode)
    );
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

  _tmpid() {
    this.lastId++;
    return 't_' + this.lastId;
  }

  _makeCallback(res) {
    const err = this._tmpid();

    return 'function(' + err + (res ? ',' + res : '') + ') {\n' +
      'if(' + err + ') { cb(' + err + '); return; }';
  }

  assertType(node, ...types) {
    if (!types.some(t => node instanceof t)) {
      this.fail(`assertType: invalid type: ${node.typename}`, node.lineno, node.colno, node);
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


  // --- Expression Compilation Helpers ---

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
        this.emit.line(`(${asyncThen ? 'async ' : ''}function(${result}){`);
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
      /*if (expressionRoot && startChar !== '{') {
        //arguments can only be in expression child nodes? So we should use regular compile?
        this._compileExpression(child, frame);
      } else {*/
      this.compile(child, frame);
      /*}*/
    });
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

  // --- Expression Compilers ---

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

  compileSymbol(node, frame) {

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

      this.async.updateFrameReads(frame, name);//will register the name as read if it's a frame variable only

      let nodeStaticPathKey = node.lockKey;//this.sequential._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame, nodeStaticPathKey)) {
        // This node accesses a declared sequence lock path.
        // Register the static path key as variable write so the next lock would wait for it
        // Multiple static path keys can be in the same block
        // @todo - optimization: if there are no further funCalls with lock on the path
        // we can use _updateFrameReads. The last funCall can record false in the lock value
        // to indicate all further paths locked by it that they don't need to make a lock for further funCalls
        // hence we can use _updateFrameReads for all of them
        this.async.updateFrameWrites(frame, nodeStaticPathKey);
        // Use sequential lookup as a lock for this node exists
        // sequentialContextLookup will `set` the path key, thus releasing it (by decrementing the lock writeCount)
        this.emit(`runtime.sequentialContextLookup(context, frame, "${name}", ${JSON.stringify(nodeStaticPathKey)})`);
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
    if (this.scriptMode) {
      if (this.asyncMode) {
        this.emit('runtime.contextOrFrameLookupScriptAsync(' + 'context, frame, "' + name + '")');
      } else {
        this.emit('runtime.contextOrFrameLookupScript(' + 'context, frame, "' + name + '")');
      }
    } else {
      this.emit('runtime.contextOrFrameLookup(' + 'context, frame, "' + name + '")');
    }
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
    this._compileExpression(val, frame, false);
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

    if (testName === 'error' && this.asyncMode) {
      // Special case for 'is error' in async mode. We do not want to await the
      // value, as that would trigger the poison system. Instead, we pass the
      // raw value (which may be a promise) to the test function.
      this.emit('(() => {');

      this.emit('const value = ');
      this.compile(node.left, frame);
      this.emit(';');

      this.emit('if (runtime.isPoison(value)) { return true; }');
      this.emit('if (value && typeof value.then === "function") { return value.then(() => false, () => true); }');
      this.emit('return false;');

      this.emit('})()');
      return;
    }

    if (node.isAsync) {
      const mergedNode = {
        isAsync: node.left.isAsync || node.right.isAsync,
        // Use node.right for position if args exist, else node.left
        positionNode: (node.right.args && node.right.args.children.length > 0) ? node.right : node.left,
        children: (node.right.args && node.right.args.children.length > 0) ? [node.left, ...node.right.args.children] : [node.left]
      };
      // Resolve the left-hand side and arguments (if any)
      this._compileAggregate(mergedNode, frame, '[', ']', true, true, function (args) {
        this.emit.line(`  const testFunc = ${testFunc};`);
        this.emit.line(`  if (!testFunc) { var err = runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}", context.path); throw err; }`);
        this.emit.line(`  const result = await testFunc.call(context, ${args}[0]`);
        if (node.right.args && node.right.args.children.length > 0) {
          this.emit.line(`, ...${args}.slice(1)`);
        }
        this.emit.line(');');
        this.emit.line('  return result === true;');
      }, true);
    } else {
      this.emit(`(${testFunc} ? ${testFunc}.call(context, `);
      this.compile(node.left, frame);
      if (node.right.args) {
        this.emit(', ');
        this.compile(node.right.args, frame);
      }
      this.emit(`) : (() => { var err = runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}", context.path); throw err; })())`);
      this.emit(' === true');
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

  compileLookupVal(node, frame) {
    if (node.isAsync) {
      // Handle both sequential and standard lookups.

      // Check if this is a sequential lookup (marked with `!`).
      let nodeStaticPathKey = node.lockKey; // this.sequential._extractStaticPathKey(node);
      if (nodeStaticPathKey && this._isDeclared(frame /*.sequenceLockFrame*/, nodeStaticPathKey)) {
        // This is a sequential lookup.
        // Register the static path key as a variable write so the next lock waits for it.
        // Multiple static path keys can be in the same block.
        this.async.updateFrameWrites(frame, nodeStaticPathKey);

        // Create the error context and pass it to the runtime function.
        const errorContextJson = JSON.stringify(this._createErrorContext(node));
        if (this.scriptMode) {
          this.emit(`runtime.sequentialMemberLookupScriptAsync(frame, (`);
        } else {
          this.emit(`runtime.sequentialMemberLookupAsync(frame, (`);
        }
        this.compile(node.target, frame); // Compile the object being accessed.
        this.emit('),');
        this.compile(node.val, frame); // Compile the property/key expression.
        // Pass the static path key and the error context.
        // The runtime function will also release the lock.
        this.emit(`, ${JSON.stringify(nodeStaticPathKey)}, ${errorContextJson})`);
        return;
      }

      // This is a standard (non-sequential) async member lookup.
      // Pass the error context directly to the runtime function.
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      if (this.scriptMode) {
        this.emit(`runtime.memberLookupScriptAsync((`);
      } else {
        this.emit(`runtime.memberLookupAsync((`);
      }
      this.compile(node.target, frame);
      this.emit('),');
      this.compile(node.val, frame);
      this.emit(`, ${errorContextJson})`);
      return; // IMPORTANT: End of all async logic.
    }

    // Sync path, this is for standard, synchronous member lookups.
    // Error handling is managed by the top-level try/catch of the compiled template.
    if (this.scriptMode) {
      this.emit(`runtime.memberLookupScript((`);
    } else {
      this.emit(`runtime.memberLookup((`);
    }
    this.compile(node.target, frame); // Mark target as part of a call path
    this.emit('),');
    this.compile(node.val, frame);
    this.emit(')');
  }

  compileFunCall(node, frame) {
    // Keep track of line/col info at runtime by setting
    // variables within an expression (SYNC MODE ONLY).
    if (!this.asyncMode) {
      this.emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');
    }

    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');

    if (this.asyncMode) {

      const sequenceLockKey = node.lockKey;//this.sequential._getSequenceKey(node.name, frame);
      if (sequenceLockKey) {
        let index = sequenceLockKey.indexOf('!', 1);
        const keyRoot = sequenceLockKey.substring(1, index === -1 ? sequenceLockKey.length : index);
        if (this._isDeclared(frame, keyRoot)) {
          this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        }
        this.async.updateFrameWrites(frame, sequenceLockKey);
      }
      let asyncName = node.name.isAsync;
      if (node.name.typename === 'Symbol' && !frame.lookup(node.name.value)) {
        asyncName = false;
      }
      asyncName = true;
      if (asyncName) {
        // Function name is dynamic, so resolve both function and arguments.
        const mergedNode = {
          isAsync: node.name.isAsync || node.args.isAsync,
          children: (node.args.children.length > 0) ? [node.name, ...node.args.children] : [node.name]
        };
        this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
          const errorContextJson = JSON.stringify(this._createErrorContext(node));
          if (!sequenceLockKey) {
            this.emit(`return runtime.callWrapAsync(${result}[0], "${funcName}", context, ${result}.slice(1), ${errorContextJson});`);
          } else {
            this.emit(`return runtime.sequentialCallWrap(${result}[0], "${funcName}", context, ${result}.slice(1), frame, "${sequenceLockKey}", ${errorContextJson});`);
          }
        });
      } else {
        // not used for now
        // @todo - finish async name handling
        // We probably need some static analysis to know for sure a name is not async
        // {% set asyncFunc = getAsyncFunction() %}
        // {{ asyncFunc(arg1, arg2) }}
        // Function name is not async, so resolve only the arguments.
        this._compileAggregate(node.args, frame, '[', ']', true, false, function (result) {
          const errorContextJson = JSON.stringify(this._createErrorContext(node));
          this.emit(`return runtime.callWrapAsync(`);
          this.compile(node.name, frame);
          this.emit.line(`, "${funcName}", context, ${result}, ${errorContextJson});`);
        }); // Resolve arguments using _compileAggregate.
      }
    } else {
      // In sync mode, compile as usual.
      this.emit('runtime.callWrap(');
      this.compile(node.name, frame);
      // Sync mode is different from async mode in that context is the
      // Context class instance not the render method context object
      // This is different from non-global objects that pass the parent of
      // the function as 'this' which is part of the context object
      this.emit(', "' + funcName + '", context, ');
      this._compileAggregate(node.args, frame, '[', ']', false, false);
      this.emit('))');
    }
  }

  compileFilterGet(node, frame) {
    this.emit('env.getFilter("' + node.value + '")');//@todo I think this can not be async
  }

  //todo tests
  // compileFilterAsync with arguments
  // a chain of filters
  // non-async compileFilter
  // async compileFilter with arguments
  compileFilter(node, frame) {
    this.assertType(node.name, nodes.Symbol);

    if (node.isAsync) {
      // Although filters are compiled differently to expressions -
      // using temp var for the result so we can't wrap it as expression
      // still we need to process it as expression for its arguments
      // and wrap if the wrapInAsyncBlock is true
      this.sequential.processExpression(node, frame);

      const filterGetNode = { value: node.name.value, typename: 'FilterGet' };
      const mergedNode = {
        isAsync: true,
        children: [filterGetNode, ...node.args.children]
      };
      if (!node.wrapInAsyncBlock) {
        this._compileAggregate(mergedNode, frame, '[', ']', true, false, function (result) {
          this.emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
        });
      } else {
        this.emit.asyncBlockValue(mergedNode, frame, (n, f) => {
          this._compileAggregate(n, f, '[', ']', true, false, function (result) {
            this.emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
          });
        }, undefined, node.args);
      }
    } else {
      this.emit('env.getFilter("' + node.name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this.emit(')');
    }
  }

  compileFilterAsync(node, frame) {
    let symbol = node.symbol.value;

    this.assertType(node.name, nodes.Symbol);

    frame.set(symbol, symbol);

    if (node.isAsync) {
      // Although filters are compiled differently to expressions,
      // using temp var for the result so it can't be wrapped as expression
      // still we need to process it as expression for its arguments
      this.sequential.processExpression(node, frame);

      this.emit.line(`let ${symbol} = `);
      // Use node.args as the position node since it's what's being evaluated async
      if (!node.wrapInAsyncBlock) {
        this._compileAggregate(node.args, frame, '[', ']', true, false, function (result) {
          this.emit(`return env.getFilter("${node.name.value}").bind(env)(...${result});`);
        });
      } else {
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          this._compileAggregate(n.args, f, '[', ']', true, false, function (result) {
            this.emit(`return env.getFilter("${node.name.value}").bind(env)(...${result});`);
          });
        }, undefined, node.args);
      }
      this.emit(';');
    } else {
      this.emit('env.getFilter("' + node.name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this.emit.line(', ' + this._makeCallback(symbol));
      this.emit.addScopeLevel();
    }

  }

  compileKeywordArgs(node, frame) {
    this.emit('runtime.makeKeywordArgs(');
    this.compileDict(node, frame);
    this.emit(')');
  }

  compileCaller(node, frame) {
    // basically an anonymous "macro expression"
    this.emit('(function (){');
    const funcId = this._compileMacro(node, frame, true);
    this.emit(`return ${funcId};})()`);
  }

  // This method will be implemented in the derived Compiler class
  _compileMacro(node, frame, keepFrame) {
    throw new Error('_compileMacro must be implemented in the derived class');
  }

  /**
   * Compiles a virtual "DataPath" node into a JavaScript array literal.
   * While there is no DataPath node in the AST, we create a temporary node with
   * typename 'DataPath' and pathNode property to store the actual AST for the path.
   * This is used to compile the first argument (path) of @data commands
   * where a path like "user.posts[0].title"
   * needs to be converted into a JavaScript array like ['user', 'posts', 0, 'title'].
   * The method recursively traverses the AST nodes representing the path and generates
   * JavaScript code that builds this array. It handles:
   * - Symbol nodes (variable names like 'user')
   * - LookupVal nodes (property access like '.posts' or array access like '[0]')
   * - Special case for empty bracket notation '[]'
   * - Special case for null (represents root of data object)
   */
  compileDataPath(node, frame) {
    // Flatten the path into a NodeList and use _compileAggregate
    // _compileAggregate will automatically handle sync vs async based on node.isAsync
    const pathNodes = this._flattenPathToNodeList(node.pathNode);
    this._compileAggregate(pathNodes, frame, '[', ']', true, true);
  }

  /**
   * Helper to flatten a path into a NodeList of path segments.
   * Converts a path AST (Symbol, LookupVal, Literal nodes) into a flat array
   * of path segments that can be compiled into a JavaScript array literal.
   *
   * @param {nodes.Node} pathNode - The AST node representing the path
   * @returns {nodes.NodeList} A NodeList containing the flattened path segments
   */
  _flattenPathToNodeList(pathNode) {
    const segments = [];
    const flatten = (node) => {
      if (node instanceof nodes.Symbol) {
        segments.push(new nodes.Literal(node.lineno, node.colno, node.value));
      } else if (node instanceof nodes.LookupVal) {
        flatten(node.target);
        if (node.val === null) {
          segments.push(new nodes.Literal(node.lineno, node.colno, '[]'));
        } else {
          segments.push(node.val);
        }
      } else if (node instanceof nodes.Literal && node.value === null) {
        segments.push(new nodes.Literal(node.lineno, node.colno, null));
      } else {
        this.fail('Invalid node type in path for @data command. Only symbols, lookups, and null are allowed.',
          node.lineno, node.colno, node);
      }
    };
    flatten(pathNode);

    const nodeList = new nodes.NodeList(pathNode.lineno, pathNode.colno, segments);
    nodeList.isAsync = segments.some(seg => seg.isAsync);
    return nodeList;
  }

  // --- Expression Dispatchers ---

  compileAwaited(node, frame) {
    if (node.isAsync) {
      this.emit('(await ');
      this.compile(node, frame);
      this.emit(')');
    } else {
      this.compile(node, frame);
    }
  }

  _compileAwaitedExpression(node, frame, forceWrap) {
    if (node.isAsync) {
      this.emit('(await ');
      this._compileExpression(node, frame, forceWrap);
      this.emit(')');
    } else {
      this._compileExpression(node, frame, false);
    }
  }

  // @todo - audit compileExpression and wrapping
  // @todo - _compileExpression should take care of it's own async block wrapping
  _compileExpression(node, frame, forceWrap, positionNode) {
    // I'm not really sure if this type check is worth it or not.
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

    if (node.isAsync) {

      if (node instanceof nodes.Symbol && node.isCompilerInternal) {
        // Don't wrap compiler-internal symbols - they're plain JS variables
        this.compile(node, frame);
        return;
      }

      if (this.emit.asyncClosureDepth === 0 && !forceWrap) {
        // some expressions compile await (@todo - check if so) so they need be in async context
        this.fail('All expressions must be wrapped in an async IIFE', node.lineno, node.colno, node);
      }

      this.sequential.processExpression(node, frame);
      if (forceWrap || node.wrapInAsyncBlock) {
        node.wrapInAsyncBlock = false;//so that compile won't wrap it and ignore positionNode
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          this.compile(n, f);
        }, undefined, positionNode ?? node);
      } else {
        this.compile(node, frame);
      }
    } else {
      this.compile(node, frame);
    }
  }
}

module.exports = CompilerBase;
