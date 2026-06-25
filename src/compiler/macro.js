
import * as nodes from '../language/nodes.js';
import {
  CALLER_CHAIN_NAME,
  RETURN_CHAIN_NAME,
} from './reserved.js';
import {
  isClassifiedImportedCallableDeclaration,
  DECLARATION_ROLE,
  DECLARATION_STORAGE
} from './declarations.js';

class CompileMacro {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentCallerBindingContext = null;
  }

  canCompileMacroCallerInvocation(node) {
    return !!(
      this.compiler.asyncMode &&
      node._analysis.macroCallerInvocation &&
      this.currentCallerBindingContext
    );
  }

  _emitMacroCallerInvocationDispatch({ bufferId, node }) {
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
    compiler.emit.line(`if (runtime.isMacro(${activeContext.rawCallerVar})) {`);

    const invocationBufferId = compiler._tmpid();
    const invocationFinishedId = compiler._tmpid();
    const invocationResultId = compiler._tmpid();
    compiler.emit.line(`let ${invocationBufferId} = new runtime.CommandBuffer(context, ${activeContext.allCallersBufferId}, ${activeContext.rawCallerVar}.__callerLinkedFacts || null, ${activeContext.rawCallerVar}.__callerOwnFacts || null, null, ${callerBufferStackErrorContext}, null, renderState);`);
    compiler.emit.line(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit.line(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_CHAIN_NAME}", args: [${invocationFinishedId}], errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_CHAIN_NAME}");`);
    compiler.emit.line(`let ${invocationResultId} = runtime.finallyValue(runtime.invokeMacro(${activeContext.rawCallerVar}, context, ${argsId}, ${invocationBufferId}), () => ${invocationBufferId}.finish());`);
    compiler.emit.line(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_CHAIN_NAME}", args: [${invocationResultId}], errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_CHAIN_NAME}");`);
    compiler.emit.line(`return ${invocationResultId};`);
    compiler.emit.line('}');
    compiler.emit.line(`return runtime.callWrapAsync(${activeContext.rawCallerVar}, "caller", context, ${argsId}, ${errorContext}, ${bufferId});`);
    compiler.emit('})()');
  }

  analyzeCaller(node) {
    const compiledMacroFuncId = `macro_${this.compiler._tmpid()}`;
    node.name.addAnalysis({ isSymbolTarget: true });
    const declareOnEnter = [
      this._createMacroCallerDeclaration(),
      this.compiler.return.createChainDeclaration()
    ];
    const textChainName = !this.compiler.scriptMode
      ? this.compiler.analysis.getCurrentTextChain(node._analysis)
      : null;
    if (textChainName) {
      declareOnEnter.push({ name: textChainName, type: 'text', initializer: null, internal: true });
    }
    const seenParamNames = new Set();
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg.addAnalysis({ isSymbolTarget: true });
        this._validateParameterDeclaration(arg.value, arg, seenParamNames, node);
        declareOnEnter.push(this._createMacroArgumentDeclaration(arg.value));
      }
    });
    return {
      createScope: true,
      scopeBoundary: false,
      parentReadOnly: true,
      declareOnEnter,
      compiledMacroFuncId,
      wantsLinkedChildBuffer: true
    };
  }

  compileCaller(node) {
    const compiler = this.compiler;
    compiler.emit('(function (){');
    const funcId = this._compileAsyncCaller(node);
    compiler.emit(`return ${funcId};})()`);
  }

  _compileAsyncCaller(node) {
    const funcId = this._compileAsyncMacro(node);
    const callerFacts = this.compiler.chain.getCommandBufferFacts(node);
    this.compiler.emit.line(`${funcId}.__callerLinkedFacts = ${JSON.stringify(callerFacts.linkedFacts)};`);
    this.compiler.emit.line(`${funcId}.__callerOwnFacts = ${JSON.stringify(callerFacts.ownFacts)};`);
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
    const declareOnEnter = [];
    const declareInParentOnExit = [];
    const macroDecl = this.prepareMacroDeclaration(node);
    const compiledMacroFuncId = node._analysis.compiledMacroFuncId;
    node.name.addAnalysis({ isSymbolTarget: true });
    declareOnEnter.push(this.compiler.return.createChainDeclaration());
    declareOnEnter.push(this._createMacroCallerDeclaration());
    const seenParamNames = new Set();
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg.addAnalysis({ isSymbolTarget: true });
        this._validateParameterDeclaration(arg.value, arg, seenParamNames, node);
        declareOnEnter.push(this._createMacroArgumentDeclaration(arg.value));
      } else if (arg instanceof nodes.Dict) {
        arg.children.forEach((pair) => {
          this._validateParameterDeclaration(pair.key.value, pair.key, seenParamNames, node);
          declareOnEnter.push(this._createMacroArgumentDeclaration(pair.key.value));
        });
      }
    }, undefined, node);
    declareInParentOnExit.push(macroDecl);
    declareOnEnter.push({ name: CALLER_CHAIN_NAME, type: 'var', initializer: null, internal: true });
    node.body.addAnalysis({ macroSetupOwner: node });
    return {
      createScope: true,
      scopeBoundary: true,
      declareOnEnter,
      declareInParentOnExit,
      hasCallerSupport: false,
      compiledMacroFuncId
    };
  }

  prepareMacroDeclaration(node) {
    const existingDeclaration = node._analysis?.macroDeclaration || null;
    if (existingDeclaration) {
      return existingDeclaration;
    }
    const compiledMacroFuncId = node._analysis?.compiledMacroFuncId || `macro_${this.compiler._tmpid()}`;
    const macroDeclaration = {
      name: node.name.value,
      parentOwned: true,
      isMacro: true,
      storage: DECLARATION_STORAGE.DIRECT,
      jsVar: compiledMacroFuncId
    };
    node.addAnalysis({ compiledMacroFuncId, macroDeclaration });
    return macroDeclaration;
  }

  recordMacroCallerInvocation(node) {
    let current = node._analysis.parent;
    while (current) {
      const owner = current.node;
      if (owner instanceof nodes.Macro) {
        owner.addAnalysis({ hasCallerSupport: true });
        this.compiler.analysis.addCommandFacts(owner.body, {
          observed: [CALLER_CHAIN_NAME],
          mutated: [CALLER_CHAIN_NAME]
        });
        return;
      }
      current = current.parent;
    }
  }

  collectMacroCallerInvocationFacts(node, analysisPass) {
    const isCallerCall = node.name instanceof nodes.Symbol && node.name.value === 'caller';
    if (!isCallerCall) {
      return null;
    }

    const mutates = [];
    const textChain = analysisPass.getCurrentTextChain(node._analysis);
    if (textChain) {
      mutates.push(textChain);
    }
    // caller() is a reserved macro call-block binding in async mode. Its
    // invocation ordering uses the macro-local __caller__ lane, so any
    // nested child boundary containing caller() must link that lane.
    mutates.push(CALLER_CHAIN_NAME);
    this.recordMacroCallerInvocation(node);
    return { mutates, macroCallerInvocation: true };
  }

  compileMacroCallerInvocation(node) {
    if (!this.canCompileMacroCallerInvocation(node)) {
      return false;
    }
    this._emitMacroCallerInvocationDispatch({
      bufferId: this.compiler.buffer.currentBuffer,
      node
    });
    return true;
  }

  _validateParameterDeclaration(name, nameNode, seenParamNames, ownerNode) {
    if (ownerNode.name?.value === name) {
      this.compiler.fail(
        `Identifier '${name}' conflicts with the macro/function name.`,
        nameNode.lineno,
        nameNode.colno,
        ownerNode,
        nameNode
      );
    }
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

  compileMacro(node) {
    const funcId = node._analysis.macroBindingHoisted
      ? node._analysis.compiledMacroFuncId
      : this.compileMacroBinding(node);
    this.compileMacroExport(node, funcId);
  }

  compileHoistedMacroBindings(node) {
    const children = node.children || null;
    if (!children) {
      return;
    }
    children.forEach((child) => {
      if (!(child instanceof nodes.Macro) || child instanceof nodes.Caller) {
        return;
      }
      if (child._analysis.macroBindingHoisted) {
        return;
      }
      this.compileMacroBinding(child);
      child.addAnalysis({ macroBindingHoisted: true });
    });
  }

  compileMacroBinding(node) {
    return this._compileAsyncMacro(node);
  }

  compileMacroExport(node, funcId) {
    const compiler = this.compiler;
    const name = node.name.value;
    if (name.charAt(0) !== '_' && compiler.analysis.isParentOwnedDeclarationRootOwned(node._analysis, name)) {
      compiler.emit.line(`context.addResolvedExport("${name}", ${funcId});`);
    }
  }

  emitInheritanceDirectCallableBindingsFactory(node) {
    const declarations = this._getInheritanceRootMacroDeclarations(node);
    const importedDeclarations = this._getInheritanceDirectImportedCallableDeclarations(node);
    const emit = this.compiler.emit;
    // Participant roots do not run their source body directly, so root-local
    // macros are created through an owner-scoped factory and attached to the
    // loaded inheritance entry.
    emit.line('function createDirectCallableBindings(ownerState, context) {');
    this._emitInheritanceRootLikeMacroLocals();
    if (declarations.length === 0 && importedDeclarations.length === 0) {
      emit.line('return null;');
    } else {
      emit.line('const directCallableBindings = {};');
      this.compiler.inheritance.withDirectBindingFactory(node, 'directCallableBindings', () => {
        this.compiler.composition.emitDirectImportFactoryBindings(importedDeclarations, 'directCallableBindings');
        declarations.forEach((child) => {
          this.compileMacroBinding(child);
          emit.line(`directCallableBindings[${JSON.stringify(child.name.value)}] = ${child._analysis.compiledMacroFuncId};`);
        });
      });
      emit.line('return directCallableBindings;');
    }
    emit.line('}');
  }

  emitInheritanceRootMacroExports(node, directCallableBindingsVar) {
    this._getInheritanceRootMacroDeclarations(node).forEach((child) => {
      this.compileMacroExport(
        child,
        `${directCallableBindingsVar}[${JSON.stringify(child.name.value)}]`
      );
    });
  }

  _getInheritanceRootMacroDeclarations(node) {
    return node.children.filter((child) => child instanceof nodes.Macro);
  }

  _getInheritanceDirectImportedCallableDeclarations(node) {
    const declarations = node._analysis.declaredChains || new Map();
    return Array.from(declarations.values()).filter((declaration) =>
      declaration.declarationOwner === node._analysis &&
      declaration.requiresCleanScopeBinding &&
      isClassifiedImportedCallableDeclaration(declaration)
    );
  }

  _emitInheritanceRootLikeMacroLocals() {
    // Macro codegen expects these names in its enclosing JS scope.
    this.compiler.emit.line('const { env, runtime, renderState, errorContextTable: __ec } = ownerState;');
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

  _createMacroArgumentDeclaration(name) {
    return {
      name,
      type: 'var',
      initializer: null,
      role: DECLARATION_ROLE.MACRO_ARGUMENT
    };
  }

  postAnalyzeCaller(node) {
    return this._getSetupFacts(node, node._analysis, node._analysis);
  }

  postAnalyzeNodeList(node) {
    const owner = node._analysis.macroSetupOwner || null;
    if (!owner) {
      return {};
    }
    return this._getSetupFacts(owner, owner._analysis, node._analysis);
  }

  _getSetupFacts(node, setupAnalysis, targetAnalysis) {
    const observed = new Set(targetAnalysis.observes || []);
    const mutated = new Set(targetAnalysis.mutates || []);
    const defaultNodesByName = this._getCallableDefaultNodesByName(node);
    setupAnalysis.declareOnEnter.forEach((decl) => {
      if (
        decl.role !== DECLARATION_ROLE.MACRO_ARGUMENT &&
        decl.role !== DECLARATION_ROLE.MACRO_CALLER
      ) {
        return;
      }
      mutated.add(decl.name);
      const defaultNode = defaultNodesByName.get(decl.name);
      if (defaultNode) {
        addSetNames(observed, defaultNode._analysis.observedChains);
        addSetNames(mutated, defaultNode._analysis.mutatedChains);
      }
    });
    const facts = {};
    if (observed.size > 0) {
      facts.observes = Array.from(observed);
    }
    if (mutated.size > 0) {
      facts.mutates = Array.from(mutated);
    }
    return facts;
  }

  _getCallableDefaultNodesByName(node) {
    const signature = this.compiler.getCallableSignatureFacts(node.args, {
      allowKeywordArgs: true,
      symbolsOnly: true,
      label: 'macro signature',
      ownerNode: node
    });
    return new Map(signature.keywordDefaults.map((entry) => [entry.name, entry.valueNode]));
  }

  _createMacroCallerDeclaration() {
    return {
      name: 'caller',
      type: 'var',
      initializer: null,
      internal: true,
      role: DECLARATION_ROLE.MACRO_CALLER
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
    // all-callers buffer so multiple invocations can run independently.
    compiler.emit(`(runtime.isMacro(${rawCallerVar}) ? function() {`);
    compiler.emit(`let ${invocationArgsId} = Array.prototype.slice.call(arguments);`);
    compiler.emit(`let ${invocationBufferId} = new runtime.CommandBuffer(context, ${allCallersBufferId}, ${rawCallerVar}.__callerLinkedFacts || null, ${rawCallerVar}.__callerOwnFacts || null, null, ${callerBufferStackErrorContext}, null, renderState);`);
    compiler.emit(`let ${invocationFinishedId} = ${invocationBufferId}.getFinishedPromise();`);
    compiler.emit(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_CHAIN_NAME}", args: [${invocationFinishedId}], errorContext: ${compiler.emitErrorContext(positionNode)} }), "${CALLER_CHAIN_NAME}");`);
    // __caller__ timing is owned only by caller invocation code. Track both:
    // 1. when this invocation child buffer stops receiving commands
    // 2. when the invocation's returned value settles
    compiler.emit(`let ${invocationResultId} = runtime.finallyValue(runtime.invokeMacro(${rawCallerVar}, context, ${invocationArgsId}, ${invocationBufferId}), () => ${invocationBufferId}.finish());`);
    compiler.emit(`${bufferId}.addCommand(new runtime.WaitResolveCommand({ chainName: "${CALLER_CHAIN_NAME}", args: [${invocationResultId}], errorContext: ${compiler.emitErrorContext(positionNode)} }), "${CALLER_CHAIN_NAME}");`);
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
    // only after all started caller() invocations have registered.
    compiler.emit.line(`runtime.declareBufferChain(${bufferId}, "${CALLER_CHAIN_NAME}", "var", context, null);`);
    // Caller-capable macros still allow plain invocations with no caller block.
    compiler.emit.line(`if (runtime.isMacro(${rawCallerVar})) {`);
    // The all-callers buffer is parent-linked because caller() may emit
    // parent-visible observable commands, unlike the isolated macro buffer.
    compiler.emit.line(`  ${allCallersBufferId} = new runtime.CommandBuffer(context, macroParentBuffer, ${rawCallerVar}.__callerLinkedFacts || null, ${rawCallerVar}.__callerOwnFacts || null, macroParentBuffer, ${callerBufferStackErrorContext}, macroParentBuffer, renderState);`);
    compiler.emit.line('}');
  }

  _emitAsyncMacroReturn({ node, bufferId, allCallersBufferId, hasCallerSupport }) {
    const compiler = this.compiler;
    // Macro-body boundary errors report through the compiled reportError
    // callback and propagate through chain poison, not by rejecting here.
    const callerReadyVar = hasCallerSupport ? compiler._tmpid() : null;
    const callerReadyPrefix =
      (hasCallerSupport ? `const ${callerReadyVar} = ${bufferId}.addCommand(new runtime.SnapshotCommand({ chainName: "${CALLER_CHAIN_NAME}", errorContext: ${compiler.emitErrorContext(node)} }), "${CALLER_CHAIN_NAME}");` : '') +
      (hasCallerSupport ? `await ${callerReadyVar};` : '') +
      (hasCallerSupport ? `if (${allCallersBufferId}) {${allCallersBufferId}.finish();}` : '');
    const iifeOpen = hasCallerSupport ? '(async () => {' : '(() => {';

    if (compiler.scriptMode) {
      const returnVar = compiler._tmpid();
      return iifeOpen +
        callerReadyPrefix +
        `${bufferId}.finish();` +
        `const ${returnVar}_snapshot = ${bufferId}.getChain("${RETURN_CHAIN_NAME}").finalSnapshot();` +
        `return runtime.thenValue(${returnVar}_snapshot, (value) => value === runtime.RETURN_UNSET ? null : value);` +
        `})()`;
    } else {
      const textSnapshotVar = compiler._tmpid();
      return iifeOpen +
        callerReadyPrefix +
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

function addSetNames(target, names) {
  if (names) {
    names.forEach((name) => target.add(name));
  }
}

export {CompileMacro};
