'use strict';

const nodes = require('../nodes');
const { TemplateError } = require('../lib');
// const { Frame, AsyncFrame } = require('./runtime'); // Not used in base class
const { Obj } = require('../object');
const {
  validateSinkSnapshotInGuard
} = require('./validation');

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
    this.idPool = options && options.idPool ? options.idPool : null;
    this.throwOnUndefined = options.throwOnUndefined || false;
    this.asyncMode = options.asyncMode || false;
    this.scriptMode = options.scriptMode || false;
    this.guardDepth = 0;
    this.importedBindings = new Set();

    // These will be instantiated by the derived Compiler class
    // and are essential for expression compilation.
    this.sequential = null;
    this.emit = null;
    this.async = null;
  }

  compile(node, frame) {
    var _compile = this['compile' + node.typename];
    if (_compile) {
      _compile.call(this, node, frame);
    } else {
      this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno, node);
    }
  }

  // --- Core Utilities (Needed by Expressions) ---

  _generateErrorContext(node, positionNode) {
    if (!node) return 'UnknownContext';
    // Special case for ChannelCommand for more descriptive errors
    if (node.typename === 'ChannelCommand' && node.call && node.call.name) {
      const staticPath = this.sequential._extractStaticPath(node.call.name);
      if (staticPath) {
        return staticPath.join('.');
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
    if (this.idPool && typeof this.idPool.next === 'function') {
      return 't_' + this.idPool.next();
    }
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

  _nodeDeclaresOutput(node, name) {
    const declares = node._analysis.declares;
    return Array.isArray(declares) && declares.some((decl) => decl && decl.name === name);
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
    let doResolve = resolveItems && this.asyncMode;
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
      let wrapper = null;
      if (this.asyncMode) {
        if (startChar === '[') wrapper = 'runtime.createArray';
        if (startChar === '{') wrapper = 'runtime.createObject';
      }

      if (compileThen) {
        const result = this._tmpid();
        this.emit.line(`(${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this.emit('})(');
      }

      if (wrapper) this.emit(wrapper + '(');
      this.emit(startChar);
      this._compileArguments(node, frame, expressionRoot, startChar);
      this.emit(endChar);
      if (wrapper) this.emit(')');

      if (compileThen) {
        this.emit(')');
      }
    }
  }

  _compileResolvedPartList(partCompilers, compileThen, asyncThen) {
    if (partCompilers.length === 1) {
      this.emit('runtime.resolveSingleArr(');
      partCompilers[0].call(this);
      this.emit(')');
    } else if (partCompilers.length === 2) {
      this.emit('runtime.resolveDuo(');
      partCompilers[0].call(this);
      this.emit(',');
      partCompilers[1].call(this);
      this.emit(')');
    } else {
      this.emit('runtime.resolveAll([');
      for (let i = 0; i < partCompilers.length; i++) {
        if (i > 0) {
          this.emit(',');
        }
        partCompilers[i].call(this);
      }
      this.emit('])');
    }

    if (compileThen) {
      const result = this._tmpid();
      this.emit(`.then(${asyncThen ? 'async ' : ''}function(${result}){`);
      compileThen.call(this, result, partCompilers.length);
      this.emit(' })');
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

  _binFuncEmitter(node, frame, funcName, separator = ',') {
    if (this.asyncMode) {
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
    if (this.asyncMode) {
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
    if (this.asyncMode) {
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

  analyzeSymbol(node, analysisPass) {
    if (node._analysis?.declarationTarget || node.isCompilerInternal) {
      return {};
    }
    const name = node.value;

    const uses = [];
    const mutates = [];
    const sequenceLockLookup = this.asyncMode ? this.sequential.getSequenceLockLookup(node) : null;
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      uses.push(sequenceLockLookup.key);
      if (sequenceLockLookup.repair) {
        mutates.push(sequenceLockLookup.key);
      }
    }

    if (analysisPass.findDeclaration(node._analysis, name)) {
      uses.push(name);
    }

    return { uses, mutates };
  }

  compileSymbol(node, frame) {

    let name = node.value;
    if (node.isCompilerInternal) {
      // Compiler-generated temp symbols (e.g. lifted super/filter temps)
      // are emitted as direct JS locals and never resolved from frame/context.
      this.emit(name);
      return;
    }
    const declaredOutput = this.analysis.findDeclaration(node._analysis, name);
    if (declaredOutput) {
      if (node.sequential || node.sequentialRepair) {
        this._failNonContextSequenceRoot(node, declaredOutput);
      }
      if (declaredOutput.type === 'var') {
        if (!this.scriptMode && this.inBlock) {
          // Block functions can read var channels declared in the child root buffer
          // while executing under a parent block buffer. Use runtime var lookup
          // there so cross-tree reads resolve against the producer buffer.
          this.emit(`runtime.varChannelLookup("${name}", ${this.buffer.currentBuffer})`);
          return;
        }
        // Var channels are read as point-in-stream snapshots when used as symbols.
        // This makes `x` equivalent to `x.snapshot()` in expressions.
        this.buffer.emitAddSnapshot(frame, name, node);
        return;
      }
      this.fail(
        `Channel '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
    // Not in template scope, check context/frame with potential sequence lock
    if (this.asyncMode) {
      const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
      const nodeStaticPathKey = sequenceLockLookup && sequenceLockLookup.key;
      if (nodeStaticPathKey) {
        this._assertSequenceRootIsContextPath(frame, nodeStaticPathKey, node);
        // This node accesses a declared sequence lock path.
        // Register the static path key as variable write so the next lock would wait for it
        // Multiple static path keys can be in the same block
        // @todo - optimization: if there are no further funCalls with lock on the path,
        // emit a terminal marker so follow-up accesses can skip redundant lock plumbing.

        if (this.scriptMode) {
          this.emit(`runtime.sequentialContextLookupScriptValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
        } else {
          this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
        }
        return;
      }
    }
    else {//not async mode
      const v = frame.lookup(name);
      if (v) {
        //we are using a local variable, this is currently used only for:
        //the async filter, super(), set var
        this.emit(v);
        return;
      }
    }
    if (this.scriptMode) {
      this.emit('runtime.contextOrVarLookupScriptAsync(' +
        'context, "' + name + '", ' +
        `${this.buffer.currentBuffer}, ` +
        `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this._generateErrorContext(node))}, path: context.path }` +
        ')');
    } else {
      const useContextOnlyInheritanceLookup =
        this.asyncMode &&
        this.inBlock &&
        !this.analysis.findDeclaration(node._analysis, name);
      if (useContextOnlyInheritanceLookup) {
        const contextRef = this._tmpid();
        // Preserve context-first semantics for non-output names, then only fall back
        // to channel-aware lookup for dynamic var-channel visibility.
        this.emit('(() => {');
        this.emit(`const ${contextRef} = context.lookup("${name}");`);
        this.emit(`if (${contextRef} !== undefined) { return ${contextRef}; }`);
        this.emit(`return runtime.contextOrVarLookup(context, "${name}", ${this.buffer.currentBuffer});`);
        this.emit('})()');
      } else if (!this.asyncMode) {
        this.emit(`runtime.contextOrFrameLookup(context, frame, "${name}")`);
      } else {
        this.emit(`runtime.contextOrVarLookup(context, "${name}", ${this.buffer.currentBuffer})`);
      }
    }
  }

  //todo - do not resolve, instead resolve it at the point of use: output or argument to functions, filters. Add tests
  // or better - return a promise
  //maybe resolve the unused/not-last elements?
  compileGroup(node, frame) {
    this._compileAggregate(node, frame, '(', ')', true, false);
  }

  //todo - do not resolve, instead resolve it at the point of use: output or argument to functions, filters. Add tests
  //do not return a promise for the whole thing so that resolved elements can be used as soon as possible
  compileArray(node, frame) {
    this._compileAggregate(node, frame, '[', ']', !!node.mustResolve, false);
  }

  //todo - Add other usage tests - function argument, filter argument, output
  compileDict(node, frame) {
    //do not resolve dictionary values, this is handled by memberLookupAsync
    this._compileAggregate(node, frame, '{', '}', false, false);
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
    if (this.asyncMode) {
      const hasCommandEffects = !!(node._analysis && node._analysis.mutatedChannels && node._analysis.mutatedChannels.size > 0);
      if (hasCommandEffects) {
        this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, frame, function(boundaryFrame) {
          this.emit('const cond = await runtime.resolveSingle(');
          this.compile(node.cond, boundaryFrame);
          this.emit.line(');');
          this.emit('if(cond) {');
          this.emit('return ');
          this.compile(node.body, boundaryFrame);
          this.emit.line(';');
          this.emit('} else {');
          if (node.else_) {
            this.emit('return ');
            this.compile(node.else_, boundaryFrame);
            this.emit.line(';');
          } else {
            this.emit.line('return "";');
          }
          this.emit('}');
        });
        return;
      }

      this.emit('runtime.resolveSingle(');
      this.compile(node.cond, frame);
      this.emit(').then(async function(cond) {');

      this.emit('  if(cond) {');
      this.emit('    return ');
      this.compile(node.body, frame);
      this.emit(';');

      this.emit('  } else {');

      if (node.else_) {
        this.emit('    return ');
        this.compile(node.else_, frame);
        this.emit(';');
      } else {
        this.emit('    return "";');
      }
      this.emit('  }'); // End else

      this.emit('})');
    } else {
      // Sync execution
      this.emit('(');
      this.compile(node.cond, frame);
      this.emit('?');
      this.compile(node.body, frame);
      this.emit(':');
      if (node.else_ !== null) {
        this.compile(node.else_, frame);
      } else {
        this.emit('""');
      }
      this.emit(')');
    }
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
      const channelName = this._getObservedChannelName(node.left, frame);
      if (channelName) {
        this.buffer.emitAddIsError(frame, channelName, node.left);
        return;
      }
      // Special case for 'is error' in async mode. We do not want to await the
      // value, as that would trigger the poison system. Instead, we pass the
      // raw value (which may be a promise) to the test function.
      this.emit('runtime.isError(');
      this.compile(node.left, frame);
      this.emit(')');
      return;
    }

    if (this.asyncMode) {
      const mergedNode = {
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
    if (this.asyncMode) {
      this._compileBinOpShortCircuit(node, frame, true);
    } else {
      this._binOpEmitter(node, frame, ' || ');
    }
  }

  compileAnd(node, frame) {
    if (this.asyncMode) {
      this._compileBinOpShortCircuit(node, frame, false);
    } else {
      this._binOpEmitter(node, frame, ' && ');
    }
  }

  _compileBinOpShortCircuit(node, frame, isOr) {
    // left || right -> if (left) return left; else return right;
    // left && right -> if (!left) return left; else return right;
    const hasCommandEffects = !!(node._analysis && node._analysis.mutatedChannels && node._analysis.mutatedChannels.size > 0);
    if (hasCommandEffects) {
      this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, frame, function(boundaryFrame) {
        this.emit('const left = await runtime.resolveSingle(');
        this.compile(node.left, boundaryFrame);
        this.emit.line(');');
        const check = isOr ? 'left' : '!left';
        this.emit(`if (${check}) {`);
        this.emit.line('return left;');
        this.emit('} else {');
        this.emit('return ');
        this.compile(node.right, boundaryFrame);
        this.emit.line(';');
        this.emit('}');
      });
      return;
    }

    this.emit('runtime.resolveSingle(');
    this.compile(node.left, frame);
    this.emit(').then(async function(left) {');

    const check = isOr ? 'left' : '!left';
    this.emit(`  if (${check}) {`);

    this.emit('    return left;');
    this.emit('  }');
    this.emit('  else {');
    this.emit('    return ');
    this.compile(node.right, frame);
    this.emit(';');

    this.emit('  }'); // End else
    this.emit('})');
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

  compilePeekError(node, frame) {
    if (this.asyncMode) {
      const channelName = this._getObservedChannelName(node.target, frame);
      if (channelName) {
        this.buffer.emitAddGetError(frame, channelName, node.target);
        return;
      }
    }
    this.emit('runtime.peekError(');
    this.compile(node.target, frame);
    this.emit(')');
  }

  _getObservedChannelName(targetNode, frame) {
    if (!this.scriptMode || !targetNode) {
      return null;
    }
    // Sequence-marked targets (path! / path!!) are handled by sequential-path
    // compilation and must not be reinterpreted as var-channel observation.
    if (targetNode.sequential) {
      return null;
    }

    if (targetNode instanceof nodes.Symbol) {
      const name = targetNode.value;
      const channelDecl = this.analysis.findDeclaration(targetNode._analysis, name);
      if (channelDecl) {
        return name;
      }
      return null;
    }

    if (targetNode instanceof nodes.FunCall) {
      const candidate = this.sequential._extractStaticPathRoot(targetNode.name, 2);
      if (candidate) {
        const channelDecl = this.analysis.findDeclaration(targetNode._analysis, candidate);
        if (channelDecl) {
          return candidate;
        }
      }
      return null;
    }

    return null;
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
    if (this.asyncMode) {
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

  analyzeLookupVal(node, analysisPass) {
    const uses = [];
    const mutates = [];
    let sequenceChannelLookup = null;
    const sequenceLockLookup = this.asyncMode ? this.sequential.getSequenceLockLookup(node) : null;
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      uses.push(sequenceLockLookup.key);
      if (sequenceLockLookup.repair) {
        mutates.push(sequenceLockLookup.key);
      }
    }

    if (this.scriptMode) {
      const sequencePath = this.sequential._extractStaticPath(node);
      const lookupFacts =
        sequencePath && sequencePath.length >= 2
          ? (() => {
            const channelName = sequencePath[0];
            const channelDecl = analysisPass.findDeclaration(node._analysis, channelName);
            const propertyName = sequencePath[sequencePath.length - 1];
            if (!channelDecl || channelDecl.type !== 'sequence' || propertyName === 'snapshot') {
              return null;
            }
            return {
              channelName,
              propertyName,
              subpath: sequencePath.slice(1, -1)
            };
          })()
          : null;
      if (lookupFacts) {
        uses.push(lookupFacts.channelName);
        sequenceChannelLookup = lookupFacts;
      }
    }

    return { uses, mutates, sequenceChannelLookup };
  }

  compileLookupVal(node, frame) {
    if (this.asyncMode) {
      const sequenceChannelLookup =
        node._analysis && node._analysis.sequenceChannelLookup;
      if (this.scriptMode && sequenceChannelLookup) {
        this.buffer.emitAddSequenceGet(
          frame,
          sequenceChannelLookup.channelName,
          sequenceChannelLookup.propertyName,
          sequenceChannelLookup.subpath,
          node
        );
        return;
      }

      // Handle both sequential and standard lookups.

      // Check if this is a sequential lookup (marked with `!`).
      const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
      const nodeStaticPathKey = sequenceLockLookup && sequenceLockLookup.key;
      if (nodeStaticPathKey) {
        this._assertSequenceRootIsContextPath(frame, nodeStaticPathKey, node);
        // This is a sequential lookup.
        // Register the static path key as a variable write so the next lock waits for it.
        // Multiple static path keys can be in the same block.

        // Create the error context and pass it to the runtime function.
        const errorContextJson = JSON.stringify(this._createErrorContext(node));
        if (this.scriptMode) {
          this.emit('runtime.sequentialMemberLookupScriptAsyncValue((');
        } else {
          this.emit('runtime.sequentialMemberLookupAsyncValue((');
        }
        this.compile(node.target, frame); // Compile the object being accessed.
        this.emit('),');
        this.compile(node.val, frame); // Compile the property/key expression.
        this.emit(`, "${nodeStaticPathKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
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

  analyzeFunCall(node, analysisPass) {
    const uses = [];
    const mutates = [];
    let specialChannelCall = null;
    let importedCallable = null;
    let directCallerCall = false;
    let directMacroCall = null;
    const sequenceLockLookup = this.asyncMode ? this.sequential.getSequenceLockLookup(node) : null;
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      uses.push(sequenceLockLookup.key);
      mutates.push(sequenceLockLookup.key);
      return { uses, mutates };
    }

    // caller() calls can emit command structure and must be dispatched in the
    // current boundary instead of behind deferred .then(...) lowering in
    // both template and script call-block bodies.
    if (node.name) {
      const isCallerCall =
          (node.name instanceof nodes.Symbol && node.name.value === 'caller') ||
          this.sequential._extractStaticPathRoot(node.name) === 'caller';
      if (isCallerCall) {
        directCallerCall = true;
        const textChannel = analysisPass.getCurrentTextChannel(node._analysis);
        if (textChannel) {
          uses.push(textChannel);
          mutates.push(textChannel);
        }
        return { uses, mutates, directCallerCall };
      }
    }

    if (this.asyncMode && node.name instanceof nodes.Symbol && analysisPass.findDeclaration) {
      const macroDecl = analysisPass.findDeclaration(node._analysis, node.name.value);
      if (macroDecl && macroDecl.isMacro) {
        directMacroCall = {
          binding: macroDecl.declarationOrigin ? macroDecl.declarationOrigin.compiledMacroFuncId : null
        };
      }
    }

    if (this.asyncMode && node?.name && analysisPass.findDeclaration) {
      const importedRoot = this.sequential._extractStaticPathRoot(node.name);
      const importedDecl = importedRoot ? analysisPass.findDeclaration(node._analysis, importedRoot) : null;
      const isImportedCallable = !!(
        (importedDecl && importedDecl.imported) ||
        (!importedDecl && importedRoot && this.importedBindings && this.importedBindings.has(importedRoot))
      );
      if (isImportedCallable) {
        importedCallable = true;
        const visibleChannels = analysisPass.getIncludeVisibleVarChannels(node._analysis)
          .map((entry) => entry.runtimeName);
        const textChannel = analysisPass.getCurrentTextChannel(node._analysis);
        const allUses = new Set(visibleChannels);
        if (textChannel) {
          allUses.add(textChannel);
        }
        allUses.forEach((name) => uses.push(name));
      }
    }

    const callFacts =
      this.asyncMode &&
      this.scriptMode &&
      node &&
      node.name &&
      !(node._analysis && node._analysis.sequenceLockLookup)
        ? (() => {
          const sequencePath = this.sequential._extractStaticPath(node.name);
          if (!sequencePath || sequencePath.length < 2) {
            return null;
          }

          const channelName = sequencePath[0];
          const channelDecl = analysisPass.findDeclaration(node._analysis, channelName);
          if (!channelDecl) {
            return null;
          }

          const methodName = sequencePath[sequencePath.length - 1];
          return {
            channelName,
            channelType: channelDecl.type,
            methodName,
            subpath: sequencePath.slice(1, -1),
            isObservation:
                sequencePath.length === 2 &&
                (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError')
          };
        })()
        : null;
    if (callFacts) {
      uses.push(callFacts.channelName);
      if (!callFacts.isObservation) {
        mutates.push(callFacts.channelName);
      }
      specialChannelCall = callFacts;
    }

    return { uses, mutates, specialChannelCall, importedCallable, directCallerCall, directMacroCall };
  }

  compileFunCall(node, frame) {
    // Keep track of line/col info at runtime by setting
    // variables within an expression (SYNC MODE ONLY).
    if (!this.asyncMode) {
      this.emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');
    }

    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');
    const directMacroCall = this.asyncMode ? node._analysis.directMacroCall : null;
    const directMacroBinding = directMacroCall ? directMacroCall.binding : null;
    const isDirectMacroCall = !!directMacroCall;
    const importedCallableFacts = this.asyncMode ? node._analysis.importedCallable : null;

    if (this.asyncMode) {
      if (this._compileSpecialChannelFunCall(node, frame)) {
        return;
      }

      if (this.macro && this.macro.isDirectCallerCall(node)) {
        this.macro._emitCallerCallDispatch({
          bufferId: this.buffer.currentBuffer,
          node,
          frame
        });
        return;
      }

      const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
      const sequenceLockKey = sequenceLockLookup && sequenceLockLookup.key;
      if (sequenceLockKey) {
        let index = sequenceLockKey.indexOf('!', 1);
        const keyRoot = sequenceLockKey.substring(1, index === -1 ? sequenceLockKey.length : index);
        const keyRootOutput = this.analysis.findDeclaration(node._analysis, keyRoot);
        const keyRootSyntheticVar = frame && frame.resolve && frame.resolve(keyRoot, false);
        if (keyRootOutput || keyRootSyntheticVar) {
          this._failNonContextSequenceRoot(node, keyRootOutput);
        }
      }
      if (sequenceLockKey) {
        const errorContextJson = JSON.stringify(this._createErrorContext(node));
        this.emit('runtime.sequentialCallWrapValue(');
        this.compile(node.name, frame);
        this.emit(`, "${funcName}", context, `);
        this._compileAggregate(node.args, frame, '[', ']', false, false);
        this.emit(`, "${sequenceLockKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
        return;
      }
      if (isDirectMacroCall) {
        this.emit('runtime.invokeMacro(');
        if (directMacroBinding) {
          this.emit(directMacroBinding);
        } else {
          this.compile(node.name, frame);
        }
        this.emit(', context, ');
        this._compileAggregate(node.args, frame, '[', ']', false, false);
        this.emit(`, ${this.buffer.currentBuffer})`);
        return;
      }
      if (importedCallableFacts) {
        // Imported callables are structurally ambiguous: they may resolve to a
        // macro boundary or an ordinary function. Give them a child buffer up
        // front so the eventual dispatch happens inside a known current flow.
        this.boundaries.compileValueBoundary(this.buffer, node, frame, (n, f) => {
          this._emitAsyncDynamicCall(n, f, 'currentBuffer');
        });
        return;
      }
      // Dynamic async calls should dispatch in the current boundary with raw
      // promise-valued callee/args, not from a later .then(...).
      this._emitAsyncDynamicCall(node, frame, this.buffer.currentBuffer);
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
      this.emit(`, ${this.buffer.currentBuffer}))`);
    }
  }

  _compileSpecialChannelFunCall(node, frame) {
    if (!this.scriptMode) {
      return false;
    }
    const specialChannelCall = node._analysis && node._analysis.specialChannelCall;
    if (!specialChannelCall) {
      return false;
    }
    if (specialChannelCall.channelType === 'var') {
      // Var should behave like a normal value in expressions:
      // implicit var read first, then regular member/method access.
      return false;
    }
    if (this._compileChannelObservationFunCall(node, frame, specialChannelCall)) {
      return true;
    }
    return this._compileSequenceChannelFunCall(node, frame, specialChannelCall);
  }

  _assertSequenceRootIsContextPath(frame, lockKey, node) {
    if (!lockKey || lockKey.charAt(0) !== '!') {
      return;
    }
    const sepIndex = lockKey.indexOf('!', 1);
    const keyRoot = lockKey.substring(1, sepIndex === -1 ? lockKey.length : sepIndex);
    if (!keyRoot) {
      return;
    }
    const keyRootOutput = this.analysis.findDeclaration(node._analysis, keyRoot);
    const keyRootSyntheticVar = frame && frame.resolve && frame.resolve(keyRoot, false);
    if (keyRootOutput || keyRootSyntheticVar) {
      this._failNonContextSequenceRoot(node, keyRootOutput);
    }
  }

  _failNonContextSequenceRoot(node, declaration = null) {
    if (declaration && declaration.macroParam) {
      this.fail('Sequence marker (!) is not allowed inside macros', node.lineno, node.colno, node);
    }
    this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
  }

  _compileChannelObservationFunCall(node, frame, specialChannelCall) {
    if (specialChannelCall.subpath.length !== 0) {
      return false;
    }
    validateSinkSnapshotInGuard(this, {
      node,
      command: specialChannelCall.methodName,
      channelType: specialChannelCall.channelType
    });
    if (specialChannelCall.methodName === 'snapshot') {
      this.buffer.emitAddSnapshot(frame, specialChannelCall.channelName, node);
      return true;
    }
    if (specialChannelCall.methodName === 'isError') {
      this.buffer.emitAddIsError(frame, specialChannelCall.channelName, node);
      return true;
    }
    if (specialChannelCall.methodName === 'getError') {
      this.buffer.emitAddGetError(frame, specialChannelCall.channelName, node);
      return true;
    }
    return false;
  }

  _compileSequenceChannelFunCall(node, frame, specialChannelCall) {
    if (specialChannelCall.channelType !== 'sequence' || specialChannelCall.methodName === 'snapshot') {
      return false;
    }
    this._compileAggregate(node.args, frame, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
        frame,
        specialChannelCall.channelName,
        specialChannelCall.methodName,
        specialChannelCall.subpath,
        resolvedArgs,
        node
      );
      this.emit(';');
    });
    return true;
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

    if (this.asyncMode) {
      // Although filters are compiled differently to expressions -
      // they still compile to a normal promise-valued expression.
      // Any outer structural wrapping should happen at the caller site,
      // not here.
      const parts = [
        function () {
          this.emit(`env.getFilter("${node.name.value}")`);
        },
        ...node.args.children.map((arg) => function () {
          this.compile(arg, frame);
        })
      ];
      this._compileResolvedPartList(parts, function (result) {
        this.emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
      }, false);
    } else {
      this.emit('env.getFilter("' + node.name.value + '").call(context, ');
      this._compileAggregate(node.args, frame, '', '', false, false);
      this.emit(')');
    }
  }

  compileFilterAsync(node, frame) {
    let symbol = node.symbol.value;

    this.assertType(node.name, nodes.Symbol);

    if (this.asyncMode) {
      // Although filters are compiled differently to expressions,
      // they still compile to a normal promise-valued expression.
      // Any outer structural wrapping should happen at the caller site,
      // not here.
      this.emit.line(`let ${symbol} = `);
      this._compileAggregate(node.args, frame, '[', ']', true, false, function (result) {
        this.emit(`return env.getFilter("${node.name.value}").bind(env)(...${result});`);
      });
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

  analyzeCaller(node) {
    return this.macro.analyzeCaller(node);
  }

  _emitAsyncDynamicCall(node, frame, currentBufferExpr) {
    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');
    const errorContextJson = JSON.stringify(this._createErrorContext(node));
    this.emit('runtime.callWrapAsync(');
    this.compile(node.name, frame);
    this.emit(`, "${funcName}", context, `);
    this._compileAggregate(node.args, frame, '[', ']', false, false);
    this.emit(`, ${errorContextJson}, ${currentBufferExpr})`);
  }

  compileCaller(node, frame) {
    return this.macro.compileCaller(node, frame);
  }

  // This method will be implemented in the derived Compiler class
  _compileMacro(node, frame, keepFrame) {
    return this.macro._compileMacro(node, frame, keepFrame);
  }

  /**
   * Compiles a virtual "DataPath" node into a JavaScript array literal.
   * While there is no DataPath node in the AST, we create a temporary node with
   * typename 'DataPath' and pathNode property to store the actual AST for the path.
   * This is used to compile the first argument (path) of data commands
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
    // _compileAggregate automatically handles the compiler's sync vs async mode.
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
    // Support two forms:
    // 1) Normal expression path (symbols/lookups/null) -> flatten recursively
    // 2) Array literal of segments (e.g., ['[]', 'status'] or [0, 'status'])
    //    which allows root-level bracket indexing without a leading symbol
    const segments = [];

    if (pathNode instanceof nodes.Array) {
      // Directly use the array items as path segments
      for (const item of pathNode.children) {
        segments.push(item);
      }
      return new nodes.NodeList(pathNode.lineno, pathNode.colno, segments);
    }

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
      } else if (node instanceof nodes.Literal) {
        segments.push(node);
      } else {
        this.fail('Invalid node type in path for data command. Only symbols, lookups, null, or array-literals are allowed.',
          node.lineno, node.colno, node);
      }
    };
    flatten(pathNode);

    return new nodes.NodeList(pathNode.lineno, pathNode.colno, segments);
  }

  // --- Expression Dispatchers ---

  compileAwaited(node, frame) {
    if (this.asyncMode) {
      this.emit('(await ');
      this.compile(node, frame);
      this.emit(')');
    } else {
      this.compile(node, frame);
    }
  }

  _compileAwaitedExpression(node, frame) {
    if (this.asyncMode) {
      this.emit('(await ');
      this._compileExpression(node, frame);
      this.emit(')');
    } else {
      this._compileExpression(node, frame);
    }
  }

  // Statement/root-expression wrapper.
  // In __waited__ scope, root expressions add exactly one completion marker
  // unless the caller opts out for control/composition inputs.
  // `_compileExpression` stays recursive and never emits waited markers itself.
  compileExpression(node, frame, positionNode, excludeFromWaitedRootTracking = false) {
    const shouldEmitOwnWaitedResolve = this.asyncMode &&
      this.buffer.currentWaitedChannelName &&
      !excludeFromWaitedRootTracking;

    if (!shouldEmitOwnWaitedResolve) {
      this._compileExpression(node, frame, positionNode);
      return;
    }

    const resultId = this._tmpid();
    const waitedChannelName = this.buffer.currentWaitedChannelName;
    const waitedOwnerBuffer = this.buffer.currentWaitedOwnerBuffer || this.buffer.currentBuffer;
    const posLiteral = this.buffer._emitPositionLiteral(positionNode ?? node);

    this.emit('(() => { ');
    this.emit(`let ${resultId} = `);
    this._compileExpression(node, frame, positionNode);
    this.emit('; ');
    this.emit(`${waitedOwnerBuffer}.add(new runtime.WaitResolveCommand({ channelName: "${waitedChannelName}", args: [${resultId}], pos: ${posLiteral} }), "${waitedChannelName}"); `);
    this.emit(`return ${resultId}; `);
    this.emit('})()');
  }

  // @todo - audit remaining `_compileExpression` root call sites and move them to
  // `compileExpression` unless they are intentional subexpressions/exclusions.
  // @todo - `_compileExpression` should take care of its own async block wrapping.
  // @todo - !!!  make the CommandBuffer tree synchronously before any expression evaluation
  //         each node will know its current command buffer
  _compileExpression(node, frame, positionNode) {
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
      nodes.PeekError,
      nodes.Compare,
      nodes.NodeList
    );

    if (node instanceof nodes.Symbol && node.isCompilerInternal) {
      // Don't wrap compiler-internal symbols - they're plain JS variables
      this.compile(node, frame);
      return;
    }
    this.compile(node, frame);
  }
}

module.exports = CompilerBase;
