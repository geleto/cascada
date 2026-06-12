
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPES} from '../chain-types.js';

const FINALIZED_CHAIN_SET_FIELDS = [
  'usedChains',
  'mutatedChains',
  'usedChainsFromParent',
  'mutatedChainsFromParent',
  'linkedChains',
  'linkedMutatedChains'
];

/**
 * Chain analysis pass.
 *
 * This pass annotates AST nodes with `_analysis` metadata, validates scope
 * ownership, and derives declaration/use/mutation/link metadata for codegen.
 * Node analyzers seed local facts during the first walk. Post-analyzers run
 * after children in the finalization pass so custom nodes can aggregate
 * immediate child facts without walking whole subtrees.
 */
class CompileAnalysis {
  constructor(compiler) {
    this.compiler = compiler;
    this._declarationsFinalized = false;
  }

  run(rootNode) {
    // Analysis is single-shot per AST. Rerunning would merge stale per-node
    // `_analysis` maps from the prior pass into the fresh traversal.
    this._declarationsFinalized = false;
    if (!rootNode) {
      return;
    }

    this._walk(rootNode, null, null);
    this._finalizeDeclarations(rootNode);
    this._declarationsFinalized = true;
    this._finalizeChainUsage(rootNode);
  }

  _walk(node, parentNode, parentField) {
    this._forEachNode(node, (currentNode, currentParentNode, currentParentField) => {
      const analysis = this._initializeAnalysis(currentNode, currentParentNode, currentParentField);
      this._analyzeNode(currentNode);
      this.compiler._generateErrorContext(currentNode);
      this._registerDeclarations(analysis);
      this._validateUses(analysis);
      this._validateMutations(analysis);
    }, parentNode, parentField);
  }

