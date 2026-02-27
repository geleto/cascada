const {
  RESERVED_DECLARATION_NAMES,
  validateResolveUp,
  validateGuardVariablesDeclared,
  validateGuardVariablesModified,
  validateSetTarget,
  validateDeclarationScope,
  validateReadOnlyOuterMutation,
  validateOutputDeclarationNode,
  ENABLE_READVARS_VALIDATION
} = require('./validation');

const parser = require('../parser');
const transformer = require('../transformer');
const nodes = require('../nodes');
const { Frame, AsyncFrame } = require('../runtime/runtime');
const CompileSequential = require('./compile-sequential');
const CompileEmit = require('./compile-emit');
const CompileAsync = require('./compile-async');
const CompileInheritance = require('./compile-inheritance');
const CompileLoop = require('./compile-loop');
const CompileBuffer = require('./compile-buffer');
const CompilerBase = require('./compiler-base');
const { CONVERT_TEMPLATE_VAR_TO_VALUE, SEQUNTIAL_PATHS_USE_VALUE, VALUE_IMPORT_BINDINGS } = require('../feature-flags');

class Compiler extends CompilerBase {
  init(templateName, options) {
    // Initialize base properties like codebuf, asyncMode, etc.
    super.init(options);

    // Properties specific to the full statement-aware compiler
    this.templateName = templateName;
    this.hasExtends = false;
    this.inBlock = false;
    this.enableReadVarsValidation = ENABLE_READVARS_VALIDATION;

    // Instantiate and link helper modules
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = new CompileAsync(this);
    this.inheritance = new CompileInheritance(this);
    this.loop = new CompileLoop(this);
    this.buffer = new CompileBuffer(this);
  }


  //@todo - move to compile-base next to _isDeclared
  _addDeclaredVar(frame, varName) {
    if (this.asyncMode || this.scriptMode) {
      validateDeclarationScope(frame, varName, this, null);
      // Variables and outputs share the same lexical scoping rules.
      // Use _getDeclaredOutput (lexical-only) for collision checks.
      const outputDecl = this.async._getDeclaredOutput(frame, varName);
      const allowSequenceLockAlias = varName && varName.startsWith('!') &&
        outputDecl && outputDecl.type === 'sequential_path';
      if (outputDecl && outputDecl.type !== 'value' && !allowSequenceLockAlias) {
        this.fail(`Cannot declare variable '${varName}' because an output with the same name is already declared.`);
      }

      if (!frame.declaredVars) {
        frame.declaredVars = new Set();
      }
      frame.declaredVars.add(varName);
    }
  }

  isReservedDeclarationName(name) {
    return RESERVED_DECLARATION_NAMES.has(name);
  }

