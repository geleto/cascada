const OPTIMIZE_ASYNC = true;//optimize async operations

// these are nodes that may perform async operations even if their children do not
const asyncOperationNodes = new Set([
  //expression nodes
  'LookupVal', 'Symbol', 'FunCall', 'Filter', 'Caller', 'CallExtension', 'CallExtensionAsync', 'Is',
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
    //store the writes and variable declarations down the scope chain
    //search for the var in the scope chain
    let vf = frame;
    if (name.startsWith('!')) {
      // Sequence keys are conceptually declared at the root for propagation purposes.
      /*vf = frame.sequenceLockFrame;
      if (!vf.declaredVars) {
        vf.declaredVars = new Set();
      }
      vf.declaredVars.add(name);*/
      while (vf.parent) {
        vf = vf.parent;
      }
    } else {
      do {
        if (vf.declaredVars && vf.declaredVars.has(name)) {
          break;//found the var in vf
        }
        if (vf.isolateWrites) {
          vf = null;
          break;
        }
        vf = vf.parent;
      }
      while (vf);

      if (!vf) {
        //the variable did not exist
        //declare a new variable in the current frame (or a parent if !createScope)
        vf = frame;
        while (!vf.createScope) {
          vf = vf.parent;//skip the frames that can not create a new scope
        }
        this.compiler._addDeclaredVar(vf, name);
      }
    }

    //count the sets in the current frame/async block, propagate the first write down the chain
    //do not count for the frame where the variable is declared
    while (frame != vf) {
      if (!frame.writeCounts || !frame.writeCounts[name]) {
        frame.writeCounts = frame.writeCounts || {};
        frame.writeCounts[name] = 1;//first write, countiune to the parent frames (only 1 write per async block is propagated)
      } else {
        frame.writeCounts[name]++;
        break;//subsequent writes are not propagated
      }
      frame = frame.parent;
    }
  }

  //@todo - handle included parent frames properly
  updateFrameReads(frame, name) {
    //find the variable declaration in the scope chain
    //let declared = false;
    let df = frame;
    do {
      if (df.declaredVars && df.declaredVars.has(name)) {
        //declared = true;
        break;//found the var declaration
      }
      df = df.parent;
    }
    while (df);//&& !df.isolateWrites );

    if (!df) {
      //a context variable
      return;
    }

    while (frame != df) {
      if ((frame.readVars && frame.readVars.has(name)) || (frame.writeCounts && frame.writeCounts[name])) {
        //found the var
        //if it's already in readVars - skip
        //if it's set here or by children - it will be snapshotted anyway, don't add
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
};

