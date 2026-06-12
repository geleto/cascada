import * as nodes from '../language/nodes.js';

class CompileSequential {

  constructor(compiler) {
    this.compiler = compiler;
  }

  recordFunCallNameLockKey(node) {
    const lockKey = node._analysis.sequenceFunCallLockKey;
    if (!lockKey || !node.name) {
      return;
    }
    node.name.addAnalysis({ inheritedSequenceFunCallLockKey: lockKey });
  }

  recordSequenceLockLookup(node) {
    const analysis = node._analysis;
    const funCallLockKey = analysis.inheritedSequenceFunCallLockKey || null;
    let nodeLockKey = null;
    let definesLock = false;
    let validatesLock = false;

    if (node.sequential) {
      const currentPathKey = this._extractStaticPathKey(node);
      if (node.sequentialRepair && !funCallLockKey) {
        nodeLockKey = currentPathKey;
      }

      if (!funCallLockKey) {
        if (!node.sequentialRepair && !node.isSequenceErrorCheck) {
          this.compiler.fail('Sequence marker (!) is not allowed in non-call paths', node.lineno, node.colno, node);
        }
        nodeLockKey = currentPathKey;
      } else if (funCallLockKey !== currentPathKey) {
        this.compiler.fail('Cannot use more than one sequence marker (!) in a single effective path segment.', node.lineno, node.colno, node);
      }
      validatesLock = !!nodeLockKey;
    } else if (node instanceof nodes.FunCall) {
      const lockKey = this._getSequenceKey(node.name);
      analysis.sequenceFunCallLockKey = lockKey || null;
      if (lockKey) {
        nodeLockKey = lockKey;
        definesLock = true;
        if (this._hasSequentialRepair(node.name)) {
          node.sequentialRepair = true;
        }
      }
    }

    if (!nodeLockKey) {
      return null;
    }
    if (definesLock) {
      this._recordSequenceLockDefinition(analysis, nodeLockKey);
    } else if (validatesLock) {
      this._recordSequenceLockUsage(analysis, nodeLockKey, node);
    }
    return { key: nodeLockKey, repair: !!node.sequentialRepair };
  }

  recordBareSequenceLockLookup(node, analysisPass) {
    const analysis = node._analysis;
    if (analysis.sequenceLockLookup || node.sequential) {
      return null;
    }
    if (!(node instanceof nodes.Symbol || node instanceof nodes.LookupVal)) {
      return null;
    }
    const sequenceLockLookup = this._findBareSequenceLockLookup(node);
    if (!sequenceLockLookup) {
      return null;
    }
    this.compiler._failIfSequenceRootIsDeclared(node, sequenceLockLookup.key, analysisPass);
    // Bare sequence lock lookups cover both value reads and status observations
    // such as `path! is error`; current consumers only need the shared `uses`
    // fact, not a separate read-vs-observe split.
    analysis.uses.push(sequenceLockLookup.key);
    return sequenceLockLookup;
  }

  _findBareSequenceLockLookup(node) {
    const analysis = node._analysis;
    const sequenceLocks = this._getSequenceLockSet(analysis);
    const funCallLockKey = analysis.inheritedSequenceFunCallLockKey || null;
    const parent = analysis.parent ? analysis.parent.node : null;

    if (node instanceof nodes.Symbol && parent instanceof nodes.LookupVal && parent.target === node) {
      return null;
    }

    const staticPath = this.extractStaticPath(node);
    let nodeLockKey = null;
    const pathKey = this._getStaticPathKey(staticPath);
    if (pathKey && pathKey !== funCallLockKey && this._isSequenceLockDeclared(sequenceLocks, pathKey)) {
      nodeLockKey = pathKey;
    } else if (node instanceof nodes.LookupVal) {
      const isOutermostLookup = !parent || !(parent instanceof nodes.LookupVal) || parent.target !== node;
      if (isOutermostLookup) {
        if (staticPath.rootNode instanceof nodes.Symbol && staticPath.root !== null) {
          const baseKey = '!' + staticPath.root;
          if (baseKey !== funCallLockKey && this._isSequenceLockDeclared(sequenceLocks, baseKey)) {
            nodeLockKey = baseKey;
          }
        }
      }
    }

    return nodeLockKey ? { key: nodeLockKey, repair: false } : null;
  }

