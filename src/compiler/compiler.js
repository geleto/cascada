'use strict';

const parser = require('../parser');
const transformer = require('../transformer');
const nodes = require('../nodes');
const { Frame, AsyncFrame } = require('../runtime/runtime');
const CompileSequential = require('./compile-sequential');
const CompileEmit = require('./compile-emit');
const CompileAsync = require('./compile-async');
const CompileInheritance = require('./compile-inheritance');
const CompileLoop = require('./compile-loop');
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
    this.inheritance = new CompileInheritance(this);
    this.loop = new CompileLoop(this);
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

  //@todo - move to compile-base next to _isDeclared
  _addDeclaredVar(frame, varName) {
    if (this.asyncMode || this.scriptMode) {
      if (!frame.declaredVars) {
        frame.declaredVars = new Set();
      }
      frame.declaredVars.add(varName);
    }
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
        const staticPath = this.sequential._extractStaticPath(n.call.name);
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

  //@todo - move to compile-base
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

      frame = this.emit.asyncBlockAddToBufferBegin(node, frame, positionNode, 'text');
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
        this._compileExpression(arg, frame, false);

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
              this.emit.line(`frame.markOutputBufferScope(${this.buffer});`);
              this.compile(arg, f);
            }, null, arg); // Use content arg node for position
          }
          else {
            //when not resolve args, the contentArgs are callback functions
            this.emit.line('function(cb) {');
            this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

            this.emit.withScopedSyntax(() => {
              this.emit.asyncBlockRender(node, frame, function (f) {
                this.emit.line(`frame.markOutputBufferScope(${this.buffer});`);
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
      frame = this.emit.asyncBlockAddToBufferEnd(node, frame, positionNode, 'text');
    } else {
      const res = this._tmpid();
      this.emit.line(', ' + this._makeCallback(res));
      frame = this.emit.asyncBlockAddToBufferBegin(node, frame, positionNode, 'text');
      const errorContextJson2 = node.isAsync ? JSON.stringify(this._createErrorContext(node, positionNode)) : '';
      if (node.isAsync) {
        this.emit(`await runtime.suppressValueAsync(${res}, ${autoescape} && env.opts.autoescape, ${errorContextJson2});`);
      } else {
        this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
      }
      frame = this.emit.asyncBlockAddToBufferEnd(node, frame, positionNode, 'text');

      this.emit.addScopeLevel();
    }
  }

  compileCallExtensionAsync(node, frame) {
    this._compileCallExtension(node, frame, true);
  }

  compileNodeList(node, frame) {
    this._compileChildren(node, frame);
  }

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

      } else {
        // TEMPLATE MODE: Replicates the original, tested behavior.
        if (node.varType !== 'assignment') { // 'set' is the only valid type
          this.fail(`'${node.varType}' is not allowed in template mode. Use 'set'.`, node.lineno, node.colno, node);
        }

        /*
        // This was an optimization to use local variables for the set value,
        // @todo - reenable synchronous mode, also check compileSymbol
        // Look up the existing temporary variable ID. This is the crucial part
        // for template-mode re-assignments.
        id = frame.lookup(name);
        if (id === null || id === undefined) {
          // If it's a new variable in this scope, generate a new ID and declare it.
          id = this._tmpid();
          this.emit.line('let ' + id + ';');
        }
        */
      }

      // Both modes rely on a fresh temp for the JS assignment.
      id = this._tmpid();
      const declarationKeyword = this.asyncMode ? 'let' : 'var';
      this.emit.line(`${declarationKeyword} ${id};`);

      if (this.asyncMode) {
        const declarationFrame = this._getDeclarationFrame(frame);
        declarationFrame.set(name, id);
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
      if (node.path) {
        // Validation for set_path
        if (ids.length !== 1) {
          this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
        }
        this.emit(ids[0] + ' = ');

        if (this.asyncMode) {
          this.emit('runtime.setPath(');
          this.emit(`frame.lookup("${node.targets[0].value}")` + ', ');
          // Compile path array WITHOUT resolving items (so promises are passed to setPath)
          this._compileAggregate(node.path, frame, '[', ']', false, false);
          this.emit(', ');
          // Compile value expression WITH force-wrapping to ensure it's handled in async context if needed
          // The result will be a Promise, which setPath handles.
          this._compileExpression(node.value, frame, true);
          this.emit(')');
        } else {
          // Sync mode
          this.emit('runtime.setPath(');
          this.emit(`frame.lookup("${node.targets[0].value}")` + ', ');
          this.compile(node.path, frame);
          this.emit(', ');
          this.compile(node.value, frame);
          this.emit(')');
        }
        this.emit.line(';');
      } else if (node.value) { // e.g., set x = 123
        this.emit(ids.join(' = ') + ' = ');
        this._compileExpression(node.value, frame, true, node.value);
        this.emit.line(';');
      } else { // e.g., set x = capture ...
        this.emit(ids.join(' = ') + ' = ');
        this.emit.asyncBlockValue(node, frame, (n, f) => {
          this.compile(n.body, f);
        }, undefined, node.body);
        this.emit.line(';');
      }
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
    const branchHandlers = []; // Track handlers per branch
    let catchPoisonPos;
    const caseCreatesScope = this.scriptMode || this.asyncMode;

    if (this.asyncMode) {
      // Add try-catch wrapper for error handling
      this.emit('try {');
      this.emit('const switchResult = ');
      this._compileAwaitedExpression(node.expr, frame, false);
      this.emit(';');
      this.emit('');
      // Note: awaited result cannot be a resolved PoisonedValue, so no check needed

      // Emit switch statement
      this.emit('switch (switchResult) {');
    } else {
      // Sync mode - no error handling needed
      this.emit('switch (');
      this._compileAwaitedExpression(node.expr, frame, false);
      this.emit(') {');
    }

    // Compile cases
    node.cases.forEach((c, i) => {
      this.emit('case ');
      this._compileAwaitedExpression(c.cond, frame, false);
      this.emit(': ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      if (c.body.children.length) {
        // Use case body 'c.body' as position node for this block
        this.emit.asyncBlock(c, frame, caseCreatesScope, (f) => {
          this.compile(c.body, f);
          branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});

          // Collect handlers from this branch
          if (this.asyncMode) {
            branchHandlers.push(this._collectBranchHandlers(c.body));
          }
        }, c.body);; // Pass body as code position
        this.emit.line('break;');
      } else {
        // Empty case body (fall-through)
        branchWriteCounts.push({});
        if (this.asyncMode) {
          branchHandlers.push(new Set());
        }
      }
    });

    // Compile default case, if present
    if (node.default) {
      this.emit('default: ');

      branchPositions.push(this.codebuf.length);
      this.emit('');

      // Use default body 'node.default' as position node for this block
      this.emit.asyncBlock(node, frame, caseCreatesScope, (f) => {
        this.compile(node.default, f);
        branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});

        // Collect handlers from default
        if (this.asyncMode) {
          branchHandlers.push(this._collectBranchHandlers(node.default));
        }
      }, node.default); // Pass default as code position
    } else {
      // No default case - add empty handler placeholder for collection
      // (branchPositions and branchWriteCounts intentionally not modified)
      if (this.asyncMode) {
        branchHandlers.push(new Set());
      }
    }

    this.emit('}'); // Close switch

    if (this.asyncMode) {
      // Add catch block to poison variables and handlers when switch expression fails
      const errorCtx = this._createErrorContext(node, node.expr);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorCtx.lineno}, ${errorCtx.colno}, "${errorCtx.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}'); // No re-throw - execution continues with poisoned vars
    }

    // Combine writes from all branches
    const totalWrites = this.async._combineWriteCounts(branchWriteCounts);

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

    // Fill in the poison handling code now that we have write counts and handlers
    if (this.asyncMode) {
      // Combine handlers from all branches
      const allHandlers = new Set();
      branchHandlers.forEach(handlers => {
        handlers.forEach(h => allHandlers.add(h));
      });

      const hasVariables = Object.keys(totalWrites).length > 0;
      const hasHandlers = allHandlers.size > 0;

      if (hasVariables || hasHandlers) {
        // Variable poisoning in catch block
        if (hasVariables) {
          this.emit.insertLine(catchPoisonPos,
            `    frame.poisonBranchWrites(contextualError, ${JSON.stringify(totalWrites)});`);
        }

        // Handler (buffer) poisoning in catch block
        if (hasHandlers) {
          const handlerArray = Array.from(allHandlers);
          this.emit.insertLine(catchPoisonPos,
            `    runtime.addPoisonMarkersToBuffer(${this.buffer}, contextualError, ${JSON.stringify(handlerArray)});`);
        }
      }
    }

    // Use node.expr (passed earlier) for the end block
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, false, false, node.expr);
  }

  compileGuard(node, frame) {
    if (!this.asyncMode) {
      this.fail('guard block only supported in async mode', node.lineno, node.colno);
    }

    const variableTargets = node.variableTargets === '*' ? '*' :
      (Array.isArray(node.variableTargets) && node.variableTargets.length > 0 ? node.variableTargets : null);
    const hasSequenceTargets = node.sequenceTargets && node.sequenceTargets.length > 0;
    let handlerTargets = Array.isArray(node.handlerTargets) && node.handlerTargets.length > 0 ? node.handlerTargets : null;
    const handlerTargetsAll = handlerTargets && handlerTargets[0] === '@';
    if (handlerTargetsAll && handlerTargets) {
      handlerTargets = null;
    }
    // We need guard state if we have variables OR if we have sequence targets (for error detection)
    // Note: We don't fully resolve sequence targets here yet, but if the user *requested* sequence targets,
    // we should prepare the state. If it turns out they are empty/unused, init() handles empty lists fine.
    const needsGuardState = (variableTargets === '*') || !!variableTargets || hasSequenceTargets;
    const guardStateVar = needsGuardState ? this._tmpid() : null;

    if (variableTargets && variableTargets !== '*') {
      for (const varName of variableTargets) {
        if (!this._isDeclared(frame, varName)) {
          this.fail(`guard variable "${varName}" is not declared`, node.lineno, node.colno, node);
        }
      }
    }

    // Guard blocks are always async boundaries
    node.isAsync = true;

    // 1. Start Async Block with Nested Buffer
    // This creates a nested buffer (this.buffer) and pushes a new async block
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, true);

    // 2. Link for explicit reversion (optional, if we want to support manual revert)
    this.emit.line(`frame.markOutputBufferScope(${this.buffer});`);
    let guardInitLinePos = null;
    if (guardStateVar) {
      if (variableTargets === '*') {
        guardInitLinePos = this.codebuf.length;
        this.emit.line(``);
      } else {
        this.emit.line(`const ${guardStateVar} = runtime.guard.init(frame, ${JSON.stringify(variableTargets)});`);
      }
    }

    // 3. Compile Body
    this.compile(node.body, frame);

    // Resolve and Validate Sequence Targets
    // We do this by checking frame.writeCounts which contains all variables and sequence locks modified in the block
    const resolvedSequenceTargets = new Set();
    const modifiedLocks = new Set();

    if (frame.writeCounts) {
      for (const key of Object.keys(frame.writeCounts)) {
        if (key.startsWith('!')) {
          modifiedLocks.add(key);
        }
      }
    }

    if (node.sequenceTargets && node.sequenceTargets.length > 0) {
      for (const target of node.sequenceTargets) {
        let matchFound = false;

        if (target === '!') {
          // Global guard: all modified sequence locks
          for (const lock of modifiedLocks) {
            resolvedSequenceTargets.add(lock);
            matchFound = true;
          }
        } else {
          // Specific target: lock! -> !lock
          // target ends with '!' as per parser
          const baseKey = '!' + target.slice(0, -1);

          for (const lock of modifiedLocks) {
            // Check for exact match or child match (e.g. !lock matching !lock or !lock!sub)
            // Also include read-lock keys (suffix '~') for the same base.
            if (lock === baseKey || lock.startsWith(baseKey + '!') || lock.startsWith(baseKey + '~')) {
              resolvedSequenceTargets.add(lock);
              matchFound = true;
            }
          }

          if (!matchFound) {
            this.fail(`guard sequence lock "${target}" is not modified inside guard`, node.lineno, node.colno, node);
          }
        }
      }

      if (resolvedSequenceTargets.size > 0) {
        // Pass guardState (which is always initialized now if needed) to repairSequenceLocks
        // Note: guardStateVar is guaranteed to exist because variableTargets OR resolvedSequenceTargets > 0 triggers init
        this.emit.line(`  runtime.guard.repairSequenceLocks(frame, ${guardStateVar}, ${JSON.stringify(Array.from(resolvedSequenceTargets))});`);
      }
    }


    let finalVariableTargets = variableTargets;
    if (variableTargets === '*') {
      const writtenVars = frame.writeCounts
        ? Object.keys(frame.writeCounts).filter((key) => !key.startsWith('!'))
        : [];
      finalVariableTargets = writtenVars;
      if (guardStateVar && guardInitLinePos !== null) {
        this.emit.insertLine(guardInitLinePos,
          `const ${guardStateVar} = runtime.guard.init(frame, ${JSON.stringify(writtenVars)});`);
      }
    }

    if (finalVariableTargets && finalVariableTargets.length > 0) {
      for (const varName of finalVariableTargets) {
        if (!frame.writeCounts || !frame.writeCounts[varName]) {
          this.fail(`guard variable "${varName}" must be modified inside guard`, node.lineno, node.colno, node);
        }
      }
      for (const varName of finalVariableTargets) {
        this.async.updateFrameWrites(frame, varName);
      }
    }


    // 4. Inject Logic BEFORE closing the block
    // We need to wait for all inner async operations to complete so the buffer is fully populated
    // We wait for 1 because the current block itself is an active closure
    this.emit.line('await astate.waitAllClosures(1);');

    // 5. Check Buffer/Variables for Poison
    const guardErrorsVar = this._tmpid();

    // Calculate allowed handlers for poison detection based on selectors
    let allowedBufferHandlers = '[]';

    // If no specific selectors are provided (neither variables nor handlers),
    // it functions as a global guard (catch everything).
    if (handlerTargetsAll) {
      allowedBufferHandlers = 'null';
    } else if (handlerTargets) {
      allowedBufferHandlers = JSON.stringify(handlerTargets);
    }

    this.emit.line(`const ${guardErrorsVar} = await runtime.guard.getErrors(frame, ${guardStateVar || 'null'}, ${this.buffer}, ${allowedBufferHandlers});`);

    this.emit.line(`if (${guardErrorsVar}.length > 0) {`);
    if (handlerTargetsAll) {
      this.emit.line(`  runtime.markBufferReverted(${this.buffer});`);
      this.emit.line(`  delete ${this.buffer}._reverted;`);
      this.emit.line(`  ${this.buffer}.length = 0;`);
      this.emit.line(`  ${this.buffer}_index = 0;`);
    } else if (handlerTargets) {
      this.emit.line(`  runtime.revertBufferHandlers(${this.buffer}, ${JSON.stringify(handlerTargets)});`);
      this.emit.line(`  ${this.buffer}_index = ${this.buffer}.length;`);
    }

    if (guardStateVar) {
      this.emit.line(`  runtime.guard.complete(frame, ${guardStateVar}, true);`);
    }

    let recoveryWriteCounts;
    if (node.recoveryBody) {
      this.emit.asyncBlock(node, frame, true, (f) => {
        if (node.errorVar) {
          // Declare the error variable in the compiled scope
          this._addDeclaredVar(f, node.errorVar);
          this.async.updateFrameWrites(f, node.errorVar);
          // Directly set the variable in the frame.
          // Note: using 'true' for resolveUp is irrelevant here as it's a new variable in new scope (if logic holds),
          // but we set it in 'f' specifically.
          this.emit.line(`frame.set('${node.errorVar}', new runtime.PoisonError(${guardErrorsVar}));`);
        }
        this.compile(node.recoveryBody, f);
        recoveryWriteCounts = this.async.countsTo1(f.writeCounts);
      });
    }

    this.emit.line('} else {');

    if (recoveryWriteCounts) {
      this.emit.line(`frame.skipBranchWrites(${JSON.stringify(recoveryWriteCounts)});`);
    }

    if (guardStateVar) {
      this.emit.line(`  runtime.guard.complete(frame, ${guardStateVar}, false);`);
    }
    this.emit.line('}');

    // 6. End Async Block
    frame = this.emit.asyncBlockBufferNodeEnd(node, frame, true, false, node);
  }

  compileRevert(node, frame) {
    this.emit.addToBuffer(node, frame, () => {
      this.emit(`{ handler: '_', command: '_revert', arguments: [], pos: { lineno: ${node.lineno}, colno: ${node.colno} } }`);
    }, node);
    this.emit.line(`runtime.markBufferHasRevert(${this.buffer});`);
  }


  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if (this.asyncMode && node.isAsync) {
      async = false;//old type of async
    }

    const branchCreatesScope = this.scriptMode || this.asyncMode;

    // Use node.cond as the position node for the overarching If block
    frame = this.emit.asyncBlockBufferNodeBegin(node, frame, false, node.cond);

    let trueBranchWriteCounts, falseBranchWriteCounts;
    let trueBranchCodePos;
    let poisonCheckPos, catchPoisonPos;

    if (this.asyncMode) {
      // Async mode: Add try-catch wrapper for poison condition handling
      this.emit('try {');
      this.emit('const condResult = ');//@todo - use a temporary variable for the condition result
      this._compileAwaitedExpression(node.cond, frame, false);
      this.emit(';');
      this.emit('');

      this.emit('if (condResult) {');

      trueBranchCodePos = this.codebuf.length;
      this.emit('');
      // Use node.body as the position node for the true branch block
      this.emit.asyncBlock(node, frame, branchCreatesScope, (f) => {
        this.compile(node.body, f);
        trueBranchWriteCounts = this.async.countsTo1(f.writeCounts);
      }, node.body); // Pass body as code position

      this.emit('} else {');

      if (trueBranchWriteCounts) {
        //skip the true branch writes in the false branch
        this.emit('frame.skipBranchWrites(' + JSON.stringify(trueBranchWriteCounts) + ');');
      }

      if (node.else_) {
        // Use node.else_ as the position node for the false branch block
        this.emit.asyncBlock(node, frame, branchCreatesScope, (f) => {
          this.compile(node.else_, f);
          falseBranchWriteCounts = this.async.countsTo1(f.writeCounts);
        }, node.else_); // Pass else as code position
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

      // Add catch block to poison variables when condition fails
      const errorContext = this._createErrorContext(node, node.cond);
      this.emit('} catch (e) {');
      this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContext.lineno}, ${errorContext.colno}, "${errorContext.errorContextString}", context.path);`);
      catchPoisonPos = this.codebuf.length;
      this.emit('');
      this.emit('}');  // No re-throw - execution continues with poisoned vars

      // Fill in the poison handling code now that we have write counts and handlers
      const combinedCounts = this.async._combineWriteCounts([trueBranchWriteCounts, falseBranchWriteCounts]);

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
    } else {
      // Sync mode
      this.emit('if(');
      this._compileAwaitedExpression(node.cond, frame, false);
      this.emit('){');

      this.emit.withScopedSyntax(() => {
        let trueFrame = frame;
        if (branchCreatesScope) {
          trueFrame = frame.push();
          this.emit.line('frame = frame.push();');
        }
        this.compile(node.body, trueFrame);
        if (branchCreatesScope) {
          this.emit.line('frame = frame.pop();');
        }
        if (async) {
          this.emit('cb()');
        }
      });

      this.emit('} else {');

      if (node.else_) {
        this.emit.withScopedSyntax(() => {
          let falseFrame = frame;
          if (branchCreatesScope) {
            falseFrame = frame.push();
            this.emit.line('frame = frame.push();');
          }
          this.compile(node.else_, falseFrame);
          if (branchCreatesScope) {
            this.emit.line('frame = frame.pop();');
          }
          if (async) {
            this.emit('cb()');
          }
        });
      } else {
        if (async) {//not asyncMode
          this.emit('cb()');
        }
      }
      this.emit('}');
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
    this.loop.compileWhile(node, frame);
  }

  compileFor(node, frame) {
    this.loop.compileFor(node, frame);
  }

  compileAsyncEach(node, frame) {
    this.loop.compileAsyncEach(node, frame);
  }

  compileAsyncAll(node, frame) {
    this.loop.compileAsyncAll(node, frame);
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

    // Wrap the entire body in withPath to fork the context
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

    this.emit.line('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));

    let returnStatement;
    if (node.isAsync) {
      const errorCheck = `if (${err}) throw ${err};`;
      let bufferArgs = bufferId;
      if (this.scriptMode) {
        bufferArgs += ', this';
      }
      if (node.focus) {
        bufferArgs += `, "${node.focus}"`;
      }

      const flattenCall = `runtime.flattenBuffer(${bufferArgs})`;

      // Template mode OR script mode with :text focus needs SafeString
      const needsSafeString = !this.scriptMode || node.focus === 'text';
      const safeStringCall = needsSafeString
        ? `runtime.newSafeStringAsync(${flattenCall})`
        : flattenCall;

      returnStatement = `astate.waitAllClosures().then(() => {${errorCheck}return ${safeStringCall};});`;
    } else {
      // Sync case
      const needsSafeString = !this.scriptMode || node.focus === 'text';
      returnStatement = needsSafeString
        ? `new runtime.SafeString(${bufferId})`
        : bufferId;
    }

    this.emit.line('return ' + returnStatement);

    // Close the withPath wrapper function
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

  compileImport(node, frame) {
    this.inheritance.compileImport(node, frame);
  }

  compileFromImport(node, frame) {
    this.inheritance.compileFromImport(node, frame);
  }

  compileBlock(node, frame) {
    this.inheritance.compileBlock(node, frame);
  }

  compileSuper(node, frame) {
    this.inheritance.compileSuper(node, frame);
  }

  compileExtends(node, frame) {
    this.inheritance.compileExtends(node, frame);
  }

  compileInclude(node, frame) {
    this.inheritance.compileInclude(node, frame);
  }

  compileIncludeSync(node, frame) {
    this.inheritance.compileIncludeSync(node, frame);
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
        frame = this.emit.asyncBlockAddToBufferBegin(node, frame, child, 'text');
        const errorContextJson = node.isAsync ? JSON.stringify(this._createErrorContext(node, child)) : '';

        // In script mode, we use a special suppressor that passes through Result Objects
        // but still escapes standard strings if autoescape is on.
        if (this.scriptMode) {
          this.emit(`${node.isAsync ? 'await runtime.suppressValueScriptAsync(' : 'runtime.suppressValueScript('}`);
        } else {
          this.emit(`${node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue('}`);
        }

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
          this.emit(`, env.opts.autoescape, ${errorContextJson})`);
        } else {
          this.emit(', env.opts.autoescape)');
        }
        this.emit(';\n');

        frame = this.emit.asyncBlockAddToBufferEnd(node, frame, child, 'text'); // Pass Output node as op, child as pos
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
      // NEW: Pre-declaration pass
      const sequenceLocks = this.sequential.collectSequenceLocks(node);
      this.sequential.preDeclareSequenceLocks(frame, sequenceLocks);

      this.async.propagateIsAsync(node);
      // this.sequential._declareSequentialLocks(node, frame); // Old logic removed
    }

    this.emit.funcBegin(node, 'root');
    this.emit.line(`frame.markOutputBufferScope(${this.buffer});`);
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
        this.emit.line(`context = context.forkForPath(${this.inheritance._templateName()});`);
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
    const staticPath = this.sequential._extractStaticPath(node.call.name);

    if (this.outputFocus) {//@todo - think this over
      //skip compiling commands that do not target the focued property
      let commandTarget;

      if (staticPath && staticPath.length >= 1) {
        commandTarget = staticPath[0]; // First segment is always the handler
      } /* else if (node.call.name.value === 'text') {
        // Special case for text command
        commandTarget = 'text';
      }*/

      // If we identified a specific target and it doesn't match the focus, skip compilation.
      if (commandTarget && this.outputFocus !== commandTarget) {
        return;
      }
      /*// If the focus is on 'data', we can safely skip all OutputCommands.
      if (this.outputFocus === 'data') {
        return;
      }*/
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
      // Revert Command Interception
      if (command === '_revert') {
        if (subpath && subpath.length > 0) {
          this.fail('_revert() can only be called on the handler root (e.g. @data._revert())', node.lineno, node.colno, node);
        }
        // Special check for transpiled @data commands which move path to first argument
        if (handler === 'data' && node.call.args && node.call.args.children.length > 0) {
          const pathArg = node.call.args.children[0];
          // If pathArg is provided and is NOT a null literal, it means a subpath was provided
          // The transpiler generates Literal(null) for root calls like @data._revert()
          if (pathArg && !(pathArg instanceof nodes.Literal && pathArg.value === null)) {
            this.fail('_revert() can only be called on the handler root (e.g. @data._revert())', node.lineno, node.colno, node);
          }
        }
        this.emit.addToBuffer(node, frame, () => {
          this.emit(`{ handler: '${handler}', command: '_revert', arguments: [], pos: { lineno: ${node.lineno}, colno: ${node.colno} } }`);
        }, node);
        this.emit.line(`runtime.markBufferHasRevert(${this.buffer});`);
        return;
      }

      if (isAsync) {
        this.emit.asyncBlockAddToBuffer(node, frame, (resultVar, f) => {
          this.emit(`${resultVar} = `);
          emitLogic(f); // Pass the inner frame to the logic.
        }, node, handler);
      } else {
        this.emit.addToBuffer(node, frame, () => {
          emitLogic(frame); // Pass the current frame.
        }, node, handler);
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

        // Convert the path argument into a flat array of segments (Literal/Symbol)
        // expected by the runtime @data handlers.
        const pathNodeList = this._flattenPathToNodeList(pathArg);
        const dataPathNode = new nodes.Array(pathArg.lineno, pathArg.colno, pathNodeList.children);
        dataPathNode.isAsync = pathNodeList.isAsync;
        dataPathNode.mustResolve = true;

        // Our array node at the front.
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

  _getDeclarationFrame(frame) {
    let current = frame;
    while (current && current.createScope === false) {
      current = current.parent;
    }
    return current || frame;
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
