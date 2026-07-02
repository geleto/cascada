
import * as nodes from '../language/nodes.js';
import {CompileAnalysis} from './analysis.js';
import {CompilerCommon} from './compiler-common.js';
import {CompileCall} from './call.js';
import {CompileLookup} from './lookup.js';
import {CompileGuard} from './guard.js';
import {CompileAssignment} from './assignment.js';
import {renameSharedName} from '../inheritance/shared-names.js';
import {isImmutableDeclaration, isStoredDirectly} from './declarations.js';

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

const scriptArithmeticOps = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%'
};

class CompilerBaseAsync extends CompilerCommon {
  init(options) {
    super.init({ ...options, asyncMode: true });
    this.analysis = new CompileAnalysis(this);
    this.call = new CompileCall(this);
    this.lookup = new CompileLookup(this);
    this.guard = new CompileGuard(this);
    this.assignment = new CompileAssignment(this);
    this._registerCompilers();
  }

  _registerCompilers() {
    [
      this,
      this.assignment,
      this.guard,
      this.call,
      this.lookup,
      this.macro,
      this.return,
      this.composition,
      this.loop,
      this.inheritance,
      this.chain,
      this.component
    ].forEach((compilerPart) => {
      this.analysis.registerCompiler(compilerPart);
    });
  }

  analyzeSymbol(node) {
    // Symbol targets introduce or update a name; they are not expression reads
    // and should not perform source/context lookup.
    if (
      node._analysis?.isSymbolTarget ||
      node._analysis?.operationOwnedPath ||
      node._analysis?.isStaticCallableCallTarget ||
      node.isCompilerInternal
    ) {
      return {};
    }
    const name = node.value;

    const observes = [];
    const mutates = [];
    const sequenceLockLookup = this.sequential.recordSequenceLockLookup(node);
    node.addAnalysis({ sequenceLockLookup });
    if (sequenceLockLookup) {
      const thisSharedFacts = this.chain.analyzeThisSharedAccess(node);
      if (thisSharedFacts) {
        this.fail(
          'Sequence marker (!) is only supported on context paths, not this.<shared> chains.',
          node.lineno,
          node.colno,
          node
        );
      }
      this._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key);
      const target = sequenceLockLookup.repair ? mutates : observes;
      target.push(sequenceLockLookup.key);
    }

    const declaration = this._getVisibleDeclaration(node, name);
    // Skip intrinsic direct names at the source-read producer. Final folding
    // repeats this because observes can also come from custom/post analyzers.
    if (declaration && !(this.scriptMode && declaration.shared) && !isImmutableDeclaration(declaration)) {
      observes.push(name);
    }

