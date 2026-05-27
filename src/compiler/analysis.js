
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPES} from '../chain-types.js';

/**
 * Chain analysis pre-pass.
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
    this._finalizeChainUsage(rootNode);
    return null;
  }

  _annotateSequenceMetadata(rootNode) {
    if (!this.compiler || !this.compiler.asyncMode || !this.compiler.sequential || !rootNode) {
      return;
    }

    const sequenceLocks = Array.from(new Set(this.compiler.sequential.collectSequenceLocks(rootNode)));
    rootNode.addAnalysis({ sequenceLocks });
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

    const analysis = this._ensureAnalysis(node, parentNode, parentField);
    this._analyzeNode(node);
    this.compiler._generateErrorContext(node);
    this._registerDeclarations(analysis);
    this._validateUses(analysis);
    this._validateMutations(analysis);

    node.fields.forEach((field) => {
      this._walk(node[field], node, field);
    });
  }

  _ensureAnalysis(node, parentNode, parentField) {
    const parentAnalysis = parentNode?._analysis ?? null;
    const existingAnalysis = node._analysis ?? {};
    const inheritedSequenceFunCallLockKey = parentAnalysis
      ? (
        parentNode instanceof nodes.FunCall &&
        parentField === 'name' &&
        parentAnalysis.sequenceFunCallLockKey
          ? parentAnalysis.sequenceFunCallLockKey
          : parentAnalysis.inheritedSequenceFunCallLockKey ?? null
      )
      : null;
    // Keep this base shape limited to cross-cutting analysis facts that this
    // pass owns or derives for many node types: scope/declaration ownership,
    // chain use/mutation/link metadata, and shared boundary state. Node-
    // specific facts such as declaration targets, sequential lookup details,
    // guard/import/caller/component metadata, etc. should be attached only by
    // the analyzer that owns that feature.
    //
    // Analysis facts are populated in two passes: node analyzers seed local
    // declarations/uses/boundary flags during the walk, then post-analyzers
    // run after declaration ownership and aggregate used/mutated/linked facts
    // have been derived.
    node._analysis = {
      node,
      createScope: false,
      scopeBoundary: false,
      parentReadOnly: false,
      textOutput: null,
      sequenceLocks: null,
      declares: [],
      declaresInParent: [],
      uses: [],
      mutates: [],
      declaredChains: null,
      usedChains: null,
      mutatedChains: null,
      linkedChains: null,
      // Parent-owned linked chains this boundary may mutate. Future command-buffer
      // scheduling can use this to distinguish read-only child buffers.
      linkedMutatedChains: null,
      createsLinkedChildBuffer: false,
      expressionControlFlowBoundary: false,
      ...existingAnalysis,
      parent: parentAnalysis,
      inheritedSequenceFunCallLockKey
    };
    return node._analysis;
  }

  _analyzeNode(node) {
    const analyzerName = `analyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node.addAnalysis(returned);
      }
    }
  }

  _postAnalyzeNode(node) {
    const analyzerName = `postAnalyze${node.typename}`;
    const analyzer = this.compiler && this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node.addAnalysis(returned);
      }
    }
  }

  getChainsUsedFromParent(node) {
    const analysis = node?._analysis;
    const chains = new Set(analysis?.usedChains ?? []);
    if (analysis?.declaredChains instanceof Map) {
      for (const name of analysis.declaredChains.keys()) {
        chains.delete(name);
      }
    }
    return Array.from(chains);
  }

  extractSymbols(targetNode) {
    if (!targetNode) {
      return [];
    }
    if (targetNode instanceof nodes.Symbol) {
      return [targetNode.value];
    }
    if (targetNode instanceof nodes.NodeList || targetNode instanceof nodes.Array) {
      const names = [];
      (targetNode.children || []).forEach((child) => {
        this.extractSymbols(child).forEach((name) => names.push(name));
      });
      return names;
    }
    return [];
  }

  findDeclaration(analysis, name) {
    const owner = this.findDeclarationOwner(analysis, name);
    if (!owner || !owner.declaredChains) {
      return null;
    }
    return owner.declaredChains.get(name) || null;
  }

  markLookupDeclaration(node, name, analysis = node._analysis) {
    const declaration = this.findDeclaration(analysis, name);
    node.addAnalysis({ lookupDeclaration: declaration || null });
    return declaration;
  }

  findRootDeclaration(analysis, name) {
    const owner = this.getRootScopeOwner(analysis);
    if (!owner || !owner.declaredChains) {
      return null;
    }
    return owner.declaredChains.get(name) || null;
  }

  getRootNode(analysis) {
    let current = analysis;
    while (current.parent) {
      current = current.parent;
    }
    return current.node;
  }

  _installDeclaration(owner, decl, declarationOrigin) {
    if (decl.shared) {
      if (!decl.declarationOrigin) {
        decl.declarationOrigin = this.getTopmostChildAnalysis(declarationOrigin);
      }
      owner.declaredChains.set(decl.name, decl);
      this.compiler.inheritance.registerRootSharedDeclaration(owner, decl);
      return;
    }
    owner.declaredChains.set(decl.name, this._cloneDeclaration({ ...decl, declarationOrigin }));
  }

  getRootScopeOwner(analysis) {
    let current = analysis;
    while (current && current.parent) {
      current = current.parent;
    }
    return this._getScopeOwner(current || analysis);
  }

  getTopmostChildAnalysis(analysis) {
    let current = analysis;
    while (current.parent && current.parent.parent) {
      current = current.parent;
    }
    return current;
  }

  findDeclarationOwner(analysis, name) {
    const skipDeclarationOwner = analysis.skipDeclarationOwner || null;
    let current = analysis;
    while (current) {
      if (current.declaredChains && current.declaredChains.has(name) && current !== skipDeclarationOwner) {
        return current;
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
    }
    return null;
  }

  _getScopeOwner(analysis) {
    let current = analysis;
    while (current && !current.createScope) {
      current = current.parent;
    }
    return current || analysis;
  }

  isRootScopeOwner(analysis) {
    return this._getScopeOwner(analysis) === this.getRootScopeOwner(analysis);
  }

  isParentOwnedDeclarationRootOwned(analysis, name) {
    const hasParentOwnedDecl = analysis.declaresInParent.some((decl) => decl && decl.parentOwned && decl.name === name);
    if (!hasParentOwnedDecl) {
      return false;
    }
    const parentOwner = analysis.parent ? this._getScopeOwner(analysis.parent) : null;
    return parentOwner && parentOwner === this.getRootScopeOwner(analysis);
  }

  _passesReadOnlyBoundary(currentScopeOwner, declarationOwner) {
    let current = currentScopeOwner;
    while (current && current !== declarationOwner) {
      if (current.parentReadOnly) {
        return true;
      }
      current = current.parent ? this._getScopeOwner(current.parent) : null;
    }
    return false;
  }

  getBaseChainName(runtimeName) {
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
      analysis.declaredChains = null;
    }

    for (let i = 0; i < nodesList.length; i++) {
      const analysis = nodesList[i]._analysis;
      const owner = this._getScopeOwner(analysis);

      // Most declarations are owned by the current scope owner. For example,
      // set/var statements and macro parameters become visible in the scope
      // introduced by the current node.
      const localDeclares = analysis.declares;
      for (let j = 0; j < localDeclares.length; j++) {
        const decl = localDeclares[j];
        if (!decl || !decl.name) {
          continue;
        }
        owner.declaredChains = owner.declaredChains || new Map();
        if (!owner.declaredChains.has(decl.name)) {
          this._installDeclaration(owner, decl, analysis);
        }
      }

      // Some nodes introduce a declaration that is owned by the parent scope
      // instead of the current one. Macros are the main case: the macro name
      // is visible where the macro is declared, even though the macro body
      // itself gets its own scope owner.
      const parentDeclares = analysis.declaresInParent;
      if (parentDeclares.length > 0) {
        const parentOwner = analysis.parent ? this._getScopeOwner(analysis.parent) : null;
        if (parentOwner) {
          for (let j = 0; j < parentDeclares.length; j++) {
            const decl = parentDeclares[j];
            if (!decl || !decl.name) {
              continue;
            }
            parentOwner.declaredChains = parentOwner.declaredChains || new Map();
            if (!parentOwner.declaredChains.has(decl.name)) {
              this._installDeclaration(parentOwner, decl, analysis);
            }
          }
        }
      }
    }

    if (rootNode && rootNode._analysis) {
      const rootAnalysis = rootNode._analysis;
      const sequenceLocks = new Set();
      for (let i = 0; i < nodesList.length; i++) {
        const analysis = nodesList[i]._analysis;
        const localUses = analysis.uses;
        for (let j = 0; j < localUses.length; j++) {
          const name = localUses[j];
          if (name && name.charAt(0) === '!') {
            sequenceLocks.add(name);
          }
        }
        const localMutates = analysis.mutates;
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
    const registerDeclares = (declares, owner, declarationOrigin) => {
      if (declares.length === 0 || !owner) {
        return;
      }
      owner.declaredChains = owner.declaredChains || new Map();
      for (let i = 0; i < declares.length; i++) {
        const decl = declares[i];
        if (!decl || !decl.name) {
          continue;
        }
        this._validateReservedDeclarationName(analysis, decl);
        const currentScopeDecl = owner.declaredChains.get(decl.name) || null;
        if (analysis.node.typename === 'Macro') {
          if (decl.parentOwned) {
            if (currentScopeDecl) {
              this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
            }
            let current = owner.parent;
            while (current) {
              if (current.declaredChains && current.declaredChains.has(decl.name)) {
                this._validateDeclarationConflict(analysis, decl, current.declaredChains.get(decl.name));
              }
              if (current.scopeBoundary) {
                break;
              }
              current = current.parent;
            }
          } else if (currentScopeDecl && currentScopeDecl.declarationOrigin === declarationOrigin) {
            this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
          }
        } else if (decl.explicit !== false &&
          (analysis.node.typename === 'Set' || analysis.node.typename === 'ChainDeclaration')) {
          if (currentScopeDecl && currentScopeDecl.declarationOrigin !== declarationOrigin) {
            this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
          }
          let current = owner.parent;
          while (current) {
            if (current.declaredChains && current.declaredChains.has(decl.name)) {
              this._validateDeclarationConflict(analysis, decl, current.declaredChains.get(decl.name));
            }
            if (current.scopeBoundary) {
              break;
            }
            current = current.parent;
          }
        }
        if (!owner.declaredChains.has(decl.name)) {
          this._installDeclaration(owner, decl, declarationOrigin);
        }
      }
    };

    registerDeclares(analysis.declares, this._getScopeOwner(analysis), analysis);

    if (analysis.declaresInParent.length > 0) {
      const parentOwner = analysis.parent ? this._getScopeOwner(analysis.parent) : null;
      registerDeclares(analysis.declaresInParent, parentOwner, analysis);
    }
  }

  _validateDeclarationConflict(analysis, decl, conflictingDecl) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;

    if (decl.type !== 'var') {
      if (conflictingDecl && conflictingDecl.type === 'var') {
        this.compiler.fail(
          `Cannot declare chain '${decl.name}' because a variable with the same name is already declared`,
          lineno,
          colno,
          originNode || undefined
        );
      }
      this.compiler.fail(
        `Cannot declare chain '${decl.name}': already declared`,
        lineno,
        colno,
        originNode || undefined
      );
    }

    this.compiler.fail(
      `Identifier '${decl.name}' has already been declared.`,
      lineno,
      colno,
      originNode || undefined
    );
  }

  _validateReservedDeclarationName(analysis, decl) {
    if (decl && decl.internal) {
      return;
    }
    if (!this.compiler || !this.compiler.isReservedDeclarationName || !this.compiler.isReservedDeclarationName(decl.name)) {
      return;
    }
    if (decl.name !== 'context' && decl.type === 'var' && !this.compiler.scriptMode) {
      return;
    }
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;
    this.compiler.fail(
      `Identifier '${decl.name}' is reserved and cannot be used as a variable or chain name.`,
      lineno,
      colno,
      originNode || undefined
    );
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
    return { ...decl };
  }

  _validateMutations(analysis) {
    const scopeOwner = this._getScopeOwner(analysis);
    const currentTextChain = this.getCurrentTextChain(analysis);
    const localMutates = analysis.mutates;
    for (let i = 0; i < localMutates.length; i++) {
      const name = localMutates[i];
      if (!name) {
        continue;
      }
      if (name.charAt(0) === '!') {
        continue;
      }
      if (name === currentTextChain) {
        continue;
      }
      const declarationOwner = this.findDeclarationOwner(analysis, name);
      const declaration = this.findDeclaration(analysis, name);
      if (!declarationOwner || !declaration) {
        const rootDeclaration = this.findRootDeclaration(analysis, name);
        if (rootDeclaration && rootDeclaration.shared) {
          continue;
        }
        this._validateMissingDeclaration(analysis, name, 'mutation');
        continue;
      }
      if (declaration.type === 'sequential_path' || name.charAt(0) === '!') {
        continue;
      }
      if (declaration.shared) {
        continue;
      }
      if (!this._passesReadOnlyBoundary(scopeOwner, declarationOwner)) {
        continue;
      }
      this._validateReadOnlyMutation(analysis, name, declaration);
    }
  }

  _validateUses(analysis) {
    const currentTextChain = this.getCurrentTextChain(analysis);
    const localUses = analysis.uses;
    for (let i = 0; i < localUses.length; i++) {
      const name = localUses[i];
      if (!name) {
        continue;
      }
      if (name.charAt(0) === '!') {
        continue;
      }
      if (name === currentTextChain) {
        continue;
      }
      if (!this.findDeclaration(analysis, name)) {
        const rootDeclaration = this.findRootDeclaration(analysis, name);
        if (rootDeclaration && rootDeclaration.shared) {
          continue;
        }
        this._validateMissingDeclaration(analysis, name, 'use');
      }
    }
  }

  _validateMissingDeclaration(analysis, name, accessType) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;

    if (originNode && originNode.typename === 'ChainCommand') {
      this.compiler.fail(
        `Unsupported command target '${name}'. Commands must target declared chains (${CHAIN_TYPES.join('/')}).`,
        lineno,
        colno,
        originNode || undefined
      );
    }

    if (originNode && (originNode.typename === 'Set' || originNode.typename === 'CallAssign')) {
      this.compiler.fail(
        `Cannot assign to undeclared variable '${name}'. Use 'var' to declare a new variable.`,
        lineno,
        colno,
        originNode || undefined
      );
    }

    this.compiler.fail(
      accessType === 'mutation'
        ? `Cannot assign to undeclared variable '${name}'. Use 'var' to declare a new variable.`
        : `Can not look up unknown variable/function: ${name}`,
      lineno,
      colno,
      originNode || undefined
    );
  }

  _validateReadOnlyMutation(analysis, name, declaration) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;

    if (declaration.type === 'var') {
      this.compiler.fail(
        `Cannot assign to outer-scope variable '${name}' from a read-only scope. Call blocks can read from parent scope but cannot mutate it.`,
        lineno,
        colno,
        originNode || undefined
      );
    }
    this.compiler.fail(
      `Chain '${name}' is read-only in this scope.`,
      lineno,
      colno,
      originNode || undefined
    );
  }

  _finalizeChainUsage(node) {
    if (!node) {
      return {
        usedChains: new Set(),
        mutatedChains: new Set()
      };
    }
    if (Array.isArray(node)) {
      const aggregate = {
        usedChains: new Set(),
        mutatedChains: new Set()
      };
      node.forEach((child) => {
        const childAggregate = this._finalizeChainUsage(child);
        childAggregate.usedChains.forEach((name) => aggregate.usedChains.add(name));
        childAggregate.mutatedChains.forEach((name) => aggregate.mutatedChains.add(name));
      });
      return aggregate;
    }
    if (!(node instanceof nodes.Node)) {
      return {
        usedChains: new Set(),
        mutatedChains: new Set()
      };
    }

    const analysis = node._analysis;
    const localUses = analysis.uses;
    const localMutates = analysis.mutates;
    const usedChains = new Set();
    const mutatedChains = new Set();

    localUses.forEach((name) => {
      if (!name) {
        return;
      }
      usedChains.add(name);
    });
    localMutates.forEach((name) => {
      if (!name) {
        return;
      }
      usedChains.add(name);
      mutatedChains.add(name);
    });

    node.fields.forEach((field) => {
      const childAggregate = this._finalizeChainUsage(node[field]);
      childAggregate.usedChains.forEach((name) => usedChains.add(name));
      childAggregate.mutatedChains.forEach((name) => mutatedChains.add(name));
    });

    analysis.usedChains = usedChains.size > 0 ? usedChains : null;
    analysis.mutatedChains = mutatedChains.size > 0 ? mutatedChains : null;
    const declaredHere = analysis.declaredChains;
    analysis.linkedChains = this._deriveBoundaryLinkedChains(analysis, usedChains, declaredHere);
    analysis.linkedMutatedChains = this._deriveBoundaryLinkedChains(analysis, mutatedChains, declaredHere);
    if (analysis.expressionControlFlowBoundary) {
      analysis.createsLinkedChildBuffer = analysis.linkedMutatedChains !== null &&
        analysis.linkedMutatedChains.size > 0;
      if (!analysis.createsLinkedChildBuffer) {
        analysis.linkedChains = null;
        analysis.linkedMutatedChains = null;
      }
    }

    this._postAnalyzeNode(node);

    return this._getParentVisibleChainUsage(
      analysis,
      localUses,
      localMutates,
      usedChains,
      mutatedChains,
      declaredHere
    );
  }

  _getParentVisibleChainUsage(analysis, localUses, localMutates, usedChains, mutatedChains, declaredHere) {
    let parentUsage;
    if (analysis.scopeBoundary) {
      const nodeType = analysis.node && analysis.node.typename;
      const isMethodOrBlockBoundary = nodeType === 'Block' || nodeType === 'MethodDefinition';
      if (!isMethodOrBlockBoundary) {
        return {
          usedChains: new Set(),
          mutatedChains: new Set()
        };
      }
      parentUsage = {
        usedChains: new Set(),
        mutatedChains: new Set()
      };
      localUses.forEach((name) => {
        if (name) {
          parentUsage.usedChains.add(name);
        }
      });
      localMutates.forEach((name) => {
        if (name) {
          parentUsage.usedChains.add(name);
          parentUsage.mutatedChains.add(name);
        }
      });
    } else {
      parentUsage = {
        usedChains: new Set(usedChains),
        mutatedChains: new Set(mutatedChains)
      };
    }
    if (declaredHere) {
      declaredHere.forEach((_decl, name) => {
        if (name) {
          parentUsage.usedChains.delete(name);
          parentUsage.mutatedChains.delete(name);
        }
      });
    }
    return parentUsage;
  }

  _deriveBoundaryLinkedChains(analysis, usedChains, declaredChains) {
    if (!analysis.parent || !analysis.createsLinkedChildBuffer) {
      return null;
    }
    const linkedChains = new Set();
    usedChains.forEach((name) => {
      if (name) {
        linkedChains.add(name);
      }
    });
    if (declaredChains) {
      declaredChains.forEach((_decl, name) => {
        linkedChains.delete(name);
      });
    }
    return linkedChains.size > 0 ? linkedChains : null;
  }

  getCurrentTextChain(analysis) {
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

export {CompileAnalysis};
