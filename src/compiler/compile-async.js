const OPTIMIZE_ASYNC = true;//optimize async operations

// these are nodes that may perform async operations even if their children do not
const asyncOperationNodes = new Set([
  //expression nodes
  'LookupVal', 'Symbol', 'FunCall', 'Filter', 'Caller', 'CallExtension', 'CallExtensionAsync', 'Is', 'PeekError',
  //control nodes
  'Extends', 'Include', 'Import', 'FromImport', 'Super'
]);

module.exports = class CompileAsync {

  constructor(compiler) {
    this.compiler = compiler;
  }

  //when !OPTIMIZE_ASYNC - all nodes are treated as async
  propagateIsAsync(node) {
    let hasAsync = this.compiler.asyncMode ? !OPTIMIZE_ASYNC || asyncOperationNodes.has(node.typename) : false;

    // Get immediate children using the _getImmediateChildren method
    const children = this.compiler._getImmediateChildren(node);

    // Process each child node
    for (const child of children) {
      const childHasAsync = this.propagateIsAsync(child);
      hasAsync = this.compiler.asyncMode ? hasAsync || childHasAsync : false;
    }

    node.isAsync = hasAsync;
    return hasAsync;
  }


  //@todo - do not store writes that will not be read by the parents
  updateFrameWrites(frame, name) {
    // Store the writes and variable declarations down the scope chain
    // Search for the var in the scope chain
    let vf = frame;

    if (name.startsWith('!')) {
      // Sequence keys are conceptually declared at the root
      while (vf.parent) {
        vf = vf.parent;
      }

      // Ensure the lock is declared at root
      // (In case pre-declaration missed it or it's created dynamically)
      if (!vf.declaredVars || !vf.declaredVars.has(name)) {
        this.compiler._addDeclaredVar(vf, name);
      }
    } else {
      // Normal variable scope resolution
      do {
        if (vf.declaredVars && vf.declaredVars.has(name)) {
          break; // Found the var in vf
        }
        if (vf.isolateWrites) {
          vf = null;
          break;
        }
        vf = vf.parent;
      } while (vf);

      if (!vf) {
        // The variable did not exist
        // Declare a new variable in the current frame (or a parent if !createScope)
        vf = frame;
        while (!vf.createScope) {
          vf = vf.parent; // Skip the frames that cannot create a new scope
        }
        this.compiler._addDeclaredVar(vf, name);
      }
    }

    // Count the sets in the current frame/async block
    // Propagate the first write down the chain
    // Do not count for the frame where the variable is declared
    while (frame != vf) {
      if (!frame.writeCounts || !frame.writeCounts[name]) {
        frame.writeCounts = frame.writeCounts || {};
        frame.writeCounts[name] = 1; // First write, continue to parent frames
      } else {
        frame.writeCounts[name]++;
        break; // Subsequent writes are not propagated
      }
      frame = frame.parent;
    }
  }

  //@todo - handle included parent frames properly
  updateFrameReads(frame, name) {
    // Find the variable declaration in the scope chain
    let df = frame;

    // Special handling for sequence locks
    if (name.startsWith('!')) {
      // Locks are always declared at root
      while (df.parent) {
        df = df.parent;
      }

      // Check if the lock was pre-declared
      if (!df.declaredVars || !df.declaredVars.has(name)) {
        // Lock not pre-declared - may be created dynamically by a write
        // Don't add to readVars since it doesn't exist yet
        return;
      }
      // Lock exists at root - proceed to add to readVars for snapshotting
    } else {
      // Normal variable lookup in scope chain
      do {
        if (df.declaredVars && df.declaredVars.has(name)) {
          break; // Found the var declaration
        }
        df = df.parent;
      } while (df);

      if (!df) {
        // A context variable (not a lock, not declared)
        return;
      }
    }

    // Add to readVars for snapshotting
    // Walk from current frame up to declaration frame
    while (frame != df) {
      if ((frame.readVars && frame.readVars.has(name)) ||
        (frame.writeCounts && frame.writeCounts[name])) {
        // Already in readVars, or written here (will be snapshotted anyway)
        break;
      }
      frame.readVars = frame.readVars || new Set();
      frame.readVars.add(name);
      frame = frame.parent;
    }
  }

  //within an async block, each set is counted, but when propagating the writes to the parent async block
  //only the first write is propagated
  countsTo1(writeCounts) {
    if (!writeCounts) {
      return undefined;
    }
    let firstWritesOnly = {};
    for (let key in writeCounts) {
      firstWritesOnly[key] = 1;
    }
    return firstWritesOnly;
  }

  /**
   * Combines multiple write count objects into a single object
   * @param {Array<Object>} counts - Array of write count objects
   * @returns {Object} Combined write counts
   */
  _combineWriteCounts(counts) {
    const combined = {};

    counts.forEach((count) => {
      if (!count) return;
      Object.entries(count).forEach(([key, value]) => {
        combined[key] = (combined[key] || 0) + value;
      });
    });

    return combined;
  }
};

