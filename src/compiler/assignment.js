import * as nodes from '../language/nodes.js';

class CompileAssignment {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeCallAssign(node, analysisPass) {
    return this.analyzeSet(node, analysisPass);
  }

  postAnalyzeCallAssign(node) {
    return this.postAnalyzeSet(node);
  }

  compileCallAssign(node) {
    this.compileSet(node);
  }

  analyzeSet(node, analysisPass) {
    const compiler = this.compiler;
    const declareOnExit = [];
    const observes = [];
    const mutates = [];
    const isDeclaration = node.varType === 'declaration';
    const targets = node.targets;
    if (compiler.scriptMode) {
      switch (node.varType) {
        case 'declaration':
        case 'assignment':
          break;
        default:
          compiler.fail(`Unknown varType '${node.varType}' for set/var statement.`, node.lineno, node.colno, node);
      }
    } else if (node.varType !== 'assignment' && node.varType !== 'declaration') {
      compiler.fail(`'${node.varType}' is not allowed in template mode. Use 'set' or declaration tags.`, node.lineno, node.colno, node);
    }
    if (node.body) {
      node.body.addAnalysis({ createScope: true });
    }
    if (node.path && targets.length !== 1) {
      compiler.fail('set_path only supports a single target.', node.lineno, node.colno, node);
    }
    const thisSharedAssignment = compiler.chain.analyzeThisSharedAssignment(node);
    if (thisSharedAssignment) {
      targets.forEach((target) => compiler.chain.markOperationOwnedPath(target));
      // Nested shared-var assignment reads the current value via RawSnapshot
      // before writing the patched value. Data-chain shared sets enqueue a
      // direct data mutation command and do not need a separate observation.
      if (thisSharedAssignment.type === 'var' && thisSharedAssignment.path.length > 0) {
        observes.push(thisSharedAssignment.name);
      }
      mutates.push(thisSharedAssignment.name);
      const { declareInRootOnEnter } = thisSharedAssignment;
      const facts = {
        declareOnExit,
        observes,
        mutates,
        thisSharedAssignment
      };
      if (declareInRootOnEnter) {
        facts.declareInRootOnEnter = declareInRootOnEnter;
      }
      return facts;
    }
    targets.forEach((target) => {
      if (target instanceof nodes.Symbol) {
        target.addAnalysis({ isSymbolTarget: true });
        const name = target.value;
        const declaration = node._analysis.visibleDeclarations?.get(name) || null;
        if (compiler.scriptMode && !isDeclaration && declaration && declaration.shared) {
          compiler.fail(
            `Bare shared assignment to '${name}' is not supported. Use this.${name} = ... instead.`,
            target.lineno,
            target.colno,
            node,
            target
          );
        }
        const shouldDeclareImplicitTemplateVar = !compiler.scriptMode &&
          !isDeclaration &&
          !declaration;
        if (isDeclaration || shouldDeclareImplicitTemplateVar) {
          declareOnExit.push({ name, type: 'var', initializer: null, explicit: !!isDeclaration });
        } else {
          if (node.path) {
            observes.push(name);
          }
          mutates.push(name);
        }
      }
    });
    return {
      declareOnExit,
      observes,
      mutates
    };
  }

  postAnalyzeSet(node) {
    const compiler = this.compiler;
    const exportFromRootScope = compiler.analysis.isRootScopeOwner(node._analysis);
    const targetFacts = [];
    (node.targets || []).forEach((target) => {
      if (!(target instanceof nodes.Symbol)) {
        targetFacts.push(null);
        return;
      }
      const name = target.value;
      const visibleDeclaration = node._analysis.visibleDeclarations?.get(name) ||
        node._analysis.producedDeclarations?.get(name) ||
        null;
      targetFacts.push({
        name,
        isOwnDeclaration: visibleDeclaration && visibleDeclaration.declarationOrigin === node._analysis,
        isVarDeclaration: visibleDeclaration && visibleDeclaration.type === 'var',
        isSharedDeclaration: visibleDeclaration && visibleDeclaration.shared,
        exportFromRootScope
      });
    });
    return { setTargetFacts: targetFacts };
  }