  _extractStaticPathKey(node) {
    if (!(node instanceof nodes.LookupVal || node instanceof nodes.Symbol)) {
      return null;
    }
    return this._getStaticPathKey(this.extractStaticPath(node));
  }

  _getStaticPathKey(staticPath) {
    return staticPath.isStatic ? '!' + staticPath.segments.join('!') : null;
  }

  _getSequenceKey(node) {
    const path = this._getSequentialPath(node);
    return path ? '!' + path.join('!') : null;
  }

  _getSequentialPath(node) {
    const entries = this._collectStaticPathEntries(node);
    const sequenceEntries = entries.filter((entry) => entry.node.sequential);
    if (sequenceEntries.length === 0) {
      return null;
    }
    if (sequenceEntries.length > 1) {
      const duplicate = sequenceEntries[1].node;
      this.compiler.fail(
        'Cannot use more than one sequence marker (!) in a single effective path segment.',
        duplicate.lineno, duplicate.colno, duplicate
      );
    }

    const markerIndex = entries.indexOf(sequenceEntries[0]);
    const markerEntry = entries[markerIndex];
    if (markerEntry.sequenceValue === null) {
      this.compiler.fail(
        'Sequence Error: The sequence marker \'!\' can only be applied after a static string literal key (e.g., obj["key"]!). It cannot be used with dynamic keys like variable indices (obj[i]!), numeric indices (obj[1]!), or other expression results.',
        markerEntry.node.lineno, markerEntry.node.colno, markerEntry.node
      );
    }

    const hasDynamicOuterSegment = entries
      .slice(0, markerIndex)
      .some((entry) => entry.sequenceValue === null);
    if (hasDynamicOuterSegment) {
      this.compiler.fail(
        'Sequence Error: The sequence marker \'!\' requires the entire path preceding it to consist of static string literal segments (e.g., root["a"]["b"]!). A dynamic segment (like a variable index) was found earlier in the path.',
        markerEntry.node.lineno,
        markerEntry.node.colno,
        markerEntry.node
      );
    }

    const lockedEntries = entries.slice(markerIndex).reverse();
    const rootEntry = lockedEntries[0];
    if (!(rootEntry && rootEntry.node instanceof nodes.Symbol)) {
      const errorNode = rootEntry ? rootEntry.node : node;
      this.compiler.fail(
        'Sequence Error: Sequential paths marked with \'!\' must originate from a context variable (e.g., contextVar["key"]!). The path starts with a dynamic or non-variable element.',
        errorNode.lineno, errorNode.colno, errorNode
      );
    }

    const path = [];
    for (const entry of lockedEntries) {
      if (entry.sequenceValue === null) {
        this.compiler.fail(
          'Sequence Error: The sequence marker \'!\' requires the entire path preceding it to consist of static string literal segments (e.g., root["a"]["b"]!). A dynamic segment (like a variable index) was found earlier in the path.',
          markerEntry.node.lineno,
          markerEntry.node.colno,
          markerEntry.node
        );
      }
      path.push(entry.sequenceValue);
    }

    if (this.isCompilingMacroBody) {
      this.compiler.fail(
        'Sequence Error: Sequential paths marked with \'!\' are not allowed inside macros.',
        node.lineno, node.colno, node
      );
    }

    return path;
  }

  _isSequenceLockDeclared(sequenceLocks, lockKey) {
    if (!lockKey) {
      return false;
    }
    return sequenceLocks.has(lockKey);
  }

  _getSequenceLockSet(analysis) {
    const current = this._getRootAnalysis(analysis);
    return new Set(current.sequenceLocks);
  }

  _getRootAnalysis(analysis) {
    let current = analysis;
    while (current && current.parent) {
      current = current.parent;
    }
    return current;
  }