  _addDeclaredOutput(frame, name, outputType, initializer = null, node = null) {
    validateDeclarationScope(frame, name, this, node);
    frame.declaredOutputs = frame.declaredOutputs || new Map();

    if (this.isReservedDeclarationName(name)) {
      this.fail(
        `Identifier '${name}' is reserved and cannot be used as a variable or output name.`,
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }

    if (frame.declaredOutputs.has(name)) {
      this.fail(`Output '${name}' already declared`, node && node.lineno, node && node.colno, node || undefined);
    }

    // Match variable declaration semantics: disallow shadowing parent declarations.
    let parentFrame = frame && frame.parent;
    while (parentFrame) {
      if (parentFrame.declaredOutputs && parentFrame.declaredOutputs.has(name)) {
        this.fail(
          `Cannot declare output '${name}' because it shadows an output declared in a parent scope`,
          node && node.lineno,
          node && node.colno,
          node || undefined
        );
      }
      parentFrame = parentFrame.parent;
    }

    // Output declarations cannot conflict with variables in the same lexical frame chain.
    // Note: we intentionally do NOT consider outputParent here; macro/call detached scopes
    // can still access outer outputs via @name without having lexical name conflicts.
    if (this._isDeclared(frame, name)) {
      this.fail(
        `Cannot declare output '${name}' because a variable with the same name is already declared`,
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }

    frame.declaredOutputs.set(name, {
      type: outputType,
      initializer: initializer || null,
    });
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
   * Implements the call/caller() compilation.
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

    const emitCallArgs = (callFrame) => {
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
          this._compileExpression(arg, callFrame, false);

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
              this.emit.asyncBlockRender(node, callFrame, function (f) {
                this.emit.line(`frame.markOutputBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, f);
              }, null, arg); // Use content arg node for position
            }
            else {
              //when not resolve args, the contentArgs are callback functions
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit.asyncBlockRender(node, callFrame, function (f) {
                  this.emit.line(`frame.markOutputBufferScope(${this.buffer.currentBuffer});`);
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
    };

    let timingPromiseId = null;
    if (noExtensionCallback || node.isAsync) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
      if (this.asyncMode) {
        timingPromiseId = this._tmpid();
        this.emit.line(`let ${timingPromiseId};`);
      }

      frame = this.buffer.asyncAddToBufferScoped(
        node,
        frame,
        positionNode,
        'text',
        'text',
        true,
        this.asyncMode,
        (innerFrame) => {
          let errorContextJson;
          if (this.asyncMode) {
            this.emit(`(${timingPromiseId} = runtime.resolveSingle(`);
          } else {
            errorContextJson = node.isAsync ? JSON.stringify(this._createErrorContext(node, positionNode)) : '';
            this.emit(node.isAsync ? 'await runtime.suppressValueAsync(' : 'runtime.suppressValue(');
          }
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

          emitCallArgs(innerFrame);
          this.emit(`)`);//close the extension call
          if (this.asyncMode) {
            this.emit('))');
            this.emit(';\n');
            this.emit.line(`await ${timingPromiseId};`);
          } else if (node.isAsync) {
            this.emit(`, ${autoescape} && env.opts.autoescape, ${errorContextJson});`);//end of suppressValue
          } else {
            this.emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
          }
        }
      );
    } else {
      //use the original nunjucks callback mechanism
      this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
      emitCallArgs(frame);

      const res = this._tmpid();
      this.emit.line(', ' + this._makeCallback(res));
      let callbackTimingPromiseId = null;
      if (this.asyncMode) {
        callbackTimingPromiseId = this._tmpid();
        this.emit.line(`let ${callbackTimingPromiseId};`);
      }
      frame = this.buffer.asyncAddToBufferScoped(
        node,
        frame,
        positionNode,
        'text',
        'text',
        true,
        this.asyncMode,
        () => {
          if (this.asyncMode) {
            this.emit(`(${callbackTimingPromiseId} = runtime.resolveSingle(${res}))`);
            this.emit(';\n');
            this.emit.line(`await ${callbackTimingPromiseId};`);
          } else {
            const errorContextJson2 = node.isAsync ? JSON.stringify(this._createErrorContext(node, positionNode)) : '';
            if (node.isAsync) {
              this.emit(`await runtime.suppressValueAsync(${res}, ${autoescape} && env.opts.autoescape, ${errorContextJson2});`);
            } else {
              this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
            }
          }
        }
      );

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
    if (node.varType === 'setval' || (this.scriptMode && node.isSetvalDeclaration)) {
      return this.compileSetval(node, frame);
    }

    if (this.scriptMode &&
      node.varType === 'assignment' &&
      node.targets &&
      node.targets.length > 0 &&
      node.targets.every((t) => {
        if (!(t instanceof nodes.Symbol)) return false;
        const out = this.async._getDeclaredOutput(frame, t.value);
        return !!(out && out.type === 'value');
      })) {
      return this.compileSetval(node, frame);
    }

    const ids = [];

    // 1. First pass: Validate, declare, and prepare temporary JS variables for all targets.
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      const isDeclared = this._isDeclared(frame, name);

      // Read-only parent scopes (e.g. call/caller bodies) may read from parent frames,
      // but must not mutate parent variables. Without this check, assignments can
      // silently become local shadows, which is surprising.
      if (this.scriptMode && node.varType === 'assignment') {
        validateReadOnlyOuterMutation(this, {
          frame,
          node,
          target,
          name,
          mutatingOuterRef: isDeclared && !(frame.declaredVars && frame.declaredVars.has(name))
        });
      }

      validateSetTarget(this, node, target, name, isDeclared);

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
      // In async mode, updateFrameWrites returns whether write counters were added
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
      // Determine if resolveUp should be true based on mode and write counter metadata
      let resolveUp;

      if (this.scriptMode) {
        // Script mode: Use metadata from updateFrameWrites
        // This tells us if write counters were actually registered for this variable
        // Convert to boolean to avoid undefined vs false mismatches
        const hasResolveUpMetadata = !!(frame.varsNeedingResolveUp && frame.varsNeedingResolveUp.has(name));

        // Bidirectional validation (enabled by flag for development/debugging)
        validateResolveUp(frame, name, hasResolveUpMetadata, this, node);

        resolveUp = hasResolveUpMetadata;
      } else {
        // Template mode: always pass true to resolve up and maintain original behavior
        resolveUp = true;
      }

      this.emit.line(`frame.set("${name}", ${valueId}, ${resolveUp});`);

      // This block is specific to template mode's behavior.
      if (!this.scriptMode && !(this.asyncMode && VALUE_IMPORT_BINDINGS)) {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.setVariable("${name}", ${valueId});`);
        this.emit.line('}');
      }

      // This export logic is common to both modes.
      if (name.charAt(0) !== '_') {
        this.emit.line('if(frame.topLevel) {');
        if (this.asyncMode && VALUE_IMPORT_BINDINGS) {
          this.emit.line(`  context.addExport("${name}");`);
        } else {
          this.emit.line(`  context.addExport("${name}", ${valueId});`);
        }
        this.emit.line('}');
      }
    });
  }

  compileCallAssign(node, frame) {
    // `call_assign` is an internal script feature emitted by the ScriptTranspiler.
    if (!this.scriptMode) {
      this.fail('call_assign is only supported in script mode', node.lineno, node.colno, node);
    }

    // Reuse the existing Set compilation path.
    const setNode = new nodes.Set(node.lineno, node.colno, node.targets, node.value, node.varType);
    if (node.isSetvalDeclaration) {
      setNode.isSetvalDeclaration = !!node.isSetvalDeclaration;
    }
    return this.compileSet(setNode, frame);
  }

  compileSetval(node, frame) {
    const templateSetvalMode = !this.scriptMode && CONVERT_TEMPLATE_VAR_TO_VALUE;
    if (!this.scriptMode && !templateSetvalMode) {
      this.fail('setval is only supported in script mode or template conversion mode', node.lineno, node.colno, node);
    }
    if (!this.asyncMode) {
      // Template conversion mode rewrites `{% set %}` tags to `setval`.
      // In sync template compilation we must preserve original set semantics,
      // so route converted tags back through standard assignment compilation.
      if (templateSetvalMode) {
        const setNode = new nodes.Set(node.lineno, node.colno, node.targets, node.value, 'assignment');
        if (node.body) {
          setNode.body = node.body;
        }
        if (node.path) {
          setNode.path = node.path;
        }
        return this.compileSet(setNode, frame);
      }
      this.fail('setval is only supported in async mode', node.lineno, node.colno, node);
    }
    const ids = [];
    const isDeclaration = !!node.isSetvalDeclaration;
    const isDeclarationOnly = !!node.declarationOnly;
    const validationNode = Object.assign({}, node, {
      varType: isDeclaration ? 'declaration' : 'assignment'
    });

    // 1. First pass: validate + declarations + temp ids (mirrors compileSet structure).
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      const declaredOutput = this.async._getDeclaredOutput(frame, name);
      const shouldDeclareInTemplateMode = templateSetvalMode && !(declaredOutput && declaredOutput.type === 'value');
      const shouldDeclare = isDeclaration || shouldDeclareInTemplateMode;
      const isDeclaredForValidation = shouldDeclare
        ? !!(frame.declaredOutputs && frame.declaredOutputs.has(name))
        : !!(declaredOutput && declaredOutput.type === 'value');

      if (this.scriptMode && !isDeclaration) {
        const declaredInCurrentScope = !!(frame.declaredOutputs && frame.declaredOutputs.has(name));
        validateReadOnlyOuterMutation(this, {
          frame,
          node,
          target,
          name,
          mutatingOuterRef: isDeclaredForValidation && !declaredInCurrentScope
        });
      }

      validateSetTarget(this, validationNode, target, name, isDeclaredForValidation);

      if (shouldDeclare) {
        this._addDeclaredOutput(frame, name, 'value', null, node);
        this.emit(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "value", context, null);`);
      } else {
        if (!(declaredOutput && declaredOutput.type === 'value')) {
          this.fail(
            `Cannot assign to undeclared value output '${name}'. Use 'value ${name}' to declare it first.`,
            target.lineno,
            target.colno,
            node,
            target
          );
        }
      }

      id = this._tmpid();
      this.emit.line(`let ${id};`);
      const declarationFrame = this._getDeclarationFrame(frame);
      declarationFrame.set(name, id);
      ids.push(id);
    });

    // 2. Compile assignment source (same shape as compileSet, including set_path).
    let hasAssignedValue = false;
    if (node.path) {
      if (ids.length !== 1) {
        this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
      }
      const targetName = node.targets[0].value;
      this.emit(ids[0] + ' = ');
      this.emit('runtime.setPath(');
      // Preserve command-tree ordering by reading the current value output
      // through a raw snapshot command in the active buffer.
      this.buffer.emitAddRawSnapshot(frame, targetName, node);
      this.emit(', ');
      this._compileAggregate(node.path, frame, '[', ']', false, false);
      this.emit(', ');
      this._compileExpression(node.value, frame, true);
      this.emit(')');
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.value && !isDeclarationOnly) {
      this.emit(ids.join(' = ') + ' = ');
      this._compileExpression(node.value, frame, true, node.value);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.body) {
      this.emit(ids.join(' = ') + ' = ');
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.compile(n.body, f);
      }, undefined, node.body);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (!isDeclaration) {
      this.fail('set value assignment requires a value or capture body.', node.lineno, node.colno, node);
    }

    // 3. Second pass: emit output commands + export (mirrors compileSet second-pass shape).
    node.targets.forEach((target, i) => {
      const name = target.value;
      const valueId = ids[i];

      if (hasAssignedValue) {
        this.buffer.asyncAddValueToBuffer(node, frame, (resultVar) => {
          this.emit(
            `${resultVar} = new runtime.ValueCommand({ handler: '${name}', args: [${valueId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`
          );
        }, node, name);
      }

      if (name.charAt(0) !== '_' && hasAssignedValue) {
        this.emit.line('if(frame.topLevel) {');
        if (this.asyncMode && VALUE_IMPORT_BINDINGS) {
          this.emit.line(`  context.addExport("${name}");`);
        } else {
          this.emit.line(`  context.addExport("${name}", ${valueId});`);
        }
        this.emit.line('}');
      }

      if (!this.scriptMode && hasAssignedValue && !(this.asyncMode && VALUE_IMPORT_BINDINGS)) {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.setVariable("${name}", ${valueId});`);
        this.emit.line('}');
      }
    });
  }

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    const switchResult = this.buffer.asyncBufferNode(node, frame, false, false, node.expr, (blockFrame) => {
      const branchPositions = [];
      const branchWriteCounts = [];
      const branchHandlers = []; // Track handlers per branch
      let catchPoisonPos;
      const caseCreatesScope = this.scriptMode || this.asyncMode;

      if (this.asyncMode) {
        // Add try-catch wrapper for error handling
        this.emit('try {');
        this.emit('const switchResult = ');
        this._compileAwaitedExpression(node.expr, blockFrame, false);
        this.emit(';');
        this.emit('');
        // Note: awaited result cannot be a resolved PoisonedValue, so no check needed

        // Emit switch statement
        this.emit('switch (switchResult) {');
      } else {
        // Sync mode - no error handling needed
        this.emit('switch (');
        this._compileAwaitedExpression(node.expr, blockFrame, false);
        this.emit(') {');
      }

      // Compile cases
      node.cases.forEach((c, i) => {
        this.emit('case ');
        this._compileAwaitedExpression(c.cond, blockFrame, false);
        this.emit(': ');

        branchPositions.push(this.codebuf.length);
        this.emit('');

        if (c.body.children.length) {
          // Use case body 'c.body' as position node for this block
          this.emit.asyncBlock(c, blockFrame, caseCreatesScope, (f) => {
            this.compile(c.body, f);
            branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});

            // Collect handlers from this branch
            if (this.asyncMode) {
              branchHandlers.push(this.buffer.collectBranchHandlers(c.body, blockFrame));
            }
          }, c.body); // Pass body as code position
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
        this.emit.asyncBlock(node, blockFrame, caseCreatesScope, (f) => {
          this.compile(node.default, f);
          branchWriteCounts.push(this.async.countsTo1(f.writeCounts) || {});

          // Collect handlers from default
          if (this.asyncMode) {
            branchHandlers.push(this.buffer.collectBranchHandlers(node.default, blockFrame));
          }
        }, node.default); // Pass default as code position
      } else if (this.asyncMode) {
        // No default case - add empty handler placeholder for collection
        // (branchPositions and branchWriteCounts intentionally not modified)
        branchHandlers.push(new Set());
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
            for (const handler of allHandlers) {
              this.emit.insertLine(catchPoisonPos,
                `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${handler}");`);
            }
          }
        }
      }
    });

    frame = switchResult.frame;
  }

