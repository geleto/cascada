
import * as nodes from '../language/nodes.js';
import {CHAIN_TYPES} from '../chain-types.js';
import {isChainDeclaration, isImmutableDeclaration, isVarChainDeclaration} from './declarations.js';

/**
 * Chain analysis pass.
 *
 * This pass annotates AST nodes with `_analysis` metadata, validates scope
 * ownership, and derives declaration/observation/mutation/use/link metadata for codegen.
 * Node analyzers seed local facts during the first walk. Post-analyzers run
 * after children in the finalization pass so custom nodes can aggregate
 * immediate child facts without walking whole subtrees.
 */
class CompileAnalysis {
  constructor(compiler) {
    this.compiler = compiler;
    this._compilerHandlers = {
      analyze: new Map(),
      postAnalyze: new Map(),
      compile: new Map()
    };
  }

  registerCompiler(owner) {
    const handlersToRegister = [];
    this._getCompilerMethodNames(owner).forEach((methodName) => {
      const match = /^(postAnalyze|analyze|compile)([A-Z].*)$/.exec(methodName);
      if (!match) {
        return;
      }
      const phase = match[1];
      const nodeType = match[2];
      if (!(nodeType in nodes)) {
        return;
      }
      handlersToRegister.push({ phase, nodeType, methodName });
    });

    handlersToRegister.forEach(({ phase, nodeType, methodName }) => {
      const handlers = this._compilerHandlers[phase];
      const existing = handlers.get(nodeType);
      if (existing) {
        throw new TypeError(
          `Duplicate ${phase} handler for ${nodeType}: ` +
          `${this._describeCompilerHandler(existing)} and ${this._describeCompilerOwner(owner)}.${methodName}`
        );
      }
      handlers.set(nodeType, { owner, methodName });
    });
    return owner;
  }

  getCompilerMethod(phase, nodeType) {
    return this._compilerHandlers[phase]?.get(nodeType) ?? null;
  }

  callCompilerMethod(handler, ...args) {
    return handler.owner[handler.methodName].call(handler.owner, ...args);
  }

  _getCompilerMethodNames(owner) {
    const names = new Set();
    let current = owner;
    while (current && current !== Object.prototype) {
      Object.getOwnPropertyNames(current).forEach((name) => {
        if (name !== 'constructor') {
          names.add(name);
        }
      });
      current = Object.getPrototypeOf(current);
    }
    return Array.from(names);
  }

  _describeCompilerHandler(handler) {
    return `${this._describeCompilerOwner(handler.owner)}.${handler.methodName}`;
  }

  _describeCompilerOwner(owner) {
    return owner?.constructor?.name || 'unknown compiler';
  }

  run(rootNode) {
    // Analysis is single-shot per AST. Rerunning would merge stale per-node
    // `_analysis` maps from the prior pass into the fresh traversal.
    if (!rootNode) {
      return;
    }

    this._walk(rootNode);
    this._finalizeDeclarations(rootNode);
    this._finalizeChainUsage(rootNode);
  }