  _recordSequenceLockDefinition(analysis, lockKey) {
    const rootAnalysis = this._getRootAnalysis(analysis);
    if (!rootAnalysis || !lockKey) {
      return;
    }
    if (!rootAnalysis.sequenceLocks.includes(lockKey)) {
      rootAnalysis.sequenceLocks.push(lockKey);
    }
  }

  _recordSequenceLockUsage(analysis, lockKey, node) {
    const rootAnalysis = this._getRootAnalysis(analysis);
    if (!rootAnalysis || !lockKey) {
      return;
    }
    rootAnalysis.sequenceLockUsages.push({ lockKey, node });
  }

  validateSequenceLockUsages(rootNode) {
    const rootAnalysis = rootNode && rootNode._analysis;
    if (!rootAnalysis || rootAnalysis.sequenceLockUsages.length === 0) {
      return;
    }
    const definedLocks = new Set(rootAnalysis.sequenceLocks);
    for (const usage of rootAnalysis.sequenceLockUsages) {
      if (definedLocks.has(usage.lockKey)) {
        continue;
      }
      this.compiler.fail(
        `Sequence path '${usage.lockKey}' does not exist. You must define a sequential path (e.g. path!.method()) before checking it.`,
        usage.node.lineno,
        usage.node.colno,
        usage.node
      );
    }
  }

  // Pure generic extractor for lookup-like paths. This accepts the same static
  // segments the compiler uses for chain/command routing; `!` validation stays
  // in _getSequentialPath because sequence paths have stricter key rules.
  //
  // Contract: `segments` is the static-only projection (null unless every
  // segment is static). `root`/`rootNode` are best-effort and may be populated
  // even when `isStatic` is false (e.g. a Symbol root under a dynamic segment),
  // so the bare-lock baseKey lookup can still resolve the root. Callers that
  // need a fully static path must check `isStatic` before trusting `segments`.
  extractStaticPath(node) {
    const entries = this._collectStaticPathEntries(node);
    const rootEntry = entries[entries.length - 1] || null;
    const root = rootEntry && rootEntry.value !== null ? rootEntry.value : null;
    if (entries.length === 0 || entries.some((entry) => entry.value === null)) {
      return { isStatic: false, segments: null, root, rootNode: rootEntry?.node ?? null };
    }
    return {
      isStatic: true,
      segments: entries.map((entry) => entry.value).reverse(),
      root,
      rootNode: rootEntry.node
    };
  }

  extractStaticPathSegments(node) {
    const staticPath = this.extractStaticPath(node);
    return staticPath.isStatic ? staticPath.segments : null;
  }

  extractStaticPathRoot(node, expectedLength = null) {
    const staticPath = this.extractStaticPath(node);
    if (!staticPath.isStatic) {
      return null;
    }
    if (expectedLength !== null && staticPath.segments.length !== expectedLength) {
      return null;
    }
    return staticPath.root;
  }

  _hasSequentialRepair(node) {
    return this._collectStaticPathEntries(node)
      .some((entry) => entry.node.sequential && entry.node.sequentialRepair);
  }

  _collectStaticPathEntries(node) {
    const entries = [];
    let current = node;
    while (current) {
      if (current instanceof nodes.LookupVal) {
        entries.push({
          node: current,
          value: this._getStaticPathSegmentValue(current.val),
          sequenceValue: this._getSequencePathSegmentValue(current)
        });
        current = current.target;
        continue;
      }
      entries.push({
        node: current,
        value: this._getStaticPathSegmentValue(current),
        sequenceValue: current instanceof nodes.Symbol ? current.value : null
      });
      break;
    }
    return entries;
  }

  _getStaticPathSegmentValue(node) {
    if (node instanceof nodes.Symbol) {
      return node.value;
    }
    if (node instanceof nodes.Literal && typeof node.value === 'string') {
      return node.value;
    }
    return null;
  }

  _getSequencePathSegmentValue(lookupNode) {
    return lookupNode.val instanceof nodes.Literal && typeof lookupNode.val.value === 'string'
      ? lookupNode.val.value
      : null;
  }
};

export {CompileSequential};
