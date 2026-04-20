'use strict';

const nodes = require('../nodes');
const CompileAnalysis = require('./analysis');
const CompileRename = require('./rename');
const { validateSinkSnapshotInGuard } = require('./validation');
const CompilerCommon = require('./compiler-common');

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

  compileSymbol(node) {
    const name = node.value;
    if (node.isCompilerInternal) {
      this.emit(name);
      return;
    }
    const declaredOutput = this.analysis.findDeclaration(node._analysis, name);
    if (declaredOutput) {
      if (this.scriptMode && this.currentCompilingBlock) {
        const declarationOwner = this.analysis.findDeclarationOwner(node._analysis, name);
        const blockOwner = this.currentCompilingBlock._analysis;
        const blockBodyOwner = this.currentCompilingBlock.body ? this.currentCompilingBlock.body._analysis : null;
        const isMethodVisibleBinding = !!(
          declaredOutput.shared ||
          declaredOutput.extern ||
          declaredOutput.imported ||
          declarationOwner === blockOwner ||
          declarationOwner === blockBodyOwner
        );
        if (!isMethodVisibleBinding) {
          this.emit('undefined');
          return;
        }
      }
      if (node.sequential || node.sequentialRepair) {
        this._failNonContextSequenceRoot(node, declaredOutput);
      }
      if (declaredOutput.type === 'var') {
        if (!this.scriptMode && this.inBlock) {
          this.emit(`runtime.channelLookup("${name}", ${this.buffer.currentBuffer})`);
          return;
        }
        this.buffer.emitAddSnapshot(name, node);
        return;
      }
      this.fail(
        `Channel '${name}' cannot be used as a bare symbol. Use '${name}.snapshot()' instead.`,
        node.lineno,
        node.colno,
        node
      );
    }
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
    if (!lockKey || lockKey.charAt(0) !== '!') {
      return;
    }
    const sepIndex = lockKey.indexOf('!', 1);
    const keyRoot = lockKey.substring(1, sepIndex === -1 ? lockKey.length : sepIndex);
    if (!keyRoot) {
      return;
    }
    const keyRootOutput = this.analysis.findDeclaration(node._analysis, keyRoot);
    if (keyRootOutput) {
      this._failNonContextSequenceRoot(node, keyRootOutput);
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
    const hasCommandEffects = !!(node._analysis && node._analysis.mutatedChannels && node._analysis.mutatedChannels.size > 0);
    if (hasCommandEffects) {
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

  compileIs(node) {
    const testName = node.right.name ? node.right.name.value : node.right.value;
    const testFunc = `env.getTest("${testName}")`;
    const failMsg = `test not found: ${testName}`.replace(/"/g, '\\"');
    const errorContext = this._generateErrorContext(node, node.right);

    if (testName === 'error') {
      const channelName = this._getObservedChannelName(node.left);
      if (channelName) {
        const channelDecl = this.analysis.findDeclaration(node.left._analysis, channelName);
        if (channelDecl && channelDecl.shared) {
          this._emitSharedChannelObservation(channelName, node.left, 'isError');
        } else {
          this.buffer.emitAddIsError(channelName, node.left);
        }
        return;
      }
      this.emit('runtime.isError(');
      this.compile(node.left, null);
      this.emit(')');
      return;
    }

    const mergedNode = {
      positionNode: (node.right.args && node.right.args.children.length > 0) ? node.right : node.left,
      children: (node.right.args && node.right.args.children.length > 0) ? [node.left, ...node.right.args.children] : [node.left]
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

  compileAnd(node) {
    this._compileAsyncBinOpShortCircuit(node, false);
  }

  compilePeekError(node) {
    const channelName = this._getObservedChannelName(node.target);
    if (channelName) {
      const channelDecl = this.analysis.findDeclaration(node.target._analysis, channelName);
      if (channelDecl && channelDecl.shared) {
        this._emitSharedChannelObservation(channelName, node.target, 'getError');
      } else {
        this.buffer.emitAddGetError(channelName, node.target);
      }
      return;
    }
    this.emit('runtime.peekError(');
    this.compile(node.target, null);
    this.emit(')');
  }

  _getExplicitThisDispatchFacts(node) {
    if (!(node instanceof nodes.LookupVal)) {
      return null;
    }
    if (!(node.target instanceof nodes.Symbol) || node.target.value !== 'this') {
      return null;
    }
    if (!(node.val instanceof nodes.Literal) || typeof node.val.value !== 'string') {
      return null;
    }
    return {
      methodName: node.val.value
    };
  }

  _getComponentBindingFacts(node, { forCall = false } = {}) {
    const bindingRoot = this._getComponentBindingRoot(node);
    if (!bindingRoot) {
      return null;
    }
    const bindingName = bindingRoot.bindingName;
    const staticPath = bindingRoot.staticPath;

    if (!forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: 'shared-read',
        channelName: staticPath[1],
        implicitVarRead: true
      };
    }

    if (
      staticPath.length === 3 &&
      (staticPath[2] === 'snapshot' || staticPath[2] === 'isError' || staticPath[2] === 'getError')
    ) {
      return {
        bindingName,
        kind: 'shared-observe',
        channelName: staticPath[1],
        mode: staticPath[2],
        implicitVarRead: false
      };
    }

    if (forCall && staticPath.length === 2) {
      return {
        bindingName,
        kind: 'method-call',
        methodName: staticPath[1]
      };
    }

    return null;
  }

  _getComponentBindingRoot(node) {
    if (!this.scriptMode || !node) {
      return null;
    }

    const staticPath = this.sequential._extractStaticPath(node);
    if (!staticPath || staticPath.length < 2) {
      return null;
    }

    const bindingName = staticPath[0];
    const bindingDecl = this.analysis.findDeclaration(node._analysis, bindingName);
    if (!bindingDecl || !bindingDecl.componentBinding) {
      return null;
    }

    return {
      bindingName,
      staticPath
    };
  }

  _failUnsupportedComponentBindingUsage(node, bindingName, usage) {
    this.fail(
      `component binding '${bindingName}' only supports ${usage}`,
      node.lineno,
      node.colno,
      node
    );
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
    const uses = [];
    const mutates = [];
    let sequenceChannelLookup = null;
    const sequenceLockLookup = this.sequential.getSequenceLockLookup(node);
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

  compileLookupVal(node) {
    const explicitThisDispatch = this.scriptMode ? this._getExplicitThisDispatchFacts(node) : null;
    if (explicitThisDispatch && !(node._analysis && node._analysis.allowExplicitThisDispatchCall)) {
      this.fail(
        `bare inherited-method references are not supported; bare this.${explicitThisDispatch.methodName} references are not allowed; use this.${explicitThisDispatch.methodName}(...)`,
        node.lineno,
        node.colno,
        node
      );
    }

    const componentBindingRoot = this._getComponentBindingRoot(node);
    const componentBindingFacts = this._getComponentBindingFacts(node);
    if (componentBindingFacts && componentBindingFacts.kind === 'shared-read') {
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      this.emit(
        `runtime.observeComponentChannel(${JSON.stringify(componentBindingFacts.bindingName)}, ${this.buffer.currentBuffer}, ` +
        `${JSON.stringify(componentBindingFacts.channelName)}, runtime, ${errorContextJson}, "snapshot", true)`
      );
      return;
    }
    if (componentBindingRoot) {
      this._failUnsupportedComponentBindingUsage(
        node,
        componentBindingRoot.bindingName,
        '`ns.x` reads, `ns.x.snapshot()/isError()/getError()` observations, and `ns.method(...)` calls'
      );
    }

    const sequenceChannelLookup =
      node._analysis && node._analysis.sequenceChannelLookup;
    if (this.scriptMode && sequenceChannelLookup) {
      this.buffer.emitAddSequenceGet(
        sequenceChannelLookup.channelName,
        sequenceChannelLookup.propertyName,
        sequenceChannelLookup.subpath,
        node
      );
      return;
    }

    const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup && sequenceLockLookup.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      if (this.scriptMode) {
        this.emit('runtime.sequentialMemberLookupScriptValue((');
      } else {
        this.emit('runtime.sequentialMemberLookupAsyncValue((');
      }
      this.compile(node.target, null);
      this.emit('),');
      this.compile(node.val, null);
      this.emit(`, "${nodeStaticPathKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }

    const errorContextJson = JSON.stringify(this._createErrorContext(node));
    if (this.scriptMode) {
      this.emit('runtime.memberLookupScript((');
    } else {
      this.emit('runtime.memberLookupAsync((');
    }
    this.compile(node.target, null);
    this.emit('),');
    this.compile(node.val, null);
    this.emit(`, ${errorContextJson})`);
  }

  analyzeFunCall(node, analysisPass) {
    const uses = [];
    const mutates = [];
    let specialChannelCall = null;
    let importedCallable = null;
    let directCallerCall = false;
    let directMacroCall = null;
    const sequenceLockLookup = this.sequential.getSequenceLockLookup(node);
    node._analysis.sequenceLockLookup = sequenceLockLookup;
    if (sequenceLockLookup) {
      uses.push(sequenceLockLookup.key);
      mutates.push(sequenceLockLookup.key);
      return { uses, mutates };
    }

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

    if (node.name instanceof nodes.Symbol && analysisPass.findDeclaration) {
      const macroDecl = analysisPass.findDeclaration(node._analysis, node.name.value);
      if (macroDecl && macroDecl.isMacro) {
        directMacroCall = {
          binding: macroDecl.declarationOrigin ? macroDecl.declarationOrigin.compiledMacroFuncId : null
        };
      }
    }

    if (node?.name && analysisPass.findDeclaration) {
      const importedRoot = this.sequential._extractStaticPathRoot(node.name);
      const importedDecl = importedRoot ? analysisPass.findDeclaration(node._analysis, importedRoot) : null;
      const isImportedCallable = !!(
        (importedDecl && importedDecl.imported) ||
        (!importedDecl && importedRoot && this.importedBindings && this.importedBindings.has(importedRoot))
      );
      if (isImportedCallable) {
        importedCallable = true;
        const importedChannelName = importedDecl && (importedDecl.runtimeName || importedRoot);
        if (importedChannelName) {
          uses.push(importedChannelName);
        }
        const textChannel = analysisPass.getCurrentTextChannel(node._analysis);
        if (textChannel) {
          uses.push(textChannel);
        }
      }
    }

    const callFacts =
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
            shared: !!channelDecl.shared,
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

  compileFunCall(node) {
    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');
    const directMacroCall = node._analysis.directMacroCall;
    const directMacroBinding = directMacroCall ? directMacroCall.binding : null;
    const isDirectMacroCall = !!directMacroCall;
    const importedCallableFacts = node._analysis.importedCallable;
    const explicitThisDispatch = this.scriptMode ? this._getExplicitThisDispatchFacts(node.name) : null;
    const componentBindingRoot = this._getComponentBindingRoot(node.name);
    const componentBindingFacts = this._getComponentBindingFacts(node.name, { forCall: true });
    if (explicitThisDispatch) {
      (node.name._analysis || (node.name._analysis = {})).allowExplicitThisDispatchCall = true;
    }

    if (componentBindingFacts) {
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      if (componentBindingFacts.kind === 'method-call') {
        this.emit(
          `runtime.callComponentMethod(${JSON.stringify(componentBindingFacts.bindingName)}, ${this.buffer.currentBuffer}, ` +
          `${JSON.stringify(componentBindingFacts.methodName)}, `
        );
        this._compileAggregate(node.args, null, '[', ']', false, false);
        this.emit(`, env, runtime, cb, ${errorContextJson})`);
        return;
      }

      this.emit(
        `runtime.observeComponentChannel(${JSON.stringify(componentBindingFacts.bindingName)}, ${this.buffer.currentBuffer}, ` +
        `${JSON.stringify(componentBindingFacts.channelName)}, runtime, ${errorContextJson}, ` +
        `${JSON.stringify(componentBindingFacts.mode || 'snapshot')}, ${componentBindingFacts.implicitVarRead ? 'true' : 'false'})`
      );
      return;
    }
    if (componentBindingRoot) {
      this._failUnsupportedComponentBindingUsage(
        node.name,
        componentBindingRoot.bindingName,
        '`ns.method(...)` calls and `ns.x.snapshot()/isError()/getError()` observations'
      );
    }

    if (this._compileSpecialChannelFunCall(node)) {
      return;
    }

    if (this.macro && this.macro.isDirectCallerCall(node)) {
      this.macro._emitCallerCallDispatch({
        bufferId: this.buffer.currentBuffer,
        node
      });
      return;
    }

    const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
    const sequenceLockKey = sequenceLockLookup && sequenceLockLookup.key;
    if (sequenceLockKey) {
      let index = sequenceLockKey.indexOf('!', 1);
      const keyRoot = sequenceLockKey.substring(1, index === -1 ? sequenceLockKey.length : index);
      const keyRootOutput = this.analysis.findDeclaration(node._analysis, keyRoot);
      if (keyRootOutput) {
        this._failNonContextSequenceRoot(node, keyRootOutput);
      }
    }
    if (sequenceLockKey) {
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      this.emit('runtime.sequentialCallWrapValue(');
      this.compile(node.name, null);
      this.emit(`, "${funcName}", context, `);
      this._compileAggregate(node.args, null, '[', ']', false, false);
      this.emit(`, "${sequenceLockKey}", ${errorContextJson}, ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }
    if (isDirectMacroCall) {
      this.emit('runtime.invokeMacro(');
      if (directMacroBinding) {
        this.emit(directMacroBinding);
      } else {
        this.compile(node.name, null);
      }
      this.emit(', context, ');
      this._compileAggregate(node.args, null, '[', ']', false, false);
      this.emit(`, ${this.buffer.currentBuffer})`);
      return;
    }
    if (importedCallableFacts) {
      this.boundaries.compileValueBoundary(this.buffer, node, (n) => {
        this._emitAsyncDynamicCall(n, 'currentBuffer');
      });
      return;
    }
    if (explicitThisDispatch) {
      const errorContextJson = JSON.stringify(this._createErrorContext(node));
      this.emit(`runtime.invokeInheritedMethod(inheritanceState, "${explicitThisDispatch.methodName}", `);
      this._compileAggregate(node.args, null, '[', ']', false, false);
      this.emit(`, context, env, runtime, cb, ${this.buffer.currentBuffer}, ${errorContextJson})`);
      return;
    }
    this._emitAsyncDynamicCall(node, this.buffer.currentBuffer);
  }

  compileFilter(node) {
    this.assertType(node.name, nodes.Symbol);
    const parts = [
      function () {
        this.emit(`env.getFilter("${node.name.value}")`);
      },
      ...node.args.children.map((arg) => function () {
        this.compile(arg, null);
      })
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
    this.emit(`${waitedOwnerBuffer}.add(new runtime.WaitResolveCommand({ channelName: "${waitedChannelName}", args: [${resultId}], pos: ${posLiteral} }), "${waitedChannelName}"); `);
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
    const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup && sequenceLockLookup.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      this.emit(`runtime.sequentialContextLookupScriptValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }
    this.emit('runtime.contextOrScriptChannelLookup(' +
      'context, "' + name + '", ' +
      `${this.buffer.currentBuffer}, ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this._generateErrorContext(node))}, path: context.path }` +
      ')');
  }

  _compileAsyncTemplateSymbolLookup(node, name) {
    const sequenceLockLookup = node._analysis && node._analysis.sequenceLockLookup;
    const nodeStaticPathKey = sequenceLockLookup && sequenceLockLookup.key;
    if (nodeStaticPathKey) {
      this._assertSequenceRootIsContextPath(nodeStaticPathKey, node);
      this.emit(`runtime.sequentialContextLookupValue(context, "${name}", "${nodeStaticPathKey}", ${!!sequenceLockLookup.repair}, ${this.buffer.currentBuffer})`);
      return;
    }

    const useContextOnlyInheritanceLookup =
      this.inBlock &&
      !this.analysis.findDeclaration(node._analysis, name);
    if (useContextOnlyInheritanceLookup) {
      this.emit(
        `runtime.contextOrInheritableChannelLookup(` +
        `context, "${name}", ${this.buffer.currentBuffer}, ` +
        `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this._generateErrorContext(node))}, path: context.path }, ` +
        `inheritanceState)`
      );
    } else {
      this.emit(`runtime.contextOrChannelLookup(context, "${name}", ${this.buffer.currentBuffer})`);
    }
  }

  _compileAsyncBinOpShortCircuit(node, isOr) {
    const hasCommandEffects = !!(node._analysis && node._analysis.mutatedChannels && node._analysis.mutatedChannels.size > 0);
    if (hasCommandEffects) {
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


  _compileSpecialChannelFunCall(node) {
    if (!this.scriptMode) {
      return false;
    }
    const specialChannelCall = node._analysis && node._analysis.specialChannelCall;
    if (!specialChannelCall) {
      return false;
    }
    if (specialChannelCall.channelType === 'var') {
      return false;
    }
    if (this._compileChannelObservationFunCall(node, specialChannelCall)) {
      return true;
    }
    return this._compileSequenceChannelFunCall(node, specialChannelCall);
  }

  _compileChannelObservationFunCall(node, specialChannelCall) {
    if (specialChannelCall.subpath.length !== 0) {
      return false;
    }
    validateSinkSnapshotInGuard(this, {
      node,
      command: specialChannelCall.methodName,
      channelType: specialChannelCall.channelType
    });
    if (specialChannelCall.methodName === 'snapshot') {
      if (specialChannelCall.shared) {
        this._emitSharedChannelObservation(specialChannelCall.channelName, node, 'snapshot');
      } else {
        this.buffer.emitAddSnapshot(specialChannelCall.channelName, node);
      }
      return true;
    }
    if (specialChannelCall.methodName === 'isError') {
      if (specialChannelCall.shared) {
        this._emitSharedChannelObservation(specialChannelCall.channelName, node, 'isError');
      } else {
        this.buffer.emitAddIsError(specialChannelCall.channelName, node);
      }
      return true;
    }
    if (specialChannelCall.methodName === 'getError') {
      if (specialChannelCall.shared) {
        this._emitSharedChannelObservation(specialChannelCall.channelName, node, 'getError');
      } else {
        this.buffer.emitAddGetError(specialChannelCall.channelName, node);
      }
      return true;
    }
    return false;
  }

  _emitInheritanceStateReference() {
    return '(typeof inheritanceState === "undefined" ? null : inheritanceState)';
  }

  _emitSharedChannelObservation(channelName, node, mode = 'snapshot', implicitVarRead = false) {
    this.emit(
      `runtime.observeInheritanceSharedChannel(${JSON.stringify(channelName)}, ${this.buffer.currentBuffer}, ` +
      `{ lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: ${JSON.stringify(this._generateErrorContext(node))}, path: context.path }, ` +
      `${this._emitInheritanceStateReference()}, ${JSON.stringify(mode)}, ${implicitVarRead})`
    );
  }

  _compileSequenceChannelFunCall(node, specialChannelCall) {
    if (specialChannelCall.channelType !== 'sequence' || specialChannelCall.methodName === 'snapshot') {
      return false;
    }
    this._compileAggregate(node.args, null, '[', ']', false, false, function (resolvedArgs) {
      this.emit('return ');
      this.buffer.emitAddSequenceCall(
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

  _getObservedChannelName(targetNode) {
    if (!this.scriptMode || !targetNode) {
      return null;
    }
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
}

module.exports = CompilerBaseAsync;
module.exports.CompilerBaseAsync = CompilerBaseAsync;