  compileGuard(node, frame) {
    if (!this.asyncMode) {
      this.fail('guard block only supported in async mode', node.lineno, node.colno);
    }

    const guardTargets = this._getGuardTargets(node, frame);
    const variableTargets = guardTargets.variableTargets;
    const hasSequenceTargets = !!guardTargets.sequenceTargets;
    // We need guard state if we have variables OR if we have sequence targets (for error detection)
    // Note: We don't fully resolve sequence targets here yet, but if the user *requested* sequence targets,
    // we should prepare the state. If it turns out they are empty/unused, init() handles empty lists fine.
    const needsGuardState = (variableTargets === '*') || !!variableTargets || hasSequenceTargets;
    const guardStateVar = needsGuardState ? this._tmpid() : null;

    validateGuardVariablesDeclared(variableTargets, frame, this, node);

    // Guard blocks are always async boundaries
    node.isAsync = true;

    const guardResult = this.buffer.asyncBufferNode(node, frame, true, false, node, (blockFrame) => {
      // Guard blocks should keep output writes scoped to the guard buffer.
      blockFrame.outputScope = true;
      const previousGuardDepth = this.guardDepth;
      this.guardDepth = previousGuardDepth + 1;

      try {
        // 2. Link for explicit reversion (optional, if we want to support manual revert)
        this.emit.line(`frame.markOutputBufferScope(${this.buffer.currentBuffer});`);
        let guardInitLinePos = null;
        let guardRepairLinePos = null;
        const outputGuardInitLinePos = this.codebuf.length;
        let outputGuardStateVar = null;
        this.emit.line('');
        if (guardStateVar) {
          if (variableTargets === '*') {
            guardInitLinePos = this.codebuf.length;
            this.emit.line(``);
          } else {
            this.emit.line(`const ${guardStateVar} = runtime.guard.init(frame, ${JSON.stringify(variableTargets)}, cb);`);
          }
        }
        // Sequence lock repair must run before guard body starts scheduling work.
        guardRepairLinePos = this.codebuf.length;
        this.emit.line('');

        // 3. Compile Body
        this.compile(node.body, blockFrame);

        // Resolve and Validate Sequence Targets
        // We do this by checking frame.writeCounts which contains all variables and sequence locks modified in the block
        const resolvedSequenceTargets = new Set();
        const modifiedLocks = new Set();

        if (blockFrame.writeCounts) {
          for (const key of Object.keys(blockFrame.writeCounts)) {
            if (key.startsWith('!')) {
              if (SEQUNTIAL_PATHS_USE_VALUE && key.endsWith('~')) {
                modifiedLocks.add(key.slice(0, -1));
              } else {
                modifiedLocks.add(key);
              }
            }
          }
        }
        if (SEQUNTIAL_PATHS_USE_VALUE && blockFrame.usedOutputs) {
          for (const outputName of blockFrame.usedOutputs) {
            if (outputName.startsWith('!')) {
              modifiedLocks.add(outputName);
            }
          }
        }

        const shouldGuardAllSequencesImplicitly = SEQUNTIAL_PATHS_USE_VALUE &&
          variableTargets === '*' &&
          (!node.sequenceTargets || node.sequenceTargets.length === 0);

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
                const includeReadLocks = !SEQUNTIAL_PATHS_USE_VALUE;
                if (lock === baseKey || lock.startsWith(baseKey + '!') || (includeReadLocks && lock.startsWith(baseKey + '~'))) {
                  resolvedSequenceTargets.add(lock);
                  matchFound = true;
                }
              }

              if (!matchFound) {
                this.fail(`guard sequence lock "${target}" is not modified inside guard`, node.lineno, node.colno, node);
              }
            }
          }
        } else if (shouldGuardAllSequencesImplicitly) {
          for (const lock of modifiedLocks) {
            resolvedSequenceTargets.add(lock);
          }
        }

