'use strict';

var nodes = require('./nodes');
var lib = require('./lib');
var scopeBoundaries = require('./compiler/scope-boundaries');

var sym = 0;
function gensym() {
  return 'hole_' + sym++;
}

// copy-on-write version of map
function mapCOW(arr, func) {
  var res = null;
  for (let i = 0; i < arr.length; i++) {
    const item = func(arr[i]);

    if (item !== arr[i]) {
      if (!res) {
        res = arr.slice();
      }

      res[i] = item;
    }
  }

  return res || arr;
}

function walk(ast, func, depthFirst) {
  if (Array.isArray(ast)) {
    return mapCOW(ast, (node) => walk(node, func, depthFirst));
  }

  if (!(ast instanceof nodes.Node)) {
    return ast;
  }

  if (!depthFirst) {
    const astT = func(ast);

    if (astT && astT !== ast) {
      return astT;
    }
  }

  // The Root node is a NodeList, but it has custom fields so do not special-case NodeList
  /*if (ast instanceof nodes.NodeList) {
    const children = mapCOW(ast.children, (node) => walk(node, func, depthFirst));

    if (children !== ast.children) {
      ast = new nodes[ast.typename](ast.lineno, ast.colno, children);
    }
  } else */if (ast instanceof nodes.CallExtension) {
    const args = walk(ast.args, func, depthFirst);
    const contentArgs = mapCOW(ast.contentArgs, (node) => walk(node, func, depthFirst));

    if (args !== ast.args || contentArgs !== ast.contentArgs) {
      ast = new nodes[ast.typename](ast.extName, ast.prop, args, contentArgs);
    }
  } else {
    const props = ast.fields.map((field) => ast[field]);
    const propsT = mapCOW(props, (prop) => walk(prop, func, depthFirst));

    if (propsT !== props) {
      ast = new nodes[ast.typename](ast.lineno, ast.colno);
      propsT.forEach((prop, i) => {
        ast[ast.fields[i]] = prop;
      });
    }
  }

  return depthFirst ? (func(ast) || ast) : ast;
}

function depthWalk(ast, func) {
  return walk(ast, func, true);
}

function _liftFilters(node, asyncFilters, prop) {
  var children = [];

  var walked = depthWalk(prop ? node[prop] : node, (descNode) => {
    let symbol;
    if (descNode instanceof nodes.Block) {
      return descNode;
    } else if ((descNode instanceof nodes.Filter &&
      lib.indexOf(asyncFilters, descNode.name.value) !== -1) ||
      descNode instanceof nodes.CallExtensionAsync) {
      symbol = new nodes.Symbol(descNode.lineno,
        descNode.colno,
        gensym());

      symbol.isCompilerInternal = true;

      children.push(new nodes.FilterAsync(descNode.lineno,
        descNode.colno,
        descNode.name,
        descNode.args,
        symbol));
    }
    return symbol;
  });

  if (prop) {
    node[prop] = walked;
  } else {
    node = walked;
  }

  if (children.length) {
    children.push(node);

    return new nodes.NodeList(
      node.lineno,
      node.colno,
      children
    );
  } else {
    return node;
  }
}

function liftFilters(ast, asyncFilters) {
  return depthWalk(ast, (node) => {
    if (node instanceof nodes.Output) {
      return _liftFilters(node, asyncFilters);
    } else if (node instanceof nodes.Set) {
      return _liftFilters(node, asyncFilters, 'value');
    } else if (node instanceof nodes.For) {
      return _liftFilters(node, asyncFilters, 'arr');
    } else if (node instanceof nodes.If) {
      return _liftFilters(node, asyncFilters, 'cond');
    } else if (node instanceof nodes.CallExtension) {
      return _liftFilters(node, asyncFilters, 'args');
    } else {
      return undefined;
    }
  });
}

function liftSuper(ast) {
  return walk(ast, (blockNode) => {
    if (!(blockNode instanceof nodes.Block)) {
      return;
    }

    let hasSuper = false;
    const symbol = gensym();

    blockNode.body = walk(blockNode.body, (node) => {
      if (node instanceof nodes.FunCall && node.name.value === 'super') {
        hasSuper = true;
        const tempSymbolNode = new nodes.Symbol(node.lineno, node.colno, symbol);
        tempSymbolNode.isCompilerInternal = true;
        return tempSymbolNode;
      }
    });

    if (hasSuper) {
      const superNodeInternalSymbol = new nodes.Symbol(0, 0, symbol);
      superNodeInternalSymbol.isCompilerInternal = true;
      blockNode.body.children.unshift(new nodes.Super(
        0, 0, blockNode.name, superNodeInternalSymbol
      ));
    }
  });
}