  _walk(node, parentNode = null, parentField = null, visibleDeclarations = new Map(), scopeOwner = null) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this._walk(node[i], parentNode, parentField, visibleDeclarations, scopeOwner);
      }
      return;
    }
    if (!(node instanceof nodes.Node)) {
      return;
    }

    const analysis = this._initializeAnalysis(node, parentNode, parentField);
    analysis.visibleDeclarations = new Map(visibleDeclarations);
    this._analyzeNode(node);
    this._validateAnalysisFacts(analysis);
    this.compiler._generateErrorContext(node);

    const ownsScope = !!analysis.createScope;
    const currentScopeOwner = ownsScope ? analysis : scopeOwner;
    const childVisibleDeclarations = ownsScope
      ? this._createScopeVisibleDeclarations(visibleDeclarations, analysis)
      : visibleDeclarations;
    if (ownsScope) {
      analysis.activeVisibleDeclarations = childVisibleDeclarations;
    }

    this._validateDeclarations(analysis, analysis.declareOnEnter, currentScopeOwner, childVisibleDeclarations);
    this._publishDeclarations(analysis, analysis.declareOnEnter, currentScopeOwner, childVisibleDeclarations);
    this._validateDeclarations(analysis, analysis.declareOnExit, currentScopeOwner, childVisibleDeclarations);
    if (analysis.declareInParentOnExit.length > 0 && scopeOwner) {
      this._validateDeclarations(analysis, analysis.declareInParentOnExit, scopeOwner, visibleDeclarations);
      // Parent-owned declarations, such as macro/function names, are visible
      // inside the declaring node for self-reference, but only become visible
      // to later parent-scope source after the node exits.
      this._publishDeclarations(analysis, analysis.declareInParentOnExit, scopeOwner, childVisibleDeclarations);
    }
    analysis.visibleDeclarations = new Map(childVisibleDeclarations);

    this._validateObservations(analysis);
    this._validateMutations(analysis);

    node.fields.forEach((field) => {
      this._walk(node[field], node, field, childVisibleDeclarations, currentScopeOwner);
    });

    this._publishDeclarations(analysis, analysis.declareOnExit, currentScopeOwner, childVisibleDeclarations);
    if (analysis.declareInParentOnExit.length > 0 && scopeOwner) {
      this._publishDeclarations(analysis, analysis.declareInParentOnExit, scopeOwner, visibleDeclarations);
    }
    if (ownsScope) {
      analysis.activeVisibleDeclarations = null;
    }
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
    const previousAnalysis = node._analysis ?? {};

    // Keep this base shape limited to cross-cutting analysis facts that this
    // pass owns or derives for many node types: scope/declaration ownership,
    // chain use/mutation/link metadata, and shared boundary state. Node-
    // specific facts such as declaration targets, sequential lookup details,
    // guard/import/caller/component metadata, etc. should be attached only by
    // the analyzer that owns that feature.
    //
    // Analysis facts are populated in two passes: node analyzers seed local
    // declarations/observations/mutations/boundary flags during the walk. Post-analyzers run
    // after child facts are ready and before this node's aggregate chain
    // footprint is derived.
    node._analysis = {
      node,
      // `createScope` marks a lexical scope whose async commands are backed by
      // a child CommandBuffer: either the owner node's control-flow boundary or
      // an explicit `withScopeCommandBuffer`. Do not reintroduce a parallel
      // "creates scope buffer" flag.
      createScope: false,
      // Clean scopes, such as macros, do not implicitly link parent lanes.
      // Non-clean scope buffers may still derive parent links from ordinary
      // observed/mutated facts.
      scopeBoundary: false,
      // Meaningful only on scope owners: read-only mutation checks hop from
      // scope owner to scope owner and do not inspect intermediate nodes.
      parentReadOnly: false,
      textOutput: null,
      declareOnEnter: [],
      declareOnExit: [],
      declareInParentOnExit: [],
      observes: [],
      mutates: [],
      // Finalized declarations owned by this scope. This is for aggregation,
      // export/ownership, and parent-chain derivation only. It is not a
      // source lookup table; it may include declarations that were not visible
      // at a given source point. Use `visibleDeclarations` through
      // `findSourceDeclaration` for source meaning.
      declaredChains: null,
      observedChains: null,
      usedChains: null,
      mutatedChains: null,
      observedChainsFromParent: null,
      usedChainsFromParent: null,
      mutatedChainsFromParent: null,
      boundaryLinkedChains: null,
      boundaryLinkedObservedChains: null,
      // Parent-owned linked chains this boundary may mutate. Future command-buffer
      // command-buffer lane runners can use this to distinguish read-only child buffers.
      boundaryLinkedMutatedChains: null,
      wantsLinkedChildBuffer: false,
      createsLinkedChildBuffer: false,
      expressionControlFlowBoundary: false,
      ...previousAnalysis,
      // Immutable snapshot of declarations visible at this exact source point.
      // Ordinary identifier resolution should use this, not `declaredChains`.
      visibleDeclarations: null,
      activeVisibleDeclarations: null,
      parent: parentAnalysis,
      inheritedSequenceFunCallLockKey:
        previousAnalysis.inheritedSequenceFunCallLockKey ??
        parentAnalysis?.inheritedSequenceFunCallLockKey ??
        null
    };
    return node._analysis;
  }

  _analyzeNode(node) {
    const analyzerName = `analyze${node.typename}`;
    const handler = this.getCompilerMethod('analyze', node.typename);
    const analyzer = handler ? null : this.compiler[analyzerName];
    if (handler || typeof analyzer === 'function') {
      const returned = handler
        ? this.callCompilerMethod(handler, node, this)
        : analyzer.call(this.compiler, node, this);
      if (returned && typeof returned === 'object' && returned !== node._analysis) {
        this._validateReturnedAnalysisFacts(node._analysis, returned);
        node.addAnalysis(returned);
      }
    }
  }

  _postAnalyzeNode(node) {
    const analyzerName = `postAnalyze${node.typename}`;
    const handler = this.getCompilerMethod('postAnalyze', node.typename);
    const analyzer = handler ? null : this.compiler[analyzerName];
    if (handler || typeof analyzer === 'function') {
      // Post-analyzers run after immediate children are finalized. They may
      // return node-owned custom facts. Boundary-linked facts are derived
      // during finalization from ordinary observes/mutates/declaration facts.
      const returned = handler
        ? this.callCompilerMethod(handler, node, this)
        : analyzer.call(this.compiler, node, this);
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
    const analysis = node._analysis;
    if (!analysis || !analysis.usedChainsFromParent) {
      return [];
    }
    return Array.from(analysis.usedChainsFromParent);
  }

  getChainsObservedFromParent(node) {
    const analysis = node._analysis;
    if (!analysis || !analysis.observedChainsFromParent) {
      return [];
    }
    return Array.from(analysis.observedChainsFromParent);
  }

  getChainsMutatedFromParent(node) {
    const analysis = node._analysis;
    if (!analysis || !analysis.mutatedChainsFromParent) {
      return [];
    }
    return Array.from(analysis.mutatedChainsFromParent);
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

  // Source meaning lookup. This intentionally reads the source-point visibility
  // snapshot rather than finalized scope-owned declarations.
  findSourceDeclaration(analysis, name) {
    return analysis.visibleDeclarations?.get(name) || null;
  }

  recordSourceLookupDeclaration(node, name, analysis = node._analysis) {
    const declaration = this.findSourceDeclaration(analysis, name);
    node.addAnalysis({ lookupDeclaration: declaration });
    return declaration;
  }

  findLocalUsageDeclaration(analysis, name) {
    if (!name) {
      return null;
    }
    const sourceDeclaration = this.findSourceDeclaration(analysis, name);
    if (sourceDeclaration) {
      return sourceDeclaration;
    }
    // On-exit declarations are intentionally not source-visible to their own
    // initializer/body children, but the declaration statement itself may carry
    // usage facts for its target, such as `var x = ...` or `set x = ...`.
    return analysis.declareOnExit.find((decl) => decl.name === name) || null;
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
    decl.declarationOwner = owner;
    if (decl.shared) {
      if (!decl.declarationOrigin) {
        decl.declarationOrigin = this.getTopmostChildAnalysis(declarationOrigin);
      }
      declarations.set(decl.name, decl);
      this.compiler.inheritance.recordRootSharedDeclaration(owner, decl);
      return;
    }
    decl.declarationOrigin = declarationOrigin;
    declarations.set(decl.name, decl);
  }

  _ensureDeclarationMap(analysis, field) {
    analysis[field] = analysis[field] || new Map();
    return analysis[field];
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

  _createScopeVisibleDeclarations(parentVisibleDeclarations, analysis) {
    if (!analysis.scopeBoundary) {
      return new Map(parentVisibleDeclarations);
    }
    if (!(analysis.node instanceof nodes.Macro)) {
      return new Map();
    }
    const visibleDeclarations = new Map();
    parentVisibleDeclarations.forEach((declaration, name) => {
      if (declaration.isMacro) {
        visibleDeclarations.set(name, declaration);
      }
    });
    return visibleDeclarations;
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
    const hasParentOwnedDecl = analysis.declareInParentOnExit.some((decl) => decl.parentOwned && decl.name === name);
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
    this._forEachNode(rootNode, (node) => {
      const analysis = node._analysis;
      const owner = this._getScopeOwner(analysis);
      this._recordOwnedDeclarations(analysis, analysis.declareOnEnter, owner);
      this._recordOwnedDeclarations(analysis, analysis.declareOnExit, owner);
      if (analysis.declareInParentOnExit.length > 0) {
        const parentOwner = analysis.parent ? this._getScopeOwner(analysis.parent) : null;
        this._recordOwnedDeclarations(analysis, analysis.declareInParentOnExit, parentOwner);
      }
    });
  }

  _recordOwnedDeclarations(analysis, declarationsToRecord, owner) {
    if (declarationsToRecord.length === 0 || !owner) {
      return;
    }
    // Build the finalized owner inventory only after source-point validation.
    // Do not use this map to resolve source occurrences.
    const declarations = this._ensureDeclarationMap(owner, 'declaredChains');
    for (let i = 0; i < declarationsToRecord.length; i++) {
      const declaration = declarationsToRecord[i];
      if (!declarations.has(declaration.name)) {
        this._installDeclaration(owner, declaration, analysis);
      }
    }
  }

  _validateDeclarations(analysis, declarationsToValidate, owner, visibleDeclarations) {
    if (declarationsToValidate.length === 0 || !owner) {
      return;
    }
    const declaredInBatch = new Map();
    for (let i = 0; i < declarationsToValidate.length; i++) {
      const decl = declarationsToValidate[i];
      decl.declarationOwner = owner;
      if (!decl.declarationOrigin) {
        decl.declarationOrigin = decl.shared
          ? this.getTopmostChildAnalysis(analysis)
          : analysis;
      }
      this._validateReservedDeclarationName(analysis, decl);
      const visibleDeclaration = declaredInBatch.get(decl.name) ||
        visibleDeclarations.get(decl.name) ||
        null;
      this._validateSourceDeclarationConflict(analysis, owner, decl, visibleDeclaration);
      declaredInBatch.set(decl.name, decl);
    }
  }

  _publishDeclarations(analysis, declarationsToPublish, owner, visibleDeclarations) {
    if (declarationsToPublish.length === 0 || !owner) {
      return;
    }
    for (let i = 0; i < declarationsToPublish.length; i++) {
      const declaration = declarationsToPublish[i];
      declaration.declarationOrigin = declaration.declarationOrigin || analysis;
      declaration.declarationOwner = owner;
      visibleDeclarations.set(declaration.name, declaration);
      if (declaration.shared) {
        this.compiler.inheritance.recordRootSharedDeclaration(owner, declaration);
      }
    }
  }

  _validateSourceDeclarationConflict(analysis, owner, decl, visibleDeclaration) {
    if (decl.internal || decl.explicit === false) {
      return;
    }

    if (visibleDeclaration?.declarationOwner === owner) {
      this._validateDeclarationConflict(analysis, decl, visibleDeclaration);
      return;
    }

    if (owner.scopeBoundary) {
      return;
    }

    if (visibleDeclaration && !visibleDeclaration.internal) {
      this._validateDeclarationConflict(analysis, decl, visibleDeclaration);
    }
  }

  _validateDeclarationConflict(analysis, decl, conflictingDecl) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;

    if (isChainDeclaration(decl) && !isVarChainDeclaration(decl)) {
      if (isVarChainDeclaration(conflictingDecl)) {
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

  _validateAnalysisFacts(analysis) {
    if (analysis.uses) {
      this._failUnsupportedAnalysisFact(
        analysis,
        'uses',
        '\'observes\', \'mutates\', \'declareOnEnter\', or \'declareOnExit\''
      );
    }
    if (analysis.declares) {
      this._failUnsupportedAnalysisFact(analysis, 'declares', '\'declareOnEnter\' or \'declareOnExit\'');
    }
    if (analysis.declaresInParent) {
      this._failUnsupportedAnalysisFact(analysis, 'declaresInParent', '\'declareInParentOnExit\'');
    }
    if (analysis.linkedChains) {
      this._failUnsupportedAnalysisFact(analysis, 'linkedChains', '\'boundaryLinkedChains\'');
    }
    if (analysis.linkedMutatedChains) {
      this._failUnsupportedAnalysisFact(analysis, 'linkedMutatedChains', '\'boundaryLinkedMutatedChains\'');
    }
  }

  _validateReturnedAnalysisFacts(analysis, facts) {
    if (facts.boundaryLinkedChains) {
      this._failUnsupportedAnalysisFact(
        analysis,
        'boundaryLinkedChains',
        '\'observes\', \'mutates\', \'declareOnEnter\', or \'declareOnExit\''
      );
    }
    if (facts.boundaryLinkedObservedChains) {
      this._failUnsupportedAnalysisFact(analysis, 'boundaryLinkedObservedChains', '\'observes\'');
    }
    if (facts.boundaryLinkedMutatedChains) {
      this._failUnsupportedAnalysisFact(analysis, 'boundaryLinkedMutatedChains', '\'mutates\'');
    }
  }

  addCommandFacts(node, { observed = null, mutated = null } = {}) {
    const facts = {};
    if (observed) {
      facts.observes = this._mergeChainNameLists(
        node._analysis?.observes,
        observed
      );
    }
    if (mutated) {
      facts.mutates = this._mergeChainNameLists(
        node._analysis?.mutates,
        mutated
      );
    }
    node.addAnalysis(facts);
  }

  _mergeChainNameLists(...groups) {
    const names = new Set();
    groups.forEach((group) => {
      if (!group) {
        return;
      }
      group.forEach((name) => {
        if (name) {
          names.add(name);
        }
      });
    });
    return names.size > 0 ? Array.from(names) : null;
  }

  _failUnsupportedAnalysisFact(analysis, field, replacement) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;
    this.compiler.fail(
      `Analysis fact '${field}' is no longer supported. Use ${replacement} instead.`,
      lineno,
      colno,
      originNode || undefined
    );
  }

  _validateMutations(analysis) {
    const scopeOwner = this._getScopeOwner(analysis);
    const rootDeclarations = this.getRootScopeOwner(analysis).activeVisibleDeclarations;
    const currentTextChain = this.getCurrentTextChain(analysis);
    const localMutates = analysis.mutates;
    for (let i = 0; i < localMutates.length; i++) {
      const name = localMutates[i];
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
        continue;
      }
      const declaration = this.findLocalUsageDeclaration(analysis, name);
      if (!declaration) {
        const rootDeclaration = rootDeclarations ? rootDeclarations.get(name) : null;
        if (rootDeclaration && rootDeclaration.shared) {
          continue;
        }
        this._validateMissingDeclaration(analysis, name, 'mutation');
        continue;
      }
      if (declaration.shared) {
        continue;
      }
      if (isImmutableDeclaration(declaration)) {
        this._failImmutableMutation(analysis, name, declaration);
        continue;
      }
      const declarationOwner = declaration.declarationOwner;
      if (!this._passesReadOnlyBoundary(scopeOwner, declarationOwner)) {
        continue;
      }
      this._validateReadOnlyMutation(analysis, name, declaration);
    }
  }

  _validateObservations(analysis) {
    const rootDeclarations = this.getRootScopeOwner(analysis).activeVisibleDeclarations;
    const currentTextChain = this.getCurrentTextChain(analysis);
    const localObserves = analysis.observes;
    for (let i = 0; i < localObserves.length; i++) {
      const name = localObserves[i];
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
        continue;
      }
      if (!this.findSourceDeclaration(analysis, name)) {
        const rootDeclaration = rootDeclarations ? rootDeclarations.get(name) : null;
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

    if (isVarChainDeclaration(declaration)) {
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

  _failImmutableMutation(analysis, name, declaration) {
    const originNode = analysis.node || null;
    const lineno = originNode && originNode.lineno;
    const colno = originNode && originNode.colno;
    const category = declaration.imported ? 'import binding' : 'macro/function declaration';
    this.compiler.fail(
      `Cannot assign to ${category} '${name}'.`,
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
      this._validateReturnedAnalysisFacts(analysis, postAnalysisFacts);
      node.addAnalysis(postAnalysisFacts);
      this._validateAnalysisFacts(analysis);
    }

    const localObserves = analysis.observes;
    const localMutates = analysis.mutates;
    const usage = this._createChainUsageAggregate();

    // Derived direct storage is not decided yet: this fold is still assembling
    // the mutation facts that later storage derivation will use. At this point
    // only intrinsic immutable declarations (macros/imports) are known to have
    // no lane, so this pre-derivation filter intentionally uses
    // isImmutableDeclaration rather than isStoredDirectly. Phase 3 will derive
    // read-only var storage after mutation aggregation, then purge/update the
    // aggregate chain facts with the final storage predicate.
    localObserves.forEach((name) => {
      const declaration = this.findLocalUsageDeclaration(analysis, name);
      if (!isImmutableDeclaration(declaration)) {
        this._addChainObservation(usage, name);
      }
    });
    localMutates.forEach((name) => {
      const declaration = this.findLocalUsageDeclaration(analysis, name);
      if (isImmutableDeclaration(declaration)) {
        // First-walk validation catches ordinary source mutations. Keep this
        // final guard for mutation facts added by post-analyzers after that pass.
        this._failImmutableMutation(analysis, name, declaration);
      }
      this._addChainMutation(usage, name);
    });
    this._mergeChainUsage(usage, childUsage);
    const declaredHere = analysis.declaredChains;
    if (declaredHere) {
      declaredHere.forEach((decl, name) => {
        if (!isImmutableDeclaration(decl)) {
          this._addBroadChainUse(usage, name);
        }
      });
    }

    analysis.observedChains = usage.observedChains.size > 0 ? usage.observedChains : null;
    analysis.usedChains = usage.usedChains.size > 0 ? usage.usedChains : null;
    analysis.mutatedChains = usage.mutatedChains.size > 0 ? usage.mutatedChains : null;
    const scopeChainsFromParent = this._deriveChainsFromParent(usage, declaredHere);
    analysis.observedChainsFromParent = scopeChainsFromParent.observedChains.size > 0 ? scopeChainsFromParent.observedChains : null;
    analysis.usedChainsFromParent = scopeChainsFromParent.usedChains.size > 0 ? scopeChainsFromParent.usedChains : null;
    analysis.mutatedChainsFromParent = scopeChainsFromParent.mutatedChains.size > 0 ? scopeChainsFromParent.mutatedChains : null;
    analysis.boundaryLinkedChains = this._deriveBoundaryLinkedChains(analysis, scopeChainsFromParent.usedChains);
    analysis.boundaryLinkedObservedChains = this._deriveBoundaryLinkedChains(analysis, scopeChainsFromParent.observedChains);
    analysis.boundaryLinkedMutatedChains = this._deriveBoundaryLinkedChains(analysis, scopeChainsFromParent.mutatedChains);
    analysis.boundaryLinkedChains = this._normalizeChainSet(analysis.boundaryLinkedChains, 'boundaryLinkedChains', analysis);
    analysis.boundaryLinkedObservedChains = this._normalizeChainSet(analysis.boundaryLinkedObservedChains, 'boundaryLinkedObservedChains', analysis);
    analysis.boundaryLinkedMutatedChains = this._normalizeChainSet(analysis.boundaryLinkedMutatedChains, 'boundaryLinkedMutatedChains', analysis);
    this._finalizeBufferCreation(analysis);
    return this._getPropagatedChainUsage(
      analysis,
      localObserves,
      localMutates,
      scopeChainsFromParent
    );
  }

  _createChainUsageAggregate() {
    return {
      observedChains: new Set(),
      usedChains: new Set(),
      mutatedChains: new Set()
    };
  }

  _mergeChainUsage(target, source) {
    source.usedChains.forEach((name) => this._addBroadChainUse(target, name));
    source.observedChains.forEach((name) => this._addChainObservation(target, name));
    source.mutatedChains.forEach((name) => this._addChainMutation(target, name));
  }

  _addChainObservation(usage, name) {
    if (name) {
      usage.observedChains.add(name);
      this._addBroadChainUse(usage, name);
    }
  }

  _addChainMutation(usage, name) {
    if (name) {
      usage.mutatedChains.add(name);
      this._addBroadChainUse(usage, name);
    }
  }

  _addBroadChainUse(usage, name) {
    if (name) {
      usage.usedChains.add(name);
    }
  }

  _deriveChainsFromParent(usage, declaredChains) {
    const parentUsage = this._createChainUsageAggregate();
    this._mergeChainUsage(parentUsage, usage);
    if (declaredChains) {
      declaredChains.forEach((_decl, name) => {
        parentUsage.observedChains.delete(name);
        parentUsage.usedChains.delete(name);
        parentUsage.mutatedChains.delete(name);
      });
    }
    return parentUsage;
  }

  _getPropagatedChainUsage(analysis, localObserves, localMutates, scopeChainsFromParent) {
    // This is the read-only footprint this node contributes to its parent,
    // not the parent-visible footprint this node consumes from its parent.
    // Returning an empty aggregate at scope boundaries makes parent aggregates
    // cover only the current span between nested boundaries.
    if (analysis.scopeBoundary) {
      const nodeType = analysis.node && analysis.node.typename;
      const isMethodOrBlockBoundary = nodeType === 'Block' || nodeType === 'MethodDefinition';
      const parentUsage = this._createChainUsageAggregate();
      if (!isMethodOrBlockBoundary) {
        return parentUsage;
      }
      localObserves.forEach((name) => {
        this._addChainObservation(parentUsage, name);
      });
      localMutates.forEach((name) => {
        this._addChainMutation(parentUsage, name);
      });
      return this._deriveChainsFromParent(parentUsage, analysis.declaredChains);
    }
    if (this._propagatesBoundaryLinkedUsage(analysis)) {
      return this._getBoundaryLinkedUsage(analysis);
    }
    return scopeChainsFromParent;
  }

  _propagatesBoundaryLinkedUsage(analysis) {
    if (!this._wantsLinkableChildBuffer(analysis)) {
      return false;
    }
    if (analysis.expressionControlFlowBoundary) {
      return analysis.boundaryLinkedMutatedChains !== null;
    }
    return true;
  }

  _getBoundaryLinkedUsage(analysis) {
    const parentUsage = this._createChainUsageAggregate();
    if (analysis.boundaryLinkedChains) {
      analysis.boundaryLinkedChains.forEach((name) => this._addBroadChainUse(parentUsage, name));
    }
    if (analysis.boundaryLinkedObservedChains) {
      analysis.boundaryLinkedObservedChains.forEach((name) => this._addChainObservation(parentUsage, name));
    }
    if (analysis.boundaryLinkedMutatedChains) {
      analysis.boundaryLinkedMutatedChains.forEach((name) => this._addChainMutation(parentUsage, name));
    }
    return parentUsage;
  }

  _deriveBoundaryLinkedChains(analysis, chainsFromParent) {
    if (!this._wantsLinkableChildBuffer(analysis) || chainsFromParent.size === 0) {
      return null;
    }
    return new Set(chainsFromParent);
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
    return !!(
      analysis &&
      analysis.parent &&
      (analysis.wantsLinkedChildBuffer || (analysis.createScope && !analysis.scopeBoundary))
    );
  }

  _finalizeBufferCreation(analysis) {
    analysis.createsLinkedChildBuffer = this._shouldCreateLinkedChildBuffer(analysis);
    if (!this._createsLinkableChildBuffer(analysis)) {
      analysis.boundaryLinkedChains = null;
      analysis.boundaryLinkedObservedChains = null;
      analysis.boundaryLinkedMutatedChains = null;
    }
  }

  _shouldCreateLinkedChildBuffer(analysis) {
    if (!analysis.parent || !analysis.wantsLinkedChildBuffer) {
      return false;
    }
    if (!analysis.expressionControlFlowBoundary) {
      return true;
    }
    return analysis.boundaryLinkedMutatedChains !== null;
  }

  _createsLinkableChildBuffer(analysis) {
    return !!(analysis && (
      analysis.createsLinkedChildBuffer ||
      (analysis.parent && analysis.createScope && !analysis.scopeBoundary)
    ));
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
