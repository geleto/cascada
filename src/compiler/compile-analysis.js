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

    this._walk(rootNode, null, null, state);
    this._finalizeAggregates(rootNode);

    return state;
  }

  _walk(node, parentNode, parentField, state) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._walk(node[i], parentNode, parentField, state);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    state.nodeCount++;

    const analysis = this._ensureAnalysis(node, parentNode, parentField);
    this._analyzeNode(node, state);
    this._publishLocalDeclarationsForVisibility(analysis);

    node.fields.forEach((field) => {
      const child = node[field];
      this._walk(child, node, field, state);
    });

    this._finalizeNode(node, state);
  }

  _ensureAnalysis(node, parentNode, parentField) {
    const parentAnalysis = parentNode && parentNode._analysis ? parentNode._analysis : null;
    node._analysis = Object.assign({
      createScope: false,
      scopeBoundary: false,
      declarationTarget: false,
      parent: parentAnalysis,
      declares: [],
      uses: [],
      mutates: [],
      declaredOutputs: null,
      usedOutputs: null,
      mutatedOutputs: null,
      usedHandlers: null,
      mutatedHandlers: null
    }, node._analysis || {});
    node._analysis.parent = parentAnalysis;
    if (!Array.isArray(node._analysis.declares)) {
      node._analysis.declares = [];
    }
    if (!Array.isArray(node._analysis.uses)) {
      node._analysis.uses = [];
    }
    if (!Array.isArray(node._analysis.mutates)) {
      node._analysis.mutates = [];
    }
    void parentField;
    return node._analysis;
  }

  _analyzeNode(node, state) {
    const analyzerName = `analyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this, state);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node._analysis = Object.assign(node._analysis || {}, returned);
      }
    }
  }

  _finalizeNode(node, state) {
    const analyzerName = `finalizeAnalyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this, state);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node._analysis = Object.assign(node._analysis || {}, returned);
      }
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

  getVisibleOutputDeclarationFromNode(node, name) {
    if (!node || !node._analysis) {
      return null;
    }
    return this._getVisibleOutputDeclaration(node._analysis, name);
  }

  detectSpecialOutputCall(node, lookupDeclaredOutput) {
    if (!this.compiler || !this.compiler.asyncMode || !this.compiler.sequential || !node || !node.name || typeof lookupDeclaredOutput !== 'function') {
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

  _findScopeOwner(analysis) {
    let current = analysis;
    while (current) {
      if (current.createScope) {
        return current;
      }
      current = current.parent;
    }
    return analysis;
  }

  _finalizeAggregates(rootNode) {
    const nodesList = [];
    this._collectNodes(rootNode, nodesList);
    for (let i = 0; i < nodesList.length; i++) {
      const analysis = nodesList[i]._analysis;
      if (!analysis) {
        continue;
      }
      analysis.declaredOutputs = null;
      analysis.usedOutputs = null;
      analysis.mutatedOutputs = null;
      analysis.usedHandlers = null;
      analysis.mutatedHandlers = null;
    }

    for (let i = 0; i < nodesList.length; i++) {
      const analysis = nodesList[i]._analysis;
      if (!analysis) {
        continue;
      }
      const owner = this._findScopeOwner(analysis);

      const localDeclares = Array.isArray(analysis.declares) ? analysis.declares : [];
      for (let j = 0; j < localDeclares.length; j++) {
        const decl = localDeclares[j];
        if (!decl || !decl.name) {
          continue;
        }
        owner.declaredOutputs = owner.declaredOutputs || new Map();
        if (!owner.declaredOutputs.has(decl.name)) {
          owner.declaredOutputs.set(decl.name, {
            type: decl.type,
            initializer: Object.prototype.hasOwnProperty.call(decl, 'initializer') ? decl.initializer : null
          });
        }
      }

      const localUses = Array.isArray(analysis.uses) ? analysis.uses : [];
      for (let j = 0; j < localUses.length; j++) {
        const name = localUses[j];
        if (!name) {
          continue;
        }
        owner.usedOutputs = owner.usedOutputs || new Set();
        owner.usedOutputs.add(name);
        owner.usedHandlers = owner.usedHandlers || new Set();
        owner.usedHandlers.add(name);
      }

      const localMutates = Array.isArray(analysis.mutates) ? analysis.mutates : [];
      for (let j = 0; j < localMutates.length; j++) {
        const name = localMutates[j];
        if (!name) {
          continue;
        }
        owner.mutatedOutputs = owner.mutatedOutputs || new Set();
        owner.mutatedOutputs.add(name);
        owner.mutatedHandlers = owner.mutatedHandlers || new Set();
        owner.mutatedHandlers.add(name);
      }
    }

    if (rootNode && rootNode._analysis) {
      const rootAnalysis = rootNode._analysis;
      const sequenceLocks = new Set();
      for (let i = 0; i < nodesList.length; i++) {
        const analysis = nodesList[i] && nodesList[i]._analysis ? nodesList[i]._analysis : null;
        if (!analysis) {
          continue;
        }
        const localUses = Array.isArray(analysis.uses) ? analysis.uses : [];
        for (let j = 0; j < localUses.length; j++) {
          const name = localUses[j];
          if (name && name.charAt(0) === '!') {
            sequenceLocks.add(name);
          }
        }
        const localMutates = Array.isArray(analysis.mutates) ? analysis.mutates : [];
        for (let j = 0; j < localMutates.length; j++) {
          const name = localMutates[j];
          if (name && name.charAt(0) === '!') {
            sequenceLocks.add(name);
          }
        }
      }
      rootAnalysis.sequenceLocks = Array.from(sequenceLocks);
    }
  }

  _publishLocalDeclarationsForVisibility(analysis) {
    if (!analysis || !Array.isArray(analysis.declares) || analysis.declares.length === 0) {
      return;
    }
    const owner = this._findScopeOwner(analysis);
    owner.declaredOutputs = owner.declaredOutputs || new Map();
    for (let i = 0; i < analysis.declares.length; i++) {
      const decl = analysis.declares[i];
      if (!decl || !decl.name) {
        continue;
      }
      if (!owner.declaredOutputs.has(decl.name)) {
        owner.declaredOutputs.set(decl.name, {
          type: decl.type,
          initializer: Object.prototype.hasOwnProperty.call(decl, 'initializer') ? decl.initializer : null
        });
      }
    }
  }

  _collectNodes(node, out) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._collectNodes(node[i], out);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }
    out.push(node);
    node.fields.forEach((field) => {
      this._collectNodes(node[field], out);
    });
  }

  _isOutputDeclaredInVisibleScopes(analysis, name) {
    return !!this._getVisibleOutputDeclaration(analysis, name);
  }

  isOutputDeclaredInVisibleScopesFromNode(node, name) {
    if (!node || !node._analysis) {
      return false;
    }
    return this._isOutputDeclaredInVisibleScopes(node._analysis, name);
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
