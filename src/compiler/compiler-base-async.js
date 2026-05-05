
import * as nodes from '../nodes.js';
import {CompileAnalysis} from './analysis.js';
import {CompileRename} from './rename.js';
import {CompilerCommon} from './compiler-common.js';
import {CompileCall} from './call.js';
import {CompileLookup} from './lookup.js';

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

class CompilerBaseAsync extends CompilerCommon {
  init(options) {
    super.init(Object.assign({}, options, { asyncMode: true }));
    this.analysis = new CompileAnalysis(this);
    this.rename = new CompileRename(this);
    this.call = new CompileCall(this);
    this.lookup = new CompileLookup(this);
    this.templateUsesInheritanceSurface = false;
  }

  analyzeSymbol(node, analysisPass) {
    if (node._analysis?.declarationTarget || node.isCompilerInternal) {
      return {};
    }
    const name = node.value;

    const uses = [];
    const mutates = [];
    const sequenceLockLookup = this.sequential.getSequenceLockLookup(node);
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      const thisSharedFacts = this.channel.getThisSharedAccessFacts(node, analysisPass);
      if (thisSharedFacts) {
        this.fail(
          'Sequence marker (!) is only supported on context paths, not this.<shared> channels.',
          node.lineno,
          node.colno,
          node
        );
      }
      this._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key, analysisPass);
      uses.push(sequenceLockLookup.key);
      if (sequenceLockLookup.repair) {
        mutates.push(sequenceLockLookup.key);
      }
    }

    const declaration = analysisPass.findDeclaration(node._analysis, name);
    if (declaration && !(this.scriptMode && declaration.shared)) {
      uses.push(name);
    }

    return { uses, mutates };
  }

  compileSymbol(node) {
    const name = node.value;
    if (node.isCompilerInternal) {
      this.emit(name);
      return;
    }
    const declaredChannel = this.analysis.findDeclaration(node._analysis, name);
    if (declaredChannel && this.scriptMode && declaredChannel.shared) {
      this._compileScriptAmbientOnlySymbolLookup(node, name);
      return;
    }
    if (declaredChannel) {
      this._compileDeclaredSymbolLookup(node, name, declaredChannel);
      return;
    }
    this._compileAmbientSymbolLookup(node, name);
  }

  _compileDeclaredSymbolLookup(node, name, declaredChannel) {
    if (this.scriptMode && this.currentCallableDefinition) {
      if (this.inheritance.isHiddenFromCurrentCallable(node, name, declaredChannel, { includeImported: true })) {
        this.emit('undefined');
        return;
      }
    }
    if (!this.scriptMode && this.currentCallableDefinition && this.inBlock && declaredChannel.type === 'var') {
      if (this.inheritance.isHiddenFromCurrentCallable(node, name, declaredChannel)) {
        this.emit('undefined');
        return;
      }
    }
    if (node.sequential || node.sequentialRepair) {
      this._failNonContextSequenceRoot(node, declaredChannel);
    }
    if (declaredChannel.type !== 'var') {
      this.fail(
        `Channel '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
    if (declaredChannel.shared) {
      this.channel.emitSharedChannelObservation(name, node, 'snapshot', true);
      return;
    }
    if (!this.scriptMode && this.inBlock) {
      this.emit(`runtime.channelLookup("${name}", ${this.buffer.currentBuffer})`);
      return;
    }
    this.buffer.emitAddSnapshot(name, node);
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
    this._failIfSequenceRootIsDeclared(node, lockKey, this.analysis);
  }

  _failIfSequenceRootIsDeclared(node, lockKey, analysisPass) {
    if (!lockKey || lockKey.charAt(0) !== '!') {
      return;
    }
    const sepIndex = lockKey.indexOf('!', 1);
    const keyRoot = lockKey.substring(1, sepIndex === -1 ? lockKey.length : sepIndex);
    if (!keyRoot) {
      return;
    }
    const keyRootChannel = analysisPass.findDeclaration(node._analysis, keyRoot);
    if (keyRootChannel) {
      this._failNonContextSequenceRoot(node, keyRootChannel);
    }
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

  compileInlineIf(node) {
    const hasLinkedMutations = node._analysis.linkedMutatedChannels &&
      node._analysis.linkedMutatedChannels.size > 0;
    if (hasLinkedMutations) {
      this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, function() {
        this.emit('const cond = await runtime.resolveSingle(');
        this.compile(node.cond, null);
        this.emit.line(');');
        this.emit('if(cond) {');
        this.emit('return ');
        this.compile(node.body, null);
        this.emit.line(';');
        this.emit('} else {');
        if (node.else_) {
          this.emit('return ');
          this.compile(node.else_, null);
          this.emit.line(';');
        } else {
          this.emit.line('return "";');
        }
        this.emit('}');
      });
      return;
    }

    this.emit('runtime.resolveSingle(');
    this.compile(node.cond, null);
    this.emit(').then(async function(cond) {');
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

  analyzeInlineIf() {
    return {
      createsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compileIs(node) {
    const testFacts =
      node._analysis.isTest ||
      this._getIsTestFacts(node);
    const testName = testFacts.name;
    const testFunc = `env.getTest("${testName}")`;
    const failMsg = `test not found: ${testName}`.replace(/"/g, '\\"');
    const errorContext = this._generateErrorContext(node, node.right);

    if (testFacts.isError) {
      const observationFacts = testFacts.errorObservation;
      if (observationFacts) {
        this._emitErrorObservation(observationFacts, node.left, 'isError');
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
      this.emit.line(`  const testFunc = ${testFunc};`);
      this.emit.line(`  if (!testFunc) { var err = runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}", context.path); throw err; }`);
      this.emit.line(`  const result = await testFunc.call(context, ${args}[0]`);
      if (node.right.args && node.right.args.children.length > 0) {
        this.emit.line(`, ...${args}.slice(1)`);
      }
      this.emit.line(');');
      this.emit.line('  return result === true;');
    }, true);
  }

  compileOr(node) {
    this._compileAsyncBinOpShortCircuit(node, true);
  }

  analyzeOr() {
    return {
      createsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compileAnd(node) {
    this._compileAsyncBinOpShortCircuit(node, false);
  }

  analyzeAnd() {
    return {
      createsLinkedChildBuffer: true,
      expressionControlFlowBoundary: true
    };
  }

  compilePeekError(node) {
    const observationFacts =
      node._analysis.errorObservation ||
      this._getErrorObservationFacts(node.target);
    if (observationFacts) {
      this._emitErrorObservation(observationFacts, node.target, 'getError');
      return;
    }
    this.emit('runtime.peekError(');
    this.compile(node.target, null);
    this.emit(')');
  }

  compileCompare(node) {
    this.emit('runtime.resolveDuo(');
    this.compile(node.expr, null);
    this.emit(',');
    this.compile(node.ops[0].expr, null);
    this.emit(').then(async function([expr, ref1]){');
    this.emit(`return expr ${compareOps[node.ops[0].type]} ref1`);
    node.ops.forEach((op, index) => {
      if (index > 0) {
        this.emit(` ${compareOps[op.type]} `);
        this.compileAwaited(op.expr, null);
      }
    });
    this.emit('})');
  }

  analyzeLookupVal(node, analysisPass) {
    return this.lookup.analyzeLookupVal(node, analysisPass);
  }

  postAnalyzeIs(node) {
    const isTest = this._getIsTestFacts(node);
    return {
      isTest,
      errorObservation: isTest.errorObservation || null
    };
  }

  postAnalyzePeekError(node) {
    return {
      errorObservation: this._getErrorObservationFacts(node.target)
    };
  }

  compileLookupVal(node) {
    this.lookup.compileLookupVal(node);
  }

  analyzeFunCall(node, analysisPass) {
    return this.call.analyzeFunCall(node, analysisPass);
  }

  postAnalyzeFunCall(node) {
    return this.call.postAnalyzeFunCall(node);
  }

  compileFunCall(node) {
    this.call.compileFunCall(node);
  }

  compileFilter(node) {
    this.assertType(node.name, nodes.Symbol);
    const parts = [
      function () {
        this.emit(`env.getFilter("${node.name.value}")`);
      },
      ...node.args.children.map((arg) => (function() {
        this.compile(arg, null);
      }))
    ];
    this._compileResolvedPartList(parts, function (result) {
      this.emit(`return ${result}[0].call(context, ...${result}.slice(1));`);
    }, false);
  }

  compileFilterAsync(node) {
    const symbol = node.symbol.value;
    this.assertType(node.name, nodes.Symbol);
    this.emit.line(`let ${symbol} = `);
    this._compileAggregate(node.args, null, '[', ']', true, false, function (result) {
      this.emit(`return env.getFilter("${node.name.value}").bind(env)(...${result});`);
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
    const shouldEmitOwnWaitedResolve = this.buffer.currentWaitedChannelName &&
      !excludeFromWaitedRootTracking;

    if (!shouldEmitOwnWaitedResolve) {
      this._compileExpression(node, null, positionNode);
      return;
    }

    const resultId = this._tmpid();
    const waitedChannelName = this.buffer.currentWaitedChannelName;
    const waitedOwnerBuffer = this.buffer.currentWaitedOwnerBuffer || this.buffer.currentBuffer;
    const posLiteral = this.buffer._emitPositionLiteral(positionNode ?? node);

    this.emit('(() => { ');
    this.emit(`let ${resultId} = `);
    this._compileExpression(node, null, positionNode);
    this.emit('; ');
    this.emit(`${waitedOwnerBuffer}.addCommand(new runtime.WaitResolveCommand({ channelName: "${waitedChannelName}", args: [${resultId}], pos: ${posLiteral} }), "${waitedChannelName}"); `);
    this.emit(`return ${resultId}; `);
    this.emit('})()');
  }

  analyzeCaller(node) {
    return this.macro.analyzeCaller(node);
  }

  compileCaller(node) {
    this.macro.compileAsyncCaller(node);
  }


  _compileAsyncAggregate(node, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    const doResolve = resolveItems;
    if (doResolve) {
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
        case '{':
          this.emit('runtime.resolveObjectProperties({');
          this._compileArguments(node, null, expressionRoot, startChar);
          this.emit('})');
          break;
        case '(': {
          this.emit('runtime.resolveAll([');
          this._compileArguments(node, null, expressionRoot, '[');
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
          break;
        }
      }

      if (compileThen) {
        const result = this._tmpid();
        this.emit(`.then(${asyncThen ? 'async ' : ''}function(${result}){`);
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
      this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }
    this._compileScriptAmbientOnlySymbolLookup(node, name);
  }

  _compileScriptAmbientOnlySymbolLookup(node, name) {
    this.emit(
      `context.lookupScript("${name}", ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this._generateErrorContext(node))}, path: context.path }` +
      ')'
    );
  }

  _compileAsyncTemplateSymbolLookup(node, name) {
    const sequenceLockLookup = node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup?.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }

    this.emit(`context.lookup("${name}")`);
  }

  _compileAsyncBinOpShortCircuit(node, isOr) {
    const hasLinkedMutations = node._analysis.linkedMutatedChannels &&
      node._analysis.linkedMutatedChannels.size > 0;
    if (hasLinkedMutations) {
      this.boundaries.compileExpressionControlFlowBoundary(this.buffer, node, function() {
        this.emit('const left = await runtime.resolveSingle(');
        this.compile(node.left, null);
        this.emit.line(');');
        const check = isOr ? 'left' : '!left';
        this.emit(`if (${check}) {`);
        this.emit.line('return left;');
        this.emit('} else {');
        this.emit('return ');
        this.compile(node.right, null);
        this.emit.line(';');
        this.emit('}');
      });
      return;
    }

    this.emit('runtime.resolveSingle(');
    this.compile(node.left, null);
    this.emit(').then(async function(left) {');

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
    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');
    const errorContextJson = JSON.stringify(this._createErrorContext(node));
    this.emit('runtime.callWrapAsync(');
    this.compile(node.name, null);
    this.emit(`, "${funcName}", context, `);
    this._compileAggregate(node.args, null, '[', ']', false, false);
    this.emit(`, ${errorContextJson}, ${currentBufferExpr})`);
  }

  _emitAsyncBinFunc(node, funcName, separator) {
    this.emit('(');
    this.emit('runtime.resolveDuo(');
    this.compile(node.left, null);
    this.emit(',');
    this.compile(node.right, null);
    this.emit(')');
    this.emit(`.then(function([left,right]){return ${funcName}(left${separator}right);}))`);
  }

  _emitAsyncBinOp(node, str) {
    this.emit('runtime.resolveDuo(');
    this.compile(node.left, null);
    this.emit(',');
    this.compile(node.right, null);
    this.emit(')');
    this.emit('.then(function([left,right]){return left ' + str + ' right;})');
  }

  _emitAsyncUnaryOp(node, operator) {
    this.emit('runtime.resolveSingle(');
    this.compile(node.target, null);
    this.emit(`).then(function(target){return ${operator}target;})`);
  }

  _emitErrorObservation(observationFacts, targetNode, mode) {
    if (observationFacts.kind === 'component') {
      this.component.emitChannelObservation({
        bindingName: observationFacts.bindingName,
        channelName: observationFacts.channelName,
        mode,
        implicitVarRead: false
      }, targetNode);
      return;
    }
    if (observationFacts.kind === 'shared-channel') {
      this.channel.emitSharedChannelObservation(observationFacts.channelName, targetNode, mode);
      return;
    }
    if (mode === 'isError') {
      this.buffer.emitAddIsError(observationFacts.channelName, targetNode);
      return;
    }
    this.buffer.emitAddGetError(observationFacts.channelName, targetNode);
  }

  _getIsTestFacts(node) {
    const name = node.right.name ? node.right.name.value : node.right.value;
    const isError = name === 'error';
    return {
      name,
      isError,
      hasArgs: !!(node.right.args && node.right.args.children.length > 0),
      errorObservation: isError ? this._getErrorObservationFacts(node.left) : null
    };
  }

  _getErrorObservationFacts(targetNode) {
    const componentBindingRoot = this.component.getBindingRoot(targetNode);
    if (componentBindingRoot && componentBindingRoot.staticPath.length === 2) {
      return {
        kind: 'component',
        bindingName: componentBindingRoot.bindingName,
        channelName: componentBindingRoot.staticPath[1]
      };
    }

    const channelName = this._getObservedChannelName(targetNode);
    if (!channelName) {
      return null;
    }
    const channelDecl = this.analysis.findDeclaration(targetNode._analysis, channelName);
    return {
      kind: channelDecl && channelDecl.shared ? 'shared-channel' : 'channel',
      channelName
    };
  }

  _getObservedChannelName(targetNode) {
    if (!this.scriptMode || !targetNode) {
      return null;
    }
    if (targetNode.sequential) {
      return null;
    }

    const thisSharedFacts = this.channel.getThisSharedAccessFacts(targetNode);
    if (thisSharedFacts && thisSharedFacts.channelPath.length === 1) {
      return thisSharedFacts.channelName;
    }

    if (targetNode instanceof nodes.Symbol) {
      const name = targetNode.value;
      const channelDecl = this.analysis.findDeclaration(targetNode._analysis, name);
      if (channelDecl) {
        if (this.scriptMode && channelDecl.shared) {
          return null;
        }
        return name;
      }
      return null;
    }

    if (targetNode instanceof nodes.FunCall) {
      const candidate = this.sequential._extractStaticPathRoot(targetNode.name, 2);
      if (candidate) {
        const channelDecl = this.analysis.findDeclaration(targetNode._analysis, candidate);
        if (channelDecl) {
          if (this.scriptMode && channelDecl.shared) {
            return null;
          }
          return candidate;
        }
      }
      return null;
    }

    return null;
  }
}

export {CompilerBaseAsync};