        if (resolvedSequenceTargets.size > 0) {
          if (SEQUNTIAL_PATHS_USE_VALUE) {
            this.emit.insertLine(
              guardRepairLinePos,
              `runtime.guard.repairSequenceOutputs(frame, ${this.buffer.currentBuffer}, ${guardStateVar}, ${JSON.stringify(Array.from(resolvedSequenceTargets))});`
            );
          } else {
            // Pass guardState (which is always initialized now if needed) to repairSequenceLocks
            // Note: guardStateVar is guaranteed to exist because variableTargets OR resolvedSequenceTargets > 0 triggers init
            this.emit.insertLine(
              guardRepairLinePos,
              `runtime.guard.repairSequenceLocks(frame, ${guardStateVar}, ${JSON.stringify(Array.from(resolvedSequenceTargets))});`
            );
          }
        }


        let finalVariableTargets = variableTargets;
        if (variableTargets === '*') {
          const writtenVars = blockFrame.writeCounts
            ? Object.keys(blockFrame.writeCounts).filter((key) => !key.startsWith('!'))
            : [];
          finalVariableTargets = writtenVars;
          if (guardStateVar && guardInitLinePos !== null) {
            this.emit.insertLine(guardInitLinePos,
              `const ${guardStateVar} = runtime.guard.init(frame, ${JSON.stringify(writtenVars)}, cb);`);
          }
        }

