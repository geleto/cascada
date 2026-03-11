'use strict';

const nodes = require('../nodes');

/**
 * Output analysis pre-pass.
 *
 * This pass annotates AST nodes with `_analysis` metadata and precomputes
 * declaration/use/mutation sets without changing compile-time behavior yet.
 *
 * Initial migration target:
 * - establish stable `_analysis` structure and scope ownership
 * - compute declaration placement inline during traversal
 * - collect a conservative first version of usage/mutation metadata
 */
class CompileAnalysis {
  constructor(compiler) {
    this.compiler = compiler;
  }

  run(rootNode) {
    if (!rootNode) {
      return null;
    }

    const state = {
      nodeCount: 0,
      declarationCount: 0,
      usageCount: 0,
      mutationCount: 0
    };

    this._walk(rootNode, null, null, {
      inDeclarationTarget: false,
      forceCreateScope: false
    }, state);

    return state;
  }

  _walk(node, parentNode, parentField, ctx, state) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._walk(node[i], parentNode, parentField, ctx, state);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    state.nodeCount++;

    const analysis = this._ensureAnalysis(node, parentNode, parentField, ctx);
    this._analyzeNode(node, analysis, ctx, state);

    node.fields.forEach((field) => {
      const child = node[field];
      const childCtx = this._nextContext(node, field, ctx);
      this._walk(child, node, field, childCtx, state);
    });
  }

  _ensureAnalysis(node, parentNode, parentField, ctx) {
    if (!node._analysis) {
      const parentAnalysis = parentNode && parentNode._analysis ? parentNode._analysis : null;
      node._analysis = {
        createScope: false,
        scopeBoundary: false,
        parent: parentAnalysis,
        declaresLocal: new Map(),
        usesLocal: new Set(),
        mutatesLocal: new Set(),
        declaredOutputs: null,
        usedOutputs: null,
        mutatedOutputs: null
      };
    }
    if (ctx && ctx.forceCreateScope) {
      node._analysis.createScope = true;
    }
    return node._analysis;
  }

  _nextContext(node, field, ctx) {
    if (this.compiler && typeof this.compiler.analyzeChildContext === 'function') {
      const next = this.compiler.analyzeChildContext(node, field, ctx);
      if (next) {
        return next;
      }
    }

    return ctx;
  }

  _analyzeNode(node, analysis, ctx, state) {
    const analyzerName = `analyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      analyzer.call(this.compiler, node, analysis, ctx, this, state);
    }
  }

  _extractSymbols(targetNode) {
    if (!targetNode) {
      return [];
    }
    if (targetNode instanceof nodes.Symbol) {
      return [targetNode.value];
    }
    if (targetNode instanceof nodes.NodeList || targetNode instanceof nodes.Array) {
      const names = [];
      (targetNode.children || []).forEach((child) => {
        this._extractSymbols(child).forEach((name) => names.push(name));
      });
      return names;
    }
    return [];
  }

  _extractObservedOutputName(targetNode) {
    if (!targetNode) {
      return null;
    }
    if (targetNode instanceof nodes.Symbol) {
      return targetNode.value;
    }
    if (targetNode instanceof nodes.FunCall && this.compiler.sequential && this.compiler.sequential._extractStaticPathRoot) {
      return this.compiler.sequential._extractStaticPathRoot(targetNode.name, 2);
    }
    return null;
  }

  getVisibleOutputDeclarationFromNode(node, name) {
    if (!node || !node._analysis) {
      return null;
    }
    return this._getVisibleOutputDeclaration(node._analysis, name);
  }

  detectObservedOutputNameFromNodeScope(node, targetNode, isSequenceMarkedTargetFn) {
    if (!node || !node._analysis) {
      return null;
    }
    if (typeof isSequenceMarkedTargetFn === 'function' && isSequenceMarkedTargetFn(targetNode)) {
      return null;
    }
    const outputName = this._extractObservedOutputName(targetNode);
    if (!outputName) {
      return null;
    }
    if (!this._isOutputDeclaredInVisibleScopes(node._analysis, outputName)) {
      return null;
    }
    return outputName;
  }

  detectSpecialOutputCall(node, lookupDeclaredOutput) {
    if (!this.compiler || !this.compiler.scriptMode || !this.compiler.sequential || !node || !node.name || typeof lookupDeclaredOutput !== 'function') {
      return null;
    }
    if (node.lockKey) {
      return null;
    }

    const sequencePath = this.compiler.sequential._extractStaticPath(node.name);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const outputName = sequencePath[0];
    const outputDecl = lookupDeclaredOutput(outputName);
    if (!outputDecl) {
      return null;
    }

    const methodName = sequencePath[sequencePath.length - 1];
    const isObservation =
      sequencePath.length === 2 &&
      (methodName === 'snapshot' || methodName === 'isError' || methodName === 'getError' || methodName === '__checkpoint');

    return {
      outputName,
      outputType: outputDecl.type,
      methodName,
      pathDepth: sequencePath.length,
      subpath: sequencePath.slice(1, -1),
      isObservation
    };
  }

  detectSequenceOutputLookup(node, lookupDeclaredOutput) {
    if (!this.compiler || !this.compiler.scriptMode || !this.compiler.sequential || !node || typeof lookupDeclaredOutput !== 'function') {
      return null;
    }
    const sequencePath = this.compiler.sequential._extractStaticPath(node);
    if (!sequencePath || sequencePath.length < 2) {
      return null;
    }

    const outputName = sequencePath[0];
    const outputDecl = lookupDeclaredOutput(outputName);
    const propertyName = sequencePath[sequencePath.length - 1];
    if (!outputDecl || outputDecl.type !== 'sequence' || propertyName === 'snapshot') {
      return null;
    }

    return {
      outputName,
      propertyName,
      subpath: sequencePath.slice(1, -1)
    };
  }

  registerOutputDeclaration(analysis, outputName, meta, state) {
    if (!outputName) {
      return;
    }
    analysis.declaresLocal.set(outputName, meta);

    const owner = this._findDeclarationOwner(analysis);
    owner.declaredOutputs = owner.declaredOutputs || new Map();
    if (!owner.declaredOutputs.has(outputName)) {
      owner.declaredOutputs.set(outputName, {
        type: meta.type,
        initializer: meta.initializer || null
      });
    }
    state.declarationCount++;
  }

  registerOutputUsage(analysis, outputName, state) {
    if (!outputName) {
      return;
    }
    analysis.usesLocal.add(outputName);
    const owner = this._findDeclarationOwner(analysis);
    owner.usedOutputs = owner.usedOutputs || new Set();
    owner.usedOutputs.add(outputName);
    state.usageCount++;
  }

  registerOutputMutation(analysis, outputName, state) {
    if (!outputName) {
      return;
    }
    analysis.mutatesLocal.add(outputName);
    const owner = this._findDeclarationOwner(analysis);
    owner.mutatedOutputs = owner.mutatedOutputs || new Set();
    owner.mutatedOutputs.add(outputName);
    state.mutationCount++;
  }

  _findDeclarationOwner(analysis) {
    let current = analysis;
    while (current) {
      if (current.createScope) {
        return current;
      }
      current = current.parent;
    }
    return analysis;
  }

  _isOutputDeclaredInVisibleScopes(analysis, name) {
    return !!this._getVisibleOutputDeclaration(analysis, name);
  }

  _getVisibleOutputDeclaration(analysis, name) {
    let current = analysis;
    while (current) {
      if (current.declaredOutputs && current.declaredOutputs.has(name)) {
        return current.declaredOutputs.get(name);
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
    }
    return null;
  }
}

module.exports = CompileAnalysis;
