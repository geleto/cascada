'use strict';

const parser = require('../parser');
const transformer = require('../transformer');
const nodes = require('../nodes');
const { Frame, AsyncFrame } = require('../runtime');
const CompileSequential = require('./compile-sequential');
const CompileEmit = require('./compile-emit');
const CompileAsync = require('./compile-async');
const CompilerBase = require('./compiler-base');

class Compiler extends CompilerBase {
  init(templateName, options) {
    // Initialize base properties like codebuf, asyncMode, etc.
    super.init(options);

    // Properties specific to the full statement-aware compiler
    this.templateName = templateName;
    this.buffer = null;
    this.bufferStack = [];
    this.hasExtends = false;
    this.inBlock = false;

    // Instantiate and link helper modules
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = new CompileAsync(this);
  }


  _pushBuffer() {
    const id = this._tmpid();
    this.bufferStack.push(this.buffer);
    this.buffer = id;
    if (this.asyncMode) {
      this.emit.line(`let ${this.buffer} = []; let ${this.buffer}_index = 0;`);
    } else {
      this.emit.line(`let ${this.buffer} = "";`);
    }
    return id;
  }

  _popBuffer() {
    this.buffer = this.bufferStack.pop();
  }



  _templateName() {
    return this.templateName === null ? 'undefined' : JSON.stringify(this.templateName);
  }

  _addDeclaredVar(frame, varName) {
    if (this.asyncMode || this.scriptMode) {
      if (!frame.declaredVars) {
        frame.declaredVars = new Set();
      }
      frame.declaredVars.add(varName);
    }
  }

  /**
   * Extracts a static path from a LookupVal node chain.
   * A static path consists only of Symbol and Literal nodes in a chain.
   * Returns null if the path is not static (contains expressions, function calls, etc.)
   *
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

  /**
   * Recursively collect all output handlers written to within a node's subtree.
   * Used to determine which handlers need poison markers when branch is skipped.
   *
   * @param {Node} node - AST node to analyze
   * @returns {Set<string>} Set of handler names ('text', 'data', etc.)
   */
  _collectBranchHandlers(node) {
    const handlers = new Set();

    const traverse = (n) => {
      if (!n) return;

      // Case 1: Regular output {{ ... }} uses implicit 'text' handler
      if (n instanceof nodes.Output) {
        handlers.add('text');
      }

      // Case 2: OutputCommand @handler.method() or @handler()
      if (n instanceof nodes.OutputCommand) {
        const staticPath = this._extractStaticPath(n.call.name);
        if (staticPath && staticPath.length > 0) {
          const handlerName = staticPath[0]; // First segment is always handler name
          handlers.add(handlerName);
        }
      }

      // Recurse into all children
      const children = this._getImmediateChildren(n);
      children.forEach(child => traverse(child));
    };

    traverse(node);
    return handlers;
  }

  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  //todo


  compileCallExtension(node, frame) {
    this._compileCallExtension(node, frame, false);
  }

  /**
   * CallExtension - no callback, can return either value or promise
   * CallExtensionAsync - uses callback, async = true. This was the way to handle the old nunjucks async
   * @todo - rewrite with _emitAggregate
   */
  _compileCallExtension(node, frame, async) {
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async;//assign the return value directly, no callback
    var resolveArgs = node.resolveArgs && node.isAsync;
    const positionNode = args || node; // Prefer args position if available

    let errorContextJson;
    if (noExtensionCallback || node.isAsync) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);

      frame = this.emit.asyncBlockAddToBufferBegin(node, frame, positionNode);
      errorContextJson = node.isAsync ? JSON.stringify(this._createErrorContext(node, positionNode)) : '';
      this.emit(node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
      if (noExtensionCallback) {
        //the extension returns a value directly
        if (!resolveArgs) {
          //send the arguments as they are - promises or values
          this.emit(`${ext}["${node.prop}"](context`);
        }
        else {
          //resolve the arguments before calling the function
          this.emit(`runtime.resolveArguments(${ext}["${node.prop}"].bind(${ext}), 1)(context`);
        }
      } else {
        //isAsync, the callback should be promisified
        if (!resolveArgs) {
          this.emit(`runtime.promisify(${ext}["${node.prop}"].bind(${ext}))(context`);
        }
        else {
          this.emit(`runtime.resolveArguments(runtime.promisify(${ext}["${node.prop}"].bind(${ext})), 1)(context`);
        }
      }
    } else {
      //use the original nunjucks callback mechanism
      this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
    }

    if ((args && args.children.length) || contentArgs.length) {
      this.emit(',');
    }

    if (args) {
      if (!(args instanceof nodes.NodeList)) {
        this.fail('compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`', node.lineno, node.colno, node);
      }

      args.children.forEach((arg, i) => {
        // Tag arguments are passed normally to the call. Note
        // that keyword arguments are turned into a single js
        // object as the last argument, if they exist.
        this.compile(arg, frame);

        if (i !== args.children.length - 1 || contentArgs.length) {
          this.emit(',');
        }
      });
    }

    if (contentArgs.length) {
      contentArgs.forEach((arg, i) => {
        if (i > 0) {
          this.emit(',');
        }

        if (arg) {
          if (node.isAsync && !resolveArgs) {
            //when args are not resolved, the contentArgs are promises
            this.emit.asyncBlockRender(node, frame, function (f) {
              this.compile(arg, f);
            }, null, arg); // Use content arg node for position
          }
          else {
            //when not resolve args, the contentArgs are callback functions
            this.emit.line('function(cb) {');
            this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this.emit.withScopedSyntax(() => {
              this.emit.asyncBlockRender(node, frame, function (f) {
                this.compile(arg, f);
              }, 'cb', arg); // Use content arg node for position
              this.emit.line(';');
            });

            this.emit.line('}');//end callback
          }
        } else {
          this.emit('null');
        }
      });
    }