function convertStatements(ast) {
  return depthWalk(ast, (node) => {
    if (!(node instanceof nodes.If) && !(node instanceof nodes.For)) {
      return undefined;
    }

    let async = false;
    walk(node, (child) => {
      if (child instanceof nodes.FilterAsync ||
        child instanceof nodes.IfAsync ||
        child instanceof nodes.AsyncEach ||
        child instanceof nodes.AsyncAll ||
        child instanceof nodes.CallExtensionAsync) {
        async = true;
        // Stop iterating by returning the node
        return child;
      }
      return undefined;
    });

    if (async) {
      if (node instanceof nodes.If) {
        return new nodes.IfAsync(
          node.lineno,
          node.colno,
          node.cond,
          node.body,
          node.else_
        );
      } else if (node instanceof nodes.For && !(node instanceof nodes.AsyncAll)) {
        return new nodes.AsyncEach(
          node.lineno,
          node.colno,
          node.arr,
          node.name,
          node.body,
          node.else_
        );
      }
    }
    return undefined;
  });
}

function cps(ast, asyncFilters) {
  return convertStatements(liftSuper(liftFilters(ast, asyncFilters)));
}

function rewriteImplicitLoopSymbol(ast, idPool) {
  let loopSym = 0;
  // These fields are evaluated outside the per-iteration body binding:
  // - arr / concurrentLimit belong to scheduler/control-flow evaluation
  // - else_ runs when no iteration body executes
  // They must keep the parent active loop symbol.
  const LOOP_NON_BODY_FIELDS = ['arr', 'concurrentLimit', 'else_'];
  function nextLoopSymbol() {
    // Reuse compiler's per-compilation id pool so generated temporary ids
    // and loop runtime aliases cannot collide.
    if (idPool && typeof idPool.next === 'function') {
      return 'loop#' + idPool.next();
    }
    return 'loop#' + (loopSym++);
  }
  function targetDeclaresLoop(targetNode) {
    if (!targetNode) {
      return false;
    }
    if (targetNode instanceof nodes.Symbol) {
      return targetNode.value === 'loop';
    }
    if (targetNode instanceof nodes.Array) {
      return targetNode.children.some((child) => targetDeclaresLoop(child));
    }
    return false;
  }

  function rewrite(node, activeLoopSymbol) {
    if (Array.isArray(node)) {
      node.forEach((child) => rewrite(child, activeLoopSymbol));
      return;
    }

    if (!(node instanceof nodes.Node)) {
      return;
    }

    if (node instanceof nodes.For || node instanceof nodes.AsyncEach || node instanceof nodes.AsyncAll) {
      const loopSymbol = nextLoopSymbol();
      // Persist per-loop runtime symbol on node so compiler/runtime can bind
      // metadata output without relying on lexical name "loop". The suffix
      // makes each loop binding canonical and scope-stable.
      node.loopRuntimeName = loopSymbol;
      const loopIsShadowedByTarget = targetDeclaresLoop(node.name);

      // Non-body zones execute outside iteration binding and keep parent loop scope.
      // Do not rewrite declaration targets (`name`): they are bindings, not reads.
      LOOP_NON_BODY_FIELDS.forEach((field) => {
        rewrite(node[field], activeLoopSymbol);
      });

      // Only iteration body executes with this loop binding.
      // If target declares `loop`, it shadows loop metadata in this scope.
      rewrite(node.body, loopIsShadowedByTarget ? null : loopSymbol);
      return;
    }

    if (node instanceof nodes.While) {
      const loopSymbol = nextLoopSymbol();
      node.loopRuntimeName = loopSymbol;

      // Async while compiles condition inside iteration body.
      rewrite(node.cond, loopSymbol);
      rewrite(node.body, loopSymbol);
      return;
    }

    if (node instanceof nodes.Symbol &&
      activeLoopSymbol &&
      node.value === 'loop' &&
      !node.isCompilerInternal) {
      // Rewrite user-facing loop metadata symbol to the per-loop runtime symbol.
      node.value = activeLoopSymbol;
      return;
    }

    // Set/CallAssign capture bodies are on `.body` but not included in `fields`.
    if ((node instanceof nodes.Set || node instanceof nodes.CallAssign) && node.body) {
      rewrite(node.body, activeLoopSymbol);
    }

    node.fields.forEach((field) => {
      rewrite(node[field], activeLoopSymbol);
    });
  }

  rewrite(ast, null);
  return ast;
}

