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
