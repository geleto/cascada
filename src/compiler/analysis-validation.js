import {CHAIN_TYPES} from '../chain-types.js';
import * as nodes from '../language/nodes.js';
import {isChainDeclaration, isImmutableDeclaration, isVarChainDeclaration} from './declarations.js';

class CompileAnalysisValidation {
  constructor(analysisPass) {
    this.analysisPass = analysisPass;
    this.compiler = analysisPass.compiler;
  }

  validateDeclarations(analysis, declarationsToValidate, owner, visibleDeclarations) {
    if (declarationsToValidate.length === 0 || !owner) {
      return;
    }
    const declaredInBatch = new Map();
    for (let i = 0; i < declarationsToValidate.length; i++) {
      const decl = declarationsToValidate[i];
      decl.declarationOwner = owner;
      if (!decl.declarationOrigin) {
        decl.declarationOrigin = decl.shared
          ? this.analysisPass.getTopmostChildAnalysis(analysis)
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

  validateAnalysisFacts(analysis) {
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

  validateReturnedAnalysisFacts(analysis, facts) {
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

  validateMutations(analysis) {
    const scopeOwner = this.analysisPass._getScopeOwner(analysis);
    const rootDeclarations = this.analysisPass.getRootScopeOwner(analysis).activeVisibleDeclarations;
    const currentTextChain = this.analysisPass.getCurrentTextChain(analysis);
    const localMutates = analysis.mutates;
    for (let i = 0; i < localMutates.length; i++) {
      const name = localMutates[i];
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
        continue;
      }
      const declaration = this.analysisPass.findLocalUsageDeclaration(analysis, name);
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
        this.failImmutableMutation(analysis, name, declaration);
        continue;
      }
      const declarationOwner = declaration.declarationOwner;
      if (!this.analysisPass._passesReadOnlyBoundary(scopeOwner, declarationOwner)) {
        continue;
      }
      this._validateReadOnlyMutation(analysis, name, declaration);
    }
  }

  validateMacroValueUse(analysis) {
    const node = analysis.node;
    // A valid macro call target is still a symbol read with lookupDeclaration.
    // Call classification marks it so this validation only rejects value uses.
    if (
      this.compiler.scriptMode ||
      !(node instanceof nodes.Symbol) ||
      analysis.isSymbolTarget ||
      analysis.operationOwnedPath ||
      analysis.isMacroCallTarget ||
      node.isCompilerInternal
    ) {
      return;
    }

    const declaration = analysis.lookupDeclaration || null;
    if (!declaration?.isMacro) {
      return;
    }

    this.compiler.fail(
      `Macro '${node.value}' cannot be used as a value in an async template. Call it directly.`,
      node.lineno,
      node.colno,
      node
    );
  }

  validateObservations(analysis) {
    const rootDeclarations = this.analysisPass.getRootScopeOwner(analysis).activeVisibleDeclarations;
    const currentTextChain = this.analysisPass.getCurrentTextChain(analysis);
    const localObserves = analysis.observes;
    for (let i = 0; i < localObserves.length; i++) {
      const name = localObserves[i];
      if (this._shouldSkipChainAccessValidation(name, currentTextChain)) {
        continue;
      }
      if (!this.analysisPass.findSourceDeclaration(analysis, name)) {
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

  failImmutableMutation(analysis, name, declaration) {
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

  normalizeChainSet(value, field, analysis) {
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
}

export {CompileAnalysisValidation};