function rewriteDuplicateDeclarations(ast, idPool) {
  const scopeStack = [new Map()];
  const declarationCounts = new Map();
  const scopeRules = scopeBoundaries;

  function currentScope() {
    return scopeStack[scopeStack.length - 1];
  }

  function lookupRenamed(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const mapped = scopeStack[i].get(name);
      if (mapped) {
        return mapped;
      }
    }
    return null;
  }

  function nextRenamed(name) {
    const nextCount = (declarationCounts.get(name) || 0) + 1;
    declarationCounts.set(name, nextCount);
    if (nextCount === 1) {
      return name;
    }
    if (idPool && typeof idPool.next === 'function') {
      // Share compiler/transformer id space for deterministic, collision-free aliases.
      return `${name}#${idPool.next()}`;
    }
    return `${name}#${nextCount - 1}`;
  }

  function registerDeclarations(symbols, scopeMap) {
    symbols.forEach((symbol) => {
      if (!(symbol instanceof nodes.Symbol) || symbol.isCompilerInternal) {
        return;
      }
      const sourceName = symbol.value;
      const renamed = nextRenamed(sourceName);
      // Rewrite declaration target in-place and remember source->runtime mapping
      // for subsequent reads inside the active lexical scope chain.
      symbol.value = renamed;
      scopeMap.set(sourceName, renamed);
    });
  }

  function withScope(fn) {
    scopeStack.push(new Map());
    fn();
    scopeStack.pop();
  }

  function rewrite(node) {
    if (Array.isArray(node)) {
      node.forEach(rewrite);
      return;
    }

    if (!(node instanceof nodes.Node)) {
      return;
    }

    if (node instanceof nodes.Symbol && !node.isCompilerInternal) {
      const mapped = lookupRenamed(node.value);
      if (mapped) {
        // Symbol reads/writes resolve to the nearest active declaration mapping.
        node.value = mapped;
      }
      return;
    }

    const boundaryFields = scopeRules.getScopeBoundaryFields(node);
    const boundarySet = new Set(boundaryFields);

    // Current-scope declarations.
    const declarationContexts = [
      {},
      { inImportTarget: true },
      { inFromImportTarget: true }
    ];
    for (let i = 0; i < declarationContexts.length; i++) {
      const ctx = declarationContexts[i];
      if (!scopeRules.isDeclarationSite(node, ctx)) {
        continue;
      }
      registerDeclarations(scopeRules.extractDeclaredSymbols(node, ctx), currentScope());
      break;
    }

    // Non-boundary fields remain in the current lexical scope.
    node.fields.forEach((field) => {
      if (boundarySet.has(field)) {
        return;
      }
      rewrite(node[field]);
    });

    // Boundary fields each execute in child lexical scopes.
    boundaryFields.forEach((field) => {
      const value = node[field];
      if (Array.isArray(value)) {
        value.forEach((child) => {
          // Each branch/case/body gets its own lexical declaration scope.
          withScope(() => {
            rewrite(child);
          });
        });
        return;
      }

      if (value instanceof nodes.Node || value != null) {
        withScope(() => {
          rewrite(value);
        });
      }
    });
  }

  rewrite(ast);
  return ast;
}

function transform(ast, asyncFilters, name, opts) {
  if (opts.asyncMode) {
    ast = addDynamicExtendsSetup(ast, opts);
  }
  ast = cps(ast, asyncFilters || []);
  if (opts.asyncMode) {
    ast = rewriteImplicitLoopSymbol(ast, opts && opts.idPool);
  }
  if (opts.asyncMode) {
    ast = rewriteDuplicateDeclarations(ast, opts && opts.idPool);
  }
  return ast;
}

