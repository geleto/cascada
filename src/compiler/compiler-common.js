
import * as nodes from '../language/nodes.js';
import {CompileError} from '../errors.js';
import {Obj} from '../object.js';

import {
  isReservedDeclaration,
  isReservedDeclarationName,
} from './reserved.js';
import {CompileSequential} from './sequential.js';
import {CompileEmit} from './emit.js';
import {CompileInheritance} from './inheritance.js';
import {CompileLoop} from './loop.js';
import {CompileBuffer} from './buffer.js';
import {CompileMacro} from './macro.js';
import {CompileBoundaries} from './async-boundaries.js';
import {CompileChain} from './chain.js';
import {CompileComponent} from './component.js';
import {CompileReturn} from './return.js';
import {CompileComposition} from './composition.js';
import {CompileCompositionPayload} from './composition-payload.js';

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
    this.sourceName = typeof options.sourceName === 'string'
      ? options.sourceName
      : (typeof options.templateName === 'string' ? options.templateName : undefined);
    this.sourcePath = typeof options.sourcePath === 'string'
      ? options.sourcePath
      : this.sourceName;
    this.errorContextEntries = [];
    this.errorContextTableBuilt = false;
    // Added diagnostic metadata inherited by nested AST origins. This is not
    // an error context; each origin still emits its own compact context.
    this.currentInheritedAddedContext = null;
    this.currentInheritedLabelOverride = null;
    this.currentLoopVar = null;
    this.inBlock = false;

    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = null;
    this.inheritance = new CompileInheritance(this);
    this.composition = new CompileComposition(this);
    this.compositionPayload = new CompileCompositionPayload(this);
    this.loop = new CompileLoop(this);
    this.buffer = new CompileBuffer(this);
    this.macro = new CompileMacro(this);
    this.return = new CompileReturn(this);
    this.boundaries = new CompileBoundaries(this);
    this.chain = new CompileChain(this);
    this.component = new CompileComponent(this);
  }

  compile(node, frame) {
    const compileNode = () => {
      const handler = this.analysis?.getCompilerMethod?.('compile', node.typename) ?? null;
      if (handler) {
        this.analysis.callCompilerMethod(handler, node, frame);
        return true;
      }

      const _compile = this['compile' + node.typename];
      if (_compile) {
        _compile.call(this, node, frame);
        return true;
      }
      return false;
    };

    if (this.currentLoopVar && node._analysis?.scopeBoundary) {
      this.withCurrentLoopVar(null, () => {
        if (!compileNode()) {
          this.compileNodeList(node, frame);
        }
      });
      return;
    }
    if (compileNode()) {
      return;
    }
    if (node instanceof nodes.NodeList) {
      this.compileNodeList(node, frame);
      return;
    }
    this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno, node);
  }

  // --- Core Utilities (Needed by Expressions) ---

  _generateErrorContext(node, positionNode = node, label = null) {
    if (!node) {
      throw new TypeError('_generateErrorContext requires a node');
    }
    const resolvedPositionNode = positionNode === node && node._analysis?.errorContextPositionNode
      ? node._analysis.errorContextPositionNode
      : positionNode;
    const finalLabel = this._getErrorContextLabel(node, resolvedPositionNode, label);
    if (label === null && node._analysis && node._analysis.errorContextIndex === undefined) {
      this._registerErrorContextEntry(node, finalLabel, resolvedPositionNode);
    }
    return finalLabel;
  }

  _getErrorContextLabel(node, positionNode = node, label = null) {
    const parentProvidedOwnerLabel = label || node._analysis?.errorContextLabel || null;

    const nodeType = parentProvidedOwnerLabel || node.typename || 'Node';
    const posType = (positionNode && positionNode.typename) || 'PosNode';
    const finalLabel = (!parentProvidedOwnerLabel && (node === positionNode || nodeType === posType))
      ? nodeType
      : `${nodeType}(${posType})`;
    return finalLabel;
  }

  _addErrorContextEntry(label, positionNode, addedContext = null) {
    if (this.errorContextTableBuilt) {
      throw new Error('Cannot register error context after the error context table has been emitted');
    }
    const lineno = positionNode.lineno !== undefined ? positionNode.lineno + 1 : 0;
    const colno = positionNode.colno !== undefined ? positionNode.colno : 0;
    const index = this.errorContextEntries.length;
    this.errorContextEntries.push({ lineno, colno, label, addedContext });
    return index;
  }

  _registerErrorContextEntry(node, label, positionNode = node) {
    const index = this._addErrorContextEntry(label, positionNode);
    node.addAnalysis({ errorContextIndex: index });
    return index;
  }

  _emitStaticErrorContext(node, addedContext = null) {
    if (!node) {
      return 'null';
    }
    const tableExpr = this.inheritance.currentCallableNode
      ? 'methodData.errorContextTable'
      : '__ec';
    const contextIndex = this.getErrorContextIndex(node, addedContext);
    return `${tableExpr}[${contextIndex}]`;
  }

  _applyInheritedErrorContext(contextExpr, owned = false) {
    const inheritedAddedContext = this.currentInheritedAddedContext;
    const inheritedLabelOverride = this.currentInheritedLabelOverride;
    if (contextExpr === 'null') {
      return contextExpr;
    }
    if (!owned && !inheritedAddedContext && !inheritedLabelOverride) {
      return contextExpr;
    }
    const ownedContextExpr = inheritedAddedContext
      ? `runtime.cloneWithAddedContext(${contextExpr}, ${inheritedAddedContext})`
      : `runtime.cloneContext(${contextExpr})`;
    return inheritedLabelOverride
      ? `runtime.setContextLabel(${ownedContextExpr}, ${inheritedLabelOverride})`
      : ownedContextExpr;
  }

  emitErrorContext(node, addedContext = null) {
    const contextExpr = this._emitStaticErrorContext(node, addedContext);
    return this._applyInheritedErrorContext(contextExpr);
  }

  createInheritedAddedContextVar(addedContextExpr) {
    const addedContextVar = this._tmpid();
    // Inherited diagnostics are lexical metadata, not context identity. Inner
    // scopes intentionally shadow duplicate keys such as nested loop metadata.
    const valueExpr = this.currentInheritedAddedContext
      ? `{ ...${this.currentInheritedAddedContext}, ...${addedContextExpr} }`
      : addedContextExpr;
    this.emit.line(`const ${addedContextVar} = ${valueExpr};`);
    return addedContextVar;
  }

  withInheritedAddedContext(addedContextVar, emitFunc) {
    const previousAddedContext = this.currentInheritedAddedContext;
    this.currentInheritedAddedContext = addedContextVar;
    try {
      return emitFunc();
    } finally {
      this.currentInheritedAddedContext = previousAddedContext;
    }
  }

  withInheritedAddedContextExpr(addedContextExpr, emitFunc) {
    const addedContextVar = this.createInheritedAddedContextVar(addedContextExpr);
    return this.withInheritedAddedContext(addedContextVar, () => emitFunc(addedContextVar));
  }

  withInheritedLabelOverride(labelExpr, emitFunc) {
    const previousLabel = this.currentInheritedLabelOverride;
    this.currentInheritedLabelOverride = labelExpr;
    try {
      return emitFunc();
    } finally {
      this.currentInheritedLabelOverride = previousLabel;
    }
  }

  withCurrentLoopVar(loopVar, emitFunc) {
    const previousLoopVar = this.currentLoopVar;
    this.currentLoopVar = loopVar;
    const result = emitFunc();
    this.currentLoopVar = previousLoopVar;
    return result;
  }

  getErrorContextIndex(node, addedContext = null) {
    if (addedContext) {
      return this._getAddedErrorContextIndex(node, addedContext);
    }
    if (node._analysis.errorContextIndex === undefined) {
      this._generateErrorContext(node);
    }
    return node._analysis.errorContextIndex;
  }

  _normalizeAddedContextFields(addedContextFields = {}) {
    const addedContext = {};
    for (const [key, value] of Object.entries(addedContextFields || {})) {
      if (value === undefined || value === null) {
        continue;
      }
      addedContext[key] = value;
    }
    return Object.keys(addedContext).length === 0 ? null : addedContext;
  }

  emitClonedErrorContext(node, addedContextFields = {}) {
    if (!node) {
      throw new TypeError('emitClonedErrorContext requires an origin node');
    }
    const addedContext = this._normalizeAddedContextFields(addedContextFields);
    const staticContextExpr = addedContext === null
      ? this._emitStaticErrorContext(node)
      : this._emitStaticErrorContext(node, addedContext);
    return this._applyInheritedErrorContext(staticContextExpr, true);
  }

  emitBufferStackErrorContext(node, addedContext = null, { owned = false } = {}) {
    const contextAddedContext = owned
      ? this._normalizeAddedContextFields(addedContext)
      : addedContext;
    const contextExpr = this._emitStaticErrorContext(node, contextAddedContext);
    return this._applyInheritedErrorContext(contextExpr, owned);
  }

  _getAddedErrorContextIndex(node, addedContext) {
    if (!node) {
      throw new TypeError('_getAddedErrorContextIndex requires a node');
    }
    const resolvedPositionNode = node._analysis?.errorContextPositionNode || node;
    const finalLabel = this._getErrorContextLabel(node, resolvedPositionNode, null);
    const key = JSON.stringify(addedContext);
    if (!node._analysis.addedContextIndexes) {
      node.addAnalysis({ addedContextIndexes: Object.create(null) });
    }
    if (node._analysis.addedContextIndexes[key] === undefined) {
      node._analysis.addedContextIndexes[key] = this._addErrorContextEntry(
        finalLabel,
        resolvedPositionNode,
        addedContext
      );
    }
    return node._analysis.addedContextIndexes[key];
  }

  _buildErrorContextTable() {
    const labelCounts = new Map();
    this.errorContextEntries.forEach((entry) => {
      labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
    });

    const labels = [];
    const labelIndexes = new Map();
    labelCounts.forEach((count, label) => {
      if (count > 1) {
        labelIndexes.set(label, labels.length);
        labels.push(label);
      }
    });

    const specs = this.errorContextEntries.map((entry) => {
      const spec = [
        entry.lineno,
        entry.colno,
        labelIndexes.has(entry.label) ? labelIndexes.get(entry.label) : entry.label
      ];
      if (entry.addedContext) {
        spec.push(entry.addedContext);
      }
      return spec;
    });

    return { labels, specs };
  }

  emitErrorContextHelper() {
    const { labels, specs } = this._buildErrorContextTable();
    this.errorContextTableBuilt = true;
    this.emit(
      `function getErrorContexts(runtime, path, renderState) {\n` +
      `  return runtime.prepareErrorContexts(path, renderState, ${JSON.stringify(labels)}, ${JSON.stringify(specs)});\n` +
      `}\n`
    );
  }

  fail(msg, lineno, colno, node, positionNode) { // Added node and positionNode
    if (lineno !== undefined) {
      lineno += 1;
    }
    if (colno !== undefined) {
      colno += 1;
    }

    const label = node
      ? this._getErrorContextLabel(
        node,
        positionNode || node._analysis?.errorContextPositionNode || node
      )
      : null;

    throw new CompileError(msg, {
      lineno,
      colno,
      label,
      path: this.sourcePath
    });
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

  getCallableSignatureFacts(argsNode, opts = {}) {
    const signature = this._parseCallableSignature(argsNode, opts);
    const symbolsOnly = !!opts.symbolsOnly;
    const label = opts.label || 'callable signature';
    const ownerNode = opts.ownerNode || argsNode;
    const keywordNameNodes = [];
    const keywordDefaults = [];

    if (signature.kwargs) {
      signature.kwargs.children.forEach((pair) => {
        if (symbolsOnly && !(pair.key instanceof nodes.Symbol)) {
          this.fail(
            `${label} only supports identifier arguments`,
            pair.key.lineno,
            pair.key.colno,
            ownerNode,
            pair.key
          );
        }
        keywordNameNodes.push(pair.key);
        keywordDefaults.push({
          name: this.analysis ? this.analysis.getBaseChainName(pair.key.value) : pair.key.value,
          valueNode: pair.value
        });
      });
    }

    const positionalArgNames = signature.positionalNames.map((name) => (
      this.analysis ? this.analysis.getBaseChainName(name) : name
    ));

    return {
      ...signature,
      argNames: positionalArgNames.concat(keywordDefaults.map((entry) => entry.name)),
      argNameNodes: signature.args.concat(keywordNameNodes),
      placementArgNodes: signature.args.concat(keywordDefaults.map((entry) => entry.valueNode)),
      keywordDefaults
    };
  }

  getCallableArgumentChainFacts(callableSignature) {
    return {
      argNames: Array.from(new Set(callableSignature.argNames)),
      keywordDefaultsByName: new Map(
        callableSignature.keywordDefaults.map((entry) => [entry.name, entry.valueNode])
      )
    };
  }

  createCallableArgumentChainBindings(callableSignature, emitValueExpression, getPositionNode = () => null) {
    const { argNames, keywordDefaultsByName } = this.getCallableArgumentChainFacts(callableSignature);
    return argNames.map((name) => ({
      name,
      emitValueExpression: () => {
        emitValueExpression(name, keywordDefaultsByName.get(name));
      },
      positionNode: getPositionNode(name)
    }));
  }

  _describeCallableTarget(node) {
    if (!node) {
      return 'expression';
    }
    switch (node.typename) {
      case 'Symbol':
        return node.value;
      case 'FunCall':
        return this._describeCallableTarget(node.name) + '(...) result';
      case 'LookupVal': {
        const key = node.val && node.val.typename === 'Literal'
          ? JSON.stringify(node.val.value)
          : this._describeCallableTarget(node.val);
        return this._describeCallableTarget(node.target) + '[' +
          key + ']';
      }
      case 'Literal':
        return node.value === null || node.value === undefined
          ? String(node.value)
          : node.value.toString();
      default: {
        const label = node._analysis?.errorContextLabel || node.typename || 'unknown';
        return `${label} expression`;
      }
    }
  }

  _describeCallSignature(callableNode, argsNode) {
    return `${this._describeCallableTarget(callableNode)}(${this._describeCallArguments(argsNode).join(', ')})`;
  }

  _describeMacroSignature(name, parameterNames) {
    return `${name}(${parameterNames.join(', ')})`;
  }

  _describeCallArguments(argsNode) {
    if (!argsNode || !argsNode.children) {
      return [];
    }
    const descriptions = [];
    argsNode.children.forEach((arg) => {
      if (arg instanceof nodes.KeywordArgs) {
        arg.children.forEach((pair) => {
          if (pair.key instanceof nodes.Symbol) {
            descriptions.push(`${pair.key.value}=${this._describeExpression(pair.value)}`);
          }
        });
        return;
      }
      descriptions.push(this._describeExpression(arg));
    });
    return descriptions;
  }

  _describeExpression(node) {
    if (!node) {
      return 'expression';
    }
    switch (node.typename) {
      case 'Symbol':
      case 'LookupVal':
      case 'FunCall':
      case 'Literal':
        return this._describeCallableTarget(node);
      case 'Array':
        return '[...]';
      case 'Dict':
        return '{...}';
      default: {
        const label = node._analysis?.errorContextLabel || node.typename || 'expression';
        return `${label} expression`;
      }
    }
  }


  // --- Expression Compilation Helpers ---

  _compileFunctionAggregate(node, frame, funcName) {
    this._compileAggregate(node, frame, '[', ']', true, true, function (result) {
      this.emit(`return ${funcName}(...${result})`);
    });
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
    return isReservedDeclarationName(name, { asyncMode: this.asyncMode });
  }

  isReservedDeclaration(decl) {
    return isReservedDeclaration(decl, {
      asyncMode: this.asyncMode,
      scriptMode: this.scriptMode
    });
  }

  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  compileNodeList(node, frame) {
    this._compileChildren(node, frame);
  }

  compileTemplateData(node, frame) {
    this.compileLiteral(node, frame);
  }

  getCode() {
    return this.codebuf.join('');
  }

}

export {CompilerCommon};
