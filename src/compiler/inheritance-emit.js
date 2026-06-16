const COMPILED_METHOD_ENTRIES_VAR = '__compiledMethodEntries';
const COMPILED_SHARED_SCHEMA_VAR = '__compiledSharedSchema';
const INHERITED_CALLABLE_EXTRA_PARAMS = [
  'blockPayload = null',
  'blockRenderCtx = undefined',
  'methodData',
  'currentInstance'
];

class CompileInheritanceEmit {
  constructor(inheritance) {
    this.inheritance = inheritance;
    this.compiler = inheritance.compiler;
    this.emit = this.compiler.emit;
  }

  isStaticExtendsNode(...args) {
    return this.inheritance.isStaticExtendsNode(...args);
  }

  _getSharedDeclarations(...args) {
    return this.inheritance._getSharedDeclarations(...args);
  }

  _getCallableSignature(...args) {
    return this.inheritance._getCallableSignature(...args);
  }

  _getCallableSharedFootprint(...args) {
    return this.inheritance._getCallableSharedFootprint(...args);
  }

  sharedChainObservation(chainName, node, mode = 'snapshot', implicitVarRead = false) {
    const compiler = this.compiler;
    compiler.emit(
      `runtime.observeInheritanceSharedChain(${JSON.stringify(chainName)}, ${compiler.buffer.currentBuffer}, ` +
      `${compiler.emitErrorContext(node)}, ` +
      `currentInstance, ${JSON.stringify(mode)}, ${implicitVarRead})`
    );
  }

  participantRootRender(node) {
    this.emit.line('return runtime.renderInheritanceParticipantRoot({');
    this.emit.line('    context,');
    this.emit.line('    ownerState,');
    this.emit.line('    rootBuffer: output,');
    this.emit.line(`    errorContext: ${this.compiler.emitErrorContext(node)}`);
    this.emit.line('}).catch((e) => {');
    this.emit.line('  if (!runtime.isPoisonError(e)) {');
    this.emit.line(`    renderState.reportAndThrowFatalError(e, ${this.compiler.emitErrorContext(node)});`);
    this.emit.line('  }');
    this.emit.line('  throw e;');
    this.emit.line('});');
  }

  participantRootExport(node, methodEntries, sharedSchema) {
    this.emit.line(`const ${COMPILED_METHOD_ENTRIES_VAR} = ${methodEntries};`);
    this.emit.line(`const ${COMPILED_SHARED_SCHEMA_VAR} = ${sharedSchema};`);
    this.extendsParentResolver(node);
    this.compiler.emitErrorContextHelper();
    this.emit.line('return {');
    this.emit.line('root,');
    this.emit.line('inheritanceSpec: {');
    this.emit.line(`  methodEntries: ${COMPILED_METHOD_ENTRIES_VAR},`);
    this.emit.line(`  sharedSchema: ${COMPILED_SHARED_SCHEMA_VAR},`);
    this.emit.line(`  hasExtends: ${node._analysis.inheritance.hasExtends ? 'true' : 'false'}`);
    this.emit.line('},');
    this.emit.line('resolveInheritanceParent,');
    this.emit.line('getErrorContexts');
    this.emit.line('};');
  }

  inheritedMethodInvocation(methodName, argsNode, errorContextJson) {
    if (!this.compiler.scriptMode) {
      this.emit('runtime.markSafe(');
    }
    this.emit(`currentInstance.invokeFromCurrentBuffer("${methodName}", `);
    this.compiler._compileAggregate(argsNode, null, '[', ']', false, false);
    this.emit(`, context, ${this.compiler.buffer.currentBuffer}, ${errorContextJson})`);
    if (!this.compiler.scriptMode) {
      this.emit(')');
    }
  }

  blockTextPlacement(node, id, emitValue) {
    this.emit(`${id} = `);
    emitValue();
    this.emit.line(';');
    const textCmdExpr = this.compiler.buffer._emitTemplateTextCommandExpression(id, node, true);
    this.emit.line(`${this.compiler.buffer.currentBuffer}.addCommand(${textCmdExpr}, "${this.compiler.buffer.currentTextChainName}");`);
    this.compiler.buffer.emitLimitedLoopCompletion(id, node);
  }

  rootSharedDeclarations(node) {
    const sharedDeclarations = this._getSharedDeclarations(node);
    sharedDeclarations.forEach((declaration) => {
      this.sharedDeclaration(declaration, node);
    });
  }

