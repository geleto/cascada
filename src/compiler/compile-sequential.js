const nodes = require('../nodes');
const { AsyncFrame } = require('../runtime/runtime');

const SequenceOperationType = {
  PATH: 1,
  LOCK: 2,
  CONTENDED: 3//PATH + LOCK or LOCK + LOCK
};

module.exports = class CompileSequential {

  constructor(compiler) {
    this.compiler = compiler;
  }

  //@todo - public
  _declareSequentialLocks(node, frame) {
    const sequenceLockFrame = frame.getRoot();
    // Get immediate children using the _getImmediateChildren method
    const children = this.compiler._getImmediateChildren(node);

    // Process each child node
    for (const child of children) {
      this._declareSequentialLocks(child, sequenceLockFrame);
    }

    if (node.typename === 'FunCall') {
      const key = this._getSequenceKey(node.name);
      if (key) {
        this.compiler._addDeclaredVar(sequenceLockFrame, key);
      }
    }
  }

  processExpression(node, frame) {
    frame = frame.getRoot();
    const f = new AsyncFrame();
    // copy declaredVars from frame to f, but only properties that start with `!`
    // these are the keys of the active sequence locks
    // copy because we don't want any added sequence lock keys to be used in the compilation
    //@todo - do we still add sequence lock keys? Don't think so but we need to check @todo
    if (frame.declaredVars) {
      f.declaredVars = new Set();
      for (const item of frame.declaredVars) {
        if (item.startsWith('!')) {
          f.declaredVars.add(item);
        }
      }
    }
    this._collectSequenceKeysAndOperations(node, f);
    this._assignAsyncWrappersAndReleases(node, f);
  }

  // Traverses the AST to identify all LOCK and PATH operations and aggregates them up, marking CONTENDED states.
  // It also handles the funCallLockKey propagation to avoid self-contention.
  _collectSequenceKeysAndOperations(node, frame, funCallLockKey = null) {
    node.sequenceOperations = new Map();
    node.isFunCallLocked = false;
    node.lockKey = null;

    // Identify PATH Waiters & Perform Sanity Checks for `node.sequential`
    if (node.sequential) {
      // node.sequential is true if '!' is directly on this Symbol/LookupVal
      const currentPathKey = this._extractStaticPathKey(node); // Key for this specific node
      if (node.sequentialRepair && !funCallLockKey) {
        // If this is a repair node (!!), we must set the lockKey so that compileSymbol/compileLookupVal
        // emits the sequential lookup (sequentialContextLookup) which handles the repair logic.
        // However, if we are part of a FunCall lock that covers this path, the FunCall will handle the repair propagation
        // via node.sequentialRepair propagation and sequentialCallWrap logic,
        // otherwise we have two colliding operations on the same lock
        node.lockKey = currentPathKey;
      }

      if (!funCallLockKey) {
        if (!node.sequentialRepair && !node.isSequenceErrorCheck) {
          this.compiler.fail('Sequence marker (!) is not allowed in non-call paths', node.lineno, node.colno, node);
        }
        node.lockKey = currentPathKey;
      } else if (funCallLockKey !== currentPathKey) {
        this.compiler.fail('Cannot use more than one sequence marker (!) in a single effective path segment.', node.lineno, node.colno, node);
      }
      // No PATH operation is added here for this key because it's "covered" by the parent FunCall's LOCK.
    } else if ((node instanceof nodes.Symbol || node instanceof nodes.LookupVal)) {
      // Still need to identify PATH waiters for nodes that are *not* `node.sequential` themselves
      // but are on a path that *is* sequential by a FunCall elsewhere.
      const pathKey = this._extractStaticPathKey(node);
      if (pathKey && pathKey !== funCallLockKey && this.compiler._isDeclared(frame, pathKey)) {
        // this is a path that is static
        // is declared as a sequence lock
        // and is not the lock key being originated by an immediate FunCall parent (funCallLockKey)
        // in the later case the key will be handled by the funCall, not the path to it
        node.sequenceOperations.set(pathKey, SequenceOperationType.PATH);
        node.lockKey = pathKey;
      }
    } else if (node instanceof nodes.FunCall) {
      // Identify FunCall LOCK
      const lockKey = this._getSequenceKey(node.name);
      if (lockKey) {
        node.sequenceOperations.set(lockKey, SequenceOperationType.LOCK);
        funCallLockKey = lockKey;//this wil stop the node.name path from registering as a PATH waiter for the same key
        node.isFunCallLocked = true;
        node.lockKey = lockKey;
      }
    }

    // Recursive Call & Aggregate sequenceOperations
    const children = this.compiler._getImmediateChildren(node);
    for (const child of children) {

      // pass down the funCall lock key down the node.name FunCall child
      // so that we won't register the path part as a separate PATH waiter for the same key as the FunCall LOCK
      const lockKey = (node.isFunCallLocked && child === node.name) ? node.lockKey : funCallLockKey;
      this._collectSequenceKeysAndOperations(child, frame, lockKey);

      if (!child.sequenceOperations || child.sequenceOperations.size === 0) {
        continue;
      }

      for (const [key, childValue] of child.sequenceOperations) {
        const parentValue = node.sequenceOperations.get(key);
        // Merge sequenceOperations if the child has the same key
        if (parentValue === undefined || (parentValue === childValue && childValue !== SequenceOperationType.LOCK)) {
          //no parent or same type(but not LOCK + LOCK)
          node.sequenceOperations.set(key, childValue);
        } else {
          //different types or LOCK + LOCK => contention
          node.sequenceOperations.set(key, SequenceOperationType.CONTENDED);
        }
      }
    }
  }

  // The node is wrapped if there is no contention and there aren't more than one locks.
  //   Except if there is only one child with sequence operations - then the wrap test is passed down to that child
  //@todo - no early wrapping of FunCall
  _assignAsyncWrappersAndReleases(node, frame) {
    node.wrapInAsyncBlock = false;

    if (!node.sequenceOperations) {
      return;
    }

    if (node.sequenceOperations.size === 0) {
      node.sequenceOperations = null;
      return;
    }

    let children;
    let singleChildWithOperations = null;
    if (!node.isFunCallLocked) {
      //check if there is a single child with sequence operations and move the wrap test down to that child
      //but only if the current node is not a sequence locked FunCall
      children = this.compiler._getImmediateChildren(node);
      for (const child of children) {
        if (child.sequenceOperations) {
          if (singleChildWithOperations) {
            //no single child with sequence operations
            singleChildWithOperations = null;
            break;
          }
          singleChildWithOperations = child;
        }
      }
    }

    if (singleChildWithOperations) {
      // there is a single child with sequence operations
      // move the wrap test down to that child
      this._assignAsyncWrappersAndReleases(singleChildWithOperations, frame);
      return;
    }

    let haveContended = false;
    let lockCount = 0;

    // iterate node.sequenceOperations, update lockCount and haveContended
    for (const value of node.sequenceOperations.values()) {
      if (value === SequenceOperationType.LOCK) {
        lockCount++;
      }
      if (value === SequenceOperationType.CONTENDED) {
        haveContended = true;
      }
    }

    if (node.isFunCallLocked) {
      // Wrap FunCall unless it is part of a sequence error check.
      node.wrapInAsyncBlock = !node.isSequenceErrorCheck;

      if (!haveContended && lockCount === 1) {
        return;//no more wrapping needed for the children
      }

      //wrap only nodes (from the arguments) that have created a contention
      //by having CONTENTION or having a LOCK
      for (const child of children ?? this.compiler._getImmediateChildren(node)) {
        if (child.sequenceOperations && child !== node.name) {
          //search for lock or contention in child.sequenceOperations
          for (const value of child.sequenceOperations.values()) {
            if (value === SequenceOperationType.LOCK || value === SequenceOperationType.CONTENDED) {
              this._assignAsyncWrappersAndReleases(child, frame);
              break;
            }
          }
        }
      }
      return;
    }

    if (!haveContended && lockCount === 0) {
      // No contention and no locks
      // The async wrap will make sure all PATHs await their LOCKs (if they were promisified before the block)
      // The block also promisifies the PATH sequence keys making sure no further FunCall is called before the PATHs are resolved
      // The block will also release the proper key when each PATH is resolved (not in the async block finally) by using frame.set(key, ...)
      // unlike the FunCall case where the FunCall releases the key when the async block return is resolved
      node.wrapInAsyncBlock = true;
      return;//no more wrapping needed for the children
    }

    for (const child of children ?? this.compiler._getImmediateChildren(node)) {
      if (child.sequenceOperations) {
        this._assignAsyncWrappersAndReleases(child, frame);
      }
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

  /**
   * Extract the base variable name from a sequential node.
   * For account!.deposit() -> '!account'
   * For db!.query().execute() -> '!db'
   * Returns the leftmost/base identifier in the chain.
   * @param {Node} node - The sequential node
   * @returns {string|null} Lock name prefixed with '!' or null
   */
  _extractBaseLockName(node) {
    if (!node) {
      return null;
    }

    // If it's a symbol: account!
    if (node.typename === 'Symbol') {
      return '!' + node.value;
    }

    // If it's a member lookup: account!.field or account!.method()
    // Navigate to the leftmost base
    if (node.typename === 'LookupVal' && node.target) {
      return this._extractBaseLockName(node.target);
    }

    // If it's a function call: account!.method()
    // The sequence is on the object being called on
    if (node.typename === 'FunCall' && node.name) {
      return this._extractBaseLockName(node.name);
    }

    // If it's a filter: account!|filter
    if (node.typename === 'Filter' && node.name) {
      return this._extractBaseLockName(node.name);
    }

    // Try to find the base by checking children for sequential marker
    const children = this.compiler._getImmediateChildren(node);
    for (const child of children) {
      if (child && child.sequential) {
        const lockName = this._extractBaseLockName(child);
        if (lockName) {
          return lockName;
        }
      }
    }

    return null;
  }

  /**
   * Pre-declare all sequence locks at the root frame.
   * This must be called BEFORE compilation starts.
   * Locks are initialized but not set to any value - they start as undefined.
   * @param {Frame} rootFrame - The root frame
   * @param {Set<string>} locks - Set of lock names to declare
   */
  preDeclareSequenceLocks(rootFrame, locks) {
    for (const lockName of locks) {
      this.compiler._addDeclaredVar(rootFrame, lockName);
    }
  }

  /**
   * Extracts a static path from a node for sequential operation analysis.
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
};
