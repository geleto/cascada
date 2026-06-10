import * as nodes from '../language/nodes.js';
import {validateGuardVariablesDeclared} from './validation.js';

class CompileGuard {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeGuard(node) {
    const compiler = this.compiler;
    node.body.addAnalysis({ createScope: true });
    if (node.recoveryBody) {
      const recoveryAnalysis = {
        createScope: true,
        createsScopeBuffer: true
      };
      if (typeof node.errorVar === 'string' && node.errorVar) {
        recoveryAnalysis.declares = [{ name: node.errorVar, type: 'var', initializer: null }];
      } else if (node.errorVar instanceof nodes.Symbol) {
        node.errorVar.addAnalysis({ declarationTarget: true });
        recoveryAnalysis.declares = [{ name: node.errorVar.value, type: 'var', initializer: null }];
      }
      node.recoveryBody.addAnalysis(recoveryAnalysis);
    }
    const guardTargets = this._getGuardTargets(node);
    validateGuardVariablesDeclared(guardTargets.variableValidationTargets, compiler, node);
    return { guardTargets, wantsLinkedChildBuffer: true };
  }

  postAnalyzeGuard(node) {
    const compiler = this.compiler;
    const guardTargets = node._analysis.guardTargets;
    const bodyUsedChains = compiler.analysis.getChainsUsedFromParent(node.body);
    const bodyMutatedChains = compiler.analysis.getChainsMutatedFromParent(node.body);
    const modifiedLocks = new Set();
    bodyMutatedChains.forEach((chainName) => {
      if (chainName && chainName.startsWith('!')) {
        modifiedLocks.add(chainName);
      }
    });

    const resolvedSequenceTargets = this._getResolvedGuardSequenceTargets(
      node,
      guardTargets,
      modifiedLocks
    );
    const guardChains = this._getResolvedGuardChainNames(
      node,
      guardTargets,
      bodyUsedChains,
      resolvedSequenceTargets
    );
    const hasSequenceTargets = guardTargets.sequenceTargets;

    return {
      guardFacts: {
        targets: guardTargets,
        needsGuardState: guardTargets.variableTargetsAll || hasSequenceTargets,
        resolvedSequenceTargets,
        guardChains
      }
    };
  }

