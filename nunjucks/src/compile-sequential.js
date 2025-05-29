const nodes = require('./nodes');
const { AsyncFrame } = require('./runtime');

const SequenceOperationType = {
  PATH: 1,
  LOCK: 2,
  CONTENDED: 3//PATH + LOCK or LOCK + LOCK
};

module.exports = class CompileSequential {
  constructor(compiler) {
    this.compiler = compiler;
  }
  //@todo - directly to string
  processExpression(node, frame) {
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
    this._assignAsyncBlockWrappers(node, f);
    this._pushAsyncWrapDownTree(node);

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

  _assignAsyncBlockWrappers(node, frame) {
    node.sequenceOperations = new Map();
    let lockedFunCall = false;
    if (node instanceof nodes.Symbol || node instanceof nodes.LookupVal) {
      //path - Determine if currentNode has a sequence locked static path
      let pathKey = this._extractStaticPathKey(node);
      if (pathKey) {
        // currentNode is a Symbol or LookupVal accessing a potentially locked path.
        // This represents the *read* operation on that path.
        node.sequencePathKey = pathKey;
        node.sequenceOperations.set(pathKey, SequenceOperationType.PATH);
      }
    } else if (node instanceof nodes.FunCall) {
      //call - Determin if the call has a sequence lock (`!` in the path)
      let lockKey = this._getSequenceKey(node.name, frame);
      if (lockKey) {
        // currentNode is a FunCall with '!'
        // This represents the *write* operation on that lock.
        node.sequenceLockKey = lockKey;
        node.sequenceOperations.set(lockKey, SequenceOperationType.LOCK);
        lockedFunCall = true;
        node.wrapInAsyncBlock = true;//always wrap LOCK funCalls
      }
    }

    const children = this.compiler._getImmediateChildren(node);
    for (const child of children) {
      this._assignAsyncBlockWrappers(child, frame);
      if (!child.sequenceOperations) {
        continue;
      }
      for (const [key, childValue] of child.sequenceOperations) {
        if (lockedFunCall && child === node.name && key === node.sequenceLockKey) {
          //the FunCall node always has the same lock key as a path inside the node.name lookupVal
          if (childValue !== SequenceOperationType.PATH) {
            //that node should always be a PATH operation
            throw new Error('Matching FunCall node lock key with node.name path key - operator must be PATH');
          }
          //ignore this matching key in operator merge as this would create a fake CONTENDED
          continue;
        }
        //if any operation has a lock (including 2 locks) - it is contended
        const parentValue = node.sequenceOperations.get(key);
        if (parentValue === undefined || (parentValue === childValue && parentValue !== SequenceOperationType.LOCK)) {
          //no parent with that key or parent and child have same operation type
          node.sequenceOperations.set(key, childValue);
        } else {
          //parent and child have different operation types or are both locks
          node.sequenceOperations.set(key, SequenceOperationType.CONTENDED);
        }
      }
    }

    if (node.sequenceOperations.size === 0) {
      node.sequenceOperations = null;
      return;
    }

    //wrap the contended keys in async blocks at child nodes that are not contended
    for (const [key, value] of node.sequenceOperations) {
      if (value === SequenceOperationType.CONTENDED) {
        for (const child of children) {
          if (child.sequenceOperations && child.sequenceOperations.has(key)) {
            this._asyncWrapKey(child, key);
          }
        }
      }
    }
  };

  //wrap the bottom child nodes(closest to the root) where the key is not contended
  _asyncWrapKey(node, key) {

    const type = node.sequenceOperations.get(key);
    if (type !== SequenceOperationType.CONTENDED) {
      node.wrapInAsyncBlock = true;
      return;
    }

    for (const child of this.compiler._getImmediateChildren(node)) {
      if (child.sequenceOperations && child.sequenceOperations.has(key)) {
        this._asyncWrapKey(child, key);
      }
    }

    /*node.sequenceOperations.delete(key);
    if (node.sequenceOperations.size === 0) {
      delete node.sequenceOperations;
    }*/
  }

  //if the node has no lock or path of it's own and only one child has all the same keys
  //move the async wrap to that child
  _pushAsyncWrapDownTree(node) {
    const children = this.compiler._getImmediateChildren(node);
    if (node.sequenceOperations && node.wrapInAsyncBlock && !node.sequenceLockKey && !node.sequencePathKey) {
      let childWithKeys = null;
      let childWithKeysCount = 0;
      for (const child of children) {
        const sop = child.sequenceOperations;
        if (!sop) {
          continue;
        }
        for (const key of node.sequenceOperations.keys()) {
          if (sop.has(key)) {
            childWithKeys = child;
            childWithKeysCount++;
            break;
          }
        }
        if (childWithKeysCount > 1) {
          childWithKeys = null;
          break;
        }
      }
      if (childWithKeys) {
        //only one child has all the same keys
        //move the async wrap to that child (it may already be wrapped)
        node.wrapInAsyncBlock = false;
        childWithKeys.wrapInAsyncBlock = true;
      }
    }
    for (const child of children) {
      this._pushAsyncWrapDownTree(child);
    }
  }

  //public
  _getSequenceKey(node, frame) {
    let path = this._getSequencedPath(node, frame);
    return path ? '!' + path.join('!') : null;
  }

  // @todo - inline in _getSequenceKey
  // @todo - maybe this can be simplified
  _getSequencedPath(node, frame) {
    let path = [];
    let current = node;
    let sequencedCount = 0;
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

      if (nodeToAnalyze.sequenced) {
        sequencedCount++;
        if (sequencedCount > 1) {
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
    if (!sequenceMarkerNode && rootNode && rootNode.typename === 'Symbol' && rootNode.sequenced) {
      sequencedCount++;
      if (sequencedCount > 1) { /* Should be caught above if chain existed */
        this.compiler.fail('Syntax Error: Using two sequence markers \'!\' in the same path is not supported.', rootNode.lineno, rootNode.colno, rootNode);
      }
      // Root node itself is sequenced.
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
          'Sequence Error: Sequenced paths marked with \'!\' must originate from a context variable (e.g., contextVar["key"]!). The path starts with a dynamic or non-variable element.',
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
      /*if (path.length > 0 && this._isDeclared(frame, path[0])) {
        // Path starts with a template variable (e.g., {% set myVar = {} %}{{ myVar!['key'].call() }})
        // Sequencing is only for context variables.
        if (this.isCompilingMacroBody) {
          this.compiler.fail(
            'Sequence Error: Sequenced paths marked with \'!\' are not allowed for paths starting with macro variable.',
            node.lineno, node.colno, node
          );
        }
        this.compiler.fail('Sequence marker (!) is not allowed in non-context variable paths', node.lineno, node.colno, node);
        return null;
      }*/

      //throw an error if we are inside a macro
      if (this.isCompilingMacroBody) {
        this.compiler.fail(
          'Sequence Error: Sequenced paths marked with \'!\' are not allowed inside macros.',
          node.lineno, node.colno, node
        );
      }

      // Path is fully validated for sequencing!
      return path; // Return the array of static string segments.

    } // End if (sequenceMarkerNode)

    // No valid sequence marker ('!') found according to the rules.
    return null;
  }
};
