
import * as nodes from '../nodes.js';
import {CHANNEL_TYPES} from '../channel-types.js';

/**
 * Channel analysis pre-pass.
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
    this._finalizeOutputDerivedFacts(rootNode);
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
    this._registerDeclarations(analysis);
    this._validateUses(analysis);
    this._validateMutations(analysis);

    node.fields.forEach((field) => {
      this._walk(node[field], node, field);
    });

    this._finalizeNode(node);
  }

  _ensureAnalysis(node, parentNode, parentField) {
    const parentAnalysis = parentNode && parentNode._analysis ? parentNode._analysis : null;
    const existingAnalysis = node._analysis || {};
    const inheritedSequenceFunCallLockKey = parentAnalysis
      ? (
        parentNode instanceof nodes.FunCall &&
        parentField === 'name' &&
        parentAnalysis.sequenceFunCallLockKey
          ? parentAnalysis.sequenceFunCallLockKey
          : parentAnalysis.inheritedSequenceFunCallLockKey || null
      )
      : null;
    node._analysis = {
      node,
      createScope: false,
      scopeBoundary: false,
      parentReadOnly: false,
      declarationTarget: false,
      textOutput: null,
      sequenceLocks: null,
      sequenceLockLookup: null,
      declares: [],
      declaresInParent: [],
      uses: [],
      mutates: [],
      declaredChannels: null,
      usedChannels: null,
      mutatedChannels: null,
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

  _finalizeOutputDerivedFacts(node) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => this._finalizeOutputDerivedFacts(child));
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    node.fields.forEach((field) => {
      this._finalizeOutputDerivedFacts(node[field]);
    });

    const analyzerName = `finalizeOutputAnalyze${node.typename}`;
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
    const owner = this.findDeclarationOwner(analysis, name);
    if (!owner || !owner.declaredChannels) {
      return null;
    }
    return owner.declaredChannels.get(name) || null;
  }

  findDeclarationInCurrentScope(analysis, name) {
    const owner = this.getScopeOwner(analysis);
    if (!owner || !owner.declaredChannels) {
      return null;
    }
    return owner.declaredChannels.get(name) || null;
  }

  findDeclarationOwner(analysis, name) {
    const skipDeclarationOwner = analysis && analysis.skipDeclarationOwner ? analysis.skipDeclarationOwner : null;
    let current = analysis;
    while (current) {
      if (current.declaredChannels && current.declaredChannels.has(name) && current !== skipDeclarationOwner) {
        return current;
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
    }
    return null;
  }

  getScopeOwner(analysis) {
    let current = analysis;
    while (current && !current.createScope) {
      current = current.parent;
    }
    return current || analysis;
  }

  getRootScopeOwner(analysis) {
    let current = analysis;
    while (current && current.parent) {
      current = current.parent;
    }
    return this.getScopeOwner(current || analysis);
  }

  isRootScopeOwner(analysis) {
    return this.getScopeOwner(analysis) === this.getRootScopeOwner(analysis);
  }

  isDeclarationRootOwned(analysis, name) {
    return this.findDeclarationOwner(analysis, name) === this.getRootScopeOwner(analysis);
  }

  isParentOwnedDeclarationRootOwned(analysis, name) {
    const parentDeclares = Array.isArray(analysis && analysis.declaresInParent)
      ? analysis.declaresInParent
      : [];
    const hasParentOwnedDecl = parentDeclares.some((decl) => decl && decl.parentOwned && decl.name === name);
    if (!hasParentOwnedDecl) {
      return false;
    }
    const parentOwner = analysis && analysis.parent ? this.getScopeOwner(analysis.parent) : null;
    return !!parentOwner && parentOwner === this.getRootScopeOwner(analysis);
  }

  _passesReadOnlyBoundary(currentScopeOwner, declarationOwner) {
    let current = currentScopeOwner;
    while (current && current !== declarationOwner) {
      if (current.parentReadOnly) {
        return true;
      }
      current = current.parent ? this.getScopeOwner(current.parent) : null;
    }
    return false;
  }

  getBaseChannelName(runtimeName) {
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
      analysis.declaredChannels = null;
    }

    for (let i = 0; i < nodesList.length; i++) {
      const analysis = nodesList[i]._analysis;
      if (!analysis) {
        continue;
      }
      const owner = this.getScopeOwner(analysis);

      // Most declarations are owned by the current scope owner. For example,
      // set/var statements and macro parameters become visible in the scope
      // introduced by the current node.
      const localDeclares = Array.isArray(analysis.declares) ? analysis.declares : [];
      for (let j = 0; j < localDeclares.length; j++) {
        const decl = localDeclares[j];
        if (!decl || !decl.name) {
          continue;
        }
        owner.declaredChannels = owner.declaredChannels || new Map();
        if (!owner.declaredChannels.has(decl.name)) {
          owner.declaredChannels.set(decl.name, this._cloneDeclaration(Object.assign({}, decl, {
            declarationOrigin: analysis
          })));
        }
      }

      // Some nodes introduce a declaration that is owned by the parent scope
      // instead of the current one. Macros are the main case: the macro name
      // is visible where the macro is declared, even though the macro body
      // itself gets its own scope owner.
      const parentDeclares = Array.isArray(analysis.declaresInParent) ? analysis.declaresInParent : [];
      if (parentDeclares.length > 0) {
        const parentOwner = analysis.parent ? this.getScopeOwner(analysis.parent) : null;
        if (parentOwner) {
          for (let j = 0; j < parentDeclares.length; j++) {
            const decl = parentDeclares[j];
            if (!decl || !decl.name) {
              continue;
            }
            parentOwner.declaredChannels = parentOwner.declaredChannels || new Map();
            if (!parentOwner.declaredChannels.has(decl.name)) {
              parentOwner.declaredChannels.set(decl.name, this._cloneDeclaration(Object.assign({}, decl, {
                declarationOrigin: analysis
              })));
            }
          }
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
    const registerDeclares = (declares, owner, declarationOrigin) => {
      if (!Array.isArray(declares) || declares.length === 0 || !owner) {
        return;
      }
      owner.declaredChannels = owner.declaredChannels || new Map();
      for (let i = 0; i < declares.length; i++) {
        const decl = declares[i];
        if (!decl || !decl.name) {
          continue;
        }
        this._validateReservedDeclarationName(analysis, decl);
        const currentScopeDecl = owner.declaredChannels.get(decl.name) || null;
        if (analysis.node.typename === 'Macro') {
          if (decl.parentOwned) {
            if (currentScopeDecl) {
              this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
            }
            let current = owner.parent;
            while (current) {
              if (current.declaredChannels && current.declaredChannels.has(decl.name)) {
                this._validateDeclarationConflict(analysis, decl, current.declaredChannels.get(decl.name));
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
          (analysis.node.typename === 'Set' || analysis.node.typename === 'ChannelDeclaration')) {
          if (currentScopeDecl && currentScopeDecl.declarationOrigin !== declarationOrigin) {
            this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
          }
          let current = owner.parent;
          while (current) {
            if (current.declaredChannels && current.declaredChannels.has(decl.name)) {
              this._validateDeclarationConflict(analysis, decl, current.declaredChannels.get(decl.name));
            }
            if (current.scopeBoundary) {
              break;
            }
            current = current.parent;
          }
        }
        if (!owner.declaredChannels.has(decl.name)) {
          owner.declaredChannels.set(decl.name, this._cloneDeclaration(Object.assign({}, decl, {
            declarationOrigin
          })));
        }
      }
    };

    registerDeclares(analysis.declares, this.getScopeOwner(analysis), analysis);

    if (Array.isArray(analysis.declaresInParent) && analysis.declaresInParent.length > 0) {
      const parentOwner = analysis.parent ? this.getScopeOwner(analysis.parent) : null;
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
          `Cannot declare channel '${decl.name}' because a variable with the same name is already declared`,
          lineno,
          colno,
          originNode || undefined
        );
      }
      this.compiler.fail(
        `Cannot declare channel '${decl.name}': already declared`,
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
      `Identifier '${decl.name}' is reserved and cannot be used as a variable or channel name.`,
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
    return Object.assign({}, decl);
  }

  _validateMutations(analysis) {
    if (!analysis) {
      return;
    }
    const scopeOwner = this.getScopeOwner(analysis);
    const currentTextChannel = this.getCurrentTextChannel(analysis);
    const localMutates = Array.isArray(analysis.mutates) ? analysis.mutates : [];
    for (let i = 0; i < localMutates.length; i++) {
      const name = localMutates[i];
      if (!name) {
        continue;
      }
      if (name && name.charAt(0) === '!') {
        continue;
      }
      if (name === currentTextChannel) {
        continue;
      }
      const declarationOwner = this.findDeclarationOwner(analysis, name);
      const declaration = this.findDeclaration(analysis, name);
      if (!declarationOwner || !declaration) {
        this._validateMissingDeclaration(analysis, name, 'mutation');
        continue;
      }
      if (declaration.type === 'sequential_path' || (name && name.charAt(0) === '!')) {
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
    if (!analysis) {
      return;
    }
    const currentTextChannel = this.getCurrentTextChannel(analysis);
    const localUses = Array.isArray(analysis.uses) ? analysis.uses : [];
    for (let i = 0; i < localUses.length; i++) {
      const name = localUses[i];
      if (!name) {
        continue;
      }
      if (name && name.charAt(0) === '!') {
        continue;
      }
      if (name === currentTextChannel) {
        continue;
      }
      if (!this.findDeclaration(analysis, name)) {
        this._validateMissingDeclaration(analysis, name, 'use');
      }
    }
  }

  _validateMissingDeclaration(analysis, name, accessType) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;

    if (originNode && originNode.typename === 'ChannelCommand') {
      this.compiler.fail(
        `Unsupported command target '${name}'. Commands must target declared channels (${CHANNEL_TYPES.join('/')}).`,
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
      `Channel '${name}' is read-only in this scope.`,
      lineno,
      colno,
      originNode || undefined
    );
  }

  _finalizeOutputUsage(node) {
    if (!node) {
      return {
        usedChannels: new Set(),
        mutatedChannels: new Set()
      };
    }
    if (Array.isArray(node)) {
      const aggregate = {
        usedChannels: new Set(),
        mutatedChannels: new Set()
      };
      node.forEach((child) => {
        const childAggregate = this._finalizeOutputUsage(child);
        childAggregate.usedChannels.forEach((name) => aggregate.usedChannels.add(name));
        childAggregate.mutatedChannels.forEach((name) => aggregate.mutatedChannels.add(name));
      });
      return aggregate;
    }
    if (!(node instanceof nodes.Node)) {
      return {
        usedChannels: new Set(),
        mutatedChannels: new Set()
      };
    }

    const analysis = node._analysis || {};
    const localUses = Array.isArray(analysis.uses) ? analysis.uses : [];
    const localMutates = Array.isArray(analysis.mutates) ? analysis.mutates : [];
    const usedChannels = new Set();
    const mutatedChannels = new Set();

    localUses.forEach((name) => {
      if (!name) {
        return;
      }
      usedChannels.add(name);
    });
    localMutates.forEach((name) => {
      if (!name) {
        return;
      }
      usedChannels.add(name);
      mutatedChannels.add(name);
    });

    node.fields.forEach((field) => {
      const childAggregate = this._finalizeOutputUsage(node[field]);
      childAggregate.usedChannels.forEach((name) => usedChannels.add(name));
      childAggregate.mutatedChannels.forEach((name) => mutatedChannels.add(name));
    });

    analysis.usedChannels = usedChannels.size > 0 ? usedChannels : null;
    analysis.mutatedChannels = mutatedChannels.size > 0 ? mutatedChannels : null;

    if (analysis.scopeBoundary) {
      return {
        usedChannels: new Set(),
        mutatedChannels: new Set()
      };
    }

    const declaredHere = analysis.declaredChannels instanceof Map ? analysis.declaredChannels : null;
    if (!declaredHere || declaredHere.size === 0) {
      return {
        usedChannels,
        mutatedChannels
      };
    }

    const parentUsedChannels = new Set(usedChannels);
    const parentMutatedChannels = new Set(mutatedChannels);

    declaredHere.forEach((_decl, name) => {
      if (!name) {
        return;
      }
      parentUsedChannels.delete(name);
      parentMutatedChannels.delete(name);
    });

    return {
      usedChannels: parentUsedChannels,
      mutatedChannels: parentMutatedChannels
    };
  }

  getCurrentTextChannel(analysis) {
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

export default CompileAnalysis;