  compileGuard(node) {
    const compiler = this.compiler;
    const guardFacts = node._analysis.guardFacts;
    const needsGuardState = guardFacts.needsGuardState;
    const guardStateVar = needsGuardState ? compiler._tmpid() : null;
    const guardErrorContext = compiler.emitErrorContext(node);

    compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const previousGuardDepth = compiler.guardDepth;
      compiler.guardDepth = previousGuardDepth + 1;

      try {
        this.emit.line(`runtime.markChainBufferScope(${compiler.buffer.currentBuffer});`);
        let guardRepairLinePos = null;
        const chainGuardInitLinePos = compiler.codebuf.length;
        let chainGuardStateVar = null;
        this.emit.line('');
        if (guardStateVar) {
          this.emit.line(`const ${guardStateVar} = runtime.guard.init(renderState, ${guardErrorContext});`);
        }
        guardRepairLinePos = compiler.codebuf.length;
        this.emit.line('');

        compiler.compile(node.body, null);

        const resolvedSequenceTargets = guardFacts.resolvedSequenceTargets ?? [];
        const guardChains = guardFacts.guardChains ?? [];
        if (resolvedSequenceTargets.length > 0) {
          this.emit.insertLine(
            guardRepairLinePos,
            `runtime.guard.repairSequenceChains(${compiler.buffer.currentBuffer}, ${guardStateVar}, ${JSON.stringify(resolvedSequenceTargets)}, ${guardErrorContext});`
          );
        }

        if (guardChains.length > 0) {
          chainGuardStateVar = compiler._tmpid();
          this.emit.insertLine(
            chainGuardInitLinePos,
            `const ${chainGuardStateVar} = runtime.guard.initChainSnapshots(${JSON.stringify(guardChains)}, ${compiler.buffer.currentBuffer}, renderState, ${guardErrorContext});`
          );
        }

        const guardErrorsVar = compiler._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${compiler.buffer.currentBuffer}, ${JSON.stringify(guardChains)}, ${chainGuardStateVar || 'null'}, ${guardErrorContext});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        if (node.recoveryBody) {
          this._compileRecoveryScope(node, guardErrorsVar);
        }

        this.emit.line('} else {');
        this.emit.line('}');
      } finally {
        compiler.guardDepth = previousGuardDepth;
      }
    });
  }

  _compileRecoveryScope(node, guardErrorsVar) {
    const compiler = this.compiler;
    const errorVarName = this._getRecoveryErrorVarName(node);
    // Recovery is terminal within the guard buffer, so this scope buffer is
    // intentionally created only after guard finalization decides recovery runs.
    compiler.emit.withScopeCommandBuffer({
      analysisNode: node.recoveryBody,
      errorContextNode: node.recoveryBody,
      bufferStackErrorContextFields: errorVarName ? { errorVar: errorVarName } : null,
      declareTextChain: false,
      autoFinish: true,
      emitFunc: () => {
        if (errorVarName) {
          const errorVarLiteral = JSON.stringify(errorVarName);
          this.emit.line(`runtime.declareBufferChain(${compiler.buffer.currentBuffer}, ${errorVarLiteral}, "var", context, null);`);
          this.emit.line(
            `${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ chainName: ${errorVarLiteral}, args: [runtime.PoisonError.group(${guardErrorsVar})], errorContext: ${compiler.emitErrorContext(node)} }), ${errorVarLiteral});`
          );
        }
        compiler.compile(node.recoveryBody, null);
      }
    });
  }

  _getRecoveryErrorVarName(node) {
    if (typeof node.errorVar === 'string') {
      return node.errorVar || null;
    }
    if (node.errorVar instanceof nodes.Symbol) {
      return node.errorVar.value;
    }
    return null;
  }

  _getResolvedGuardSequenceTargets(node, guardTargets, modifiedLocks) {
    const resolvedSequenceTargets = new Set();
    const shouldGuardAllSequencesImplicitly =
      guardTargets.variableTargetsAll &&
      (!guardTargets.sequenceTargets || guardTargets.sequenceTargets.length === 0);

    if (guardTargets.sequenceTargets && guardTargets.sequenceTargets.length > 0) {
      for (const target of guardTargets.sequenceTargets) {
        let matchFound = false;

        if (target === '!') {
          for (const lock of modifiedLocks) {
            resolvedSequenceTargets.add(lock);
            matchFound = true;
          }
        } else {
          const baseKey = '!' + target.slice(0, -1);

          for (const lock of modifiedLocks) {
            if (lock === baseKey || lock.startsWith(baseKey + '!')) {
              resolvedSequenceTargets.add(lock);
              matchFound = true;
            }
          }

          if (!matchFound) {
            this.compiler.fail(`guard sequence lock "${target}" is not modified inside guard`, node.lineno, node.colno, node);
          }
        }
      }
    } else if (shouldGuardAllSequencesImplicitly) {
      for (const lock of modifiedLocks) {
        resolvedSequenceTargets.add(lock);
      }
    }

    return Array.from(resolvedSequenceTargets);
  }

  _getResolvedGuardChainNames(node, guardTargets, bodyUsedChains, resolvedSequenceTargets) {
    const compiler = this.compiler;
    const merged = new Set(this._getGuardedChainNames(
      bodyUsedChains,
      guardTargets,
      node.body._analysis
    ));
    for (const lockName of resolvedSequenceTargets) {
      merged.add(lockName);
    }
    const bodyDeclaredChains = Array.from((node.body._analysis.declaredChains ?? new Map()).keys());
    for (const name of bodyDeclaredChains) {
      merged.add(name);
    }
    return compiler.return.excludeGuardCaptureChains(merged);
  }

  _getGuardedChainNames(usedChains, guardTargets, analysis) {
    const compiler = this.compiler;
    const used = usedChains;

    if (!guardTargets) {
      return [];
    }

    if (guardTargets.chainSelector === '*') {
      return used;
    }

    const hasNamedChains = Array.isArray(guardTargets.chainSelector) && guardTargets.chainSelector.length > 0;
    const hasTypedChains = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedChains || hasTypedChains) {
      const guardedSet = new Set(hasNamedChains ? guardTargets.chainSelector : []);
      if (!compiler.scriptMode && guardedSet.has('text')) {
        guardedSet.add(compiler.analysis.getCurrentTextChain(analysis));
      }
      const guardedTypes = new Set(hasTypedChains ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0) {
          return false;
        }
        const chainDecl = compiler.analysis.findDeclaration(analysis, name);
        if (chainDecl) {
          return guardedTypes.has(chainDecl.type);
        }
        if (!compiler.scriptMode && name === compiler.analysis.getCurrentTextChain(analysis) && guardedTypes.has('text')) {
          return true;
        }
        return guardedTypes.has(name);
      });
    }

    if (guardTargets.variableTargetsAll) {
      return used.filter((name) => {
        if (name && name.charAt(0) === '!') {
          return false;
        }
        const chainDecl = compiler.analysis.findDeclaration(analysis, name);
        return chainDecl && chainDecl.type === 'var';
      });
    }

    if (!guardTargets.hasAnySelectors) {
      return used;
    }

    return [];
  }

  _getGuardTargets(guardNode) {
    const compiler = this.compiler;
    const chainTargetsRaw = Array.isArray(guardNode.chainTargets) &&
      guardNode.chainTargets.length > 0
      ? guardNode.chainTargets
      : null;
    let chainSelector = !chainTargetsRaw
      ? null
      : (chainTargetsRaw.includes('@') ? '*' : chainTargetsRaw);
    const typeTargets = Array.isArray(guardNode.typeTargets) && guardNode.typeTargets.length > 0
      ? guardNode.typeTargets
      : null;

    const variableTargetsRaw = guardNode.variableTargets === '*'
      ? '*'
      : (Array.isArray(guardNode.variableTargets) && guardNode.variableTargets.length > 0
        ? guardNode.variableTargets
        : null);
    const variableTargetsAll = variableTargetsRaw === '*';
    const hasVariableTargetsSelector = variableTargetsRaw !== null;
    const variableValidationTargets = [];

    if (Array.isArray(variableTargetsRaw) && variableTargetsRaw.length > 0) {
      const resolvedChains = new Set(Array.isArray(chainSelector) ? chainSelector : []);

      for (const name of variableTargetsRaw) {
        const chainDecl = compiler.analysis.findDeclaration(guardNode._analysis, name);
        const isDeclaredVar = chainDecl && chainDecl.type === 'var';

        if (isDeclaredVar) {
          variableValidationTargets.push(name);
        }
        if (chainDecl) {
          resolvedChains.add(name);
        }
        if (!compiler.scriptMode && !isDeclaredVar && !chainDecl && name === 'text') {
          resolvedChains.add(compiler.analysis.getCurrentTextChain(guardNode._analysis));
          continue;
        }
        if (!isDeclaredVar && !chainDecl) {
          variableValidationTargets.push(name);
        }
      }

      if (chainSelector !== '*') {
        chainSelector = resolvedChains.size > 0 ? Array.from(resolvedChains) : null;
      }
    }
    const sequenceTargets = Array.isArray(guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!chainSelector || !!typeTargets || hasVariableTargetsSelector || !!sequenceTargets;

    return {
      chainSelector,
      typeTargets,
      variableTargetsAll,
      variableValidationTargets: variableValidationTargets.length > 0 ? variableValidationTargets : null,
      sequenceTargets,
      hasAnySelectors
    };
  }
}

export {CompileGuard};