  sharedDeclaration(declaration, rootNode) {
    const targetBufferExpr = 'currentInstance.sharedRootBuffer';
    const errorContextNode = declaration.declarationOrigin ? declaration.declarationOrigin.node : rootNode;
    const errorContext = this.compiler.emitErrorContext(errorContextNode);
    this.emit(
      `runtime.declareInheritanceSharedChain(${targetBufferExpr}, ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context, undefined, ${errorContext}`
    );
    this.emit.line(');');
    if (!declaration.initializer) {
      return;
    }

    this.emit.line(`if (runtime.claimInheritanceSharedDefault(${targetBufferExpr}, ${JSON.stringify(declaration.name)})) {`);
    if (declaration.type === 'sequence' || declaration.type === 'var') {
      this.emit(
        `runtime.declareInheritanceSharedChain(${targetBufferExpr}, ${JSON.stringify(declaration.name)}, ${JSON.stringify(declaration.type)}, context, `
      );
      this.compiler.compile(declaration.initializer, null);
      this.emit.line(`, ${errorContext});`);
      this.emit.line('}');
      return;
    }

    const initValueId = this.compiler._tmpid();
    this.emit(`let ${initValueId} = `);
    this.compiler.compileExpression(declaration.initializer, null, declaration.initializer);
    this.emit.line(';');
    this.compiler.buffer.emitAddChainCommandByType({
      bufferExpr: targetBufferExpr,
      chainType: declaration.type,
      chainName: declaration.name,
      valueExpr: initValueId,
      positionNode: declaration.initializer,
      initializeIfNotSet: true
    });
    this.emit.line('}');
  }

  extendsParentResolver(node) {
    this.emit.line('async function resolveInheritanceParent(ownerState, context, errorContext) {');
    this.emit.line('  const __ec = ownerState.errorContextTable;');
    const inheritanceFacts = node._analysis.inheritance;
    if (!inheritanceFacts.localExtendsNode || inheritanceFacts.localExtendsNode.noParentLiteral) {
      this.emit.line('  return ownerState.runtime.noInheritanceParent();');
      this.emit.line('}');
      return;
    }

    const extendsNode = inheritanceFacts.localExtendsNode;
    const errorContextIndex = this.compiler.getErrorContextIndex(extendsNode);
    this.emit.line(`  const parentErrorContext = __ec[${errorContextIndex}];`);
    if (this.isStaticExtendsNode(extendsNode)) {
      // Static targets are known non-null here, so null-target error context is
      // only needed by the dynamic branch.
      this.emit.line(`  return ownerState.runtime.resolveInheritanceParent(ownerState, ${JSON.stringify(extendsNode.template.value)}, parentErrorContext, context);`);
    } else {
      this.emit.line('  const env = ownerState.env;');
      this.emit.line('  const runtime = ownerState.runtime;');
      this.emit.line('  const renderState = ownerState.renderState;');
      this.emit('  const parentSelection = ');
      this.compiler.compileExpression(extendsNode.template, null, extendsNode.template, true);
      this.emit.line(';');
      this.emit.line(`  return ownerState.runtime.resolveInheritanceParent(ownerState, parentSelection, parentErrorContext, context, __ec[${errorContextIndex}]);`);
    }
    this.emit.line('}');
  }

  templateConstructorEntryReturn(hasExtends, constructorDefinition) {
    if (!hasExtends) {
      this.callableEntryReturn(false);
      return;
    }
    this.constructorSuperReturn(constructorDefinition);
  }