function addDynamicExtendsSetup(ast, opts) {
  let hasDynamicExtends = false;

  // First, walk the tree to find all Extends nodes.
  const allExtends = [];
  walk(ast, (node) => {
    if (node instanceof nodes.Extends) {
      allExtends.push(node);
    }
  });

  if (allExtends.length === 0) {
    return ast;
  }

  // Check if any are dynamic (not a direct child of Root).
  for (const extendNode of allExtends) {
    if (lib.indexOf(ast.children, extendNode) === -1) {
      hasDynamicExtends = true;
      break;
    }
  }

  if (!hasDynamicExtends) {
    return ast;
  }

  // 1. Inject the initial parent-template binding.
  const target = new nodes.Symbol(0, 0, '__parentTemplate');
  const value = new nodes.Literal(0, 0, null);
  const declarationNode = new nodes.Set(0, 0, [target], value);
  declarationNode.varType = !opts.scriptMode
    ? 'declaration'
    : 'declaration';
  ast.children.unshift(declarationNode);

  // 2. Rewrite every dynamic `Extends` node into a `NodeList` of [Extends, Set].
  return walk(ast, (node) => {
    if (node instanceof nodes.Extends && lib.indexOf(ast.children, node) === -1) {
      const tempVar = gensym();

      // A. Modify the original Extends node to store its result in the temp var.
      node.asyncStoreIn = tempVar;

      // B. Create the new Set node to assign from the temp var to the frame var.
      const setTarget = new nodes.Symbol(node.lineno, node.colno, '__parentTemplate');
      const setValue = new nodes.Symbol(node.lineno, node.colno, tempVar);
      setValue.isCompilerInternal = true; // This is the crucial link!

      const setNode = new nodes.Set(node.lineno, node.colno, [setTarget], setValue);
      setNode.varType = !opts.scriptMode
        ? 'assignment'
        : 'assignment';

      // C. Replace the original Extends node with a list of the two new nodes.
      return new nodes.NodeList(node.lineno, node.colno, [node, setNode]);
    }
    return undefined;
  });
}

