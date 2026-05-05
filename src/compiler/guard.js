import * as nodes from '../nodes.js';
import {validateGuardVariablesDeclared} from './validation.js';

class CompileGuard {
  constructor(compiler) {
    this.compiler = compiler;
    this.emit = this.compiler.emit;
  }

  analyzeGuard(node) {
    const compiler = this.compiler;
    node.body._analysis = { createScope: true };
    if (node.recoveryBody) {
      const recoveryAnalysis = { createScope: true };
      if (typeof node.errorVar === 'string' && node.errorVar) {
        recoveryAnalysis.declares = [{ name: node.errorVar, type: 'var', initializer: null }];
      } else if (node.errorVar instanceof nodes.Symbol) {
        node.errorVar._analysis = Object.assign({}, node.errorVar._analysis, { declarationTarget: true });
        recoveryAnalysis.declares = [{ name: node.errorVar.value, type: 'var', initializer: null }];
      }
      node.recoveryBody._analysis = recoveryAnalysis;
    }
    const guardTargets = this._getGuardTargets(node);
    validateGuardVariablesDeclared(guardTargets.variableValidationTargets, compiler, node);
    return { guardTargets, createsLinkedChildBuffer: true };
  }

  postAnalyzeGuard(node) {
    const guardTargets = node._analysis.guardTargets;
    const bodyUsedChannels = Array.from(node.body._analysis.usedChannels ?? []);
    const modifiedLocks = new Set();
    bodyUsedChannels.forEach((channelName) => {
      if (channelName && channelName.startsWith('!')) {
        modifiedLocks.add(channelName);
      }
    });

    const resolvedSequenceTargets = this._getResolvedGuardSequenceTargets(
      node,
      guardTargets,
      modifiedLocks
    );
    const guardChannels = this._getResolvedGuardChannelNames(
      node,
      guardTargets,
      bodyUsedChannels,
      resolvedSequenceTargets
    );
    const hasSequenceTargets = guardTargets.sequenceTargets;

    return {
      guardFacts: {
        targets: guardTargets,
        needsGuardState: guardTargets.variableTargetsAll || hasSequenceTargets,
        resolvedSequenceTargets,
        guardChannels
      }
    };
  }

  compileGuard(node) {
    const compiler = this.compiler;
    const guardFacts = node._analysis.guardFacts;
    const needsGuardState = guardFacts.needsGuardState;
    const guardStateVar = needsGuardState ? compiler._tmpid() : null;

    compiler.buffer._compileAsyncControlFlowBoundary(node, () => {
      const previousGuardDepth = compiler.guardDepth;
      compiler.guardDepth = previousGuardDepth + 1;

      try {
        this.emit.line(`runtime.markChannelBufferScope(${compiler.buffer.currentBuffer});`);
        let guardRepairLinePos = null;
        const channelGuardInitLinePos = compiler.codebuf.length;
        let channelGuardStateVar = null;
        this.emit.line('');
        if (guardStateVar) {
          this.emit.line(`const ${guardStateVar} = runtime.guard.init(cb);`);
        }
        guardRepairLinePos = compiler.codebuf.length;
        this.emit.line('');

        compiler.compile(node.body, null);

        const resolvedSequenceTargets = guardFacts.resolvedSequenceTargets ?? [];
        const guardChannels = guardFacts.guardChannels ?? [];
        if (resolvedSequenceTargets.length > 0) {
          this.emit.insertLine(
            guardRepairLinePos,
            `runtime.guard.repairSequenceChannels(${compiler.buffer.currentBuffer}, ${guardStateVar}, ${JSON.stringify(resolvedSequenceTargets)});`
          );
        }

        if (guardChannels.length > 0) {
          channelGuardStateVar = compiler._tmpid();
          this.emit.insertLine(
            channelGuardInitLinePos,
            `const ${channelGuardStateVar} = runtime.guard.initChannelSnapshots(${JSON.stringify(guardChannels)}, ${compiler.buffer.currentBuffer}, cb);`
          );
        }

        const guardErrorsVar = compiler._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${compiler.buffer.currentBuffer}, ${JSON.stringify(guardChannels)}, ${channelGuardStateVar || 'null'});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        if (node.recoveryBody) {
          if (node.errorVar) {
            this.emit.line(`runtime.declareBufferChannel(${compiler.buffer.currentBuffer}, "${node.errorVar}", "var", context, null);`);
            this.emit.line(
              `${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ channelName: '${node.errorVar}', args: [new runtime.PoisonError(${guardErrorsVar})], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${node.errorVar}');`
            );
          }
          compiler.compile(node.recoveryBody, null);
        }

        this.emit.line('} else {');
        this.emit.line('}');
      } finally {
        compiler.guardDepth = previousGuardDepth;
      }
    });
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

