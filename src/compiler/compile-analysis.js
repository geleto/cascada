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

    this._annotateSequenceMetadata(rootNode);
    this._walk(rootNode, null, null);
    this._finalizeDeclarations(rootNode);
    this._finalizeOutputUsage(rootNode);
    return null;
  }

  _annotateSequenceMetadata(rootNode) {
    if (!this.compiler || !this.compiler.asyncMode || !this.compiler.sequential || !rootNode) {
      return;
    }

    const sequenceLocks = Array.from(new Set(this.compiler.sequential.collectSequenceLocks(rootNode)));
    rootNode._analysis = Object.assign(rootNode._analysis || {}, {
      sequenceLocks
    });

    const frame = {
      declaredOutputs: new Map(),
      parent: null
    };
    sequenceLocks.forEach((lockName) => {
      if (!lockName) {
        return;
      }
      frame.declaredOutputs.set(lockName, { type: 'sequential_path', initializer: null });
    });

    this.compiler.sequential._collectSequenceKeysAndOperations(rootNode, frame);

    const nodesList = [];
    this._collectNodes(rootNode, nodesList);
    for (let i = 0; i < nodesList.length; i++) {
      const node = nodesList[i];
      if (!node || !node.lockKey) {
        continue;
      }
      node._analysis = Object.assign(node._analysis || {}, {
        sequenceLockLookup: {
          key: node.lockKey,
          repair: !!node.sequentialRepair
        }
      });
    }
  }

  _walk(node, parentNode, parentField) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._walk(node[i], parentNode, parentField);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    const analysis = this._ensureAnalysis(node, parentNode);
    this._analyzeNode(node);
    this._registerDeclarations(analysis);

    node.fields.forEach((field) => {
      const child = node[field];
      this._walk(child, node, field);
    });

    this._finalizeNode(node);
  }

  _ensureAnalysis(node, parentNode) {
    const parentAnalysis = parentNode && parentNode._analysis ? parentNode._analysis : null;
    const existingAnalysis = node._analysis || {};
    const normalizeAnalysisList = (value, name) => {
      if (value === undefined) {
        return [];
      }
      if (!Array.isArray(value)) {
        throw new Error(`Invalid _analysis.${name} for ${node.typename}: expected array or undefined`);
      }
      return value;
    };
    node._analysis = Object.assign({
      createScope: false,
      scopeBoundary: false,
      declarationTarget: false,
      parent: parentAnalysis,
      textOutput: null,
      sequenceLocks: existingAnalysis.sequenceLocks || null,
      sequenceLockLookup: existingAnalysis.sequenceLockLookup || null,
      declares: normalizeAnalysisList(existingAnalysis.declares, 'declares'),
      declaresInParent: normalizeAnalysisList(existingAnalysis.declaresInParent, 'declaresInParent'),
      uses: normalizeAnalysisList(existingAnalysis.uses, 'uses'),
      mutates: normalizeAnalysisList(existingAnalysis.mutates, 'mutates'),
      declaredOutputs: null,
      usedOutputs: null,
      mutatedOutputs: null
    }, existingAnalysis);
    node._analysis.parent = parentAnalysis;
    return node._analysis;
  }

  _analyzeNode(node) {
    const analyzerName = `analyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node._analysis = Object.assign(node._analysis || {}, returned);
      }
    }
  }

  _finalizeNode(node) {
    const analyzerName = `finalizeAnalyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this);
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

  findDeclaration(analysis, name) {
    return this._findDeclaration(analysis, name);
  }

  findDeclarationInCurrentScope(analysis, name) {
    const owner = this._findScopeOwner(analysis);
    if (!owner || !owner.declaredOutputs) {
      return null;
    }
    return owner.declaredOutputs.get(name) || null;
  }

  findOuterDeclaration(analysis, name) {
    const owner = this._findScopeOwner(analysis);
    const start = owner ? owner.parent : null;
    return this._findDeclaration(start, name);
  }

  findDeclarationOwner(analysis, name) {
    return this._findDeclarationOwner(analysis, name);
  }

  getScopeOwner(analysis) {
    return this._findScopeOwner(analysis);
  }

  getIncludeVisibleVarOutputs(analysis) {
    const visibleOutputs = [];
    const visibleNames = new Set();
    let current = analysis;
    while (current) {
      if (current.declaredOutputs) {
        current.declaredOutputs.forEach((decl, name) => {
          if (!decl || decl.type !== 'var') {
            return;
          }
          const runtimeName = decl.runtimeName || name;
          const baseName = this.getBaseOutputName(runtimeName);
          if (visibleNames.has(baseName)) {
            return;
          }
          visibleNames.add(baseName);
          visibleOutputs.push({
            name,
            decl,
            runtimeName,
            baseName
          });
        });
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
    }
    return visibleOutputs;
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

  getBaseOutputName(runtimeName) {
    const hashIndex = runtimeName.indexOf('#');
    if (hashIndex === -1) {
      return runtimeName;
    }
    return runtimeName.slice(0, hashIndex);
  }

  _finalizeDeclarations(rootNode) {
    const nodesList = [];
    this._collectNodes(rootNode, nodesList);
    for (let i = 0; i < nodesList.length; i++) {
      const analysis = nodesList[i]._analysis;
      if (!analysis) {
        continue;
      }
      analysis.declaredOutputs = null;
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
          owner.declaredOutputs.set(decl.name, this._cloneDeclaration(decl));
        }
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

  _registerDeclarations(analysis) {
    if (!analysis) {
      return;
    }
    const registerDeclares = (declares, owner) => {
      if (!Array.isArray(declares) || declares.length === 0 || !owner) {
        return;
      }
      owner.declaredOutputs = owner.declaredOutputs || new Map();
      for (let i = 0; i < declares.length; i++) {
        const decl = declares[i];
        if (!decl || !decl.name) {
          continue;
        }
        if (!owner.declaredOutputs.has(decl.name)) {
          owner.declaredOutputs.set(decl.name, this._cloneDeclaration(decl));
        }
      }
    };

    registerDeclares(analysis.declares, this._findScopeOwner(analysis));

    if (Array.isArray(analysis.declaresInParent) && analysis.declaresInParent.length > 0) {
      const parentOwner = analysis.parent ? this._findScopeOwner(analysis.parent) : null;
      registerDeclares(analysis.declaresInParent, parentOwner);
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

  _cloneDeclaration(decl) {
    return {
      type: decl.type,
      initializer: Object.prototype.hasOwnProperty.call(decl, 'initializer') ? decl.initializer : null,
      internal: !!decl.internal,
      isLoopMeta: !!decl.isLoopMeta,
      runtimeName: decl.runtimeName || null
    };
  }

  _finalizeOutputUsage(node) {
    if (!node) {
      return {
        usedOutputs: new Set(),
        mutatedOutputs: new Set()
      };
    }
    if (Array.isArray(node)) {
      const aggregate = {
        usedOutputs: new Set(),
        mutatedOutputs: new Set()
      };
      node.forEach((child) => {
        const childAggregate = this._finalizeOutputUsage(child);
        childAggregate.usedOutputs.forEach((name) => aggregate.usedOutputs.add(name));
        childAggregate.mutatedOutputs.forEach((name) => aggregate.mutatedOutputs.add(name));
      });
      return aggregate;
    }
    if (!(node instanceof nodes.Node)) {
      return {
        usedOutputs: new Set(),
        mutatedOutputs: new Set()
      };
    }

    const analysis = node._analysis || {};
    const localUses = Array.isArray(analysis.uses) ? analysis.uses : [];
    const localMutates = Array.isArray(analysis.mutates) ? analysis.mutates : [];
    const usedOutputs = new Set();
    const mutatedOutputs = new Set();

    localUses.forEach((name) => {
      if (!name) {
        return;
      }
      usedOutputs.add(name);
    });
    localMutates.forEach((name) => {
      if (!name) {
        return;
      }
      usedOutputs.add(name);
      mutatedOutputs.add(name);
    });

    node.fields.forEach((field) => {
      const childAggregate = this._finalizeOutputUsage(node[field]);
      childAggregate.usedOutputs.forEach((name) => usedOutputs.add(name));
      childAggregate.mutatedOutputs.forEach((name) => mutatedOutputs.add(name));
    });

    analysis.usedOutputs = usedOutputs.size > 0 ? usedOutputs : null;
    analysis.mutatedOutputs = mutatedOutputs.size > 0 ? mutatedOutputs : null;

    if (analysis.scopeBoundary) {
      return {
        usedOutputs: new Set(),
        mutatedOutputs: new Set()
      };
    }

    const declaredHere = analysis.declaredOutputs instanceof Map ? analysis.declaredOutputs : null;
    if (!declaredHere || declaredHere.size === 0) {
      return {
        usedOutputs,
        mutatedOutputs
      };
    }

    const parentUsedOutputs = new Set(usedOutputs);
    const parentMutatedOutputs = new Set(mutatedOutputs);

    declaredHere.forEach((_decl, name) => {
      if (!name) {
        return;
      }
      parentUsedOutputs.delete(name);
      parentMutatedOutputs.delete(name);
    });

    return {
      usedOutputs: parentUsedOutputs,
      mutatedOutputs: parentMutatedOutputs
    };
  }

  _findDeclaration(analysis, name) {
    const owner = this._findDeclarationOwner(analysis, name);
    if (!owner || !owner.declaredOutputs) {
      return null;
    }
    return owner.declaredOutputs.get(name) || null;
  }

  _findDeclarationOwner(analysis, name) {
    let current = analysis;
    while (current) {
      if (current.declaredOutputs && current.declaredOutputs.has(name)) {
        return current;
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
    }
    return null;
  }

  getCurrentTextOutput(analysis) {
    let current = analysis;
    while (current) {
      if (current.textOutput) {
        return current.textOutput;
      }
      current = current.parent;
    }
    return null;
  }
}

module.exports = CompileAnalysis;
