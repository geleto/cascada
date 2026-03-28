const nodes = require('../nodes');
module.exports = class CompileSequential {

  constructor(compiler) {
    this.compiler = compiler;
  }

  // Annotate per-node sequence lookup metadata used by expression codegen.
  // This only computes the final sequenceLockLookup facts that the compiler
  // still consumes; it no longer drives any legacy async-wrapper assignment.
  annotateSequenceLockLookups(node, sequenceLocks, funCallLockKey = null, parent = null) {
    const analysis = node._analysis || (node._analysis = {});
    analysis.sequenceLockLookup = null;
    let nodeLockKey = null;
    let nodeIsFunCallLocked = false;

    // Identify PATH Waiters & Perform Sanity Checks for `node.sequential`
    if (node.sequential) {
      // node.sequential is true if '!' is directly on this Symbol/LookupVal
      const currentPathKey = this._extractStaticPathKey(node); // Key for this specific node
      if (node.sequentialRepair && !funCallLockKey) {
        // If this is a repair node (!!), we must set the lockKey so that compileSymbol/compileLookupVal
        // emits the sequential lookup (sequentialContextLookupValue) which handles the repair logic.
        // However, if we are part of a FunCall lock that covers this path, the FunCall will handle the repair propagation
        // via node.sequentialRepair propagation and sequentialCallWrapValue logic,
        // otherwise we have two colliding operations on the same lock
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
      // No PATH operation is added here for this key because it's "covered" by the parent FunCall's LOCK.
    } else if ((node instanceof nodes.Symbol || node instanceof nodes.LookupVal)) {
      // Still need to identify PATH waiters for nodes that are *not* `node.sequential` themselves
      // but are on a path that *is* sequential by a FunCall elsewhere.

      // 1) Prefer an exact static path lock for this node (most specific wins).
      const pathKey = this._extractStaticPathKey(node);
      if (pathKey && pathKey !== funCallLockKey && this._isSequenceLockDeclared(sequenceLocks, pathKey)) {
        // this is a path that is static
        // is declared as a sequence lock
        // and is not the lock key being originated by an immediate FunCall parent (funCallLockKey)
        // in the later case the key will be handled by the funCall, not the path to it
        nodeLockKey = pathKey;
      } else if (node instanceof nodes.LookupVal) {
        // 2) If no exact lock, fall back to the base symbol's lock so any read
        // under a sequenced object (db.*) respects !db.
        // Only the outermost lookup in a chain should claim the base lock.
        const isOutermostLookup = !parent || !(parent instanceof nodes.LookupVal) || parent.target !== node;
        if (isOutermostLookup) {
          let root = node;
          while (root && root.typename === 'LookupVal') {
            root = root.target;
          }
          if (root && root.typename === 'Symbol') {
            const baseKey = '!' + root.value;
            if (baseKey !== funCallLockKey && this._isSequenceLockDeclared(sequenceLocks, baseKey)) {
              nodeLockKey = baseKey;
            }
          }
        }
      } else if (node instanceof nodes.Symbol && parent instanceof nodes.LookupVal) {
        // If the parent lookup already claimed the base lock, skip registering the symbol again.
        const parentLockKey = parent._analysis && parent._analysis.sequenceLockLookup && parent._analysis.sequenceLockLookup.key;
        if (parentLockKey && parentLockKey === '!' + node.value) {
          // Skip PATH registration for this symbol.
          return;
        }
      }
    } else if (node instanceof nodes.FunCall) {
      // Identify FunCall LOCK
      const lockKey = this._getSequenceKey(node.name);
      if (lockKey) {
        funCallLockKey = lockKey;//this wil stop the node.name path from registering as a PATH waiter for the same key
        nodeIsFunCallLocked = true;
        nodeLockKey = lockKey;
        if (this._hasSequentialRepair(node.name)) {
          node.sequentialRepair = true;
        }
      }
    }

    if (nodeLockKey) {
      analysis.sequenceLockLookup = {
        key: nodeLockKey,
        repair: !!node.sequentialRepair
      };
    }

    // Recursive traversal with propagated function-lock context.
    const children = this.compiler._getImmediateChildren(node);
    for (const child of children) {
      const lockKey = (nodeIsFunCallLocked && child === node.name) ? nodeLockKey : funCallLockKey;
      this.annotateSequenceLockLookups(child, sequenceLocks, lockKey, node);
    }
  }


  _extractStaticPathKey(node) {
    // Check if the input node itself is valid to start a path extraction
    if (!node || (node.typename !== 'LookupVal' && node.typename !== 'Symbol')) {
      return null;
    }

    const parts = [];
    let current = node;

    while (current) {
      if (current.typename === 'LookupVal') {
        const valNode = current.val;
        if (valNode.typename === 'Symbol') {
          parts.unshift(valNode.value);
        } else if (valNode.typename === 'Literal' && typeof valNode.value === 'string') {
          parts.unshift(valNode.value);
        } else {
          return null; // Dynamic segment
        }
        current = current.target;
      } else if (current.typename === 'Symbol') {
        parts.unshift(current.value);
        current = null; // Stop traversal
      } else {
        return null; // Unexpected node type in path
      }
    }
    return '!' + parts.join('!');
  }


  //@todo - public
  _getSequenceKey(node) {
    let path = this._getSequentialPath(node);
    return path ? '!' + path.join('!') : null;
  }

  // @todo - inline in _getSequenceKey
  // @todo - maybe this can be simplified
  _getSequentialPath(node) {
    let path = [];
    let current = node;
    let sequentialCount = 0;
    // Flag to track if any dynamic segment (non-static key) was found
    // in the path *before* the segment marked with '!'.
    let dynamicFoundInPrefix = false;
    // Stores the node where '!' was actually found (either LookupVal or Symbol).
    let sequenceMarkerNode = null;
    // Stores the static string value of the segment marked with '!'
    let sequenceSegmentValue = null;

    function isStaticStringKey(keyNode) {
      return keyNode && keyNode.typename === 'Literal' && typeof keyNode.value === 'string';
    }


    // Traverse the Object Path upwards, searching for '!'
    // We iterate from the end of the potential path backwards (up towards the root).
    let nodeToAnalyze = current;
    while (nodeToAnalyze && nodeToAnalyze.typename === 'LookupVal') {
      const isCurrentKeyStatic = isStaticStringKey(nodeToAnalyze.val);

      if (nodeToAnalyze.sequential) {
        sequentialCount++;
        if (sequentialCount > 1) {
          this.compiler.fail(
            'Syntax Error: Using two sequence markers \'!\' in the same path is not supported.',
            nodeToAnalyze.lineno, nodeToAnalyze.colno, nodeToAnalyze
          );
        }
        // CRITICAL CHECK: The segment with '!' MUST use a static string key.
        if (!isCurrentKeyStatic) {
          this.compiler.fail(
            'Sequence Error: The sequence marker \'!\' can only be applied after a static string literal key (e.g., obj["key"]!). It cannot be used with dynamic keys like variable indices (obj[i]!), numeric indices (obj[1]!), or other expression results.',
            nodeToAnalyze.lineno, nodeToAnalyze.colno, nodeToAnalyze
          );
        }
        sequenceMarkerNode = nodeToAnalyze;
        sequenceSegmentValue = nodeToAnalyze.val.value; // Store the static key
        current = nodeToAnalyze.target; // 'current' now points to the node *before* the '!' segment
        break; // Found '!', stop searching
      }

      // If this segment doesn't have '!', check if it's dynamic.
      // This contributes to the 'dynamicFoundInPrefix' check later.
      if (!isCurrentKeyStatic) {
        dynamicFoundInPrefix = true;
      }
      nodeToAnalyze = nodeToAnalyze.target; // Move up the chain
    } // End while loop searching for '!' in LookupVal chain

    // Check if the root node itself has '!' (e.g., contextVar!)
    let rootNode = nodeToAnalyze; // Whatever node we stopped at
    if (!sequenceMarkerNode && rootNode && rootNode.typename === 'Symbol' && rootNode.sequential) {
      sequentialCount++;
      if (sequentialCount > 1) { /* Should be caught above if chain existed */
        this.compiler.fail('Syntax Error: Using two sequence markers \'!\' in the same path is not supported.', rootNode.lineno, rootNode.colno, rootNode);
      }
      // Root node itself is sequential.
      sequenceMarkerNode = rootNode;
      sequenceSegmentValue = rootNode.value; // The symbol's value is the key
      current = null; // No 'current' before the root
      // `dynamicFoundInPrefix` should be false here, as there was no preceding path.
    }

    // Validate Prefix and Collect Full Path if '!' was found
    if (sequenceMarkerNode) {
      // We found '!' (either on a LookupVal or the root Symbol).
      // We already validated that the key *at* the '!' was a static string (or it was the root Symbol).
      // Now, validate that no segment *before* the '!' was dynamic.
      if (dynamicFoundInPrefix) {
        this.compiler.fail(
          'Sequence Error: The sequence marker \'!\' requires the entire path preceding it to consist of static string literal segments (e.g., root["a"]["b"]!). A dynamic segment (like a variable index) was found earlier in the path.',
          sequenceMarkerNode.lineno, // Error reported at the node with '!'
          sequenceMarkerNode.colno,
          sequenceMarkerNode // Pass the node with '!'
        );
      }

      // --- Prefix is valid, collect the full path string ---
      // Start with the segment that had '!'
      path.push(sequenceSegmentValue);

      // Traverse upwards from 'current' (the part before '!')
      while (current && current.typename === 'LookupVal') {
        // All segments here MUST be static string keys due to the dynamicFoundInPrefix check.
        if (!isStaticStringKey(current.val)) {
          // This should theoretically not happen if dynamicFoundInPrefix logic is correct.
          this.compiler.fail(
            `Internal Compiler Error: Dynamic segment found in sequence path prefix after validation. Path segment key type: ${current.val.typename}`,
            current.lineno, current.colno, current // Pass the problematic node
          );
        }
        path.unshift(current.val.value); // Add static key to the front
        current = current.target;
      }

      // Handle and Validate the final Root Node of the collected path
      rootNode = current; // Update rootNode to the final node after traversal
      if (rootNode && rootNode.typename === 'Symbol') {
        path.unshift(rootNode.value); // Add the root symbol identifier
      } else if (rootNode) {
        // Path doesn't start with a simple variable (e.g., started with func() or literal)
        this.compiler.fail(
          'Sequence Error: Sequential paths marked with \'!\' must originate from a context variable (e.g., contextVar["key"]!). The path starts with a dynamic or non-variable element.',
          rootNode.lineno, rootNode.colno, rootNode
        );
      } else if (path.length === 0) {
        // This should not happen if sequenceSegmentValue was set.
        this.compiler.fail(`Internal Compiler Error: Sequence path collection resulted in empty path.`, node.lineno, node.colno, node);
      }
      // If !rootNode but path has elements, it means the sequence started mid-expression,
      // which is invalid for context variable sequencing. This is caught by the rootNode type check above.

      //Testing if a sequence path starts with declared variable
      //can not happen here because _declareSequentialLocks does not have access to declared variables

      // Final Validation: Check Root Origin (Context vs. Scope)
      // Ensure the path doesn't start with a variable declared in the template scope.
      /*if (path.length > 0 && this.compiler._isDeclared(frame, path[0])) {
        // Path starts with a template variable (e.g., {% set myVar = {} %}{{ myVar!['key'].call() }})
        // Sequencing is only for context variables.
        if (this.isCompilingMacroBody) {
          this.compiler.fail(
            'Sequence Error: Sequential paths marked with \'!\' are not allowed for paths starting with macro variable.',
            node.lineno, node.colno, node
          );
        }
        this.compiler.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        return null;
      }*/

      //throw an error if we are inside a macro
      if (this.isCompilingMacroBody) {
        this.compiler.fail(
          'Sequence Error: Sequential paths marked with \'!\' are not allowed inside macros.',
          node.lineno, node.colno, node
        );
      }

      // Path is fully validated for sequencing!
      return path; // Return the array of static string segments.

    } // End if (sequenceMarkerNode)

    // No valid sequence marker ('!') found according to the rules.
    return null;
  }

  /**
   * Collect all sequence lock names from the AST.
   * Walks the entire AST looking for sequence-marked operations.
   * @param {Node} node - Root AST node
   * @returns {Set<string>} Set of lock names (e.g., '!account', '!db')
   */
  collectSequenceLocks(node) {
    const definedVars = new Set();
    const atomicUsage = new Map();

    const walk = (n) => {
      if (!n) {
        return;
      }

      // 1. Check for Sequence Definition (FunCall)
      if (n.typename === 'FunCall') {
        // Check if this function call defines a sequence
        const lock = this._getSequenceKey(n.name);
        if (lock) {
          definedVars.add(lock);
          // Only recurse into arguments; do not recurse into the name (callee)
          // because it contains the sequence markers that are DEFINING this lock.
          // We don't want to count them as "usages".
          if (n.args) {
            n.args.children.forEach(walk);
          }
          return;
        }
      }

      // 2. Check for Sequence Usage (Independent !)
      // Unlike standard usage (that does not employ the `!` symbol),
      // FunCall can use the `!` marker explicitly to define a sequence lock.
      // Checking a sequence status (e.g. `service! is error`) also uses the `!` marker
      // and is a "Usage" of the lock, which requires the lock to have been defined.
      if (n.sequential) {
        const lock = this._getSequenceKey(n);
        if (lock) {
          atomicUsage.set(n, lock);
        }
        // We treat the sequential node (e.g. path!) as an atomic usage unit and do not recurse.
        return;
      }

      // 3. Default Recursion
      // Handles NodeList, Block, Expressions, etc.
      // Use _getImmediateChildren to safely traverse custom node structures
      const children = this.compiler._getImmediateChildren(n);
      children.forEach(child => walk(child));
    };

    walk(node);

    // Validate: All used locks must have been defined by a FunCall
    for (const [n, lock] of atomicUsage) {
      if (!definedVars.has(lock)) {
        this.compiler.fail(
          `Sequence path '${lock}' does not exist. You must define a sequential path (e.g. path!.method()) before checking it.`,
          n.lineno, n.colno, n
        );
      }
    }

    return definedVars;
  }

  _isSequenceLockDeclared(sequenceLocks, lockKey) {
    if (!lockKey) {
      return false;
    }
    return sequenceLocks.has(lockKey);
  }

  /**
   * Extracts a static path from a node for sequential operation analysis.
   * Update - we now use this to extract path in channel commands as well
   * @todo - move it to compiler or compiler-base
   * A static path is a chain of property accesses that can be determined at compile time.
   * @param {nodes.LookupVal|nodes.Symbol|nodes.Literal} node - The node to extract path from
   * @returns {Array<string>|null} Array of path segments or null if not static
   */
  _extractStaticPath(node) {
    const path = [];

    // Helper function to recursively traverse the lookup chain
    const traverse = (currentNode) => {
      if (currentNode instanceof nodes.Symbol) {
        // Base case: symbol node (e.g., 'paths')
        path.unshift(currentNode.value);
        return true;
      } else if (currentNode instanceof nodes.Literal && typeof currentNode.value === 'string') {
        // String literal (e.g., 'subpath')
        path.unshift(currentNode.value);
        return true;
      } else if (currentNode instanceof nodes.LookupVal) {
        // Recursive case: lookup node (e.g., paths.subpath)
        // First, try to extract the value/key part
        if (currentNode.val instanceof nodes.Literal && typeof currentNode.val.value === 'string') {
          // Property access like .subpath
          path.unshift(currentNode.val.value);
        } else if (currentNode.val instanceof nodes.Symbol) {
          // Property access like .subpath (as symbol)
          path.unshift(currentNode.val.value);
        } else {
          // Non-static value (expression, function call, etc.)
          return false;
        }

        // Then recursively traverse the target
        return traverse(currentNode.target);
      } else {
        // Any other node type is not static
        return false;
      }
    };

    // Start traversal from the given node
    if (traverse(node)) {
      return path;
    }

    return null;
  }

  _extractStaticPathRoot(node, expectedLength = null) {
    if (!node) {
      return null;
    }

    let current = node;
    let length = 0;

    while (current) {
      if (current instanceof nodes.LookupVal) {
        const valNode = current.val;
        if (valNode instanceof nodes.Symbol) {
          length++;
        } else if (valNode instanceof nodes.Literal && typeof valNode.value === 'string') {
          length++;
        } else {
          return null;
        }
        current = current.target;
        continue;
      }

      if (current instanceof nodes.Symbol) {
        length++;
        if (expectedLength !== null && length !== expectedLength) {
          return null;
        }
        return current.value;
      }

      if (current instanceof nodes.Literal && typeof current.value === 'string') {
        length++;
        if (expectedLength !== null && length !== expectedLength) {
          return null;
        }
        return current.value;
      }

      return null;
    }

    return null;
  }

  _hasSequentialRepair(node) {
    let current = node;
    while (current) {
      if (current.sequential && current.sequentialRepair) {
        return true;
      }
      if (current.typename === 'LookupVal') {
        current = current.target;
      } else if (current.typename === 'Symbol') {
        break;
      } else {
        break;
      }
    }
    return false;
  }
};
