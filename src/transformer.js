'use strict';

var nodes = require('./nodes');
var lib = require('./lib');
var scopeBoundaries = require('./compiler/scope-boundaries');
const { getScriptExtendsSourceOrderViolation } = require('./compiler/validation');

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

function liftMethodLikeSuperCalls(bodyNode, blockName) {
  if (!bodyNode) {
    return bodyNode;
  }

  const superNodes = [];

  const rewrittenBody = walk(bodyNode, (node) => {
    if (node instanceof nodes.FunCall && node.name && node.name.value === 'super') {
      const args = node.args && node.args.children ? node.args.children : [];
      if (args.length > 0) {
        return new nodes.Super(
          node.lineno,
          node.colno,
          blockName,
          null,
          node.args || new nodes.NodeList(node.lineno, node.colno)
        );
      }
      const symbol = gensym();
      const tempSymbolNode = new nodes.Symbol(node.lineno, node.colno, symbol);
      tempSymbolNode.isCompilerInternal = true;
      const superNodeInternalSymbol = new nodes.Symbol(node.lineno, node.colno, symbol);
      superNodeInternalSymbol.isCompilerInternal = true;
      superNodes.push(new nodes.Super(
        node.lineno,
        node.colno,
        blockName,
        superNodeInternalSymbol,
        node.args || new nodes.NodeList(node.lineno, node.colno)
      ));
      return tempSymbolNode;
    }
    return undefined;
  });

  if (superNodes.length > 0 && rewrittenBody && Array.isArray(rewrittenBody.children)) {
    rewrittenBody.children.unshift(...superNodes);
  }

  return rewrittenBody;
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

    blockNode.body = liftMethodLikeSuperCalls(blockNode.body, blockNode.name);
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

function normalizeAsyncCompilerNodes(ast) {
  return walk(ast, (node) => {
    if (node instanceof nodes.IfAsync) {
      return new nodes.If(node.lineno, node.colno, node.cond, node.body, node.else_);
    }
    return undefined;
  });
}

function isRootConstructorDefinitionNode(node) {
  return (
    node instanceof nodes.Block ||
    node instanceof nodes.Macro
  );
}

function createSyntheticConstructorMethod(constructorChildren, fallbackNode) {
  if (!Array.isArray(constructorChildren) || constructorChildren.length === 0) {
    return null;
  }

  const firstNode = constructorChildren[0] || fallbackNode;
  const constructorMethod = new nodes.MethodDefinition(
    firstNode ? firstNode.lineno : 0,
    firstNode ? firstNode.colno : 0,
    new nodes.Symbol(
      firstNode ? firstNode.lineno : 0,
      firstNode ? firstNode.colno : 0,
      '__constructor__'
    ),
    new nodes.NodeList(
      firstNode ? firstNode.lineno : 0,
      firstNode ? firstNode.colno : 0,
      []
    ),
    new nodes.NodeList(
      firstNode ? firstNode.lineno : 0,
      firstNode ? firstNode.colno : 0,
      constructorChildren
    ),
    false
  );
  constructorMethod.isSyntheticConstructor = true;
  constructorMethod.body = liftMethodLikeSuperCalls(constructorMethod.body, constructorMethod.name);
  return constructorMethod;
}

// @todo - do this after analysis, rename both AST nodes and analysis nodes
// use the analysis data for scoping, etc...!!!
function renameConflictingDeclarations(ast, idPool) {
  const scopeStack = [new Map()];
  const declarationCounts = new Map();
  const scopeRules = scopeBoundaries;
  function getNonBoundaryTraversalFields(node, boundarySet) {
    const fields = node.fields.filter((field) => !boundarySet.has(field));
    if (node instanceof nodes.Root) {
      fields.sort((left, right) => {
        if (left === 'children') {
          return -1;
        }
        if (right === 'children') {
          return 1;
        }
        return 0;
      });
    }
    return fields;
  }

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
    getNonBoundaryTraversalFields(node, boundarySet).forEach((field) => {
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
  ast = cps(ast, asyncFilters || []);
  if (opts.asyncMode) {
    ast = extractAsyncInheritanceMetadata(ast, !!opts.scriptMode);
  }
  if (opts.asyncMode) {
    ast = normalizeAsyncCompilerNodes(ast);
    ast = renameConflictingDeclarations(ast, opts && opts.idPool);
  }
  return ast;
}

function extractAsyncInheritanceMetadata(ast, scriptMode) {
  if (!(ast instanceof nodes.Root)) {
    return ast;
  }

  if (scriptMode) {
    const hasDirectExtends = (ast.children || []).some((child) => child instanceof nodes.Extends);
    if (hasDirectExtends) {
      const violation = getScriptExtendsSourceOrderViolation(ast);
      if (violation) {
        const error = new Error(violation.message);
        if (violation.node) {
          error.lineno = violation.node.lineno;
          error.colno = violation.node.colno;
        }
        throw error;
      }
    }
  }
  const methodNodes = [];
  const sharedDeclarations = [];
  const executableChildren = [];

  (ast.children || []).forEach((child) => {
    if (scriptMode && child instanceof nodes.Block) {
      methodNodes.push(new nodes.MethodDefinition(
        child.lineno,
        child.colno,
        child.name,
        child.args,
        child.body,
        child.withContext
      ));
      return;
    }
    if (child instanceof nodes.ChannelDeclaration && child.isShared) {
      sharedDeclarations.push(child);
      return;
    }
    executableChildren.push(child);
  });

  let extendsIndex = -1;
  for (let i = 0; i < executableChildren.length; i++) {
    if (executableChildren[i] instanceof nodes.Extends) {
      extendsIndex = i;
      break;
    }
  }

  const remainingChildren = [];
  const constructorChildren = [];

  executableChildren.forEach((child, index) => {
    const shouldLiftIntoConstructor = extendsIndex !== -1 &&
      index > extendsIndex &&
      !isRootConstructorDefinitionNode(child);
    if (shouldLiftIntoConstructor) {
      constructorChildren.push(child);
      return;
    }
    remainingChildren.push(child);
  });

  const constructorMethod = createSyntheticConstructorMethod(constructorChildren, ast);
  if (constructorMethod) {
    methodNodes.push(constructorMethod);
  }

  ast.children = remainingChildren;
  ast.inheritanceMetadata = new nodes.InheritanceMetadata(
    ast.lineno,
    ast.colno,
    new nodes.NodeList(ast.lineno, ast.colno, methodNodes),
    new nodes.SharedDeclarations(ast.lineno, ast.colno, sharedDeclarations)
  );
  return ast;
}

// var parser = require('./parser');
// var src = 'hello {% foo %}{% endfoo %} end';
// var ast = transform(parser.parse(src, [new FooExtension()]), ['bar']);
// nodes.printNodes(ast);

module.exports = {
  transform: transform
};