function _buildSequentialPathNode(lockName, node, isRepair) {
  const parts = (lockName || '').split('!').filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid sequence lock name "${lockName}"`);
  }

  let pathNode = new nodes.Symbol(node.lineno, node.colno, parts[0]);
  if (parts.length === 1) {
    pathNode.sequential = true;
    if (isRepair) {
      pathNode.sequentialRepair = true;
    }
    return pathNode;
  }

  for (let i = 1; i < parts.length; i++) {
    const key = new nodes.Literal(node.lineno, node.colno, parts[i]);
    pathNode = new nodes.LookupVal(node.lineno, node.colno, pathNode, key);
  }

  pathNode.sequential = true;
  if (isRepair) {
    pathNode.sequentialRepair = true;
  }
  return pathNode;
}

function _makeCompilerInternalSymbol(name, node, makeCompilerInternalSymbol) {
  if (typeof makeCompilerInternalSymbol === 'function') {
    return makeCompilerInternalSymbol(name, node);
  }
  const symbol = new nodes.Symbol(node.lineno, node.colno, name);
  symbol.isCompilerInternal = true;
  return symbol;
}

function _buildGuardErrorSetNode(guardErrorVarName, guardErrorTargets, node) {
  const targetSymbol = new nodes.Symbol(node.lineno, node.colno, guardErrorVarName);
  const targets = [targetSymbol];

  if (!Array.isArray(guardErrorTargets) || guardErrorTargets.length === 0) {
    return new nodes.Set(
      node.lineno,
      node.colno,
      targets,
      new nodes.Literal(node.lineno, node.colno, null),
      'declaration'
    );
  }

  const mergeFn = new nodes.Symbol(node.lineno, node.colno, '_mergeErrors');
  const args = guardErrorTargets.map((name) => {
    const targetNode = (name && name.charAt(0) === '!')
      ? _buildSequentialPathNode(name, node, false)
      : new nodes.Symbol(node.lineno, node.colno, name);
    return new nodes.PeekError(node.lineno, node.colno, targetNode);
  });
  const argList = new nodes.NodeList(node.lineno, node.colno, args);
  const mergeCall = new nodes.FunCall(node.lineno, node.colno, mergeFn, argList);
  return new nodes.Set(node.lineno, node.colno, targets, mergeCall, 'declaration');
}

function _buildGuardSequenceRepairNode(lockName, node) {
  const repairTarget = _buildSequentialPathNode(lockName, node, true);
  return new nodes.Do(node.lineno, node.colno, [repairTarget]);
}

function _buildGuardRestoreOutputCommandNode(handlerName, snapshotsVarName, node, makeCompilerInternalSymbol) {
  const handlerSymbol = new nodes.Symbol(node.lineno, node.colno, handlerName);
  const methodLookup = new nodes.LookupVal(
    node.lineno,
    node.colno,
    handlerSymbol,
    new nodes.Literal(node.lineno, node.colno, '__restoreGuardState')
  );
  const snapshotLookup = new nodes.LookupVal(
    node.lineno,
    node.colno,
    _makeCompilerInternalSymbol(snapshotsVarName, node, makeCompilerInternalSymbol),
    new nodes.Literal(node.lineno, node.colno, handlerName)
  );
  const args = new nodes.NodeList(node.lineno, node.colno, [snapshotLookup]);
  const call = new nodes.FunCall(node.lineno, node.colno, methodLookup, args);
  const outputCommandNode = new nodes.OutputCommand(node.lineno, node.colno, call);
  outputCommandNode.isCompilerInternal = true;
  return outputCommandNode;
}

function _buildGuardRecoveryIfNode({
  guardErrorVarName,
  snapshotHandlers,
  guardSnapshotsVar,
  recoveryBody,
  errorVar,
  node,
  makeCompilerInternalSymbol
}) {
  const guardErrorSymbol = new nodes.Symbol(node.lineno, node.colno, guardErrorVarName);
  const cond = new nodes.Compare(
    node.lineno,
    node.colno,
    guardErrorSymbol,
    [new nodes.CompareOperand(node.lineno, node.colno, new nodes.Literal(node.lineno, node.colno, null), '!=')]
  );

  const bodyChildren = [];

  if (guardSnapshotsVar) {
    snapshotHandlers.forEach((handlerName) => {
      bodyChildren.push(_buildGuardRestoreOutputCommandNode(handlerName, guardSnapshotsVar, node, makeCompilerInternalSymbol));
    });
  }

  if (recoveryBody) {
    if (errorVar) {
      const errorTargets = [new nodes.Symbol(node.lineno, node.colno, errorVar)];
      const errorAssign = new nodes.Set(
        node.lineno,
        node.colno,
        errorTargets,
        new nodes.Symbol(node.lineno, node.colno, guardErrorVarName),
        'declaration'
      );
      bodyChildren.push(errorAssign);
    }
    recoveryBody.children.forEach((child) => bodyChildren.push(child));
  }

  const ifBody = new nodes.NodeList(node.lineno, node.colno, bodyChildren);
  return new nodes.If(node.lineno, node.colno, cond, ifBody, null);
}

function buildGuardLoweringAst({
  guardErrorVarName,
  guardErrorTargets,
  resolvedSequenceTargets,
  snapshotHandlers,
  guardSnapshotsVar,
  recoveryBody,
  errorVar,
  node,
  makeCompilerInternalSymbol
}) {
  const guardErrorSetNode = _buildGuardErrorSetNode(guardErrorVarName, guardErrorTargets, node);
  const sequenceRepairNodes = Array.isArray(resolvedSequenceTargets)
    ? resolvedSequenceTargets.map((lockName) => _buildGuardSequenceRepairNode(lockName, node))
    : [];
  const recoveryIfNode = _buildGuardRecoveryIfNode({
    guardErrorVarName,
    snapshotHandlers,
    guardSnapshotsVar,
    recoveryBody,
    errorVar,
    node,
    makeCompilerInternalSymbol
  });
  return {
    guardErrorSetNode,
    sequenceRepairNodes,
    recoveryIfNode
  };
}

// var parser = require('./parser');
// var src = 'hello {% foo %}{% endfoo %} end';
// var ast = transform(parser.parse(src, [new FooExtension()]), ['bar']);
// nodes.printNodes(ast);

module.exports = {
  transform: transform,
  buildGuardLoweringAst: buildGuardLoweringAst
};