  _getResolvedGuardChannelNames(node, guardTargets, bodyUsedChannels, resolvedSequenceTargets) {
    const compiler = this.compiler;
    const merged = new Set(this._getGuardedChannelNames(
      bodyUsedChannels,
      guardTargets,
      node.body._analysis
    ));
    for (const lockName of resolvedSequenceTargets) {
      merged.add(lockName);
    }
    const bodyDeclaredChannels = Array.from((node.body._analysis.declaredChannels ?? new Map()).keys());
    for (const name of bodyDeclaredChannels) {
      merged.add(name);
    }
    return compiler.return.excludeGuardCaptureChannels(merged);
  }

  _getGuardedChannelNames(usedChannels, guardTargets, analysis) {
    const compiler = this.compiler;
    const used = usedChannels;

    if (!guardTargets) {
      return [];
    }

    if (guardTargets.channelSelector === '*') {
      return used;
    }

    const hasNamedChannels = Array.isArray(guardTargets.channelSelector) && guardTargets.channelSelector.length > 0;
    const hasTypedChannels = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedChannels || hasTypedChannels) {
      const guardedSet = new Set(hasNamedChannels ? guardTargets.channelSelector : []);
      if (!compiler.scriptMode && guardedSet.has('text')) {
        guardedSet.add(compiler.analysis.getCurrentTextChannel(analysis));
      }
      const guardedTypes = new Set(hasTypedChannels ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0) {
          return false;
        }
        const channelDecl = compiler.analysis.findDeclaration(analysis, name);
        if (channelDecl) {
          return guardedTypes.has(channelDecl.type);
        }
        if (!compiler.scriptMode && name === compiler.analysis.getCurrentTextChannel(analysis) && guardedTypes.has('text')) {
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
        const channelDecl = compiler.analysis.findDeclaration(analysis, name);
        return channelDecl && channelDecl.type === 'var';
      });
    }

    if (!guardTargets.hasAnySelectors) {
      return used;
    }

    return [];
  }

  _getGuardTargets(guardNode) {
    const compiler = this.compiler;
    const channelTargetsRaw = Array.isArray(guardNode.channelTargets) &&
      guardNode.channelTargets.length > 0
      ? guardNode.channelTargets
      : null;
    let channelSelector = !channelTargetsRaw
      ? null
      : (channelTargetsRaw.includes('@') ? '*' : channelTargetsRaw);
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
      const resolvedChannels = new Set(Array.isArray(channelSelector) ? channelSelector : []);

      for (const name of variableTargetsRaw) {
        const channelDecl = compiler.analysis.findDeclaration(guardNode._analysis, name);
        const isDeclaredVar = channelDecl && channelDecl.type === 'var';

        if (isDeclaredVar) {
          variableValidationTargets.push(name);
        }
        if (channelDecl) {
          resolvedChannels.add(name);
        }
        if (!compiler.scriptMode && !isDeclaredVar && !channelDecl && name === 'text') {
          resolvedChannels.add(compiler.analysis.getCurrentTextChannel(guardNode._analysis));
          continue;
        }
        if (!isDeclaredVar && !channelDecl) {
          variableValidationTargets.push(name);
        }
      }

      if (channelSelector !== '*') {
        channelSelector = resolvedChannels.size > 0 ? Array.from(resolvedChannels) : null;
      }
    }
    const sequenceTargets = Array.isArray(guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!channelSelector || !!typeTargets || hasVariableTargetsSelector || !!sequenceTargets;

    return {
      channelSelector,
      typeTargets,
      variableTargetsAll,
      variableValidationTargets: variableValidationTargets.length > 0 ? variableValidationTargets : null,
      sequenceTargets,
      hasAnySelectors
    };
  }
}

export {CompileGuard};