        validateGuardVariablesModified(finalVariableTargets, blockFrame, this, node);

        if (finalVariableTargets && finalVariableTargets.length > 0) {
          for (const varName of finalVariableTargets) {
            this.async.updateFrameWrites(blockFrame, varName);
          }
        }

        let guardHandlers = this._getGuardedOutputNames(
          blockFrame.usedOutputs,
          guardTargets,
          blockFrame
        );
        if (SEQUNTIAL_PATHS_USE_VALUE && resolvedSequenceTargets.size > 0) {
          const merged = new Set(guardHandlers);
          for (const lockName of resolvedSequenceTargets) {
            merged.add(lockName);
          }
          guardHandlers = Array.from(merged);
        }
        if (SEQUNTIAL_PATHS_USE_VALUE && blockFrame.declaredOutputs) {
          const merged = new Set(guardHandlers);
          for (const name of blockFrame.declaredOutputs.keys()) {
            merged.add(name);
          }
          guardHandlers = Array.from(merged);
        }
        if (guardHandlers.length > 0) {
          outputGuardStateVar = this._tmpid();
          this.emit.insertLine(
            outputGuardInitLinePos,
            `const ${outputGuardStateVar} = runtime.guard.initOutputSnapshots(frame, ${JSON.stringify(guardHandlers)}, ${this.buffer.currentBuffer}, cb);`
          );
        }

        // 4. Inject Logic BEFORE closing the block
        // We need to wait for all inner async operations to complete so the buffer is fully populated
        // We wait for 1 because the current block itself is an active closure
        this.emit.line('await astate.waitAllClosures(1);');

        // 5. Check Buffer/Variables for Poison
        const guardErrorsVar = this._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(frame, ${guardStateVar || 'null'}, ${this.buffer.currentBuffer}, ${JSON.stringify(guardHandlers)}, ${outputGuardStateVar || 'null'});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        let recoveryWriteCounts;
        if (node.recoveryBody) {
          this.emit.asyncBlock(node, blockFrame, true, (f) => {
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
        this.emit.line('}');
      } finally {
        this.guardDepth = previousGuardDepth;
      }
    });

