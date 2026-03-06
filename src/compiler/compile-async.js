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
    // Resolve declaration scope for the target variable/lock and declare when missing.
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
    return vf;
  }

  _getDeclaredOutput(frame, name) {
    while (frame) {
      if (frame.declaredOutputs && frame.declaredOutputs.has(name)) {
        return frame.declaredOutputs.get(name);
      }
      // Outputs follow lexical scoping only (same as variables).
      frame = frame.parent;
    }
    return null;
  }

};