  _forEachNode(node, visit, parentNode = null, parentField = null) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._forEachNode(node[i], visit, parentNode, parentField);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    visit(node, parentNode, parentField);
    node.fields.forEach((field) => {
      this._forEachNode(node[field], visit, node, field);
    });
  }

  _initializeAnalysis(node, parentNode, parentField) {
    const parentAnalysis = parentNode?._analysis ?? null;

    // Keep this base shape limited to cross-cutting analysis facts that this
    // pass owns or derives for many node types: scope/declaration ownership,
    // chain use/mutation/link metadata, and shared boundary state. Node-
    // specific facts such as declaration targets, sequential lookup details,
    // guard/import/caller/component metadata, etc. should be attached only by
    // the analyzer that owns that feature.
    //
    // Analysis facts are populated in two passes: node analyzers seed local
    // declarations/uses/boundary flags during the walk. Post-analyzers run
    // after child facts are ready and before this node's aggregate chain
    // footprint is derived.
    node._analysis = {
      node,
      createScope: false,
      scopeBoundary: false,
      // Meaningful only on scope owners: read-only mutation checks hop from
      // scope owner to scope owner and do not inspect intermediate nodes.
      parentReadOnly: false,
      textOutput: null,
      declares: [],
      declaresInParent: [],
      uses: [],
      mutates: [],
      // First-pass source-order lookup table. This is intentionally separate
      // from finalized scope ownership in `declaredChains`.
      sourceVisibleDeclarations: null,
      declaredChains: null,
      usedChains: null,
      mutatedChains: null,
      usedChainsFromParent: null,
      mutatedChainsFromParent: null,
      linkedChains: null,
      // Parent-owned linked chains this boundary may mutate. Future command-buffer
      // scheduling can use this to distinguish read-only child buffers.
      linkedMutatedChains: null,
      wantsLinkedChildBuffer: false,
      createsLinkedChildBuffer: false,
      createsScopeBuffer: false,
      expressionControlFlowBoundary: false,
      ...(node._analysis ?? {}),
      parent: parentAnalysis,
      inheritedSequenceFunCallLockKey:
        node._analysis?.inheritedSequenceFunCallLockKey ??
        parentAnalysis?.inheritedSequenceFunCallLockKey ??
        null
    };
    return node._analysis;
  }

  _analyzeNode(node) {
    const analyzerName = `analyze${node.typename}`;
    const analyzer = this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      const returned = analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        node.addAnalysis(returned);
      }
    }
  }

  _postAnalyzeNode(node) {
    const analyzerName = `postAnalyze${node.typename}`;
    const analyzer = this.compiler[analyzerName];
    if (typeof analyzer === 'function') {
      // Post-analyzers run after immediate children are finalized. They may
      // return node-owned custom facts and, narrowly, custom linked-chain
      // iterables. Custom linked-chain facts are return-only: finalization
      // checks the returned object for own linked fields before deriving
      // defaults. Writing them through node.addAnalysis() will be overwritten.
      // Finalization below normalizes linked-chain facts before codegen
      // observes them; ordinary uses/mutates belong to the first pass.
      const returned = analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        return returned;
      }
    }
    return null;
  }

  // Lifecycle: these read the finalized `*ChainsFromParent` facts, which only
  // exist after `_finalizeChainUsage` has run for the node. They are valid from
  // post-analyzers (children finalize before their parent) and from codegen.
  // First-pass analyzers must not call them — the facts are still null there.
  getChainsUsedFromParent(node) {
    const analysis = node?._analysis;
    return Array.from(analysis?.usedChainsFromParent ?? []);
  }

  getChainsMutatedFromParent(node) {
    const analysis = node?._analysis;
    return Array.from(analysis?.mutatedChainsFromParent ?? []);
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
    const declarations = owner ? this._getDeclarationMap(owner) : null;
    if (!declarations) {
      return null;
    }
    return declarations.get(name) || null;
  }

  markLookupDeclaration(node, name, analysis = node._analysis) {
    const declaration = this.findDeclaration(analysis, name);
    node.addAnalysis({ lookupDeclaration: declaration });
    return declaration;
  }

  findRootDeclaration(analysis, name) {
    const owner = this.getRootScopeOwner(analysis);
    const declarations = owner ? this._getDeclarationMap(owner) : null;
    if (!declarations) {
      return null;
    }
    return declarations.get(name) || null;
  }

  getRootNode(analysis) {
    let current = analysis;
    while (current.parent) {
      current = current.parent;
    }
    return current.node;
  }

  _installDeclaration(owner, decl, declarationOrigin, field = 'declaredChains') {
    const declarations = this._ensureDeclarationMap(owner, field);
    if (decl.shared) {
      if (!decl.declarationOrigin) {
        decl.declarationOrigin = this.getTopmostChildAnalysis(declarationOrigin);
      }
      declarations.set(decl.name, decl);
      this.compiler.inheritance.registerRootSharedDeclaration(owner, decl);
      return;
    }
    declarations.set(decl.name, { ...decl, declarationOrigin });
  }

  _ensureDeclarationMap(analysis, field) {
    analysis[field] = analysis[field] || new Map();
    return analysis[field];
  }

  _getDeclarationMap(analysis) {
    return this._declarationsFinalized
      ? analysis.declaredChains || null
      : analysis.sourceVisibleDeclarations || null;
  }

  getRootScopeOwner(analysis) {
    let current = analysis;
    while (current && current.parent) {
      current = current.parent;
    }
    return this._getScopeOwner(current);
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
      const declarations = this._getDeclarationMap(current);
      if (declarations && declarations.has(name) && current !== skipDeclarationOwner) {
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
    return current;
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
    // `declaredChains` is built only here; the walk populates the separate
    // `sourceVisibleDeclarations` table, so there is no stale finalized table
    // to reset before this pass.
    this._forEachNode(rootNode, (node) => {
      const analysis = node._analysis;
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
        const declarations = this._ensureDeclarationMap(owner, 'declaredChains');
        if (!declarations.has(decl.name)) {
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
            const declarations = this._ensureDeclarationMap(parentOwner, 'declaredChains');
            if (!declarations.has(decl.name)) {
              this._installDeclaration(parentOwner, decl, analysis);
            }
          }
        }
      }
    });
  }

  _registerDeclarations(analysis) {
    this._registerSourceDeclarations(analysis, analysis.declares, this._getScopeOwner(analysis), analysis);

    if (analysis.declaresInParent.length > 0) {
      const parentOwner = analysis.parent ? this._getScopeOwner(analysis.parent) : null;
      this._registerSourceDeclarations(analysis, analysis.declaresInParent, parentOwner, analysis);
    }
  }

  _registerSourceDeclarations(analysis, declares, owner, declarationOrigin) {
    if (declares.length === 0 || !owner) {
      return;
    }
    const declarations = this._ensureDeclarationMap(owner, 'sourceVisibleDeclarations');
    for (let i = 0; i < declares.length; i++) {
      const decl = declares[i];
      if (!decl || !decl.name) {
        continue;
      }
      this._validateReservedDeclarationName(analysis, decl);
      const currentScopeDecl = declarations.get(decl.name) || null;
      this._validateSourceDeclarationConflict(analysis, owner, decl, currentScopeDecl);
      if (!declarations.has(decl.name)) {
        this._installDeclaration(owner, decl, declarationOrigin, 'sourceVisibleDeclarations');
      }
    }
  }

  _validateSourceDeclarationConflict(analysis, owner, decl, currentScopeDecl) {
    if (decl.internal || decl.explicit === false) {
      return;
    }

    if (currentScopeDecl) {
      this._validateDeclarationConflict(analysis, decl, currentScopeDecl);
      return;
    }

    if (owner.scopeBoundary) {
      return;
    }

    this._validateAncestorDeclarationConflicts(analysis, owner, decl);
  }

  _validateAncestorDeclarationConflicts(analysis, owner, decl) {
    let current = owner.parent;
    while (current) {
      const visibleDeclarations = current.sourceVisibleDeclarations;
      const conflictingDecl = visibleDeclarations ? visibleDeclarations.get(decl.name) : null;
      if (conflictingDecl && !conflictingDecl.internal) {
        this._validateDeclarationConflict(analysis, decl, conflictingDecl);
      }
      if (current.scopeBoundary) {
        break;
      }
      current = current.parent;
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
    if (!this.compiler.isReservedDeclaration(decl)) {
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

  _validateMutations(analysis) {
    const scopeOwner = this._getScopeOwner(analysis);
    const currentTextChain = this.getCurrentTextChain(analysis);
    const localMutates = analysis.mutates;
    for (let i = 0; i < localMutates.length; i++) {
      const name = localMutates[i];
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
        continue;
      }
      const declarationOwner = this.findDeclarationOwner(analysis, name);
      const declaration = declarationOwner
        ? this._getDeclarationMap(declarationOwner).get(name)
        : null;
      if (!declaration) {
        const rootDeclaration = this.findRootDeclaration(analysis, name);
        if (rootDeclaration && rootDeclaration.shared) {
          continue;
        }
        this._validateMissingDeclaration(analysis, name, 'mutation');
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
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
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

  _shouldSkipChainAccessValidation(name, currentTextChain) {
    return !name || name.charAt(0) === '!' || name === currentTextChain;
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
      return this._createChainUsageAggregate();
    }
    if (Array.isArray(node)) {
      const aggregate = this._createChainUsageAggregate();
      node.forEach((child) => {
        const childAggregate = this._finalizeChainUsage(child);
        this._mergeChainUsage(aggregate, childAggregate);
      });
      return aggregate;
    }
    if (!(node instanceof nodes.Node)) {
      return this._createChainUsageAggregate();
    }

    const analysis = node._analysis;
    const childUsage = this._createChainUsageAggregate();

    // Children finalize first, so post-analyzers can inspect immediate child facts.
    node.fields.forEach((field) => {
      const childAggregate = this._finalizeChainUsage(node[field]);
      this._mergeChainUsage(childUsage, childAggregate);
    });

    const postAnalysisFacts = this._postAnalyzeNode(node);
    if (postAnalysisFacts) {
      node.addAnalysis(postAnalysisFacts);
    }

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
    childUsage.usedChains.forEach((name) => usedChains.add(name));
    childUsage.mutatedChains.forEach((name) => mutatedChains.add(name));

    analysis.usedChains = usedChains.size > 0 ? usedChains : null;
    analysis.mutatedChains = mutatedChains.size > 0 ? mutatedChains : null;
    const declaredHere = analysis.declaredChains;
    const chainsFromParent = this._deriveChainsFromParent(usedChains, mutatedChains, declaredHere);
    const hasCustomLinkedChains = !!(
      postAnalysisFacts &&
      Object.prototype.hasOwnProperty.call(postAnalysisFacts, 'linkedChains')
    );
    const hasCustomLinkedMutatedChains = !!(
      postAnalysisFacts &&
      Object.prototype.hasOwnProperty.call(postAnalysisFacts, 'linkedMutatedChains')
    );
    analysis.usedChainsFromParent = chainsFromParent.usedChains.size > 0 ? chainsFromParent.usedChains : null;
    analysis.mutatedChainsFromParent = chainsFromParent.mutatedChains.size > 0 ? chainsFromParent.mutatedChains : null;
    if (!hasCustomLinkedChains) {
      analysis.linkedChains = this._deriveBoundaryLinkedChains(analysis, chainsFromParent.usedChains);
    }
    if (!hasCustomLinkedMutatedChains) {
      analysis.linkedMutatedChains = this._deriveBoundaryLinkedChains(analysis, chainsFromParent.mutatedChains);
    }
    analysis.linkedChains = this._normalizeChainSet(analysis.linkedChains, 'linkedChains', analysis);
    analysis.linkedMutatedChains = this._normalizeChainSet(analysis.linkedMutatedChains, 'linkedMutatedChains', analysis);
    this._finalizeBufferCreation(analysis);
    this._assertFinalizedChainSetFields(analysis);
    return this._getPropagatedChainUsage(
      analysis,
      localUses,
      localMutates,
      chainsFromParent
    );
  }

  _createChainUsageAggregate() {
    return {
      usedChains: new Set(),
      mutatedChains: new Set()
    };
  }

  _mergeChainUsage(target, source) {
    source.usedChains.forEach((name) => target.usedChains.add(name));
    source.mutatedChains.forEach((name) => target.mutatedChains.add(name));
  }

  _deriveChainsFromParent(usedChains, mutatedChains, declaredChains) {
    const parentUsage = {
      usedChains: new Set(usedChains),
      mutatedChains: new Set(mutatedChains)
    };
    if (declaredChains) {
      declaredChains.forEach((_decl, name) => {
        parentUsage.usedChains.delete(name);
        parentUsage.mutatedChains.delete(name);
      });
    }
    return parentUsage;
  }

  _getPropagatedChainUsage(analysis, localUses, localMutates, chainsFromParent) {
    // This is the read-only footprint this node contributes to its parent,
    // not the parent-visible footprint this node consumes from its parent.
    if (analysis.scopeBoundary) {
      const nodeType = analysis.node && analysis.node.typename;
      const isMethodOrBlockBoundary = nodeType === 'Block' || nodeType === 'MethodDefinition';
      if (!isMethodOrBlockBoundary) {
        return this._createChainUsageAggregate();
      }
      const parentUsage = this._createChainUsageAggregate();
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
      return this._deriveChainsFromParent(
        parentUsage.usedChains,
        parentUsage.mutatedChains,
        analysis.declaredChains
      );
    }
    return chainsFromParent;
  }

  _deriveBoundaryLinkedChains(analysis, chainsFromParent) {
    if (!this._wantsLinkableChildBuffer(analysis)) {
      return null;
    }
    const linkedChains = new Set();
    chainsFromParent.forEach((name) => {
      linkedChains.add(name);
    });
    return linkedChains.size > 0 ? linkedChains : null;
  }

  _normalizeChainSet(value, field, analysis) {
    if (value == null) {
      return null;
    }
    const chains = new Set();
    const addChainName = (name) => this._addNormalizedChainName(chains, name, field, analysis);
    if (typeof value === 'string') {
      this._throwInvalidChainSet(value, field, analysis);
    }
    if (value instanceof Map) {
      this._throwInvalidChainSet(value, field, analysis);
    }
    if (typeof value.forEach === 'function') {
      value.forEach(addChainName);
    } else if (typeof value[Symbol.iterator] === 'function') {
      for (const name of value) {
        addChainName(name);
      }
    } else {
      this._throwInvalidChainSet(value, field, analysis);
    }
    return chains.size > 0 ? chains : null;
  }

  _addNormalizedChainName(chains, name, field, analysis) {
    if (typeof name !== 'string' || name === '') {
      this._throwInvalidChainName(name, field, analysis);
    }
    chains.add(name);
  }

  // Lightweight always-on shape guard: every finalized chain-set fact must be
  // `Set | null` so codegen never observes a stray array/iterable. This is a
  // cheap per-field check; chain-name validity is enforced once at the
  // `_normalizeChainSet` boundary where untrusted custom facts enter, and the
  // internally built `used`/`mutated` sets are strings by construction.
  _assertFinalizedChainSetFields(analysis) {
    FINALIZED_CHAIN_SET_FIELDS.forEach((field) => {
      const value = analysis[field];
      if (value !== null && !(value instanceof Set)) {
        throw new TypeError(
          `Finalized analysis fact '${field}' on ${this._describeAnalysisNode(analysis)} must be Set or null`
        );
      }
    });
  }

  _throwInvalidChainSet(value, field, analysis) {
    throw new TypeError(
      `Analysis fact '${field}' on ${this._describeAnalysisNode(analysis)} must be a Set, array, or iterable collection of chain names; got ${this._describeValue(value)}`
    );
  }

  _throwInvalidChainName(name, field, analysis) {
    throw new TypeError(
      `Analysis fact '${field}' on ${this._describeAnalysisNode(analysis)} contains an invalid chain name (${this._describeValue(name)})`
    );
  }

  _describeAnalysisNode(analysis) {
    const node = analysis && analysis.node;
    if (!node) {
      return 'unknown node';
    }
    return `${node.typename || node.constructor.name} at ${node.lineno}:${node.colno}`;
  }

  _describeValue(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value instanceof Map) {
      return 'Map';
    }
    return typeof value;
  }

  _wantsLinkableChildBuffer(analysis) {
    // Broader than `wantsLinkedChildBuffer`: guard recovery scope buffers also
    // need derived parent links even though they are not ordinary child-buffer
    // intent sites.
    return !!(
      analysis &&
      analysis.parent &&
      (analysis.wantsLinkedChildBuffer || analysis.createsScopeBuffer)
    );
  }

  _finalizeBufferCreation(analysis) {
    analysis.createsLinkedChildBuffer = this._shouldCreateLinkedChildBuffer(analysis);
    if (!this._createsLinkableChildBuffer(analysis)) {
      analysis.linkedChains = null;
      analysis.linkedMutatedChains = null;
    }
  }

  _shouldCreateLinkedChildBuffer(analysis) {
    if (!analysis.parent || !analysis.wantsLinkedChildBuffer) {
      return false;
    }
    if (!analysis.expressionControlFlowBoundary) {
      return true;
    }
    return analysis.linkedMutatedChains !== null;
  }

  _createsLinkableChildBuffer(analysis) {
    // Broader than `createsLinkedChildBuffer`: guard recovery scope buffers are
    // linkable even though the ordinary linked-child-buffer outcome is false.
    return !!(analysis && (analysis.createsLinkedChildBuffer || analysis.createsScopeBuffer));
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