    if (noExtensionCallback || node.isAsync) {
      this.emit(`)`);//close the extension call
      if (node.isAsync) {
        this.emit(`, ${autoescape} && env.opts.autoescape, ${errorContextJson});`);//end of suppressValue
      } else {
        this.emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
      }
      frame = this.emit.asyncBlockAddToBufferEnd(node, frame, positionNode);
    } else {
      const res = this._tmpid();
      this.emit.line(', ' + this._makeCallback(res));
      frame = this.emit.asyncBlockAddToBufferBegin(node, frame, positionNode);
      const errorContextJson2 = node.isAsync ? JSON.stringify(this._createErrorContext(node, positionNode)) : '';
      if (node.isAsync) {
        this.emit(`await runtime.suppressValueAsync(${res}, ${autoescape} && env.opts.autoescape, ${errorContextJson2});`);
      } else {
        this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
      }
      frame = this.emit.asyncBlockAddToBufferEnd(node, frame, positionNode);

      this.emit.addScopeLevel();
    }
  }

  compileCallExtensionAsync(node, frame) {
    this._compileCallExtension(node, frame, true);
  }

  compileNodeList(node, frame) {
    this._compileChildren(node, frame);
  }










  // @todo - add the variable in declaredVars in non-async modeW
  compileSet(node, frame) {
    const ids = [];

    // 1. First pass: Validate, declare, and prepare temporary JS variables for all targets.
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      if (this.scriptMode) {
        // Script mode: Enforce strict var/set/extern rules.
        const isDeclared = this._isDeclared(frame, name);

        switch (node.varType) {
          case 'declaration': // from 'var'
            if (isDeclared) {
              this.fail(`Identifier '${name}' has already been declared.`, target.lineno, target.colno, node, target);
            }
            break;
          case 'assignment': // from '='
            if (!isDeclared) {
              this.fail(`Cannot assign to undeclared variable '${name}'. Use 'var' to declare a new variable.`, target.lineno, target.colno, node, target);
            }
            break;
          case 'extern': // from 'extern'
            if (isDeclared) {
              this.fail(`Identifier '${name}' has already been declared.`, target.lineno, target.colno, node, target);
            }
            if (node.value) {
              this.fail('extern variables cannot be initialized at declaration.', node.lineno, node.colno, node);
            }
            break;
          default:
            this.fail(`Unknown varType '${node.varType}' for set/var statement.`, node.lineno, node.colno, node);
        }

        // In script mode, we always generate a new temporary JS variable for the assignment.
        id = this._tmpid();
        this.emit.line('let ' + id + ';');

      } else {
        // TEMPLATE MODE: Replicates the original, tested behavior.
        if (node.varType !== 'assignment') { // 'set' is the only valid type
          this.fail(`'${node.varType}' is not allowed in template mode. Use 'set'.`, node.lineno, node.colno, node);
        }

        // Look up the existing temporary variable ID. This is the crucial part
        // for template-mode re-assignments.
        id = frame.lookup(name);
        if (id === null || id === undefined) {
          // If it's a new variable in this scope, generate a new ID and declare it.
          id = this._tmpid();
          this.emit.line('let ' + id + ';');
        }
      }

      ids.push(id);

      // This call is common and crucial for async operations in both modes.
      if (this.asyncMode) {
        this.async.updateFrameWrites(frame, name);
      } else if (this.scriptMode) {
        this._addDeclaredVar(frame, name);
      }
    });

    // 2. Compile the value/body assignment.
    if (node.varType !== 'extern') { // `extern` has no value.
      if (node.value) { // e.g., set x = 123
        this.emit(ids.join(' = ') + ' = ');
        this._compileExpression(node.value, frame, true, node.value);
      } else { // e.g., set x = capture ...
        this.emit(ids.join(' = ') + ' = ');
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          this.compile(n.body, f);
        }, undefined, node.body);
      }
      this.emit.line(';');
    }


    // 3. Second pass: Set the variables in the frame and update context/exports.
    node.targets.forEach((target, i) => {
      const id = ids[i];
      const name = target.value;
      // The JS value for an 'extern' variable is null.
      const valueId = (node.varType === 'extern') ? 'null' : id;

      // This is common to both modes.
      this.emit.line(`frame.set("${name}", ${valueId}, true);`);

      // This block is specific to template mode's behavior.
      if (!this.scriptMode) {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.setVariable("${name}", ${valueId});`);
        this.emit.line('}');
      }

      // This export logic is common to both modes.
      if (name.charAt(0) !== '_') {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.addExport("${name}", ${valueId});`);
        this.emit.line('}');
      }
    });
  }

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    // Use node.expr as the primary position node for the overall switch block
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, false, node.expr);

    const branchPositions = [];
    const branchWriteCounts = [];

    // Emit switch statement
    this.emit('switch (');
    this._compileAwaitedExpression(node.expr, frame, false);
    this.emit(') {');

    // Compile cases
    node.cases.forEach((c, i) => {
      this.emit('case ');
      this._compileAwaitedExpression(c.cond, frame, false);
      this.emit(': ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      if (c.body.children.length) {
        // Use case body 'c.body' as position node for this block
        this.emit.asyncBlock(c, frame, false, (f) => {
          this.compile(c.body, f);
          branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});
        }, c.body); // Pass body as code position
        this.emit.line('break;');
      }
    });

    // Compile default case, if present
    if (node.default) {
      this.emit('default: ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      // Use default body 'node.default' as position node for this block
      this.emit.asyncBlock(node, frame, false, (f) => {
        this.compile(node.default, f);
        branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});
      }, node.default); // Pass default as code position
    }

    this.emit('}');

    // Combine writes from all branches
    const totalWrites = this._combineWriteCounts(branchWriteCounts);

    // Helper to exclude current branch writes from combined writes
    const excludeCurrentWrites = (combined, current) => {
      const filtered = { ...combined };
      if (current) {
        Object.keys(current).forEach((key) => {
          if (filtered[key]) {
            filtered[key] -= current[key];
            if (filtered[key] <= 0) {
              delete filtered[key];
            }
          }
        });
      }
      return filtered;
    };

    // Insert skip statements for each case, including default
    branchPositions.forEach((pos, i) => {
      const writesToSkip = excludeCurrentWrites(totalWrites, branchWriteCounts[i]);
      if (Object.keys(writesToSkip).length > 0) {
        this.emit.insertLine(pos, `frame.skipBranchWrites(${JSON.stringify(writesToSkip)});`);
      }
    });

    // Use node.expr (passed earlier) for the end block
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, false, false, node.expr);
  }

  /**
 * Combine multiple write count objects by adding values for each variable.
 * Used to calculate total potential writes across all branches (if/else, switch cases).
 *
 * @param {Array<Object>} counts - Array of write count objects
 * @returns {Object} Combined write counts with summed values
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

  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if (this.asyncMode && node.isAsync) {
      async = false;//old type of async
    }

    // Use node.cond as the position node for the overarching If block
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, false, node.cond);

    let trueBranchWriteCounts, falseBranchWriteCounts;
    let trueBranchCodePos;
    let poisonCheckPos, catchPoisonPos;

    if (this.asyncMode) {
      // Async mode: Add try-catch wrapper for poison condition handling
      this.emit('try {');
      this.emit('const condResult = ');
      this._compileAwaitedExpression(node.cond, frame, false);
      this.emit(';');
      this.emit('');
      this.emit('if (runtime.isPoison(condResult)) {');
      poisonCheckPos = this.codebuf.length;
      this.emit('');
      this.emit('} else if (condResult) {');
    } else {
      // Sync mode: unchanged
      this.emit('if(');
      this._compileAwaitedExpression(node.cond, frame, false);
      this.emit('){');
    }

    if (this.asyncMode) {
      trueBranchCodePos = this.codebuf.length;
      this.emit('');
      // Use node.body as the position node for the true branch block
      this.emit.asyncBlock(node, frame, false, (f) => {
        this.compile(node.body, f);
        trueBranchWriteCounts = this.async.countsTo1(f.writeCounts);
      }, node.body); // Pass body as code position
    }
    else {
      this.emit.withScopedSyntax(() => {
        this.compile(node.body, frame);
        if (async) {
          this.emit('cb()');
        }
      });
    }

    this.emit('} else {');

    if (trueBranchWriteCounts) {
      //skip the true branch writes in the false branch
      this.emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
    }

    if (node.else_) {
      if (this.asyncMode) {
        // Use node.else_ as the position node for the false branch block
        this.emit.asyncBlock(node, frame, false, (f) => {
          this.compile(node.else_, f);
          falseBranchWriteCounts = this.async.countsTo1(f.writeCounts);
        }, node.else_); // Pass else as code position
      }
      else {
        this.emit.withScopedSyntax(() => {
          this.compile(node.else_, frame);
          if (async) {
            this.emit('cb()');
          }
        });
      }
    } else {
      if (async && !this.asyncMode) {
        this.emit('cb()');
      }
    }

    this.emit('}');

    // Collect output handlers from both branches (for async mode poison handling)
    let trueBranchHandlers, falseBranchHandlers, allHandlers;
    if (this.asyncMode) {
      trueBranchHandlers = this._collectBranchHandlers(node.body);
      falseBranchHandlers = node.else_ ?
        this._collectBranchHandlers(node.else_) :
        new Set();

      // Combine handlers - both branches might write to same handlers
      allHandlers = new Set([...trueBranchHandlers, ...falseBranchHandlers]);
    }

    if (falseBranchWriteCounts) {
      //skip the false branch writes in the true branch code
      this.emit.insertLine(trueBranchCodePos, `frame.skipBranchWrites(${JSON.stringify(falseBranchWriteCounts)});`);
    }

    if (this.asyncMode) {
      // Add catch block to poison variables when condition fails
      const errorContextJson = JSON.stringify(this._createErrorContext(node, node.cond));
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContextJson}.lineno, ${errorContextJson}.colno, ${errorContextJson}.errorContextString, context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');  // No re-throw - execution continues with poisoned vars

      // Fill in the poison handling code now that we have write counts and handlers
      const combinedCounts = this._combineWriteCounts([trueBranchWriteCounts, falseBranchWriteCounts]);

      // Poison both variables and handlers when condition fails
      const hasVariables = Object.keys(combinedCounts).length > 0;
      const hasHandlers = allHandlers.size > 0;

      if (hasVariables || hasHandlers) {
        // Variable poisoning
        if (hasVariables) {
          this.emit.insertLine(poisonCheckPos,
            `  frame.poisonBranchWrites(condResult, ${JSON.stringify(combinedCounts)});`);
          this.emit.insertLine(catchPoisonPos,
            `    frame.poisonBranchWrites(contextualError, ${JSON.stringify(combinedCounts)});`);
        }

        // Handler (buffer) poisoning
        if (hasHandlers) {
          const handlerArray = Array.from(allHandlers);
          this.emit.insertLine(poisonCheckPos,
            `  runtime.addPoisonMarkersToBuffer(${this.buffer}, condResult, ${JSON.stringify(handlerArray)});`);
          this.emit.insertLine(catchPoisonPos,
            `    runtime.addPoisonMarkersToBuffer(${this.buffer}, contextualError, ${JSON.stringify(handlerArray)});`);
        }
      }
    }

    // Use node.cond (passed earlier) for the end block
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, false, false, node.cond);
  }

  compileIfAsync(node, frame) {
    if (node.isAsync) {
      this.compileIf(node, frame);
    } else {
      this.emit('(function(cb) {');
      this.compileIf(node, frame, true);
      this.emit('})(' + this._makeCallback());
      this.emit.addScopeLevel();
    }
  }

  //todo - condition with sequence locks (test 2 identicsal sequence locks in the condition expression)
  compileWhile(node, frame) {
    if (!node.isAsync) {
      // Synchronous case: remains the same, no changes needed.
      // @todo - use compileFor for the loop variable, etc...
      this.emit('while (');
      this._compileExpression(node.cond, frame, false);
      this.emit(') {');
      this.compile(node.body, frame);
      this.emit('}');
      return;
    }

    // Asynchronous case:
    const iteratorCompiler = (arrNode, loopFrame, arrVarName) => {
      // the condition expression can write if (!) sequential operations are used
      // it runs in the same frame as the loop body which writes are isolated with the sequentialLoopBody flag

      // the write counts from the below compilation are saved to the loopFrame (in the compiler)
      // these will be capped to 1 when passed to the runtime.iterate() and will be released by finalizeLoopWrites
      const iteratorFuncName = 'while_iterator_' + this._tmpid();
      this.emit.line(`let ${iteratorFuncName} = (async function* (frame) {`);

      // push a frame to trap any writes from the condition expression
      // by setting sequentialLoopBody, the writes will be released by finalizeLoopWrites
      this.emit.line('  frame = frame.push();');
      this.emit.line('  frame.sequentialLoopBody = true;');

      this.emit.line('  let iterationCount = 0;');
      this.emit.line('  while (true) {');

      // This structure correctly models a `while` loop.
      // We check the condition *before* yielding, ensuring that the loop body for a given
      // iteration runs *before* the condition for the *next* iteration is evaluated.

      // 1. Check the condition for the current prospective iteration.
      this.emit.line(`    const conditionResult = `);
      this._compileAwaitedExpression(node.cond, loopFrame, false);
      this.emit.line(';');

      // 2. If the condition is false, the loop is over.
      this.emit.line('    if (!conditionResult) { break; }');

      // 3. If the condition was true, yield the current iteration number.
      //    The `for await...of` loop in `runtime.iterate` will now pause the generator
      //    and execute the loop body for this iteration.
      this.emit.line('    yield iterationCount;');

      // 4. After the loop body has run and `for await` requests the next item,
      //    the generator will resume here and increment the counter for the next cycle.
      this.emit.line('    iterationCount++;');
      this.emit.line('  }');

      this.emit.line('  frame = frame.pop();');

      this.emit.line('}).bind(context);');
      this.emit.line('');
      this.emit.line(`let ${arrVarName} = ${iteratorFuncName}(frame);`);
    };

    const fakeForNode = new nodes.For(
      node.lineno, node.colno,
      new nodes.Symbol(node.lineno, node.colno, 'while_iterator_placeholder'), //arr
      new nodes.Symbol(node.lineno, node.colno, 'iterationCount'), //name
      node.body, //body
      null //else
    );
    fakeForNode.isAsync = true;

    // Delegate to the modified `_compileFor`
    this._compileFor(fakeForNode, frame, true, iteratorCompiler);
  }

  compileFor(node, frame) {
    this._compileFor(node, frame, false);
  }

  _compileFor(node, frame, sequential = false, iteratorCompiler = null) {
    // Use node.arr as the position for the outer async block (evaluating the array)
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, true, node.arr);

    // Evaluate the array expression
    const arr = this._tmpid();

    if (iteratorCompiler) {
      // Gets the `{ "var": 1 }` style counts from compileWhile.
      iteratorCompiler(node.arr, frame, arr);
    } else {
      this.emit(`let ${arr} = `);
      this._compileAwaitedExpression(node.arr, frame, false);
      this.emit.line(';');
    }

    // Determine loop variable names
    const loopVars = [];
    if (node.name instanceof nodes.Array) {
      node.name.children.forEach((child) => {
        loopVars.push(child.value);
        frame.set(child.value, child.value);
        if (node.isAsync) {
          this._addDeclaredVar(frame, child.value);
        }
      });
    } else {
      loopVars.push(node.name.value);
      frame.set(node.name.value, node.name.value);
      if (node.isAsync) {
        this._addDeclaredVar(frame, node.name.value);
      }
    }

    // Define the loop body function
    const loopBodyFunc = this._tmpid();
    this.emit(`let ${loopBodyFunc} = `);

    if (node.isAsync) {
      this.emit('(async function(');//@todo - think this over, does it need async block?
    } else {
      this.emit('function(');
    }

    // Function parameters
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.emit(', ');
      }
      this.emit(varName);
    });
    const loopIndex = this._tmpid();
    const loopLength = this._tmpid();
    const isLast = this._tmpid();
    const errorContext = this._tmpid();
    this.emit(`, ${loopIndex}, ${loopLength}, ${isLast}, ${errorContext}) {`);

    // Use node.body as the position for the inner buffer block (loop body execution)
    if (node.isAsync) {
      // when sequential, the loop body IIFE will await all closures (waitAllClosures)
      // we return the IIFE promise so that awaiting the loop body will wait for all closures
      this.emit('return ');
    }
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, false, node.body);

    const makeSequentialPos = this.codebuf.length;// we will know later if it's sequential or not
    this.emit.line(`runtime.setLoopBindings(frame, ${loopIndex}, ${loopLength}, ${isLast});`);

    // Handle array unpacking within the loop body
    if (loopVars.length === 2 && !Array.isArray(arr)) {
      // Object key/value iteration
      const [keyVar, valueVar] = loopVars;
      this.emit.line(`frame.set("${keyVar}", ${keyVar});`);
      this.emit.line(`frame.set("${valueVar}", ${valueVar});`);

      if (node.isAsync) {
        frame.set(keyVar, keyVar);
        frame.set(valueVar, valueVar);
        this._addDeclaredVar(frame, keyVar);
        this._addDeclaredVar(frame, valueVar);
      }
    } else if (node.name instanceof nodes.Array) {
      // Array destructuring
      node.name.children.forEach((child, index) => {
        const varName = child.value;
        const tid = this._tmpid();
        this.emit.line(`let ${tid} = Array.isArray(${varName}) ? ${varName}[${index}] : undefined;`);
        this.emit.line(`frame.set("${varName}", ${tid});`);
        if (node.isAsync) {
          frame.set(varName, tid);
          this._addDeclaredVar(frame, varName);
        }
      });
    } else {
      // Single variable loop
      const varName = node.name.value;
      this.emit.line(`frame.set("${varName}", ${varName});`);
      if (node.isAsync) {
        frame.set(varName, varName);
        this._addDeclaredVar(frame, varName);
      }
    }

    // Compile the loop body with the updated frame
    this.emit.withScopedSyntax(() => {
      this.compile(node.body, frame);
    });

    const bodyWriteCounts = frame.writeCounts;
    if (bodyWriteCounts) {
      sequential = true;//should be sequential to avoid write race conditions and long promise chains
    }
    if (sequential) {
      this.emit.insertLine(makeSequentialPos, 'frame.sequentialLoopBody = true;');
    }

    // End buffer block for the loop body (using node.body position)
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, false, sequential, node.body);

    // Close the loop body function
    this.emit.line(node.isAsync ? '}).bind(context);' : '};');

    // Define the else function if it exists
    let elseFuncId = 'null';
    if (node.else_) {
      elseFuncId = this._tmpid();
      this.emit(`let ${elseFuncId} = `);

      const awaitSequentialElse = false;//I think awaiting it like loop body is not needed

      if (node.isAsync) {
        this.emit('(async function() {');
        // must return the promise from its async block
        // which when sequential will wait for all closures
        if (awaitSequentialElse) {
          this.emit('return ');
        }
      } else {
        this.emit('function() {');
      }

      // Use node.else_ as position for the else block buffer
      frame = this.emit.asyncBlockBufferNodeBegin(node, frame, false, node.else_);
      this.compile(node.else_, frame);
      frame = this.emit.asyncBlockBufferNodeEnd(node, frame, false, sequential && awaitSequentialElse, node.else_);

      this.emit.line(node.isAsync ? '}).bind(context);' : '};');
    }

    // Create error context object
    const errorContextObj = this._tmpid();
    this.emit.line(`let ${errorContextObj} = { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: "${this._generateErrorContext(node)}", path: context.path };`);
    // Call the runtime iterate loop function
    this.emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFunc}, ${elseFuncId}, frame, ${JSON.stringify(bodyWriteCounts)}, [`);
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.emit(', ');
      }
      this.emit(`"${varName}"`);
    });
    this.emit(`], ${sequential}, ${node.isAsync}, ${errorContextObj});`);

    // End buffer block for the node (using node.arr position)
    if (iteratorCompiler || bodyWriteCounts) {
      // condition and loop body counts are a single unit of work and
      // are isolated to not affect the outer frame write counts
      // All writes will be released by finalizeLoopWrites
      // Cap the outer frame's writeCounts to 1 per variable
      // The loop as a whole counts as 1 write to the parent, regardless of iterations
      // The capping happens per loop frame before popping, and the parent naturally accumulates these capped counts.
      frame.writeCounts = this.async.countsTo1(frame.writeCounts);
    }
    // else - all write counts are from the loop body and are 1 anyway (counts are counted inside (>1) and outside (=1))
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, true, false, node.arr);
  }

  _compileAsyncLoopBindings(node, arr, i, len) {
    const bindings = [
      { name: 'index', val: `${i} + 1` },
      { name: 'index0', val: i },
      { name: 'revindex', val: `${len} - ${i}` },
      { name: 'revindex0', val: `${len} - ${i} - 1` },
      { name: 'first', val: `${i} === 0` },
      { name: 'last', val: `${i} === ${len} - 1` },
      { name: 'length', val: len },
    ];

    bindings.forEach((b) => {
      this.emit.line(`frame.set("loop.${b.name}", ${b.val});`);
    });
  }

  _compileAsyncLoop(node, frame, parallel) {
    if (node.isAsync) {
      this._compileFor(node, frame, !parallel);
      return;
    }
    // This shares some code with the For tag, but not enough to
    // worry about. This iterates across an object asynchronously,
    // but not in parallel.
    let i, len, arr, asyncMethod;

    i = this._tmpid();
    len = this._tmpid();
    arr = this._tmpid();
    asyncMethod = parallel ? 'asyncAll' : 'asyncEach';

    frame = frame.push();
    this.emit.line('frame = frame.push();');

    this.emit('let ' + arr + ' = runtime.fromIterator(');
    this._compileExpression(node.arr, frame, false);
    this.emit.line(');');

    if (node.name instanceof nodes.Array) {
      const arrayLen = node.name.children.length;
      this.emit(`runtime.${asyncMethod}(${arr}, ${arrayLen}, function(`);

      node.name.children.forEach((name) => {
        this.emit(`${name.value},`);
      });

      this.emit(i + ',' + len + ',next) {');

      node.name.children.forEach((name) => {
        const id = name.value;
        frame.set(id, id);
        //this._addDeclaredVar(frame, id);
        this.emit.line(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this.emit.line(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      //this._addDeclaredVar(frame, id);
      this.emit.line('frame.set("' + id + '", ' + id + ');');
      frame.set(id, id);
    }

    this._compileAsyncLoopBindings(node, arr, i, len);

    this.emit.withScopedSyntax(() => {
      let buf;
      if (parallel) {
        buf = this._pushBuffer();
      }

      this.compile(node.body, frame);
      this.emit.line('next(' + i + (buf ? ',' + buf : '') + ');');

      if (parallel) {
        this._popBuffer();
      }
    });

    const output = this._tmpid();
    this.emit.line('}, ' + this._makeCallback(output));
    this.emit.addScopeLevel();

    if (parallel) {
      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this.emit(`${this.buffer}[index++] = ${output};`);
      } else {
        this.emit.line(`${this.buffer} += ${output};`);
      }
    }

    if (node.else_) {
      this.emit.line('if (!' + arr + '.length) {');
      this.compile(node.else_, frame);
      this.emit.line('}');
    }

    this.emit.line('frame = frame.pop();');
    //frame = frame.pop();// - not in nunjucks (a bug?)
  }

  compileAsyncEach(node, frame) {
    this._compileAsyncLoop(node, frame, false);
  }

  compileAsyncAll(node, frame) {
    this._compileAsyncLoop(node, frame, true);
  }

  _compileMacro(node, frame, keepFrame) {
    var args = [];
    var kwargs = null;
    var funcId = 'macro_' + this._tmpid();
    //var keepFrame = (frame !== undefined);

    // Type check the definition of the args
    node.args.children.forEach((arg, i) => {
      if (i === node.args.children.length - 1 && arg instanceof nodes.Dict) {
        kwargs = arg;
      } else {
        this.assertType(arg, nodes.Symbol);
        args.push(arg);
      }
    });

    const realNames = [...args.map((n) => `l_${n.value}`), 'kwargs'];

    // Quoted argument names
    const argNames = args.map((n) => `"${n.value}"`);
    const kwargNames = ((kwargs && kwargs.children) || []).map((n) => `"${n.key.value}"`);

    // We pass a function to makeMacro which destructures the
    // arguments so support setting positional args with keywords
    // args and passing keyword args as positional args
    // (essentially default values). See runtime.js.
    let currFrame;
    if (keepFrame) {
      currFrame = frame.push(true);
    } else {
      currFrame = frame.new();
    }

    const oldIsCompilingMacroBody = this.sequential.isCompilingMacroBody; // Save previous state

    // If the macro being compiled is the anonymous 'caller' macro (generated for a {% call %} block),
    // its body's sequence operations should be evaluated against the call site's context,
    // not as if they are part of a regular macro definition's internal logic.
    // The `Caller` node (for `{{ caller() }}`) is a distinct typename.
    this.sequential.isCompilingMacroBody = node.typename !== 'Caller';

    this.emit.lines(
      `let ${funcId} = runtime.makeMacro(`,
      `[${argNames.join(', ')}], `,
      `[${kwargNames.join(', ')}], `,
      `function (${realNames.join(', ')}, astate) {`
    );

    // START CHANGE: Wrap the entire body in withPath to fork the context
    this.emit.line(`return runtime.withPath(this, "${this.templateName}", function() {`);

    if (!keepFrame) {
      this.emit.line('let callerFrame = frame;');
    }
    this.emit.lines(
      'frame = ' + ((keepFrame) ? 'frame.push(true);' : 'frame.new();'),
      'kwargs = kwargs || {};',
      'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      'frame.set("caller", kwargs.caller); }'
    );

    let err = this._tmpid();
    if (node.isAsync) {
      this.emit.lines(
        `let ${err} = null;`,
        'function cb(err) {',
        `if(err) {${err} = err;}`,
        '}');
    }

    // Expose the arguments to the template. Don't need to use
    // random names because the function
    // will create a new run-time scope for us
    args.forEach((arg) => {
      this.emit.line(`frame.set("${arg.value}", l_${arg.value});`);
      currFrame.set(arg.value, `l_${arg.value}`);
      if (node.isAsync) {
        this._addDeclaredVar(currFrame, arg.value);
      }
    });

    // Expose the keyword arguments
    if (kwargs) {
      kwargs.children.forEach((pair) => {
        const name = pair.key.value;
        if (node.isAsync) {
          this._addDeclaredVar(currFrame, name);
        }
        this.emit(`frame.set("${name}", `);
        this.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
        this.emit(` ? kwargs["${name}"] : `);
        this._compileExpression(pair.value, currFrame, false);
        this.emit(');');
      });
    }

    if (node.isAsync) {
      this._addDeclaredVar(currFrame, 'caller');
    }
    const bufferId = this._pushBuffer();

    this.emit.withScopedSyntax(() => {
      this.compile(node.body, currFrame);
    });

    // *** THIS IS THE CRITICAL CODE THAT WAS MISSING ***
    this.emit.line('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));
    this.emit.line('return ' + (
      node.isAsync ?
        `astate.waitAllClosures().then(() => {if (${err}) throw ${err};` +
        `return runtime.newSafeStringAsync(runtime.flattenBuffer(${bufferId}${this.scriptMode ? ', context' : ''}${node.focus ? ', "' + node.focus + '"' : ''}));}).catch(error => Promise.reject(error));` :
        `new runtime.SafeString(${bufferId})`
    )
    );
    // *** END OF CRITICAL CODE ***

    // END CHANGE: Close the withPath wrapper function
    this.emit.line('});'); // 1. Closes the withPath inner function

    // Now, close the outer function passed to makeMacro
    if (node.isAsync) {
      this.emit.line('}, astate);'); // 2a. Closes the main function for async
    } else {
      this.emit.line('});'); // 2b. Closes the main function for sync
    }
    this._popBuffer();

    this.sequential.isCompilingMacroBody = oldIsCompilingMacroBody; // Restore state

    return funcId;
  }

  compileMacro(node, frame) {
    var funcId = this._compileMacro(node, frame, false);

    // Expose the macro to the templates
    var name = node.name.value;
    frame.set(name, funcId);

    if (frame.parent) {
      this.emit.line(`frame.set("${name}", ${funcId});`);
    } else {
      if (node.name.value.charAt(0) !== '_') {
        this.emit.line(`context.addExport("${name}");`);
      }
      this.emit.line(`context.setVariable("${name}", ${funcId});`);
    }
  }


  _compileGetTemplateOrScript(node, frame, eagerCompile, ignoreMissing, wrapInAsyncBlock) {
    const parentTemplateId = this._tmpid();
    const parentName = this._templateName();
    const eagerCompileArg = (eagerCompile) ? 'true' : 'false';
    const ignoreMissingArg = (ignoreMissing) ? 'true' : 'false';

    // The relevant position is the template expression node
    const positionNode = node.template || node; // node.template exists for Import, Extends, Include, FromImport

    if (node.isAsync) {
      const getTemplateFunc = this._tmpid();
      //the AsyncEnviuronment.getTemplate returns a Promise
      this.emit.line(`const ${getTemplateFunc} = env.get${this.scriptMode ? 'Script' : 'Template'}.bind(env);`);
      this.emit(`let ${parentTemplateId} = ${getTemplateFunc}(`);
      /*if (wrapInAsyncBlock) {
        // Wrap the expression evaluation in an async block if needed, use template node position
        this.emit.AsyncBlockValue(node.template, frame, (n, f) => {
          this._compileExpression(n, f, true, positionNode);
        }, undefined, positionNode);
      } else {*/
      this._compileExpression(node.template, frame, wrapInAsyncBlock, positionNode);
      /*}*/
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg});`);
    } else {
      const cb = this._makeCallback(parentTemplateId);
      this.emit(`env.get${this.scriptMode ? 'Script' : 'Template'}(`);
      this._compileExpression(node.template, frame, false);
      this.emit.line(`, ${eagerCompileArg}, ${parentName}, ${ignoreMissingArg}, ${cb}`);
    }

    return parentTemplateId;
  }

  compileImport(node, frame) {
    const target = node.target.value;
    const id = this._compileGetTemplateOrScript(node, frame, false, false, true);

    if (node.isAsync) {
      const res = this._tmpid();
      this.emit(`${id} = `);
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.emit(`let ${res} = (await ${id}).getExported(${n.withContext
          ? `context.getVariables(), frame, astate, cb`
          : `null, null, astate, cb`
        });`);
      }, res, node);
      //this.emit.line(';');
    } else {
      this.emit.addScopeLevel();
      this.emit.line(id + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(id));
      this.emit.addScopeLevel();
    }

    frame.set(target, id);
    if (node.isAsync) {
      this._addDeclaredVar(frame, target);
    }

    if (frame.parent) {
      this.emit.line(`frame.set("${target}", ${id});`);
    } else {
      this.emit.line(`context.setVariable("${target}", ${id});`);
    }
  }

  compileFromImport(node, frame) {
    // Pass node.template for position in _compileGetTemplateOrScript
    const importedId = this._compileGetTemplateOrScript(node, frame, false, false, true);

    if (node.isAsync) {
      // Get the exported object from the template
      const res = this._tmpid();
      this.emit(`${importedId} = `);
      // Use node as position node for the getExported part
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.emit(`let ${res} = (await ${importedId}).getExported(${n.withContext
          ? `context.getVariables(), frame, astate, cb`
          : `null, null, astate, cb`
        });`);
      }, res, node);

      // Now extract each individual variable from the exported object
      node.names.children.forEach((nameNode) => {
        let name;
        let alias;
        let id = this._tmpid();

        if (nameNode instanceof nodes.Pair) {
          name = nameNode.key.value;
          alias = nameNode.value.value;
        } else {
          name = nameNode.value;
          alias = name;
        }

        // Generate context within the compiler scope
        const errorContext = this._generateErrorContext(node, nameNode);
        const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

        // Create individual promise for this variable - await ${importedId} which now holds the exported object
        this.emit.line(`let ${id} = (async () => { try {`);
        this.emit.line(`  let exported = await ${importedId};`);
        this.emit.line(`  if(Object.prototype.hasOwnProperty.call(exported, "${name}")) {`);
        this.emit.line(`    return exported["${name}"];`);
        this.emit.line(`  } else {`);
        this.emit.line(`    var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err;`);
        this.emit.line(`  }`);
        this.emit.line(`} catch(e) { var err = runtime.handleError(e, ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); throw err; } })();`);

        frame.set(alias, id);
        this._addDeclaredVar(frame, alias);

        if (frame.parent) {
          this.emit.line(`frame.set("${alias}", ${id});`);
        } else {
          this.emit.line(`context.setVariable("${alias}", ${id});`);
        }
      });
    } else {
      // Sync mode remains unchanged
      this.emit.addScopeLevel(); // after _compileGetTemplateOrScript
      this.emit.line(importedId + '.getExported(' +
        (node.withContext ? 'context.getVariables(), frame, ' : '') +
        this._makeCallback(importedId));
      this.emit.addScopeLevel();

      node.names.children.forEach((nameNode) => {
        let name;
        let alias;
        let id = this._tmpid();
        this.emit.line(`let ${id};`);

        if (nameNode instanceof nodes.Pair) {
          name = nameNode.key.value;
          alias = nameNode.value.value;
        } else {
          name = nameNode.value;
          alias = name;
        }

        // Generate context within the compiler scope
        const errorContext = this._generateErrorContext(node, nameNode);
        const failMsg = `cannot import '${name}'`.replace(/"/g, '\\"');

        this.emit.line(`if(Object.prototype.hasOwnProperty.call(${importedId}, "${name}")) {`);
        this.emit.line(`${id} = ${importedId}.${name};`);
        this.emit.line('} else {');
        this.emit.line(`var err = runtime.handleError(new Error("${failMsg}"), ${nameNode.lineno}, ${nameNode.colno}, "${errorContext}", context.path); cb(err); return;`);
        this.emit.line('}');

        frame.set(alias, id);

        if (frame.parent) {
          this.emit.line(`frame.set("${alias}", ${id});`);
        } else {
          this.emit.line(`context.setVariable("${alias}", ${id});`);
        }
      });
    }
  }

  compileBlock(node, frame) {
    //var id = this._tmpid();

    // If we are at the top level of a template (`!this.inBlock`) that has a
    // static `extends` tag, this block is a definition-only. We can safely
    // skip compiling any rendering code for it, as the parent template is
    // responsible for its execution. The dynamic extends case is handled later
    // with a runtime check using the __parentTemplate variable.
    if (!this.inBlock && this.hasStaticExtends && !this.hasDynamicExtends) {
      return;
    }


    // If we are executing outside a block (creating a top-level
    // block), we really don't want to execute its code because it
    // will execute twice: once when the child template runs and
    // again when the parent template runs. Note that blocks
    // within blocks will *always* execute immediately *and*
    // wherever else they are invoked (like used in a parent
    // template). This may have behavioral differences from jinja
    // because blocks can have side effects, but it seems like a
    // waste of performance to always execute huge top-level
    // blocks twice

    if (this.asyncMode) {
      this.emit.asyncBlockAddToBuffer(node, frame, (id, f) => {
        // The dynamic check runs when:
        // 1. We're at top level (!this.inBlock)
        // 2. There might be a dynamic parent (hasDynamicExtends OR hasStaticExtends)
        //    - hasDynamicExtends: Need to check frame variable
        //    - hasStaticExtends with hasDynamicExtends: Dynamic can override static
        const needsParentCheck = !this.inBlock && (this.hasDynamicExtends || this.hasStaticExtends);
        if (needsParentCheck) {
          if (this.hasDynamicExtends) {
            this.async.updateFrameReads(f, '__parentTemplate');
            this.emit.line('let parent = await runtime.contextOrFrameLookup(context, frame, "__parentTemplate");');
            if (this.hasStaticExtends) {
              // Check both: dynamic can override static
              this.emit.line('if (!parent) parent = parentTemplate;');
            }
          } else {
            // Only static extends (but in a context where dynamic might exist)
            this.emit.line('let parent = parentTemplate;');
          }
          this.emit.line('if (!parent) {');
        }
        const blockFunc = this._tmpid();
        //this.emit.line(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        //this.emit.line(`${blockFunc} = runtime.promisify(${blockFunc}.bind(context));`);
        this.emit.line(`let ${blockFunc} = await context.getAsyncBlock("${node.name.value}");`);
        this.emit.line(`${id} = ${blockFunc}(env, context, frame, runtime, astate, cb);`);
        if (needsParentCheck) {
          this.emit.line('}');
        }
      }, node);
    }
    else {
      let id = this._tmpid();
      if (!this.inBlock) {
        this.emit('(parentTemplate ? function(e, c, f, r, cb) { cb(null, ""); } : ');
      }
      this.emit(`context.getBlock("${node.name.value}")`);
      if (!this.inBlock) {
        this.emit(')');
      }
      this.emit.line('(env, context, frame, runtime, ' + this._makeCallback(id));

      if (this.asyncMode) {
        //non-async node but in async mode -> use the proper buffer implementation
        this.emit(`${this.buffer}[index++] = ${id};`);
      } else {
        this.emit.line(`${this.buffer} += ${id};`);
      }
      this.emit.addScopeLevel();
    }
  }

  compileSuper(node, frame) {
    var name = node.blockName.value;
    var id = node.symbol.value;

    if (node.isAsync) {
      //this.emit.line(`let ${id} = runtime.promisify(context.getSuper.bind(context))(env, "${name}", b_${name}, frame, runtime, astate);`);

      // Call getSuper directly - it returns the output synchronously
      // The callback (cb) is passed through for error propagation
      this.emit.line(`let ${id} = context.getSuper(env, "${name}", b_${name}, frame, runtime, astate, cb);`);
    }
    else {
      const cb = this._makeCallback(id);
      this.emit.line(`context.getSuper(env, "${name}", b_${name}, frame, runtime, ${cb}`);
    }
    this.emit.line(`${id} = runtime.markSafe(${id});`);

    if (!node.isAsync) {
      this.emit.addScopeLevel();
    }
    frame.set(id, id);
    if (node.isAsync) {
      this._addDeclaredVar(frame, id);
    }
  }

  compileExtends(node, frame) {
    var k = this._tmpid();

    if (this.asyncMode) {
      this.emit.line('context.prepareForAsyncBlocks();');
    }

    const parentTemplateId = this._compileGetTemplateOrScript(node, frame, true, false, true);

    if (this.asyncMode) {
      if (node.asyncStoreIn) {
        this.emit.line(`let ${node.asyncStoreIn} = ${parentTemplateId};`);
      }

      frame = this.emit.asyncBlockBegin(node, frame, false, node.template);
      const templateVar = this._tmpid();
      this.emit.line(`let ${templateVar} = await ${parentTemplateId};`);

      // ALWAYS store in parentTemplate for block registration (and static case)
      this.emit.line(`parentTemplate = ${templateVar};`);

      // Register blocks while still inside async block
      this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
      this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
      this.emit.line('}');

      this.emit.line('context.finishAsyncBlocks()');
      frame = this.emit.asyncBlockEnd(node, frame, false, false, node.template);
    } else {
      // SYNC MODE
      this.emit.line(`parentTemplate = ${parentTemplateId};`);
      this.emit.line(`for(let ${k} in parentTemplate.blocks) {`);
      this.emit.line(`  context.addBlock(${k}, parentTemplate.blocks[${k}]);`);
      this.emit.line('}');
      this.emit.addScopeLevel();
    }
  }

  compileInclude(node, frame) {
    if (!node.isAsync) {
      this.compileIncludeSync(node, frame);
      return;
    }
    // `asyncBlockAddToBuffer` places the final result into the parent buffer.
    // The block is async because `getTemplate` returns a promise.
    this.emit.asyncBlockAddToBuffer(node, frame, (resultVar, f) => {
      // Get the template object (this part is async)
      const templateVar = this._tmpid();
      const templateNameVar = this._tmpid();

      // Get the template name expression
      this.emit(`let ${templateNameVar} = `);
      this._compileExpression(node.template, f, false);
      this.emit.line(';');

      //the AsyncEnviuronment.getTemplate returns a Promise
      this.emit.line(`let ${templateVar} = await env.getTemplate.bind(env)(${templateNameVar}, false, ${this._templateName()}, ${node.ignoreMissing ? 'true' : 'false'});`);

      // Call the template in composition mode. This is a SYNCHRONOUS call
      // that returns the incomplete output array immediately. The master `cb` from the
      // closure is passed for error propagation.
      this.emit.line(`${resultVar} = ${templateVar}._renderForComposition(context.getVariables(), frame, astate, cb);`);
    }, node);
  }

  compileIncludeSync(node, frame) {
    //we can't use the async implementation with (async(){...})().then(...
    //as the .render() method is expected to return the result immediately
    this.emit.line('let tasks = [];');
    this.emit.line('tasks.push(');
    this.emit.line('function(callback) {');

    const id = this._compileGetTemplateOrScript(node, frame, false, node.ignoreMissing, false);
    this.emit.line(`callback(null,${id});});`);

    this.emit.line('});');

    const id2 = this._tmpid();
    this.emit.line('tasks.push(');
    this.emit.line('function(template, callback){');
    this.emit.line('template.render(context.getVariables(), frame, ' + (node.isAsync ? 'astate,' : '') + this._makeCallback(id2));
    this.emit.line('callback(null,' + id2 + ');});');
    this.emit.line('});');

    this.emit.line('tasks.push(');
    this.emit.line('function(result, callback){');

    // Adding to buffer is synchronous here
    if (this.asyncMode) {
      //non-async node but in async mode -> use the proper buffer implementation
      this.emit.line(`${this.buffer}[index++] = result;`);
    } else {
      this.emit.line(`${this.buffer} += result;`);
    }
    this.emit.line('callback(null);');
    this.emit.line('});');
    this.emit.line('env.waterfall(tasks, function(){');
    this.emit.addScopeLevel();
  }

  compileTemplateData(node, frame) {
    this.compileLiteral(node, frame);
  }

  compileCapture(node, frame) {
    // we need to temporarily override the current buffer id as 'output'
    // so the set block writes to the capture output instead of the buffer
    const buffer = this.buffer;
    this.buffer = 'output';
    if (node.isAsync) {
      const res = this._tmpid();
      // Use node.body as position node for the capture block evaluation
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        this.emit.line('let output = [];');

        this.compile(n.body, f);//write to output

        this.emit.line('await astate.waitAllClosures(1)');
        this.emit.line(`let ${res} = runtime.flattenBuffer(output${this.scriptMode ? ', context' : ''}${node.focus ? ', "' + node.focus + '"' : ''});`);
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res, node.body);
    }
    else {
      this.emit.line('(function() {');
      this.emit.line('let output = "";');
      this.emit.withScopedSyntax(() => {
        this.compile(node.body, frame);
      });
      this.emit.line('return output;');
      this.emit.line('})()');
    }

    // and of course, revert back to the old buffer id
    this.buffer = buffer;
  }

  compileOutput(node, frame) {
    const children = node.children;
    children.forEach(child => {
      // TemplateData is a special case because it is never
      // autoescaped, so simply output it for optimization
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          // Position node is the TemplateData node itself
          this.emit.addToBuffer(node, frame, function () {
            this.compileLiteral(child, frame);
          }, child); // Pass TemplateData as position
        }
      } else {
        // Use the specific child expression node for position
        frame = this.emit.asyncBlockAddToBufferBegin(node, frame, child);
        const errorContextJson = node.isAsync ? JSON.stringify(this._createErrorContext(node, child)) : '';
        this.emit(`${node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);

        if (this.throwOnUndefined) {
          this.emit(`${node.isAsync ? 'await runtime.ensureDefinedAsync(' : 'runtime.ensureDefined('}`);
        }
        this._compileExpression(child, frame, false);
        if (this.throwOnUndefined) {
          // Use child position for ensureDefined error
          if (node.isAsync) {
            this.emit(`,${child.lineno},${child.colno}, context, ${errorContextJson})`);
          } else {
            this.emit(`,${child.lineno},${child.colno}, context)`);
          }
        }
        // Use child position for suppressValue error
        if (node.isAsync) {
          this.emit(`, env.opts.autoescape, ${errorContextJson});\n`);
        } else {
          this.emit(', env.opts.autoescape);\n');
        }
        frame = this.emit.asyncBlockAddToBufferEnd(node, frame, child); // Pass Output node as op, child as pos
      }
    });
  }

  // Retrieves the direct child AST nodes of a given node in their
  // semantically significant order, as defined by the node's `fields` property
  // which is also the order they are rendered
  /*_getImmediateChildren(node) {
    const children = [];
    for (const fieldName of node.fields) { // For NodeList, fieldName will be 'children'
      const fieldValue = node[fieldName];  // fieldValue will be the actual array of child nodes

      if (fieldValue instanceof nodes.Node) {
        children.push(fieldValue);
      } else if (Array.isArray(fieldValue)) {
        // If the field is an array, iterate through it and add any Node instances.
        // This handles cases like NodeList.children or Compare.ops
        for (const item of fieldValue) {
          if (item instanceof nodes.Node) {
            children.push(item);
          }
        }
      }
    }
    return children;
  }*/

  /**
   * Retrieves the direct child AST nodes of a given node by iterating over all properties
   * and checking if they are instances of nodes.Node or arrays of nodes.Node
   * @todo public
   * @param {nodes.Node} node - The node to get children from
   * @returns {Array<nodes.Node>} Array of child nodes
   */
  _getImmediateChildren(node) {
    const children = [];

    for (const key in node) {
      if (Array.isArray(node[key])) {
        // If the field is an array, iterate through it and add any Node instances
        node[key].forEach(item => {
          if (item instanceof nodes.Node) {
            children.push(item);
          }
        });
      }
      else if (node[key] instanceof nodes.Node) {
        // If the field is a Node instance, add it
        children.push(node[key]);
      }
    }

    return children;
  }

  compileRoot(node, frame) {

    if (frame) {
      this.fail('compileRoot: root node can\'t have frame', node.lineno, node.colno, node);
    }

    // Analyze the final AST for inheritance patterns.
    this.hasStaticExtends = node.children.some(child => child instanceof nodes.Extends);
    this.hasDynamicExtends = this.asyncMode && node.children.some(child =>
      child instanceof nodes.Set &&
      child.targets[0] &&
      child.targets[0].value === '__parentTemplate'
    );

    frame = this.asyncMode ? new AsyncFrame() : new Frame();

    if (this.asyncMode) {
      this.async.propagateIsAsync(node);
      this.sequential._declareSequentialLocks(node, frame);
    }

    this.emit.funcBegin(node, 'root');
    // Always declare parentTemplate (needed even for dynamic-only extends)
    this.emit.line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (this.asyncMode) {
      this.emit.line('if (!compositionMode) {');
      this.emit.line('astate.waitAllClosures().then(async () => {');

      if (this.hasDynamicExtends) {
        // Dynamic extends: check frame variable
        this.emit.line('  let finalParent = await runtime.contextOrFrameLookup(context, frame, "__parentTemplate");');
        if (this.hasStaticExtends) {
          this.emit.line('  if (!finalParent) finalParent = parentTemplate;');
        }
      } else {
        // Static extends only: use JS variable
        this.emit.line('  let finalParent = parentTemplate;');
      }

      this.emit.line('  if(finalParent) {');
      this.emit.line('    finalParent.rootRenderFunc(env, context.forkForPath(finalParent.path), frame, runtime, astate, cb, compositionMode);');
      this.emit.line('  } else {');
      this.emit.line(`    cb(null, runtime.flattenBuffer(${this.buffer}${this.scriptMode ? ', context' : ''}${node.focus ? ', "' + node.focus + '"' : ''}));`);
      this.emit.line('  }');
      this.emit.line('}).catch(e => {');
      this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`); // Store and update the handled error
      this.emit.line('  cb(err);'); // Pass the updated error to the callback
      this.emit.line('});');
      this.emit.line('} else {');
      // If in composition mode, synchronously return the output array.
      // The caller is responsible for the lifecycle.
      this.emit.line(`  return ${this.buffer};`);
      this.emit.line('}');
    }
    else {
      // SYNC Handoff Logic
      this.emit.line('if(parentTemplate) {');
      this.emit.line('  let parentContext = context.forkForPath(parentTemplate.path);');
      this.emit.line('  parentTemplate.rootRenderFunc(env, parentContext, frame, runtime, cb);');
      this.emit.line('} else {');
      this.emit.line(`  cb(null, ${this.buffer});`);
      this.emit.line('}');
    }

    // Pass the node to _emitFuncEnd for error position info (used in sync catch)
    this.emit.funcEnd(node, true);

    this.inBlock = true;

    const blockNames = [];

    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block, i) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);

      this.emit.funcBegin(block, `b_${name}`);

      if (this.asyncMode) {
        this.emit.line(`context = context.forkForPath(${this._templateName()});`);
      }
      let tmpFrame = frame.new();//new Frame();
      this.emit.line('var frame = frame.push(true);'); // Keep this as 'var', the codebase depends on the function-scoped nature of var for frame
      this.compile(block.body, tmpFrame);
      this.emit.funcEnd(block);
    });

    this.emit.line('return {');

    blocks.forEach((block, i) => {
      const blockName = `b_${block.name.value}`;
      this.emit.line(`${blockName}: ${blockName},`);
    });

    this.emit.line('root: root\n};');
  }

  compile(node, frame) {
    var _compile = this['compile' + node.typename];
    if (_compile) {
      if (node.wrapInAsyncBlock) {
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          _compile.call(this, n, f);
        }, undefined, node);
      } else {
        _compile.call(this, node, frame);
      }
    } else {
      this.fail(`compile: Cannot compile node: ${node.typename}`, node.lineno, node.colno, node);
    }
  }


  getCode() {
    return this.codebuf.join('');
  }

  compileDo(node, frame) {
    if (node.isAsync) {
      // Use the Do node itself for the outer async block position
      this.emit.asyncBlock(node, frame, false, (f) => {
        const promisesVar = this._tmpid();
        this.emit.line(`let ${promisesVar} = [];`);
        node.children.forEach((child) => {
          // Position node for individual expressions is the child itself
          const resultVar = this._tmpid();
          this.emit.line(`let ${resultVar} = `);
          // Expressions inside DO shouldn't be wrapped in another IIFE,
          // but if they were async, their results (promises) need handling.
          // We compile them directly here.
          this._compileExpression(child, f, false);
          this.emit.line(';');
          // We only push actual promises to the wait list
          this.emit.line(`if (${resultVar} && typeof ${resultVar}.then === 'function') ${promisesVar}.push(${resultVar});`);
        });
        this.emit.line(`if (${promisesVar}.length > 0) {`);
        this.emit.line(`  await Promise.all(${promisesVar});`);
        this.emit.line(`}`);
      }, node); // Pass Do node as positionNode for the overall block
      //this.emit.line(';'); // Removed semicolon after block
    } else {
      node.children.forEach(child => {
        this._compileExpression(child, frame, false);
        this.emit.line(';');
      });
    }
  }


  compileOutputCommand(node, frame) {
    // Extract static path once for both focus detection and compilation
    const staticPath = this._extractStaticPath(node.call.name);

    if (this.outputFocus) {//@todo - think this over
      //skip compiling commands that do not target the focued property
      let commandTarget;

      if (staticPath && staticPath.length >= 1) {
        commandTarget = staticPath[0]; // First segment is always the handler
      } else if (node.call.name.value === 'text') {
        // Special case for text command
        commandTarget = 'text';
      }

      // If we identified a specific target and it doesn't match the focus, skip compilation.
      if (commandTarget && this.outputFocus !== commandTarget) {
        return;
      }
      // If the focus is on 'data', we can safely skip all OutputCommands.
      if (this.outputFocus === 'data') {
        return;
      }
    }

    // Validate the static path
    if (!staticPath || staticPath.length === 0) {
      this.fail(
        'Invalid Method Command syntax. Expected format is @handler(...) or @handler.command(...) or @handler.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    // Extract handler, subpath, and command from static path
    const handler = staticPath[0];
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;

    const isAsync = node.isAsync;

    // Use a wrapper to avoid duplicating the sync/async logic.
    const wrapper = (emitLogic) => {
      if (isAsync) {
        this.emit.asyncBlockAddToBuffer(node, frame, (resultVar, f) => {
          this.emit(`${resultVar} = `);
          emitLogic(f); // Pass the inner frame to the logic.
        });
      } else {
        this.emit.addToBuffer(node, frame, () => {
          emitLogic(frame); // Pass the current frame.
        });
      }
    };

    wrapper((f) => {
      this.emit(`{ handler: '${handler}', `);
      if (command) {
        this.emit(`command: '${command}', `);
      }
      if (subpath && subpath.length > 0) {
        this.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }

      let argList = node.call.args;
      const asyncArgs = argList.isAsync;
      this.emit('arguments: ' + (asyncArgs ? 'await ' : ''));

      if (handler === 'data') {
        // For @data commands, we create a new "virtual" AST for the arguments.
        // where the first argument is a path like "user.posts[0].title" that
        // needs to be converted into a JavaScript array like ['user', 'posts', 0, 'title'].
        const originalArgs = node.call.args.children;
        if (originalArgs.length === 0) {
          this.fail(`@data command '${command}' requires at least a path argument.`, node.lineno, node.colno, node);
        }

        const pathArg = originalArgs[0];

        // A temporary, "virtual" node to wrap the path:
        const dataPathNode = {
          typename: 'DataPath',
          pathNode: pathArg,
          // Propagate async flag so _compileAggregate can handle it correctly.
          isAsync: pathArg.isAsync
        };

        // Our virtual node at the front.
        const newArgs = [dataPathNode, ...originalArgs.slice(1)];

        argList = new nodes.NodeList(node.call.args.lineno, node.call.args.colno, newArgs);
        argList.isAsync = asyncArgs;
      }

      this._compileAggregate(argList, f, '[', ']', isAsync, true);

      this.emit(`, pos: {lineno: ${node.lineno}, colno: ${node.colno}} }`);
    });
  }


  /**
   * Do nothing for now, currently used only for focus directive
   * where the logic is handled in the parser. See parseAsRoot
   */
  compileOption(node, frame) {
  }
}

module.exports = {
  compile: function compile(src, asyncFilters, extensions, name, opts = {}) {
    AsyncFrame.inCompilerContext = true;
    const c = new Compiler(name, opts);

    // Run the extension preprocessors against the source.
    const preprocessors = (extensions || []).map(ext => ext.preprocess).filter(f => !!f);

    const processedSrc = preprocessors.reduce((s, processor) => processor(s), src);

    c.compile(transformer.transform(
      parser.parse(processedSrc, extensions, opts),
      asyncFilters,
      name,
      opts
    ));
    AsyncFrame.inCompilerContext = false;
    return c.getCode();
  },

  Compiler: Compiler
};