    return { observes, mutates };
  }

  postAnalyzeSymbol(node) {
    const facts = this.chain.collectDataPathSegmentFacts(node);
    let sequenceLockFacts = null;
    if (!node._analysis?.isSymbolTarget && !node._analysis?.operationOwnedPath && !node.isCompilerInternal) {
      sequenceLockFacts = this.sequential.collectBareSequenceLockLookupFacts(node);
    }
    this.call.validateCallableValueUse(node._analysis);
    return {
      ...facts,
      ...(sequenceLockFacts || {})
    };
  }

  compileSymbol(node) {
    const name = node.value;
    if (node.isCompilerInternal) {
      this.emit(name);
      return;
    }
    const declaredChain = this._getVisibleDeclaration(node, name);
    if (isStoredDirectly(declaredChain)) {
      this._compileDirectDeclarationLookup(node, name, declaredChain);
      return;
    }
    if (name === 'loop' && this.currentLoopVar && !declaredChain) {
      this.emit(this.currentLoopVar);
      return;
    }
    if (declaredChain && this.scriptMode && declaredChain.shared) {
      this._compileScriptAmbientOnlySymbolLookup(node, name);
      return;
    }
    if (declaredChain) {
      this._compileDeclaredSymbolLookup(node, name, declaredChain);
      return;
    }
    this._compileAmbientSymbolLookup(node, name);
  }

  _compileDirectDeclarationLookup(node, name, declaration) {
    if (node.sequential || node.sequentialRepair) {
      this._failNonContextSequenceRoot(node, declaration);
    }
    if (!declaration.jsVar) {
      this.fail(
        `Compiler error: direct declaration '${name}' has no generated binding.`,
        node.lineno,
        node.colno,
        node
      );
    }
    if (this.inheritance.emitDirectCallableReference(declaration, node)) {
      return;
    }
    this.emit(declaration.jsVar);
  }

  _compileDeclaredSymbolLookup(node, name, declaredChain) {
    if (node.sequential || node.sequentialRepair) {
      this._failNonContextSequenceRoot(node, declaredChain);
    }
    if (declaredChain.type !== 'var') {
      this.fail(
        `Chain '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
    if (declaredChain.shared) {
      this.chain.emitChainObservation(name, node, 'snapshot', true, true);
      return;
    }
    if (!this.scriptMode && this.inBlock) {
      this.emit(`runtime.chainLookup("${name}", ${this.buffer.currentBuffer}, ${this.emitErrorContext(node)})`);
      return;
    }
    this.chain.emitChainObservation(name, node);
  }

  _compileAmbientSymbolLookup(node, name) {
    if (this.scriptMode) {
      this._compileScriptSymbolLookup(node, name);
      return;
    }
    this._compileAsyncTemplateSymbolLookup(node, name);
  }

  _compileAggregate(node, _scopeState, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    this._compileAsyncAggregate(node, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen);
  }

  _assertSequenceRootIsContextPath(lockKey, node) {
    this._failIfSequenceRootIsDeclared(node, lockKey);
  }

  _failIfSequenceRootIsDeclared(node, lockKey) {
    if (!lockKey || lockKey.charAt(0) !== '!') {
      return;
    }
    const sepIndex = lockKey.indexOf('!', 1);
    const keyRoot = lockKey.substring(1, sepIndex === -1 ? lockKey.length : sepIndex);
    if (!keyRoot) {
      return;
    }
    const keyRootChain = this._getVisibleDeclaration(node, keyRoot);
    if (keyRootChain) {
      this._failNonContextSequenceRoot(node, keyRootChain);
    }
  }

  _getVisibleDeclaration(node, name) {
    return node?._analysis?.visibleDeclarations?.get(name) || null;
  }

  _binFuncEmitter(node, _scopeState, funcName, separator = ',') {
    this._emitAsyncBinFunc(node, funcName, separator);
  }

  _binOpEmitter(node, _scopeState, str) {
    this._emitAsyncBinOp(node, str);
  }

  _unaryOpEmitter(node, _scopeState, operator) {
    this._emitAsyncUnaryOp(node, operator);
  }

  analyzeInlineIf() {
    return {
      wantsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compileInlineIf(node) {
    if (node._analysis.createsLinkedChildBuffer) {
      this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, function() {
        this.emit('return runtime.resolveThen(');
        this.compile(node.cond, null);
        this.emit(', function(cond) {');
        this.emit('  if(cond) {');
        this.emit('    return ');
        this.compile(node.body, null);
        this.emit(';');
        this.emit('  } else {');
        if (node.else_) {
          this.emit('    return ');
          this.compile(node.else_, null);
          this.emit(';');
        } else {
          this.emit('    return "";');
        }
        this.emit('  }');
        this.emit('})');
      });
      return;
    }

    this.emit('runtime.resolveThen(');
    this.compile(node.cond, null);
    this.emit(', function(cond) {');
    this.emit('  if(cond) {');
    this.emit('    return ');
    this.compile(node.body, null);
    this.emit(';');
    this.emit('  } else {');
    if (node.else_) {
      this.emit('    return ');
      this.compile(node.else_, null);
      this.emit(';');
    } else {
      this.emit('    return "";');
    }
    this.emit('  }');
    this.emit('})');
  }

  compileIs(node) {
    const testFacts = this._getIsTestFacts(node);
    const testName = testFacts.name;
    const testFunc = `env.getTest("${testName}")`;
    const failMsg = `test not found: ${testName}`.replace(/"/g, '\\"');

    if (testFacts.isError) {
      if (this._compileErrorObservation(node.left, 'isError')) {
        return;
      }
      this.emit('runtime.isError(');
      this.compile(node.left, null);
      this.emit(')');
      return;
    }

    const mergedNode = {
      positionNode: testFacts.hasArgs ? node.right : node.left,
      children: testFacts.hasArgs ? [node.left, ...node.right.args.children] : [node.left]
    };
    this._compileAggregate(mergedNode, null, '[', ']', true, true, function (args) {
      const errorContext = this.emitErrorContext(mergedNode.positionNode);
      this.emit.line(`  const testFunc = ${testFunc};`);
      this.emit.line(`  if (!testFunc) { runtime.RuntimeError.reportAndThrow("${failMsg}", ${errorContext}); }`);
      this.emit.line(`  const result = await runtime.envCallWrapAsync(testFunc, context, ${args}, ${errorContext});`);
      this.emit.line('  return result === true;');
    }, true);
  }

  analyzeOr() {
    return {
      wantsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compileOr(node) {
    this._compileAsyncBinOpShortCircuit(node, true);
  }

  analyzeAnd() {
    return {
      wantsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compileAnd(node) {
    this._compileAsyncBinOpShortCircuit(node, false);
  }

  compilePeekError(node) {
    if (this._compileErrorObservation(node.target, 'getError')) {
      return;
    }
    this.emit('runtime.peekError(');
    this.compile(node.target, null);
    this.emit(')');
  }

  compileCompare(node) {
    if (this.scriptMode) {
      this._compileScriptCompare(node);
      return;
    }

    this.emit('runtime.thenValue(runtime.resolveDuo(');
    this.compile(node.expr, null);
    this.emit(',');
    this.compile(node.ops[0].expr, null);
    this.emit(`), ${node.ops.length > 1 ? 'async ' : ''}function([expr, ref1]){`);
    this.emit(`return expr ${compareOps[node.ops[0].type]} ref1`);
    node.ops.forEach((op, index) => {
      if (index > 0) {
        this.emit(` ${compareOps[op.type]} `);
        this.compileAwaited(op.expr, null);
      }
    });
    this.emit('})');
  }

  compileFilter(node) {
    this.assertType(node.name, nodes.Symbol);
    this._compileAggregate(node.args, null, '[', ']', true, false, function (result) {
      const errorContext = this.emitErrorContext(node);
      this.emit(`return runtime.envCallWrapAsync(env.getFilter("${node.name.value}"), context, ${result}, ${errorContext});`);
    }, false);
  }

  _compileScriptCompare(node) {
    const leftId = this._tmpid();
    const rightId = this._tmpid();
    const resultId = this._tmpid();

    this.emit('runtime.thenValue(runtime.resolveDuo(');
    this.compile(node.expr, null);
    this.emit(',');
    this.compile(node.ops[0].expr, null);
    this.emit(`), ${node.ops.length > 1 ? 'async ' : ''}function([${leftId}, ${rightId}]){`);

    this.emit(`let ${resultId} = runtime.scriptCompareOperator(${leftId}, ${rightId}, "${node.ops[0].type}", ${this.emitErrorContext(node)});`);
    this.emit(`if (runtime.isPoison(${resultId}) || !${resultId}) return ${resultId};`);

    node.ops.forEach((op, index) => {
      if (index === 0) {
        return;
      }
      this.emit(`${leftId} = ${rightId};`);
      this.emit(`${rightId} = `);
      this.compileAwaited(op.expr, null);
      this.emit(';');
      this.emit(`${resultId} = runtime.scriptCompareOperator(${leftId}, ${rightId}, "${op.type}", ${this.emitErrorContext(node)});`);
      this.emit(`if (runtime.isPoison(${resultId}) || !${resultId}) return ${resultId};`);
    });

    this.emit('return true;');
    this.emit('})');
  }

  compileFilterAsync(node) {
    const symbol = node.symbol.value;
    this.assertType(node.name, nodes.Symbol);
    this.emit.line(`let ${symbol} = `);
    this._compileAggregate(node.args, null, '[', ']', true, false, function (result) {
      const errorContext = this.emitErrorContext(node);
      this.emit(`return runtime.envCallWrapAsync(env.getFilter("${node.name.value}"), env, ${result}, ${errorContext});`);
    });
    this.emit(';');
  }

  compileAwaited(node) {
    this.emit('(await ');
    this.compile(node, null);
    this.emit(')');
  }

  _compileAwaitedExpression(node) {
    this.emit('(await ');
    this._compileExpression(node, null);
    this.emit(')');
  }

  compileExpression(node, _scopeState, positionNode, excludeFromWaitedRootTracking = false) {
    const shouldEmitOwnWaitedResolve = this.buffer.currentWaitedChainName &&
      !excludeFromWaitedRootTracking;

    if (!shouldEmitOwnWaitedResolve) {
      this._compileExpression(node, null, positionNode);
      return;
    }

    const resultId = this._tmpid();

    this.emit('(() => { ');
    this.emit(`let ${resultId} = `);
    this._compileExpression(node, null, positionNode);
    this.emit('; ');
    this.buffer.emitLimitedLoopCompletion(resultId, positionNode ?? node);
    this.emit(`return ${resultId}; `);
    this.emit('})()');
  }

  _compileAsyncAggregate(node, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    const doResolve = resolveItems;
    if (doResolve) {
      if (compileThen) {
        this.emit('runtime.thenValue(');
      }
      switch (startChar) {
        case '[':
          if (node.children.length === 1) {
            this.emit('runtime.resolveSingleArr(');
            this._compileArguments(node, null, expressionRoot, startChar);
            this.emit(')');
          } else if (node.children.length === 2) {
            this.emit('runtime.resolveDuo(');
            this._compileArguments(node, null, expressionRoot, startChar);
            this.emit(')');
          } else {
            this.emit('runtime.resolveAll([');
            this._compileArguments(node, null, expressionRoot, startChar);
            this.emit('])');
          }
          break;
        case '(': {
          this.emit('runtime.thenValue(runtime.resolveAll([');
          this._compileArguments(node, null, expressionRoot, '[');
          this.emit(']), function(');
          const result = this._tmpid();
          this.emit(`${result}){ return (`);
          for (let i = 0; i < node.children.length; i++) {
            if (i > 0) {
              this.emit(',');
            }
            this.emit(`${result}[${i}]`);
          }
          this.emit('); })');
          break;
        }
      }

      if (compileThen) {
        const result = this._tmpid();
        this.emit(`, ${asyncThen ? 'async ' : ''}function(${result}){`);
        compileThen.call(this, result, node.children.length);
        this.emit(' })');
      }
      return;
    }

    let wrapper = null;
    if (startChar === '[') wrapper = 'runtime.createArray';
    if (startChar === '{') wrapper = 'runtime.createObject';

    if (compileThen) {
      const result = this._tmpid();
      this.emit.line(`(${asyncThen ? 'async ' : ''}function(${result}){`);
      compileThen.call(this, result, node.children.length);
      this.emit('})(');
    }

    if (wrapper) this.emit(wrapper + '(');
    this.emit(startChar);
    this._compileArguments(node, null, expressionRoot, startChar);
    this.emit(endChar);
    if (wrapper) this.emit(')');

    if (compileThen) {
      this.emit(')');
    }
  }

  _compileScriptSymbolLookup(node, name) {
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${this.emitErrorContext(node)}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }
    this._compileScriptAmbientOnlySymbolLookup(node, name);
  }

  _compileScriptAmbientOnlySymbolLookup(node, name) {
    this.emit(
      `context.lookupScript("${name}", ` +
      `${this.emitErrorContext(node)}` +
      ')'
    );
  }

  _compileAsyncTemplateSymbolLookup(node, name) {
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${this.emitErrorContext(node)}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }

    this.emit(`context.lookup("${name}", ${this.emitErrorContext(node)})`);
  }

  _compileAsyncBinOpShortCircuit(node, isOr) {
    if (node._analysis.createsLinkedChildBuffer) {
      this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, function() {
        this.emit('return runtime.resolveThen(');
        this.compile(node.left, null);
        this.emit(', function(left) {');
        const check = isOr ? 'left' : '!left';
        this.emit(`  if (${check}) {`);
        this.emit('    return left;');
        this.emit('  } else {');
        this.emit('    return ');
        this.compile(node.right, null);
        this.emit(';');
        this.emit('  }');
        this.emit('})');
      });
      return;
    }

    this.emit('runtime.resolveThen(');
    this.compile(node.left, null);
    this.emit(', function(left) {');

    const check = isOr ? 'left' : '!left';
    this.emit(`  if (${check}) {`);
    this.emit('    return left;');
    this.emit('  }');
    this.emit('  else {');
    this.emit('    return ');
    this.compile(node.right, null);
    this.emit(';');
    this.emit('  }');
    this.emit('})');
  }


  _emitAsyncDynamicCall(node, currentBufferExpr) {
    const funcName = this._describeCallableTarget(node.name).replace(/"/g, '\\"');
    this.emit('runtime.callWrapAsync(');
    if (this.scriptMode &&
      node.name instanceof nodes.Symbol &&
      !this._getVisibleDeclaration(node.name, node.name.value)) {
      this.emit(
        `runtime.resolveScriptCallTarget(context, "${node.name.value}", ` +
        `${this.emitErrorContext(node.name)}` +
        ')'
      );
    } else {
      this.compile(node.name, null);
    }
    this.emit(`, "${funcName}", context, `);
    this._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, ${this.emitErrorContext(node)}, ${currentBufferExpr})`);
  }

  _emitAsyncBinFunc(node, funcName, separator) {
    this.emit('(');
    this.emit('runtime.thenValue(runtime.resolveDuo(');
    this.compile(node.left, null);
    this.emit(',');
    this.compile(node.right, null);
    this.emit(')');
    if (this.scriptMode && funcName === 'Math.floor' && separator === ' / ') {
      this.emit(`, function([left,right]){return runtime.scriptArithmeticOperator(left, right, "//", ${this.emitErrorContext(node)});}))`);
      return;
    }
    if (this.scriptMode && funcName === 'Math.pow') {
      this.emit(`, function([left,right]){return runtime.scriptArithmeticOperator(left, right, "**", ${this.emitErrorContext(node)});}))`);
      return;
    }
    if (funcName === 'runtime.inOperator') {
      this.emit(`, function([left,right]){return runtime.inOperator(left, right, ${this.emitErrorContext(node)});}))`);
      return;
    }
    this.emit(`, function([left,right]){return runtime.poisonIfNaN(${funcName}(left${separator}right), ${this.emitErrorContext(node)});}))`);
  }

  _emitAsyncBinOp(node, str) {
    this.emit('runtime.thenValue(runtime.resolveDuo(');
    this.compile(node.left, null);
    this.emit(',');
    this.compile(node.right, null);
    this.emit(')');
    if (this.scriptMode && str === ' + "" + ') {
      this.emit(`, function([left,right]){return runtime.scriptConcatOperator(left, right, ${this.emitErrorContext(node)});})`);
      return;
    }
    const scriptArithmeticOp = scriptArithmeticOps[str.trim()];
    if (this.scriptMode && scriptArithmeticOp) {
      this.emit(`, function([left,right]){return runtime.scriptArithmeticOperator(left, right, "${scriptArithmeticOp}", ${this.emitErrorContext(node)});})`);
      return;
    }
    this.emit(`, function([left,right]){return runtime.poisonIfNaN(left ${str} right, ${this.emitErrorContext(node)});})`);
  }

  _emitAsyncUnaryOp(node, operator) {
    this.emit('runtime.resolveThen(');
    this.compile(node.target, null);
    this.emit(`, function(target){return runtime.poisonIfNaN(${operator}target, ${this.emitErrorContext(node)});})`);
  }

  _compileErrorObservation(targetNode, mode) {
    const componentBindingRoot = this.component.findBindingRoot(targetNode);
    if (componentBindingRoot && componentBindingRoot.staticPath.length === 2) {
      this.component.emitChainObservation({
        bindingName: componentBindingRoot.bindingName,
        chainName: renameSharedName(componentBindingRoot.staticPath[1]),
        mode,
        implicitVarRead: false
      }, targetNode);
      return true;
    }

    const observation = this._getErrorObservationChain(targetNode);
    if (!observation) {
      return false;
    }

    return this.chain.emitChainObservation(
      observation.chainName,
      targetNode,
      mode,
      observation.shared
    );
  }

  _getIsTestFacts(node) {
    const name = node.right.name ? node.right.name.value : node.right.value;
    const isError = name === 'error';
    return {
      name,
      isError,
      hasArgs: !!(node.right.args && node.right.args.children.length > 0)
    };
  }

  _getErrorObservationChain(targetNode) {
    if (!this.scriptMode || !targetNode || targetNode.sequential) {
      return null;
    }

    const thisSharedFacts = this.chain.findThisSharedAccessFacts(targetNode);
    if (thisSharedFacts && thisSharedFacts.chainPath.length === 1) {
      return {
        chainName: thisSharedFacts.chainName,
        shared: true
      };
    }

    const expectedPathLength = targetNode instanceof nodes.Symbol
      ? 1
      : targetNode instanceof nodes.FunCall
        ? 2
        : 0;
    if (!expectedPathLength) {
      return null;
    }

    const pathNode = targetNode instanceof nodes.FunCall ? targetNode.name : targetNode;
    const staticPath = this.sequential.extractStaticPath(pathNode);
    if (!staticPath.isStatic || staticPath.segments.length !== expectedPathLength) {
      return null;
    }

    const declaration = this._getVisibleDeclaration(staticPath.rootNode, staticPath.root);
    if (!declaration || isStoredDirectly(declaration) || declaration.shared) {
      return null;
    }
    return {
      chainName: staticPath.root,
      shared: false
    };
  }
}

export {CompilerBaseAsync};