    frame = guardResult.frame;
  }

  _getGuardedOutputNames(usedOutputs, guardTargets, frame) {
    let used = [];
    if (usedOutputs instanceof Set) {
      used = Array.from(usedOutputs);
    } else if (Array.isArray(usedOutputs)) {
      used = usedOutputs;
    }

    if (!guardTargets) {
      return [];
    }

    if (guardTargets.handlerSelector === '*') {
      return used;
    }

    const hasNamedHandlers = Array.isArray(guardTargets.handlerSelector) && guardTargets.handlerSelector.length > 0;
    const hasTypedHandlers = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedHandlers || hasTypedHandlers) {
      const guardedSet = new Set(hasNamedHandlers ? guardTargets.handlerSelector : []);
      const guardedTypes = new Set(hasTypedHandlers ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0 || !frame) {
          return false;
        }
        const outputDecl = this.async._getDeclaredOutput(frame, name);
        if (outputDecl) {
          return guardedTypes.has(outputDecl.type);
        }
        return guardedTypes.has(name);
      });
    }

    // No selectors at all means global guard.
    if (!guardTargets.hasAnySelectors) {
      return used;
    }

    // Variable/sequence-only guards do not guard output handlers.
    return [];
  }

  _getGuardTargets(guardNode, frame) {
    const handlerTargetsRaw = Array.isArray(guardNode && guardNode.handlerTargets) &&
      guardNode.handlerTargets.length > 0
      ? guardNode.handlerTargets
      : null;
    let handlerSelector = !handlerTargetsRaw
      ? null
      : (handlerTargetsRaw.includes('@') ? '*' : handlerTargetsRaw);
    const typeTargets = Array.isArray(guardNode && guardNode.typeTargets) && guardNode.typeTargets.length > 0
      ? guardNode.typeTargets
      : null;

    const variableTargetsRaw = guardNode && guardNode.variableTargets === '*'
      ? '*'
      : (Array.isArray(guardNode && guardNode.variableTargets) && guardNode.variableTargets.length > 0
        ? guardNode.variableTargets
        : null);
    let variableTargets = variableTargetsRaw;

    if (Array.isArray(variableTargetsRaw) && variableTargetsRaw.length > 0) {
      const resolvedVariables = [];
      const resolvedHandlers = new Set(Array.isArray(handlerSelector) ? handlerSelector : []);

      for (const name of variableTargetsRaw) {
        const isDeclaredVar = this._isDeclared(frame, name);
        const outputDecl = this.async._getDeclaredOutput(frame, name);

        if (isDeclaredVar) {
          resolvedVariables.push(name);
        }
        if (outputDecl) {
          resolvedHandlers.add(name);
        }
        if (!isDeclaredVar && !outputDecl) {
          resolvedVariables.push(name);
        }
      }

      if (handlerSelector !== '*') {
        handlerSelector = resolvedHandlers.size > 0 ? Array.from(resolvedHandlers) : null;
      }
      variableTargets = resolvedVariables.length > 0 ? resolvedVariables : null;
    }
    const sequenceTargets = Array.isArray(guardNode && guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!handlerSelector || !!typeTargets || !!variableTargets || !!sequenceTargets;

    return {
      handlerSelector,
      typeTargets,
      variableTargets,
      sequenceTargets,
      hasAnySelectors
    };
  }

  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if (this.asyncMode && node.isAsync) {
      async = false;//old type of async
    }

    const branchCreatesScope = this.scriptMode || this.asyncMode;
    const ifResult = this.buffer.asyncBufferNode(node, frame, false, false, node.cond, (blockFrame) => {
      let trueBranchWriteCounts, falseBranchWriteCounts;
      let trueBranchCodePos;
      let catchPoisonPos;

      if (this.asyncMode) {
        const condResultId = this._tmpid();
        // Async mode: Add try-catch wrapper for poison condition handling
        this.emit('try {');
        this.emit(`const ${condResultId} = `);
        this._compileAwaitedExpression(node.cond, blockFrame, false);
        this.emit(';');
        this.emit('');

        this.emit(`if (${condResultId}) {`);

        trueBranchCodePos = this.codebuf.length;
        this.emit('');
        // Use node.body as the position node for the true branch block
        this.emit.asyncBlock(node, blockFrame, branchCreatesScope, (f) => {
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
          this.emit.asyncBlock(node, blockFrame, branchCreatesScope, (f) => {
            this.compile(node.else_, f);
            falseBranchWriteCounts = this.async.countsTo1(f.writeCounts);
          }, node.else_); // Pass else as code position
        }
        this.emit('}');

        // Collect output handlers from both branches (for async mode poison handling)
        let trueBranchHandlers, falseBranchHandlers, allHandlers;
        if (this.asyncMode) {
          trueBranchHandlers = this.buffer.collectBranchHandlers(node.body, blockFrame);
          falseBranchHandlers = node.else_ ?
            this.buffer.collectBranchHandlers(node.else_, blockFrame) :
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
            this.emit.insertLine(catchPoisonPos,
              `    frame.poisonBranchWrites(contextualError, ${JSON.stringify(combinedCounts)});`);
          }

          // Handler (buffer) poisoning
          if (hasHandlers) {
            for (const handler of allHandlers) {
              this.emit.insertLine(catchPoisonPos,
                `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${handler}");`);
            }
          }
        }
      } else {
        // Sync mode
        this.emit('if(');
        this._compileAwaitedExpression(node.cond, blockFrame, false);
        this.emit('){');

        this.emit.withScopedSyntax(() => {
          let trueFrame = blockFrame;
          if (branchCreatesScope) {
            trueFrame = blockFrame.push();
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
            let falseFrame = blockFrame;
            if (branchCreatesScope) {
              falseFrame = blockFrame.push();
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
        } else if (async) { // not asyncMode
          this.emit('cb()');
        }
        this.emit('}');
      }
    });

    frame = ifResult.frame;
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
    // Macro bodies should not behave like root scope returns.
    currFrame._seesRootScope = false;

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
    // Avoid mutating outer `frame` by shadowing it inside the macro body.
    this.emit.line('return (function(frame) {');

    // Keep a stable reference for caller/output lookup regardless of frame push/new.
    this.emit.line('let callerFrame = frame;');
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
    let returnStatement;
    const snapshotVar = this._tmpid();
    this.emit.managedBlock(currFrame, false, true, (managedFrame, bufferId) => {
      this.emit.withScopedSyntax(() => {
        this.compile(node.body, managedFrame);
      });

      this.emit.line('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));

      if (node.isAsync) {
        const errorCheck = `if (${err}) throw ${err};`;
        if (this.scriptMode) {
          returnStatement = `astate.waitAllClosures().then(() => {${errorCheck}return undefined;});`;
        } else {
          // Snapshot must be enqueued before this managed buffer is finished.
          this.emit.line(`const ${snapshotVar} = ${bufferId}.addSnapshot("text", {lineno: ${node.lineno}, colno: ${node.colno}});`);

          const needsSafeString = !this.scriptMode;
          const safeStringCall = needsSafeString
            ? `runtime.markSafe(${snapshotVar})`
            : snapshotVar;

          returnStatement = `astate.waitAllClosures().then(() => {${errorCheck}return ${safeStringCall};});`;
        }
      } else {
        // Sync case
        const needsSafeString = !this.scriptMode;
        returnStatement = needsSafeString
          ? `new runtime.SafeString(${bufferId})`
          : bufferId;
      }
    });

    this.emit.line('return ' + returnStatement);

    // Close the macro-body IIFE.
    this.emit.line('}).call(this, frame);');
    // Close the withPath wrapper function
    this.emit.line('});'); // 1. Closes the withPath inner function

    // Now, close the outer function passed to makeMacro
    if (node.isAsync) {
      this.emit.line('}, astate);'); // 2a. Closes the main function for async
    } else {
      this.emit.line('});'); // 2b. Closes the main function for sync
    }

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
        this.emit.line(`context.addExport("${name}", ${funcId});`);
        if (!(this.asyncMode && VALUE_IMPORT_BINDINGS)) {
          this.emit.line(`context.setVariable("${name}", ${funcId});`);
        }
      } else {
        this.emit.line(`context.setVariable("${name}", ${funcId});`);
      }
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
    const buffer = this.buffer.currentBuffer;
    const textOutput = this.buffer.currentTextOutput;
    this.buffer.currentBuffer = 'output';
    this.buffer.currentTextOutput = 'output_textOutput';
    if (node.isAsync) {
      const res = this._tmpid();
      // Use node.body as position node for the capture block evaluation
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        this.emit.line('let output = currentBuffer;');
        //this.emit.line('if (!output) { throw new Error("Capture block requires async block output buffer"); }');
        this.emit.line(`let output_textOutput = runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "text", "text", context, null);`);
        // Capture bodies should not be treated as root-scope returns.
        f._seesRootScope = false;
        // Capture returns run inside an async block; wait for sibling closures.
        f._returnWaitCount = 1;

        if (this.scriptMode) {
          this.emit.line(`let ${res} = (async function(frame) {`);
          this.compile(n.body, f);//write to output
          this.emit.line('return undefined;');
          this.emit.line('}).call(this, frame);');
        } else {
          this.compile(n.body, f);//write to output
          this.emit.line('await astate.waitAllClosures(1)');
          this.emit.line(`let ${res} = await ${this.buffer.currentBuffer}.addSnapshot("text", {lineno: ${node.body.lineno}, colno: ${node.body.colno}});`);
        }
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res, node.body, true);
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
    this.buffer.currentBuffer = buffer;
    this.buffer.currentTextOutput = textOutput;
  }

  // @todo - get rid of the asyncAddToBufferBegin after we have switch var to the new value implementation
  compileOutput(node, frame) {
    if (this.asyncMode) {
      const children = node.children;
      children.forEach(child => {
        if (child instanceof nodes.TemplateData) {
          if (child.value) {
            this.buffer.addToBuffer(node, frame, function () {
              this.compileLiteral(child, frame);
            }, child, 'text', true);
          }
          return;
        }
        const timingPromiseId = this._tmpid();
        this.emit.line(`let ${timingPromiseId};`);
        frame = this.buffer.asyncAddToBufferScoped(
          node,
          frame,
          child,
          'text',
          'text',
          true,
          true,
          (innerFrame) => {
            // Keep command args unresolved for apply-time resolution/error handling.
            // Temporary timing barrier: await expression completion in the same async
            // block that enqueues the command so current write-count/lock lifecycle stays stable.
            // It will be removed after switching from var to value implementation.
            this.emit(`(${timingPromiseId} = runtime.resolveSingle(`);
            this._compileExpression(child, innerFrame, false);
            this.emit('))');
            this.emit(';\n');
            this.emit.line(`await ${timingPromiseId};`);
          }
        );
      });
      return;
    }

    const children = node.children;
    children.forEach(child => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, frame, function () {
            this.compileLiteral(child, frame);
          }, child, 'text', false);
        }
        return;
      }

      this.buffer.addToBuffer(node, frame, function () {
        this.emit('runtime.suppressValue(');
        if (this.throwOnUndefined) {
          this.emit('runtime.ensureDefined(');
        }
        this._compileExpression(child, frame, false);
        if (this.throwOnUndefined) {
          this.emit(`,${child.lineno},${child.colno}, context)`);
        }
        this.emit(', env.opts.autoescape)');
      }, child, 'text', false);
    });
  }

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
    frame._seesRootScope = true;

    if (this.asyncMode) {
      // NEW: Pre-declaration pass
      const sequenceLocks = this.sequential.collectSequenceLocks(node);
      this.sequential.preDeclareSequenceLocks(frame, sequenceLocks);

      this.async.propagateIsAsync(node);
      // this.sequential._declareSequentialLocks(node, frame); // Old logic removed
    }

    this.emit.beginEntryFunction(node, 'root', frame);
    this.emit.line(`frame.markOutputBufferScope(${this.buffer.currentBuffer});`);
    if (SEQUNTIAL_PATHS_USE_VALUE && frame.declaredOutputs) {
      for (const [name, decl] of frame.declaredOutputs.entries()) {
        if (!decl || decl.type !== 'sequential_path') {
          continue;
        }
        this.emit.line(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
      }
    }
    // Always declare parentTemplate (needed even for dynamic-only extends)
    this.emit.line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (this.asyncMode && VALUE_IMPORT_BINDINGS) {
      this.emit.line('context.resolveExports(frame, runtime);');
    }
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
      // Includes/imports in async mode may return CommandBuffer values from
      // composition and insert them into the parent output buffer as child
      // segments. Chain advancement through child slots requires each child
      // root buffer to be marked finished once root execution has completed.
      this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line('    finalParent.rootRenderFunc(env, context.forkForPath(finalParent.path), frame, runtime, astate, cb, compositionMode);');
      this.emit.line('  } else {');
      if (this.scriptMode) {
        // In script mode, explicit return is preferred, but scripts without return
        // must still complete instead of hanging.
        this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line('    cb(null, undefined);');
      } else {
        this.emit.line(`    const __rootSnapshot = ${this.buffer.getCurrentTextOutput()}.finalSnapshot();`);
        this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line('    cb(null, await __rootSnapshot);');
      }
      this.emit.line('  }');
      this.emit.line('}).catch(e => {');
      this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`); // Store and update the handled error
      this.emit.line('  cb(err);'); // Pass the updated error to the callback
      this.emit.line('});');
      this.emit.line('} else {');
      // If in composition mode, synchronously return the output array.
      // The caller is responsible for the lifecycle.
      // Mark finished before returning so a parent buffer that attaches this
      // composition result can advance chaining through the child-buffer slot.
      this.emit.line(`  ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
      this.emit.line(`  return ${this.buffer.currentBuffer};`);
      this.emit.line('}');
    }
    else {
      // SYNC Handoff Logic
      this.emit.line('if(parentTemplate) {');
      this.emit.line('  let parentContext = context.forkForPath(parentTemplate.path);');
      this.emit.line('  parentTemplate.rootRenderFunc(env, parentContext, frame, runtime, cb);');
      this.emit.line('} else {');
      this.emit.line(`  cb(null, ${this.buffer.currentBuffer});`);
      this.emit.line('}');
    }

    // Pass the node to _emitFuncEnd for error position info (used in sync catch)
    this.emit.endEntryFunction(node, true);

    this.inBlock = true;

    const blockNames = [];

    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block, i) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);

      let tmpFrame = frame.new();//new Frame();
      this.emit.beginEntryFunction(block, `b_${name}`, tmpFrame);

      if (this.asyncMode) {
        this.emit.line(`context = context.forkForPath(${this.inheritance._templateName()});`);
      }
      this.emit.line('var frame = frame.push(true);'); // Keep this as 'var', the codebase depends on the function-scoped nature of var for frame
      this.compile(block.body, tmpFrame);
      this.emit.endEntryFunction(block);
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

  compileReturn(node, frame) {
    const returnTarget = (frame && frame._seesRootScope) ? 'root' : 'function';
    const hasValue = !!node.value;

    if (this.asyncMode) {
      const resultVar = this._tmpid();
      if (returnTarget === 'root') {
        const errorContext = this._generateErrorContext(node);
        this.emit.line('return astate.waitAllClosures(0).then(async () => {');
        this.emit(`  let ${resultVar} = `);
        if (hasValue) {
          this._compileExpression(node.value, frame, true, node);
        } else {
          this.emit('undefined');
        }
        this.emit.line(';');
        this.emit.line(`  const resolved = await runtime.resolveSingle(${resultVar});`);
        this.emit.line('  if (runtime.isPoison(resolved)) { throw new runtime.PoisonError(resolved.errors); }');
        this.emit.line(`  ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line('  cb(null, resolved);');
        this.emit.line('}).catch(e => {');
        this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${errorContext}", context.path);`);
        this.emit.line('  cb(err);');
        this.emit.line('});');
      } else {
        const waitCount = (frame && frame._returnWaitCount !== undefined) ? frame._returnWaitCount : 0;
        this.emit.line(`return astate.waitAllClosures(${waitCount}).then(async () => {`);
        this.emit(`  let ${resultVar} = `);
        if (hasValue) {
          this._compileExpression(node.value, frame, true, node);
        } else {
          this.emit('undefined');
        }
        this.emit.line(';');
        this.emit.line(`  const resolved = await runtime.resolveSingle(${resultVar});`);
        this.emit.line('  if (runtime.isPoison(resolved)) { throw new runtime.PoisonError(resolved.errors); }');
        this.emit.line(`  ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line('  return resolved;');
        this.emit.line('});');
      }
      return;
    }

    this.emit('cb(null, ');
    if (hasValue) {
      this._compileExpression(node.value, frame, false, node);
    } else {
      this.emit('undefined');
    }
    this.emit.line(');');
    this.emit.line('return;');
  }

  compileOutputDeclaration(node, frame) {
    const outputType = node.outputType;
    const nameNode = node.name;
    validateOutputDeclarationNode(this, {
      node,
      nameNode,
      outputType,
      hasInitializer: !!node.initializer,
      asyncMode: this.asyncMode,
      scriptMode: this.scriptMode,
      isNameSymbol: nameNode instanceof nodes.Symbol
    });
    const name = nameNode.value;

    this._addDeclaredOutput(frame, name, outputType, node.initializer, node);

    this.emit(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "${outputType}", context, `);
    if (outputType === 'sink' || outputType === 'sequence') {
      this.compile(node.initializer, frame);
    } else {
      this.emit('null');
    }
    this.emit.line(');');

    if (outputType === 'value' && node.initializer) {
      const callName = new nodes.Symbol(node.lineno, node.colno, name);
      const callArgs = new nodes.NodeList(
        node.initializer.lineno || node.lineno,
        node.initializer.colno || node.colno,
        [node.initializer]
      );
      callArgs.isAsync = !!node.initializer.isAsync;
      const callNode = new nodes.FunCall(node.lineno, node.colno, callName, callArgs);
      callNode.isAsync = !!node.initializer.isAsync;

      const initCommandNode = new nodes.OutputCommand(node.lineno, node.colno, callNode);
      initCommandNode.isAsync = !!node.initializer.isAsync;
      this.buffer.compileOutputCommand(initCommandNode, frame);
    }
  }


  compileOutputCommand(node, frame) {
    if (!this.scriptMode) {
      this.fail('Output commands are only supported in script mode', node.lineno, node.colno, node);
    }
    this.buffer.compileOutputCommand(node, frame);
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
