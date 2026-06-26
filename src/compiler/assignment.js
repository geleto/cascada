import * as nodes from '../language/nodes.js';
import {isStoredDirectly} from './declarations.js';

class CompileAssignment {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeCallAssign(node) {
    return this.analyzeSet(node);
  }

  compileCallAssign(node) {
    this.compileSet(node);
  }

  analyzeSet(node) {
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

  compileSet(node) {
    const compiler = this.compiler;
    const thisSharedAssignment = node._analysis.thisSharedAssignment;
    if (thisSharedAssignment) {
      compiler.chain.compileThisSharedAssignment(node, thisSharedAssignment);
      return;
    }

    const ids = [];
    const isDeclarationOnly = !!node.declarationOnly;
    const targetInfo = this._getSetTargetInfo(node);
    const isLiteralNone = node.value instanceof nodes.Literal && node.value.value === null;
    const allTargetsAreOwnDeclarations = node.targets.every((target, i) => {
      const info = targetInfo[i];
      return info && info.isOwnDeclaration;
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
      const info = targetInfo[i] || { isOwnDeclaration: false, isVarDeclaration: false };

      if (!info.isOwnDeclaration && !info.isVarDeclaration) {
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
      const valueId = ids[i] ?? 'null';
      const info = targetInfo[i];
      const isDirectDeclaration = info && info.isOwnDeclaration && isStoredDirectly(info.declaration);

      if (info && info.isOwnDeclaration) {
        const initializer = hasAssignedValue ? valueId : 'null';
        compiler.chain.emitLocalVarBindings(compiler.buffer.currentBuffer, [{
          name,
          declaration: info.declaration,
          emitInitializerExpression: () => {
            this.emit(initializer);
          }
        }], node._analysis.declarations);
      }

      if (hasAssignedValue) {
        if (!(info && info.isOwnDeclaration)) {
          this.emit.line(`${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ chainName: '${name}', args: [${valueId}], errorContext: ${compiler.emitErrorContext(node)} }), '${name}');`);
        }
      }

      if (name.charAt(0) !== '_' && hasAssignedValue && info && info.exportFromRootScope && !info.isSharedDeclaration) {
        if (isDirectDeclaration) {
          this.emit.line(`context.addResolvedExport("${name}", ${info.declaration.jsVar});`);
        } else {
          this.emit.line(`context.addDeferredExport("${name}", "${name}", ${compiler.buffer.currentBuffer});`);
        }
      }
    });
  }

  _getSetTargetInfo(node) {
    const exportFromRootScope = this.compiler.analysis.isRootScopeOwner(node._analysis);
    return (node.targets || []).map((target) => {
      if (!(target instanceof nodes.Symbol)) {
        return null;
      }
      const name = target.value;
      const declaration = node._analysis.visibleDeclarations?.get(name) ||
        node._analysis.producedDeclarations?.get(name) ||
        null;
      return {
        name,
        declaration,
        isOwnDeclaration: !!(declaration && declaration.declarationOrigin === node._analysis),
        isVarDeclaration: !!(declaration && declaration.type === 'var'),
        isSharedDeclaration: !!(declaration && declaration.shared),
        exportFromRootScope
      };
    });
  }
}

export {CompileAssignment};