  constructorSuperReturn(constructorDefinition) {
    this.emit.line(`return runtime.resolveThen(currentInstance.invokeSuper(methodData, [], context, ${this.compiler.buffer.currentBuffer}, ${this.compiler.emitErrorContext(constructorDefinition)}), (parentResult) => {`);
    this.emit.line(`  ${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line('  return parentResult;');
    this.emit.line('});');
  }

  scriptSharedDefaultConstructorEntryReturn(hasExtends, constructorDefinition) {
    // Shared defaults still run through constructor execution. This helper is
    // for scripts with shared default initializers but no user constructor body.
    if (!hasExtends) {
      this.callableEntryReturn(true);
      return;
    }
    this.constructorSuperReturn(constructorDefinition);
  }

  callableArgumentValue(payloadOriginalArgsVar, name, defaultValueNode) {
    const nameJson = JSON.stringify(name);
    this.emit(`Object.prototype.hasOwnProperty.call(${payloadOriginalArgsVar}, ${nameJson}) ? ${payloadOriginalArgsVar}[${nameJson}] : `);
    if (defaultValueNode) {
      this.compiler._compileExpression(defaultValueNode, null);
    } else {
      this.emit('undefined');
    }
  }

  callableArgumentChains(callableNode, callableSignature, payloadOriginalArgsVar) {
    this.compiler.chain.emitLocalVarChainBindings(
      this.compiler.buffer.currentBuffer,
      this.compiler.createCallableArgumentChainBindings(
        callableSignature,
        (name, defaultValueNode) => {
          this.callableArgumentValue(payloadOriginalArgsVar, name, defaultValueNode);
        },
        () => callableNode
      )
    );
  }

  callableContextSetup(isScriptMethod, invocationPath) {
    this.emit.line(
      `context = runtime.createInheritanceCallableContext(` +
      `context, ${isScriptMethod ? 'true' : 'false'}, ${invocationPath}, blockPayload, blockRenderCtx` +
      `);`
    );
  }

  callableEntryParentLinks(callableNode, isScriptMethod) {
    this.emit.line(`${this.compiler.buffer.currentBuffer}._context = context;`);
    if (!isScriptMethod) {
      this.emit.line(`${this.compiler.buffer.currentTextChainVar}._context = context;`);
    }
  }

  callableEntrySetup(callableNode, isScriptMethod, invocationPath, callableSignature) {
    if (isScriptMethod) {
      this.compiler.return.emitDeclareChain(this.compiler.buffer.currentBuffer);
    }
    const payloadOriginalArgsVar = this.compiler._tmpid();
    this.emit.line(`const ${payloadOriginalArgsVar} = runtime.getInheritanceCallableOriginalArgs(blockPayload);`);
    this.callableContextSetup(isScriptMethod, invocationPath);
    this.callableEntryParentLinks(callableNode, isScriptMethod);
    this.callableArgumentChains(callableNode, callableSignature, payloadOriginalArgsVar);
  }

  inheritedCallableFunction(callableNode, functionName, emitBody) {
    this.emit.entryFunction(callableNode, functionName, emitBody, {
      extraParams: INHERITED_CALLABLE_EXTRA_PARAMS,
      noReturn: true,
      ...this.compiler.chain.getCommandBufferFactsArgsWithLinked(
        callableNode,
        'methodData.mergedLinkedChains',
        'methodData.mergedMutatedChains'
      )
    });
  }

  callableEntryReturn(isScriptMethod) {
    if (isScriptMethod) {
      const resultVar = this.compiler._tmpid();
      this.compiler.return.emitFinalSnapshot(this.compiler.buffer.currentBuffer, resultVar);
      // Script methods still own their entry-local command-buffer lifetime.
      // The invocation command waits on the per-call invocation buffer after
      // this local buffer closes, so caller-visible completion still covers the
      // full inherited call.
      this.emit.line(`return ${resultVar};`);
      return;
    }

    this.emit.line(`${this.compiler.buffer.currentBuffer}.finish();`);
    this.emit.line(`return ${this.compiler.buffer.currentTextChainVar}.finalSnapshot();`);
  }

  callableEntryCompletion(callableNode, isScriptMethod, constructorRootNode) {
    if (constructorRootNode && !isScriptMethod) {
      this.templateConstructorEntryReturn(constructorRootNode._analysis.inheritance.hasExtends, callableNode);
    } else if (constructorRootNode && callableNode.isSharedDefaultOnlyConstructor) {
      this.scriptSharedDefaultConstructorEntryReturn(constructorRootNode._analysis.inheritance.hasExtends, callableNode);
    } else {
      this.callableEntryReturn(isScriptMethod);
    }
  }

  callableEntriesObject(node, rootCompileResult) {
    const callables = rootCompileResult.blocks;
    const constructorEntry = rootCompileResult.constructorEntry;
    const methodEntries = callables.map((callableNode) =>
      this.methodEntryObject(this.methodEntryDescriptor(callableNode))
    );

    if (constructorEntry) {
      const constructorUsesSuper = (!this.compiler.scriptMode && node._analysis.inheritance.hasExtends) ||
        (this.compiler.scriptMode && constructorEntry.isSharedDefaultOnlyConstructor && node._analysis.inheritance.hasExtends) ||
        constructorEntry._analysis.callableUsesSuper;
      methodEntries.push(this.methodEntryObject(this.methodEntryDescriptor(constructorEntry, {
        name: '__constructor__',
        fnExpr: 'b___constructor__',
        isConstructor: true,
        usesSuper: constructorUsesSuper,
        signature: { argNames: [] }
      })));
    }

    return `{ ${methodEntries.join(', ')} }`;
  }

  methodEntryDescriptor(callableNode, overrides = {}) {
    const name = overrides.name ?? callableNode.name.value;
    return {
      name,
      fnExpr: overrides.fnExpr ?? `b_${name}`,
      ownerNode: callableNode,
      errorContextNode: overrides.errorContextNode ?? callableNode,
      isConstructor: !!overrides.isConstructor,
      usesSuper: overrides.usesSuper ?? !!callableNode._analysis.callableUsesSuper,
      superErrorContextIndexLiteral: this.callableSuperErrorContextIndexLiteral(callableNode),
      inheritedMethodDependencies: this.inheritedMethodDependenciesObject(callableNode._analysis.callableInheritedMethodDependencies),
      signature: overrides.signature ?? {
        argNames: this._getCallableSignature(callableNode).argNames
      }
    };
  }

  methodEntryObject(entry) {
    const callableFootprint = this._getCallableSharedFootprint(entry.ownerNode);
    // The emitted ABI calls these "own" chains because they are the callable
    // entry's own parent-visible shared dependencies.
    const ownLinkedChainNames = callableFootprint.sharedDependencies;
    const ownMutatedChainNames = callableFootprint.mutationDependencies;
    const ownLinkedChains = JSON.stringify(ownLinkedChainNames);
    const ownMutatedChains = JSON.stringify(ownMutatedChainNames);
    const errorContextIndex = this.compiler.getErrorContextIndex(entry.errorContextNode);
    const name = JSON.stringify(entry.name);
    return `${name}: { name: ${name}, fn: ${entry.fnExpr}, signature: ${JSON.stringify(entry.signature)}, errorContextIndex: ${errorContextIndex}, isConstructor: ${entry.isConstructor ? 'true' : 'false'}, super: ${entry.usesSuper ? 'true' : 'false'}, superErrorContextIndex: ${entry.superErrorContextIndexLiteral ?? 'null'}, inheritedMethodDependencies: ${entry.inheritedMethodDependencies || '{}'}, ownLinkedChains: ${ownLinkedChains}, ownMutatedChains: ${ownMutatedChains} }`;
  }

  inheritedMethodDependenciesObject(methodDependencies) {
    if (!methodDependencies) {
      return '{}';
    }
    const names = Object.keys(methodDependencies);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(methodDependencies[name])}`).join(', ')} }`;
  }

  callableSuperErrorContextIndexLiteral(callableNode) {
    return callableNode._analysis.callableSuperErrorContextIndex !== undefined
      ? callableNode._analysis.callableSuperErrorContextIndex.toString()
      : 'null';
  }

  sharedSchemaLiteral(node) {
    const sharedDeclarations = this._getSharedDeclarations(node);
    const entries = sharedDeclarations.map((child) => {
      const errorContextNode = child.declarationOrigin ? child.declarationOrigin.node : node;
      return `${JSON.stringify(child.name)}: { ` +
        `type: ${JSON.stringify(child.type)}, ` +
        `errorContextIndex: ${this.compiler.getErrorContextIndex(errorContextNode)}, ` +
        `hasDefault: ${child.initializer ? 'true' : 'false'} ` +
        `}`;
    });
    return `{ ${entries.join(', ')} }`;
  }

  superInvocation({
    node,
    positionalArgsNode,
    hasAssignmentTarget,
    hasExplicitArgs,
    needsSafeTemplateOutput
  }) {
    const id = node.symbol ? node.symbol.value : null;
    if (hasAssignmentTarget) {
      this.emit(`let ${id} = `);
    } else if (needsSafeTemplateOutput) {
      this.emit('runtime.markSafe(');
    }
    this.emit('currentInstance.invokeSuper(methodData, ');
    if (hasExplicitArgs) {
      this.compiler._compileAggregate(positionalArgsNode, null, '[', ']', false, false);
    } else {
      this.emit('[]');
    }
    this.emit(`, context, ${this.compiler.buffer.currentBuffer}, ${this.compiler.emitErrorContext(node)}`);
    this.emit(')');
    if (!hasAssignmentTarget) {
      if (needsSafeTemplateOutput) {
        this.emit(')');
      }
      return;
    }
    this.emit.line(';');
    if (needsSafeTemplateOutput) {
      this.emit.line(`${id} = runtime.markSafe(${id});`);
    }
  }
}

export {CompileInheritanceEmit};
