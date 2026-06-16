
import * as nodes from '../language/nodes.js';
import {
  CALLER_SCHED_CHAIN_NAME,
  RETURN_CHAIN_NAME,
} from './reserved.js';

class CompileMacro {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentCallerBindingContext = null;
  }

  isDirectCallerCall(node) {
    return !!(
      this.compiler.asyncMode &&
      node._analysis.directCallerCall &&
      this.currentCallerBindingContext
    );
  }

  _emitCallerCallDispatch({ bufferId, node }) {
    const compiler = this.compiler;
    const activeContext = this.currentCallerBindingContext;
    const argsId = compiler._tmpid();
    const errorContext = compiler.emitErrorContext(node);
    const callerStackFields = {
      caller: true,
      callableName: compiler._describeCallableTarget(node.name),
      callSignature: compiler._describeCallSignature(node.name, node.args)
    };
    const callerBufferStackErrorContext = compiler.emitErrorContext(node, callerStackFields);

    // Direct caller() must register its invocation buffer and __caller__
    // waits in the current boundary, not from a later .then.
    compiler.emit('(() => {');
    compiler.emit(`let ${argsId} = `);
    compiler._compileAggregate(node.args, null, '[', ']', false, false);
    compiler.emit.line(';');
    compiler.emit.line(`if (${activeContext.rawCallerVar} && ${activeContext.rawCallerVar}.isMacro) {`);

    const invocationBufferId = compiler._tmpid();
    const invocationFinishedId = compiler._tmpid();
    const invocationResultId = compiler._tmpid();
    compiler.emit.line(`let ${invocationBufferId} = new runtime.CommandBuffer(context, ${activeContext.allCallersBufferId}, ${activeContext.rawCallerVar}.__callerBoundaryLinkedChains || null, null, ${activeContext.rawCallerVar}.__callerBoundaryLinkedMutatedChains || null, ${callerBufferStackErrorContext}, null, renderState);`);
    compiler.emit.line(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit.line(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_SCHED_CHAIN_NAME}", args: [${invocationFinishedId}], errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_SCHED_CHAIN_NAME}");`);
    compiler.emit.line(`let ${invocationResultId} = runtime.finallyValue(runtime.invokeMacro(${activeContext.rawCallerVar}, context, ${argsId}, ${invocationBufferId}), () => ${invocationBufferId}.finish());`);
    compiler.emit.line(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_SCHED_CHAIN_NAME}", args: [${invocationResultId}], errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_SCHED_CHAIN_NAME}");`);
    compiler.emit.line(`return ${invocationResultId};`);
    compiler.emit.line('}');
    compiler.emit.line(`return runtime.callWrapAsync(${activeContext.rawCallerVar}, "caller", context, ${argsId}, ${errorContext}, ${bufferId});`);
    compiler.emit('})()');
  }

  analyzeCaller(node) {
    const compiledMacroFuncId = `macro_${this.compiler._tmpid()}`;
    node.name.addAnalysis({ declarationTarget: true });
    const declares = [
      { name: 'caller', type: 'var', initializer: null, internal: true },
      this.compiler.return.createChainDeclaration()
    ];
    const textChainName = !this.compiler.scriptMode
      ? this.compiler.analysis.getCurrentTextChain(node._analysis)
      : null;
    if (textChainName) {
      declares.push({ name: textChainName, type: 'text', initializer: null, internal: true });
    }
    const seenParamNames = new Set();
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg.addAnalysis({ declarationTarget: true });
        this._validateParameterDeclaration(arg.value, arg, seenParamNames, node);
        declares.push({ name: arg.value, type: 'var', initializer: null, macroParam: true });
      }
    });
    return {
      createScope: true,
      scopeBoundary: false,
      parentReadOnly: true,
      declares,
      compiledMacroFuncId,
      wantsLinkedChildBuffer: true
    };
  }

  _getCallerBoundaryLinkedChains(node) {
    const boundaryLinkedChains = node._analysis.boundaryLinkedChains;
    if (!boundaryLinkedChains) {
      return [];
    }
    return Array.from(boundaryLinkedChains);
  }

  _getCallerBoundaryLinkedMutatedChains(node) {
    const boundaryLinkedMutatedChains = node._analysis.boundaryLinkedMutatedChains;
    if (!boundaryLinkedMutatedChains) {
      return [];
    }
    return Array.from(boundaryLinkedMutatedChains);
  }

  compileCaller(node) {
    const compiler = this.compiler;
    compiler.emit('(function (){');
    const funcId = this._compileAsyncCaller(node);
    compiler.emit(`return ${funcId};})()`);
  }

  _compileAsyncCaller(node) {
    const funcId = this._compileAsyncMacro(node);
    const callerBoundaryLinkedChains = this._getCallerBoundaryLinkedChains(node);
    const callerBoundaryLinkedMutatedChains = this._getCallerBoundaryLinkedMutatedChains(node);
    this.compiler.emit.line(`${funcId}.__callerBoundaryLinkedChains = ${JSON.stringify(callerBoundaryLinkedChains)};`);
    this.compiler.emit.line(`${funcId}.__callerBoundaryLinkedMutatedChains = ${JSON.stringify(callerBoundaryLinkedMutatedChains)};`);
    return funcId;
  }

  compileSyncCaller(node, frame) {
    const compiler = this.compiler;
    compiler.emit('(function (){');
    const funcId = this._compileSyncCaller(node, frame);
    compiler.emit(`return ${funcId};})()`);
  }

  _compileSyncCaller(node, frame) {
    return this._compileSyncMacro(node, frame, true);
  }

  analyzeMacro(node) {
    const declares = [];
    const declaresInParent = [];
    const compiledMacroFuncId = `macro_${this.compiler._tmpid()}`;
    node.name.addAnalysis({ declarationTarget: true });
    declares.push(this.compiler.return.createChainDeclaration());
    declares.push({ name: 'caller', type: 'var', initializer: null, internal: true });
    const seenParamNames = new Set();
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg.addAnalysis({ declarationTarget: true });
        this._validateParameterDeclaration(arg.value, arg, seenParamNames, node);
        declares.push({ name: arg.value, type: 'var', initializer: null, macroParam: true });
      } else if (arg instanceof nodes.Dict) {
        arg.children.forEach((pair) => {
          this._validateParameterDeclaration(pair.key.value, pair.key, seenParamNames, node);
          declares.push({ name: pair.key.value, type: 'var', initializer: null, macroParam: true });
        });
      }
    }, undefined, node);
    const macroDecl = { name: node.name.value, type: 'var', initializer: null, isMacro: true };
    const parentMacroDecl = { name: node.name.value, type: 'var', initializer: null, parentOwned: true, isMacro: true };
    declares.push(macroDecl);
    declaresInParent.push(parentMacroDecl);
    declares.push({ name: CALLER_SCHED_CHAIN_NAME, type: 'var', initializer: null, internal: true });
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
      declaresInParent,
      hasCallerSupport: false,
      compiledMacroFuncId
    };
  }

  _validateParameterDeclaration(name, nameNode, seenParamNames, ownerNode) {
    if (seenParamNames.has(name)) {
      this.compiler.fail(
        `Identifier '${name}' has already been declared.`,
        nameNode.lineno,
        nameNode.colno,
        ownerNode,
        nameNode
      );
    }
    seenParamNames.add(name);
  }

  bodyUsesCallerScheduling(bodyNode) {
    // __caller__ intentionally remains in generic use/mutate facts so nested
    // caller() boundaries can link it, but macro support checks should go
    // through this helper instead of open-coding the internal lane name.
    return this.compiler.analysis.getChainsUsedFromParent(bodyNode).includes(CALLER_SCHED_CHAIN_NAME);
  }

  postAnalyzeMacro(node) {
    return {
      hasCallerSupport: this.bodyUsesCallerScheduling(node.body)
    };
  }

  compileMacro(node) {
    const compiler = this.compiler;
    const funcId = this._compileAsyncMacro(node);
    const name = node.name.value;
    compiler.emit.line(`runtime.declareBufferChain(${compiler.buffer.currentBuffer}, "${name}", "var", context, null);`);
    compiler.buffer.asyncAddValueToBuffer((resultVar) => {
      compiler.emit(
        `${resultVar} = new runtime.VarCommand({ chainName: '${name}', args: [${funcId}], errorContext: ${compiler.emitErrorContext(node)} })`
      );
    }, node, name);
    if (name.charAt(0) !== '_' && compiler.analysis.isParentOwnedDeclarationRootOwned(node._analysis, name)) {
      if (compiler.scriptMode) {
        compiler.emit.line(`context.addResolvedExport("${name}", ${funcId});`);
      } else {
        compiler.emit.line(`context.addDeferredExport("${name}", "${name}", ${compiler.buffer.currentBuffer});`);
      }
    }
  }

  _parseMacroSignature(node) {
    const signature = this.compiler.getCallableSignatureFacts(node.args, {
      allowKeywordArgs: true,
      symbolsOnly: true,
      label: 'macro signature',
      ownerNode: node
    });
    return {
      ...signature,
      callableSignature: signature,
      emittedArgNames: signature.positionalNames.map((name) => `"${name}"`),
      emittedKwargNames: signature.keywordNames.map((name) => `"${name}"`),
      emittedParamNames: signature.positionalNames.map((name) => `l_${name}`).concat('kwargs')
    };
  }

  _emitCallerBindingValue({ bufferId, rawCallerVar, allCallersBufferId, positionNode }) {
    const compiler = this.compiler;
    const invocationBufferId = compiler._tmpid();
    const invocationArgsId = compiler._tmpid();
    const invocationFinishedId = compiler._tmpid();
    const invocationResultId = compiler._tmpid();
    const callerStackFields = {
      caller: true,
      callableName: compiler._describeCallableTarget(positionNode.name),
      callSignature: compiler._describeCallSignature(positionNode.name, positionNode.args)
    };
    const callerBufferStackErrorContext = compiler.emitErrorContext(positionNode, callerStackFields);

    // See docs/code/caller.md for the full caller-boundary architecture.
    // The macro body can use caller(), but a particular invocation only has a
    // caller boundary when it was invoked through a call block.
    // Each caller() invocation gets its own child buffer under the macro-local
    // all-callers buffer so multiple invocations can schedule independently.
    compiler.emit(`(${rawCallerVar} && ${rawCallerVar}.isMacro ? function() {`);
    compiler.emit(`let ${invocationArgsId} = Array.prototype.slice.call(arguments);`);
    compiler.emit(`let ${invocationBufferId} = new runtime.CommandBuffer(context, ${allCallersBufferId}, ${rawCallerVar}.__callerBoundaryLinkedChains || null, null, ${rawCallerVar}.__callerBoundaryLinkedMutatedChains || null, ${callerBufferStackErrorContext}, null, renderState);`);
    compiler.emit(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_SCHED_CHAIN_NAME}", args: [${invocationFinishedId}], errorContext: ${compiler.emitErrorContext(positionNode)} }), "${CALLER_SCHED_CHAIN_NAME}");`);
    // __caller__ timing is owned only by caller invocation code. Track both:
    // 1. when this invocation child buffer stops receiving commands
    // 2. when the invocation's returned value settles
    compiler.emit(`let ${invocationResultId} = runtime.finallyValue(runtime.invokeMacro(${rawCallerVar}, context, ${invocationArgsId}, ${invocationBufferId}), () => ${invocationBufferId}.finish());`);
    compiler.emit(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_SCHED_CHAIN_NAME}", args: [${invocationResultId}], errorContext: ${compiler.emitErrorContext(positionNode)} }), "${CALLER_SCHED_CHAIN_NAME}");`);
    compiler.emit(`return ${invocationResultId};`);
    compiler.emit(`} : ${rawCallerVar})`);
  }

  _emitMacroCallerSetup({ node, bufferId, rawCallerVar, allCallersBufferId }) {
    const compiler = this.compiler;
    const callerBufferStackErrorContext = compiler.emitErrorContext(node, {
      callerBlock: true,
      macroName: node.name.value,
      macroSignature: compiler._describeMacroSignature(node.name.value, [])
    });
    compiler.emit.line(`let ${rawCallerVar} = kwargs.caller;`);
    compiler.emit.line(`let ${allCallersBufferId} = null;`);
    // __caller__ records when each invocation child buffer has finished
    // receiving commands, so the macro can close the shared caller boundary
    // only after all started caller() invocations have been scheduled.
    compiler.emit.line(`runtime.declareBufferChain(${bufferId}, "${CALLER_SCHED_CHAIN_NAME}", "var", context, null);`);
    // Caller-capable macros still allow plain invocations with no caller block.
    compiler.emit.line(`if (${rawCallerVar} && ${rawCallerVar}.isMacro) {`);
    // The all-callers buffer is parent-linked because caller() may emit
    // parent-visible observable commands, unlike the isolated macro buffer.
    compiler.emit.line(`  ${allCallersBufferId} = new runtime.CommandBuffer(context, macroParentBuffer, ${rawCallerVar}.__callerBoundaryLinkedChains || null, null, ${rawCallerVar}.__callerBoundaryLinkedMutatedChains || null, ${callerBufferStackErrorContext}, macroParentBuffer, renderState);`);
    compiler.emit.line('}');
  }

  _emitAsyncMacroReturn({ node, bufferId, allCallersBufferId, hasCallerSupport }) {
    const compiler = this.compiler;
    // Macro-body boundary errors report through the compiled reportError
    // callback and propagate through chain poison, not by rejecting here.
    const callerReadyVar = hasCallerSupport ? compiler._tmpid() : null;
    const callerSchedulingPrefix =
      (hasCallerSupport ? `const ${callerReadyVar} = ${bufferId}.addCommand(new runtime.SnapshotCommand({ chainName: "${CALLER_SCHED_CHAIN_NAME}", errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_SCHED_CHAIN_NAME}");` : '') +
      (hasCallerSupport ? `await ${callerReadyVar};` : '') +
      (hasCallerSupport ? `if (${allCallersBufferId}) {${allCallersBufferId}.finish();}` : '');
    const iifeOpen = hasCallerSupport ? '(async () => {' : '(() => {';

    if (compiler.scriptMode) {
      const returnVar = compiler._tmpid();
      return iifeOpen +
        callerSchedulingPrefix +
        `${bufferId}.finish();` +
        `const ${returnVar}_snapshot = ${bufferId}.getChain("${RETURN_CHAIN_NAME}").finalSnapshot();` +
        `return runtime.thenValue(${returnVar}_snapshot, (value) => value === runtime.RETURN_UNSET ? null : value);` +
        `})()`;
    } else {
      const textSnapshotVar = compiler._tmpid();
      return iifeOpen +
        callerSchedulingPrefix +
        `${bufferId}.finish();` +
        `const ${textSnapshotVar} = ${bufferId}.getChain("${compiler.buffer.currentTextChainName}").finalSnapshot();` +
        `return runtime.thenValue(${textSnapshotVar}, (value) => runtime.markSafe(value));` +
        `})()`;
    }
  }

  _emitAsyncMacroBindings({ node, callableSignature, managedFrame, bufferId, args, kwargs, rawCallerVar, allCallersBufferId }) {
    const compiler = this.compiler;
    const hasCallerSupport = !!(rawCallerVar && allCallersBufferId);
    const positionalArgNames = new Set(args.map((arg) => arg.value));
    const positionNodesByName = new Map();
    args.forEach((arg) => {
      positionNodesByName.set(arg.value, arg);
    });
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        positionNodesByName.set(pair.key.value, pair);
      });
    }

    if (compiler.scriptMode) {
      compiler.return.emitDeclareChain(bufferId);
    }

    if (hasCallerSupport) {
      this._emitMacroCallerSetup({
        node,
        bufferId,
        rawCallerVar,
        allCallersBufferId
      });
    }

    const bindings = [{
      name: 'caller',
      emitValueExpression: () => {
        if (hasCallerSupport) {
          this._emitCallerBindingValue({
            bufferId,
            rawCallerVar,
            allCallersBufferId,
            positionNode: node
          });
        } else {
          compiler.emit('kwargs.caller');
        }
      },
      positionNode: node
    }].concat(compiler.createCallableArgumentChainBindings(
      callableSignature,
      (name, defaultValueNode) => {
        if (positionalArgNames.has(name)) {
          compiler.emit(`l_${name}`);
          return;
        }
        compiler.emit(`Object.prototype.hasOwnProperty.call(kwargs, ${JSON.stringify(name)}) ? kwargs[${JSON.stringify(name)}] : `);
        compiler._compileExpression(defaultValueNode, managedFrame);
      },
      (name) => positionNodesByName.get(name) || node
    ));

    compiler.chain.emitLocalVarChainBindings(bufferId, bindings);
  }

  _emitSyncMacroBindings({ managedFrame, args, kwargs }) {
    const compiler = this.compiler;

    this._emitSyncMacroBinding('caller', () => {
      compiler.emit('kwargs.caller');
    }, managedFrame, 'kwargs.caller');
    args.forEach((arg) => {
      this._emitSyncMacroBinding(arg.value, () => {
        compiler.emit(`l_${arg.value}`);
      }, managedFrame, `l_${arg.value}`);
    });

    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        this._emitSyncMacroBinding(name, () => {
          compiler.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
          compiler.emit(` ? kwargs["${name}"] : `);
          compiler._compileExpression(pair.value, managedFrame);
        }, managedFrame);
      });
    }
  }

  _emitSyncMacroBinding(name, emitValueExpr, managedFrame, managedValueExpr = null) {
    const compiler = this.compiler;
    compiler.emit(`frame.set("${name}", `);
    emitValueExpr();
    compiler.emit.line(');');
    if (managedFrame && managedValueExpr !== null) {
      managedFrame.set(name, managedValueExpr);
    }
  }

  _emitCompiledAsyncMacroBody({ node, callableSignature, managedFrame, bufferId, args, kwargs, rawCallerVar, allCallersBufferId, hasCallerSupport }) {
    const compiler = this.compiler;
    this._emitAsyncMacroBindings({
      node,
      callableSignature,
      managedFrame,
      bufferId,
      args,
      kwargs,
      rawCallerVar,
      allCallersBufferId
    });

    const prevCallerBindingContext = this.currentCallerBindingContext;
    if (hasCallerSupport) {
      this.currentCallerBindingContext = { rawCallerVar, allCallersBufferId };
    }
    compiler.emit.withScopedSyntax(() => {
      compiler.compile(node.body, managedFrame);
    });
    this.currentCallerBindingContext = prevCallerBindingContext;

    return this._emitAsyncMacroReturn({
      node,
      bufferId,
      allCallersBufferId,
      hasCallerSupport
    });
  }

  _emitCompiledSyncMacroBody({ node, managedFrame, bufferId, args, kwargs, keepFrame }) {
    const compiler = this.compiler;
    this._emitSyncMacroBindings({ managedFrame, args, kwargs });
    compiler.emit.withScopedSyntax(() => {
      compiler.compile(node.body, managedFrame);
    });
    compiler.emit.line(`frame = ${keepFrame ? 'frame.pop()' : 'callerFrame'};`);
    return `new runtime.SafeString(${bufferId})`;
  }

  _compileAsyncMacro(node) {
    const compiler = this.compiler;
    const funcId = node._analysis.compiledMacroFuncId;
    const {
      args,
      kwargs,
      callableSignature,
      emittedParamNames,
      emittedArgNames,
      emittedKwargNames
    } = this._parseMacroSignature(node);
    const oldIsCompilingMacroBody = compiler.sequential.isCompilingMacroBody;
    compiler.sequential.isCompilingMacroBody = node.typename !== 'Caller';

    const macroNeedsCallerSupport = !!node._analysis.hasCallerSupport;

    compiler.emit.lines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${emittedArgNames.join(', ')}], `,
      `[${emittedKwargNames.join(', ')}], `,
      `function (${emittedParamNames.join(', ')}, macroParentBuffer) {`
    );

    compiler.emit.line(`return runtime.withPath(this, "${compiler.sourcePath}", function() {`);
    compiler.emit.line('return (function() {');
    compiler.emit.lines(
      'kwargs = kwargs || {};',
      'if (!Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      '  kwargs.caller = undefined;',
      '}'
    );

    let returnStatement;
    const rawCallerVar = macroNeedsCallerSupport ? compiler._tmpid() : null;
    const allCallersBufferId = macroNeedsCallerSupport ? compiler._tmpid() : null;

    if (node.typename === 'Caller') {
      const callerTextChainVar = !compiler.scriptMode ? compiler._tmpid() : null;
      if (!compiler.scriptMode) {
        compiler.emit.line(`let ${callerTextChainVar} = runtime.declareBufferChain(macroParentBuffer, "${compiler.buffer.currentTextChainName}", "text", context, null);`);
      }
      compiler.buffer.withBufferState({
        currentBuffer: 'macroParentBuffer',
        currentTextChainVar: callerTextChainVar
      }, () => {
        returnStatement = this._emitCompiledAsyncMacroBody({
          node,
          callableSignature,
          managedFrame: null,
          bufferId: 'macroParentBuffer',
          args,
          kwargs,
          rawCallerVar,
          allCallersBufferId,
          hasCallerSupport: macroNeedsCallerSupport
        });
      });
    } else {
      const parameterNames = callableSignature.positionalNames.concat(callableSignature.keywordNames);
      const macroStackFields = {
        macroName: node.name.value,
        macroSignature: compiler._describeMacroSignature(node.name.value, parameterNames)
      };
      compiler.emit.withScopeCommandBuffer({
        frame: null,
        parentBufferOverride: null,
        analysisNode: node.body,
        errorContextNode: node,
        traceParentOverride: 'macroParentBuffer',
        bufferStackErrorContextFields: macroStackFields,
        emitFunc: (managedFrame, bufferId) => {
          returnStatement = this._emitCompiledAsyncMacroBody({
            node,
            callableSignature,
            managedFrame,
            bufferId,
            args,
            kwargs,
            rawCallerVar,
            allCallersBufferId,
            hasCallerSupport: macroNeedsCallerSupport
          });
        }
      });
    }

    compiler.emit.line(`return ${returnStatement};`);
    compiler.emit.line('}).call(this);');
    compiler.emit.line('});');
    compiler.emit.line('}, true);');

    compiler.sequential.isCompilingMacroBody = oldIsCompilingMacroBody;
    return funcId;
  }

  _compileSyncMacro(node, frame, keepFrame) {
    const compiler = this.compiler;
    const funcId = `macro_${compiler._tmpid()}`;
    const {
      args,
      kwargs,
      emittedParamNames,
      emittedArgNames,
      emittedKwargNames
    } = this._parseMacroSignature(node);
    const currFrame = keepFrame
      ? frame.push(true)
      : frame.new();
    const oldIsCompilingMacroBody = compiler.sequential.isCompilingMacroBody;
    compiler.sequential.isCompilingMacroBody = node.typename !== 'Caller';

    compiler.emit.lines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${emittedArgNames.join(', ')}], `,
      `[${emittedKwargNames.join(', ')}], `,
      `function (${emittedParamNames.join(', ')}) {`
    );

    compiler.emit.line(`return runtime.withPath(this, "${compiler.sourcePath}", function() {`);
    compiler.emit.line('return (function(frame) {');
    compiler.emit.line('let callerFrame = frame;');
    if (keepFrame) {
      compiler.emit.line('frame = frame.push(true);');
    } else {
      compiler.emit.line('frame = frame.new();');
    }
    compiler.emit.lines(
      'kwargs = kwargs || {};',
      'if (!Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      '  kwargs.caller = undefined;',
      '}'
    );

    let returnStatement;
    compiler.emit.withScopeCommandBuffer({
      frame: currFrame,
      parentBufferOverride: keepFrame ? compiler.buffer.currentBuffer : null,
      analysisNode: node.body,
      emitFunc: (managedFrame, bufferId) => {
        returnStatement = this._emitCompiledSyncMacroBody({
          node,
          managedFrame,
          bufferId,
          args,
          kwargs,
          keepFrame
        });
      }
    });

    compiler.emit.line(`return ${returnStatement};`);
    compiler.emit.line('}).call(this, frame);');
    compiler.emit.line('});');
    compiler.emit.line('});');

    compiler.sequential.isCompilingMacroBody = oldIsCompilingMacroBody;
    return funcId;
  }

  compileSyncMacroDeclaration(node, frame) {
    const funcId = this._compileSyncMacro(node, frame, false);
    const name = node.name.value;
    this._emitSyncMacroDeclarationBinding(name, funcId, frame);
  }

  _emitSyncMacroDeclarationBinding(name, funcId, frame) {
    frame.set(name, funcId);
    if (frame.parent) {
      this.compiler.emit.line(`frame.set("${name}", ${funcId});`);
      return;
    }
    this.compiler.emit.line(`context.setVariable("${name}", ${funcId});`);
    if (name.charAt(0) !== '_') {
      this.compiler.emit.line(`context.addResolvedExport("${name}", ${funcId});`);
    }
  }
}

export {CompileMacro};
