'use strict';

const nodes = require('../nodes');
const { TemplateError } = require('../lib');
// const { Frame, AsyncFrame } = require('./runtime'); // Not used in base class
const { Obj } = require('../object');
const { RESERVED_DECLARATION_NAMES, RESERVED_ASYNC_DECLARATION_NAMES } = require('./validation');
const CompileSequential = require('./sequential');
const CompileEmit = require('./emit');
const CompileInheritance = require('./inheritance');
const CompileLoop = require('./loop');
const CompileBuffer = require('./buffer');
const CompileMacro = require('./macro');
const CompileBoundaries = require('./boundaries');
const CompileChannel = require('./channel');
const CompileComponent = require('./component');
const CompileReturn = require('./return');

/**
 * CompilerCommon - Common base class for compiler functionality
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
class CompilerCommon extends Obj {
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
    this.templateName = typeof options.templateName === 'string' ? options.templateName : undefined;
    this.hasExtends = false;
    this.inBlock = false;
    this.currentCallableDefinition = null;
    this.isCompilingCallableEntry = false;
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = null;
    this.inheritance = new CompileInheritance(this);
    this.loop = new CompileLoop(this);
    this.buffer = new CompileBuffer(this);
    this.macro = new CompileMacro(this);
    this.return = new CompileReturn(this);
    this.boundaries = new CompileBoundaries(this);
    this.channel = new CompileChannel(this);
    this.component = new CompileComponent(this);
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

  _isStaticExtendsNode(node) {
    return node instanceof nodes.Extends &&
      !node.noParentLiteral &&
      node.template instanceof nodes.Literal &&
      typeof node.template.value === 'string';
  }

  _isDynamicExtendsNode(node) {
    return node instanceof nodes.Extends &&
      !node.noParentLiteral &&
      !(node.template instanceof nodes.Literal && typeof node.template.value === 'string');
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

  _parseCallableSignature(argsNode, opts = {}) {
    const allowKeywordArgs = opts.allowKeywordArgs !== false;
    const symbolsOnly = !!opts.symbolsOnly;
    const label = opts.label || 'callable signature';
    const ownerNode = opts.ownerNode || argsNode;
    const args = [];
    let kwargs = null;

    if (!argsNode) {
      return {
        args,
        kwargs,
        positionalNames: [],
        keywordNames: []
      };
    }

    argsNode.children.forEach((arg, i) => {
      if (i === argsNode.children.length - 1 && arg instanceof nodes.KeywordArgs) {
        if (!allowKeywordArgs) {
          this.fail(
            `${label} does not support keyword arguments`,
            arg.lineno,
            arg.colno,
            ownerNode,
            arg
          );
        }
        kwargs = arg;
        return;
      }

      if (symbolsOnly && !(arg instanceof nodes.Symbol)) {
        this.fail(
          `${label} only supports identifier arguments`,
          arg.lineno,
          arg.colno,
          ownerNode,
          arg
        );
      }

      args.push(arg);
    });

    return {
      args,
      kwargs,
      positionalNames: args.map((n) => n.value),
      keywordNames: ((kwargs && kwargs.children) || []).map((n) => n.key.value)
    };
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

  compileIn(node, frame) {
    this._binFuncEmitter(node, frame, 'runtime.inOperator');
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


  _failNonContextSequenceRoot(node, declaration = null) {
    if (declaration && declaration.macroParam) {
      this.fail('Sequence marker (!) is not allowed inside macros', node.lineno, node.colno, node);
    }
    this.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
  }

  compileFilterGet(node, frame) {
    this.emit('env.getFilter("' + node.value + '")');//@todo I think this can not be async
  }

  //todo tests
  // compileFilterAsync with arguments
  // a chain of filters
  // non-async compileFilter
  // async compileFilter with arguments
  compileKeywordArgs(node, frame) {
    this.emit('runtime.makeKeywordArgs(');
    this.compileDict(node, frame);
    this.emit(')');
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

  // Statement/root-expression wrapper.
  // In __waited__ scope, root expressions add exactly one completion marker
  // unless the caller opts out for control/composition inputs.
  // `_compileExpression` stays recursive and never emits waited markers itself.
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
      nodes.Super,
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

  isReservedDeclarationName(name) {
    return RESERVED_DECLARATION_NAMES.has(name) || (this.asyncMode && RESERVED_ASYNC_DECLARATION_NAMES.has(name));
  }

  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  _getInheritanceMetadata(node) {
    return node && node.inheritanceMetadata ? node.inheritanceMetadata : null;
  }

  _getMethodDefinitions(node) {
    const metadata = this._getInheritanceMetadata(node);
    if (!metadata || !metadata.methods || !Array.isArray(metadata.methods.children)) {
      return [];
    }
    return metadata.methods.children.filter((child) => child && child.name && child.name.value !== '__constructor__');
  }

  _getConstructorDefinition(node) {
    const metadata = this._getInheritanceMetadata(node);
    if (!metadata || !metadata.methods || !Array.isArray(metadata.methods.children)) {
      return null;
    }
    return metadata.methods.children.find((child) => child && child.name && child.name.value === '__constructor__') || null;
  }

  _getSharedDeclarations(node) {
    const metadata = this._getInheritanceMetadata(node);
    const inferredSharedDeclarations =
      node && node._analysis && Array.isArray(node._analysis.inferredTemplateSharedDeclarations)
        ? node._analysis.inferredTemplateSharedDeclarations
        : [];
    if (!metadata || !metadata.sharedDeclarations || !Array.isArray(metadata.sharedDeclarations.children)) {
      return inferredSharedDeclarations;
    }
    return metadata.sharedDeclarations.children.filter(Boolean).concat(inferredSharedDeclarations);
  }

  compileNodeList(node, frame) {
    this._compileChildren(node, frame);
  }

  compileTemplateData(node, frame) {
    this.compileLiteral(node, frame);
  }

  /**
   * Retrieves the direct child AST nodes of a given node by iterating over all properties
   * and checking if they are instances of nodes.Node or arrays of nodes.Node
   * @todo public
   * @param {nodes.Node} node - The node to get children from
   * @returns {Array<nodes.Node>} Array of child nodes
   */
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

  getCode() {
    return this.codebuf.join('');
  }

}

module.exports = CompilerCommon;
module.exports.CompilerCommon = CompilerCommon;
