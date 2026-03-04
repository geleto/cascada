'use strict';

var nodes = require('./nodes');
var lib = require('./lib');
var { LOOP_VARS_USE_VALUE } = require('./feature-flags');

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

function rewriteImplicitLoopSymbol(ast) {
  let loopSym = 0;
  // These fields are evaluated outside the per-iteration body binding:
  // - arr / concurrentLimit belong to scheduler/control-flow evaluation
  // - else_ runs when no iteration body executes
  // They must keep the parent active loop symbol.
  const LOOP_NON_BODY_FIELDS = ['arr', 'concurrentLimit', 'else_'];
  function nextLoopSymbol() {
    return '__loop__' + (loopSym++);
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

  function containsIncludeForCurrentLoop(node, atTopLoopBody) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (containsIncludeForCurrentLoop(node[i], false)) {
          return true;
        }
      }
      return false;
    }

    if (!(node instanceof nodes.Node)) {
      return false;
    }

    if (node instanceof nodes.Include) {
      return true;
    }

    // Do not let nested loops force aliasing for the parent loop.
    if (!atTopLoopBody &&
      (node instanceof nodes.For || node instanceof nodes.AsyncEach || node instanceof nodes.AsyncAll || node instanceof nodes.While)) {
      return false;
    }

    // Capture/call bodies are not part of node.fields and must be visited
    // explicitly so include-compat aliasing is enabled when needed.
    if ((node instanceof nodes.Set || node instanceof nodes.CallAssign) &&
      node.body &&
      containsIncludeForCurrentLoop(node.body, false)) {
      return true;
    }

    for (let i = 0; i < node.fields.length; i++) {
      if (containsIncludeForCurrentLoop(node[node.fields[i]], false)) {
        return true;
      }
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
      // metadata output without relying on lexical name "loop".
      node.loopRuntimeName = loopSymbol;
      // Includes read from context variables, so some loop bodies need a
      // compatibility alias for plain "loop" in addition to loopRuntimeName.
      node.needsLoopAlias = containsIncludeForCurrentLoop(node.body, true);
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
      node.needsLoopAlias = containsIncludeForCurrentLoop(node.body, true);

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

function transform(ast, asyncFilters, name, opts) {
  if (opts.asyncMode) {
    ast = addDynamicExtendsSetup(ast, opts);
  }
  ast = cps(ast, asyncFilters || []);
  if (opts.asyncMode && LOOP_VARS_USE_VALUE) {
    return rewriteImplicitLoopSymbol(ast);
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

  // 1. Inject the initial `{% set __parentTemplate = null; %}`
  const target = new nodes.Symbol(0, 0, '__parentTemplate');
  const value = new nodes.Literal(0, 0, null);
  const declarationNode = new nodes.Set(0, 0, [target], value);
  declarationNode.varType = opts.scriptMode ? 'declaration' : 'assignment';
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
      setNode.varType = 'assignment';

      // C. Replace the original Extends node with a list of the two new nodes.
      return new nodes.NodeList(node.lineno, node.colno, [node, setNode]);
    }
    return undefined;
  });
}

// var parser = require('./parser');
// var src = 'hello {% foo %}{% endfoo %} end';
// var ast = transform(parser.parse(src, [new FooExtension()]), ['bar']);
// nodes.printNodes(ast);

module.exports = {
  transform: transform
};
