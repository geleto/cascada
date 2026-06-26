import * as nodes from '../language/nodes.js';
import {validateGuardVariablesDeclared} from './validation.js';

// Experimental implementation, will be rewritten
class CompileGuard {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeGuard(node) {
    const compiler = this.compiler;
    const guardTargets = this._getGuardTargets(node);
    node.body.addAnalysis({
      createScope: true,
      wantsLinkedChildBuffer: true
    });
    if (node.recoveryBody) {
      const recoveryAnalysis = {
        createScope: true,
        wantsLinkedChildBuffer: true
      };
      if (typeof node.errorVar === 'string' && node.errorVar) {
        recoveryAnalysis.declareOnEnter = [{ name: node.errorVar, type: 'var', initializer: null }];
        compiler.analysis.addCommandFacts(node.recoveryBody, { mutated: [node.errorVar] });
      } else if (node.errorVar instanceof nodes.Symbol) {
        node.errorVar.addAnalysis({ isSymbolTarget: true });
        recoveryAnalysis.declareOnEnter = [{ name: node.errorVar.value, type: 'var', initializer: null }];
        compiler.analysis.addCommandFacts(node.recoveryBody, { mutated: [node.errorVar.value] });
      }
      node.recoveryBody.addAnalysis(recoveryAnalysis);
    }
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
    const recoveryObservedChains = node.recoveryBody
      ? compiler.analysis.getChainsObservedFromParent(node.recoveryBody)
      : [];
    const recoveryMutatedChains = node.recoveryBody
      ? compiler.analysis.getChainsMutatedFromParent(node.recoveryBody)
      : [];
    const bodyObservedChains = compiler.analysis.getChainsObservedFromParent(node.body);
    const bodyMutatedChainsFromParent = compiler.analysis.getChainsMutatedFromParent(node.body);
    const ownedObservedChains = Array.from(new Set([
      ...bodyObservedChains,
      ...guardChains,
      ...recoveryObservedChains
    ]));
    const ownedMutatedChains = Array.from(new Set([
      ...bodyMutatedChainsFromParent,
      ...guardChains,
      ...recoveryMutatedChains
    ]));

    return {
      observes: ownedObservedChains,
      mutates: ownedMutatedChains,
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

    compiler.boundaries.compileAsyncControlFlowBoundary(compiler.buffer, node, () => {
      const previousGuardDepth = compiler.guardDepth;
      compiler.guardDepth = previousGuardDepth + 1;

      let guardRepairLinePos = null;
      const chainGuardInitLinePos = compiler.codebuf.length;
      let chainGuardStateVar = null;
      this.emit.line('');
      if (guardStateVar) {
        this.emit.line(`const ${guardStateVar} = runtime.guard.init(renderState, ${guardErrorContext});`);
      }
      guardRepairLinePos = compiler.codebuf.length;
      this.emit.line('');

      compiler.emit.withScopeCommandBuffer({
        analysisNode: node.body,
        errorContextNode: node.body,
        declareTextChain: false,
        autoFinish: true,
        emitFunc: () => {
          compiler.compile(node.body, null);
        }
      });

      const resolvedSequenceTargets = guardFacts.resolvedSequenceTargets;
      const guardChains = guardFacts.guardChains;
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
        `return runtime.thenValue(runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${compiler.buffer.currentBuffer}, ${JSON.stringify(guardChains)}, ${chainGuardStateVar || 'null'}, ${guardErrorContext}), (${guardErrorsVar}) => {`
      );
      this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

      if (node.recoveryBody) {
        this._compileRecoveryScope(node, guardErrorsVar);
      }

      this.emit.line('} else {');
      this.emit.line('}');
      this.emit.line('});');
      compiler.guardDepth = previousGuardDepth;
    }, node);
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
    return compiler.return.excludeGuardCaptureChains(merged);
  }

  _getGuardedChainNames(usedChains, guardTargets, analysis) {
    const compiler = this.compiler;
    const used = usedChains;

    if (!guardTargets) {
      return [];
    }
    if (!guardTargets.hasAnySelectors) {
      return used;
    }
    if (guardTargets.chainSelector === '*') {
      return used;
    }

    const guarded = new Set();
    const hasNamedChains = Array.isArray(guardTargets.chainSelector) && guardTargets.chainSelector.length > 0;
    const hasTypedChains = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedChains || hasTypedChains) {
      const guardedSet = new Set(hasNamedChains ? guardTargets.chainSelector : []);
      if (!compiler.scriptMode && guardedSet.has('text')) {
        guardedSet.add(compiler.analysis.getCurrentTextChain(analysis));
      }
      const guardedTypes = new Set(hasTypedChains ? guardTargets.typeTargets : []);
      used.forEach((name) => {
        let matches = false;
        if (guardedSet.has(name)) {
          matches = true;
        }
        if (!matches && guardedTypes.size > 0) {
          const chainDecl = analysis.visibleDeclarations?.get(name) || null;
          if (chainDecl) {
            matches = guardedTypes.has(chainDecl.type);
          } else if (!compiler.scriptMode && name === compiler.analysis.getCurrentTextChain(analysis)) {
            matches = guardedTypes.has('text');
          } else {
            matches = guardedTypes.has(name);
          }
        }
        if (matches) {
          guarded.add(name);
        }
      });
    }

    if (guardTargets.variableTargetsAll) {
      used.forEach((name) => {
        if (name && name.charAt(0) === '!') {
          return;
        }
        const chainDecl = analysis.visibleDeclarations?.get(name) || null;
        if (chainDecl && chainDecl.type === 'var') {
          guarded.add(name);
        }
      });
    }
    return Array.from(guarded);
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

    const variableTargetsRaw = Array.isArray(guardNode.variableTargets) && guardNode.variableTargets.length > 0
      ? guardNode.variableTargets
      : null;
    const variableTargetsAll = !!guardNode.allVariableTargets;
    const hasVariableTargetsSelector = variableTargetsAll || variableTargetsRaw !== null;
    const variableValidationTargets = [];

    if (variableTargetsRaw) {
      const resolvedChains = new Set(Array.isArray(chainSelector) ? chainSelector : []);

      for (const name of variableTargetsRaw) {
        const chainDecl = guardNode._analysis.visibleDeclarations?.get(name) || null;
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