  compileSet(node) {
    const compiler = this.compiler;
    const thisSharedAssignment = node._analysis.thisSharedAssignment;
    if (thisSharedAssignment) {
      compiler.chain.compileThisSharedAssignment(node, thisSharedAssignment);
      return;
    }

    const ids = [];
    const isDeclarationOnly = !!node.declarationOnly;
    const targetFacts = node._analysis.setTargetFacts ?? null;
    const isLiteralNone = node.value instanceof nodes.Literal && node.value.value === null;
    const allTargetsAreOwnDeclarations = node.targets.every((target, i) => {
      const facts = targetFacts && targetFacts[i] ? targetFacts[i] : null;
      return facts && facts.isOwnDeclaration;
    });
    const canSeedLiteralNoneDirectly = isLiteralNone && allTargetsAreOwnDeclarations && !node.path && !node.body;

    node.targets.forEach((target, i) => {
      if (!(target instanceof nodes.Symbol)) {
        compiler.fail(
          'Compiler error: assignment target must be a symbol.',
          target.lineno,
          target.colno,
          node,
          target
        );
      }
      const name = target.value;
      const facts = targetFacts && targetFacts[i]
        ? targetFacts[i]
        : {
          isOwnDeclaration: false,
          isVarDeclaration: false
        };

      if (!facts.isOwnDeclaration && !facts.isVarDeclaration) {
        compiler.fail(
          `Compiler error: analysis did not resolve a visible var declaration for '${name}'.`,
          target.lineno,
          target.colno,
          node,
          target
        );
      }

      if (canSeedLiteralNoneDirectly) {
        ids.push(null);
        return;
      }

      const id = compiler._tmpid();
      this.emit.line(`let ${id};`);
      ids.push(id);
    });

    let hasAssignedValue = false;
    if (canSeedLiteralNoneDirectly) {
      hasAssignedValue = true;
    } else if (node.path) {
      const targetName = node.targets[0].value;
      const pathValueId = compiler._tmpid();
      this.emit(`let ${pathValueId} = `);
      compiler.compileExpression(node.value, null, node.value);
      this.emit.line(';');
      this.emit(ids[0] + ' = ');
      this.emit('runtime.deepAssign(');
      compiler.buffer.emitAddRawSnapshot(targetName, node);
      this.emit(', ');
      compiler._compileAggregate(node.path, null, '[', ']', false, false);
      this.emit(', ');
      this.emit(pathValueId);
      this.emit(')');
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.value && !isDeclarationOnly) {
      this.emit(ids.join(' = ') + ' = ');
      compiler.compileExpression(node.value, null, node.value);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.body) {
      this.emit(ids.join(' = ') + ' = ');
      compiler.compile(node.body, null);
      this.emit.line(';');
      hasAssignedValue = true;
    }

    node.targets.forEach((target, i) => {
      const name = target.value;
      const valueId = ids[i];
      const facts = targetFacts && targetFacts[i] ? targetFacts[i] : null;

      if (facts && facts.isOwnDeclaration) {
        const initializer = hasAssignedValue ? valueId : 'null';
        this.emit.line(`runtime.declareBufferChain(${compiler.buffer.currentBuffer}, "${name}", "var", context, ${initializer});`);
      }

      if (hasAssignedValue) {
        if (!(facts && facts.isOwnDeclaration)) {
          this.emit.line(`${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ chainName: '${name}', args: [${valueId}], errorContext: ${compiler.emitErrorContext(node)} }), '${name}');`);
        }
      }

      if (name.charAt(0) !== '_' && hasAssignedValue && facts && facts.exportFromRootScope && !facts.isSharedDeclaration) {
        this.emit.line(`context.addDeferredExport("${name}", "${name}", ${compiler.buffer.currentBuffer});`);
      }
    });
  }
}

export {CompileAssignment};
