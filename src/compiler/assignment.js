import * as nodes from '../nodes.js';

class CompileAssignment {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeSet(node, analysisPass) {
    const compiler = this.compiler;
    const declares = [];
    const uses = [];
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
      node.body._analysis = { createScope: true };
    }
    if (node.path && targets.length !== 1) {
      compiler.fail('set_path only supports a single target.', node.lineno, node.colno, node);
    }
    const thisSharedPath = compiler.channel.getThisSharedSetPathFacts(node, analysisPass);
    if (thisSharedPath) {
      uses.push(thisSharedPath.name);
      mutates.push(thisSharedPath.name);
      return {
        declares,
        uses,
        mutates,
        thisSharedSetPath: thisSharedPath
      };
    }
    targets.forEach((target) => {
      if (target instanceof nodes.Symbol) {
        target._analysis = Object.assign({}, target._analysis, { declarationTarget: true });
        const name = target.value;
        const declaration = analysisPass.findDeclaration(node._analysis, name);
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
          declares.push({ name, type: 'var', initializer: null, explicit: !!isDeclaration });
        } else {
          mutates.push(name);
        }
      }
    });
    return {
      declares,
      uses,
      mutates
    };
  }

  finalizeAnalyzeSet(node) {
    const compiler = this.compiler;
    if (node._analysis.thisSharedSetPath) {
      return {};
    }

    const exportFromRootScope = compiler.analysis.isRootScopeOwner(node._analysis);
    const targetFacts = [];
    (node.targets || []).forEach((target) => {
      if (!(target instanceof nodes.Symbol)) {
        targetFacts.push(null);
        return;
      }
      const name = target.value;
      const visibleDeclaration = compiler.analysis.findDeclaration(node._analysis, name);
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
    const thisSharedPath = node._analysis.thisSharedSetPath;
    if (thisSharedPath) {
      compiler.channel.compileThisSharedSetPath(node, thisSharedPath);
      return;
    }

    const ids = [];
    const isDeclarationOnly = !!node.declarationOnly;
    const targetFacts = node._analysis.setTargetFacts ?? null;

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

      if (facts.isOwnDeclaration) {
        this.emit(`runtime.declareBufferChannel(${compiler.buffer.currentBuffer}, "${name}", "var", context, null);`);
      } else if (!facts.isVarDeclaration) {
        compiler.fail(
          `Compiler error: analysis did not resolve a visible var declaration for '${name}'.`,
          target.lineno,
          target.colno,
          node,
          target
        );
      }

      const id = compiler._tmpid();
      this.emit.line(`let ${id};`);
      ids.push(id);
    });

    let hasAssignedValue = false;
    if (node.path) {
      const targetName = node.targets[0].value;
      const pathValueId = compiler._tmpid();
      this.emit(`let ${pathValueId} = `);
      compiler.compileExpression(node.value, null, node.value);
      this.emit.line(';');
      this.emit(ids[0] + ' = ');
      this.emit('runtime.setPath(');
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

      if (hasAssignedValue) {
        this.emit.line(`${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: '${name}', args: [${valueId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${name}');`);
      }

      if (name.charAt(0) !== '_' && hasAssignedValue && facts && facts.exportFromRootScope && !facts.isSharedDeclaration) {
        this.emit.line(`context.addDeferredExport("${name}", "${name}", ${compiler.buffer.currentBuffer});`);
      }
    });
  }
}

export {CompileAssignment};
