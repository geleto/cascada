const {
  RESERVED_DECLARATION_NAMES,
  validateGuardVariablesDeclared,
  validateSetTarget,
  validateDeclarationTarget,
  validateDeclarationScope,
  validateReadOnlyOuterMutation,
  validateOutputDeclarationNode
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
const CompileAnalysis = require('./compile-analysis');
const CompileRename = require('./compile-rename');
const CompilerBase = require('./compiler-base');

class Compiler extends CompilerBase {
  init(templateName, options) {
    // Initialize base properties like codebuf, asyncMode, etc.
    super.init(options);

    // Properties specific to the full statement-aware compiler
    this.templateName = templateName;
    this.hasExtends = false;
    this.inBlock = false;

    // Instantiate and link helper modules
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = new CompileAsync(this);
    this.inheritance = new CompileInheritance(this);
    this.loop = new CompileLoop(this);
    this.buffer = new CompileBuffer(this);
    this.analysis = new CompileAnalysis(this);
    this.rename = new CompileRename(this);
    this.analysisState = null;
  }


  //@todo - move to compile-base next to _isDeclared
  _addDeclaredVar(frame, varName) {
    if (this.asyncMode || this.scriptMode) {
      validateDeclarationScope(frame, varName, this, null);
      // Variables and outputs share the same lexical scoping rules.
      // At this point only compiler-generated synthetic outputs can exist on the frame.
      const outputDecl = this._findSyntheticOutputDeclaration(frame, varName);
      const allowSequenceLockAlias = varName && varName.startsWith('!') &&
        outputDecl && outputDecl.type === 'sequential_path';
      if (outputDecl && outputDecl.type !== 'var' && !allowSequenceLockAlias) {
        this.fail(`Cannot declare variable '${varName}' because an output with the same name is already declared.`);
      }
    }
  }

  isReservedDeclarationName(name) {
    return RESERVED_DECLARATION_NAMES.has(name);
  }

  _addDeclaredOutput(frame, name, outputType, initializer = null, node = null) {
    validateDeclarationScope(frame, name, this, node);
    const declaredOutputs = this._getSyntheticDeclarationsInCurrentScope(frame);

    if (this.isReservedDeclarationName(name)) {
      this.fail(
        `Identifier '${name}' is reserved and cannot be used as a variable or output name.`,
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }

    if (declaredOutputs && declaredOutputs.has(name)) {
      this.fail(`Cannot declare output '${name}': already declared`, node && node.lineno, node && node.colno, node || undefined);
    }

    let parentFrame = frame && frame.parent;
    while (parentFrame) {
      const parentDeclaredOutputs = this._getSyntheticDeclarationsInCurrentScope(parentFrame);
      if (parentDeclaredOutputs && parentDeclaredOutputs.has(name)) {
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
    if (this._isDeclared(frame, name, node)) {
      this.fail(
        `Cannot declare output '${name}' because a variable with the same name is already declared`,
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }

    this._setSyntheticOutputDeclaration(frame, name, {
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

  /**
   * Emit a runtime prelink call that attaches `childBufferExpr` to handler lanes
   * on `parentBufferExpr` when those lanes are present in `presenceMapExpr`.
   *
   * `insertPos` is used for block functions where prelinking must be injected
   * before block body code is emitted.
   */
  emitLinkWithParentCompositionBuffer(handlers, parentBufferExpr, childBufferExpr, presenceMapExpr, insertPos = null) {
    const snippet = `runtime.linkWithParentCompositionBuffer(${parentBufferExpr}, ${childBufferExpr}, ${JSON.stringify(handlers)}, ${presenceMapExpr});`;

    if (typeof insertPos === 'number') {
      this.emit.insertLine(insertPos, snippet);
    } else {
      this.emit.line(snippet);
    }
  }


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

    const emitExtensionInvocation = (callFrame, extId) => {
      if (noExtensionCallback) {
        // the extension returns a value directly
        if (!resolveArgs) {
          // send the arguments as they are - promises or values
          this.emit(`${extId}["${node.prop}"](context`);
        } else {
          // resolve the arguments before calling the function
          this.emit(`runtime.resolveArguments(${extId}["${node.prop}"].bind(${extId}), 1)(context`);
        }
      } else {
        // isAsync, the callback should be promisified
        if (!resolveArgs) {
          this.emit(`runtime.promisify(${extId}["${node.prop}"].bind(${extId}))(context`);
        } else {
          this.emit(`runtime.resolveArguments(runtime.promisify(${extId}["${node.prop}"].bind(${extId})), 1)(context`);
        }
      }
      emitCallArgs(callFrame);
      this.emit(`)`);
    };

    if (this.scriptMode) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
      emitExtensionInvocation(frame, ext);
      this.emit.line(';');
      return;
    }

    if (noExtensionCallback || node.isAsync) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);

      const callTextHandler = this.buffer.currentTextOutputName;
      frame = this.buffer.asyncAddToBufferScoped(
        node,
        frame,
        positionNode,
        callTextHandler,
        callTextHandler,
        true,
        this.asyncMode,
        (innerFrame) => {
          if (this.asyncMode) {
            this.emit('runtime.resolveSingle(');
          } else {
            this.emit('runtime.suppressValue(');
          }
          emitExtensionInvocation(innerFrame, ext);
          if (this.asyncMode) {
            this.emit(')');
          } else {
            this.emit(`, ${autoescape} && env.opts.autoescape);`);//end of suppressValue
          }
        },
        null,
        false
      );
    } else {
      //use the original nunjucks callback mechanism
      this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
      emitCallArgs(frame);

      const res = this._tmpid();
      this.emit.line(', ' + this._makeCallback(res));
      const callbackTextHandler = this.buffer.currentTextOutputName;
      frame = this.buffer.asyncAddToBufferScoped(
        node,
        frame,
        positionNode,
        callbackTextHandler,
        callbackTextHandler,
        true,
        this.asyncMode,
        () => {
          if (this.asyncMode) {
            this.emit(`runtime.resolveSingle(${res})`);
          } else {
            this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
          }
        },
        null
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

  analyzeSet(node, analysisPass) {
    const declares = [];
    const mutates = [];
    const isDeclaration = node.varType === 'declaration';
    const targets = node.targets;
    if (node.body) {
      node.body._analysis = { createScope: true };
    }
    targets.forEach((target) => {
      if (target instanceof nodes.Symbol) {
        target._analysis = { declarationTarget: true };
        const name = target.value;
        const shouldDeclareImplicitTemplateVar = !this.scriptMode &&
          !isDeclaration &&
          !analysisPass.findDeclaration(node._analysis, name);
        if (isDeclaration || shouldDeclareImplicitTemplateVar) {
          declares.push({ name, type: 'var', initializer: null });
        } else {
          mutates.push(name);
        }
      }
    });
    return {
      declares,
      mutates
    };
  }

  compileSet(node, frame) {
    if (this.asyncMode) {
      return this.compileAsyncVarSet(node, frame);
    }

    const ids = [];

    // 1. First pass: Validate, declare, and prepare temporary JS variables for all targets.
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      const isDeclared = this._isDeclared(frame, name, node);
      const declaredFrame = isDeclared ? frame.resolve(name, false) : null;

      // Read-only parent scopes (e.g. call/caller bodies) may read from parent frames,
      // but must not mutate parent variables. Without this check, assignments can
      // silently become local shadows, which is surprising.
      if (this.scriptMode && node.varType === 'assignment') {
        validateReadOnlyOuterMutation(this, {
          frame,
          node,
          target,
          name,
          mutatingOuterRef: !!declaredFrame && declaredFrame !== frame
        });
      }

      validateSetTarget(this, node, target, name, isDeclared);

      // Sync mode relies on a fresh temp for JS assignment.
      id = this._tmpid();
      this.emit.line(`var ${id};`);
      ids.push(id);

      if (this.scriptMode) {
        this._addDeclaredVar(frame, name);
      }
    });

    // 2. Compile the value/body assignment.
    if (node.path) {
      // Validation for set_path
      if (ids.length !== 1) {
        this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
      }
      this.emit(ids[0] + ' = ');

      this.emit('runtime.setPath(');
      this.emit(`frame.lookup("${node.targets[0].value}")` + ', ');
      this.compile(node.path, frame);
      this.emit(', ');
      this.compile(node.value, frame);
      this.emit(')');
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


    // 3. Second pass: Set the variables in the frame and update context/exports.
    node.targets.forEach((target, i) => {
      const id = ids[i];
      const name = target.value;
      this.emit.line(`frame.set("${name}", ${id}, ${!this.scriptMode});`);

      // This block is specific to template mode's behavior.
      if (!this.scriptMode && !this.asyncMode) {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.setVariable("${name}", ${id});`);
        this.emit.line('}');
      }

      // This export logic is common to both modes.
      if (name.charAt(0) !== '_') {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.addExport("${name}", ${id});`);
        this.emit.line('}');
      }
    });
  }

  analyzeCallAssign(node, analysisPass) {
    return this.analyzeSet(node, analysisPass);
  }

  compileCallAssign(node, frame) {
    // `call_assign` is an internal script feature emitted by the ScriptTranspiler.
    if (!this.scriptMode) {
      this.fail('call_assign is only supported in script mode', node.lineno, node.colno, node);
    }

    return this.compileSet(node, frame);
  }

  compileAsyncVarSet(node, frame) {
    if (!this.asyncMode) {
      this.fail('async var output assignments are only supported in async mode', node.lineno, node.colno, node);
    }
    const ids = [];
    const isDeclaration = node.varType === 'declaration';
    const isDeclarationOnly = !!node.declarationOnly;
    const validationNode = Object.assign({}, node, {
      varType: isDeclaration ? 'declaration' : 'assignment'
    });

    // 1. First pass: validate + declarations + temp ids (mirrors compileSet structure).
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      const visibleDeclaration = this.analysis.findDeclaration(node._analysis, name);
      const isOwnDeclaration = !!(visibleDeclaration && visibleDeclaration.declarationOrigin === node._analysis);
      const isDeclaredForValidation = !isOwnDeclaration &&
        !!(visibleDeclaration && visibleDeclaration.type === 'var');

      if (this.scriptMode && !isDeclaration) {
        const declarationOwner = visibleDeclaration
          ? this.analysis.findDeclarationOwner(node._analysis, name)
          : null;
        const currentScopeOwner = this.analysis.getScopeOwner(node._analysis);
        validateReadOnlyOuterMutation(this, {
          frame,
          node,
          target,
          name,
          mutatingOuterRef: isDeclaredForValidation &&
            !!declarationOwner &&
            declarationOwner !== currentScopeOwner
        });
      }

      validateSetTarget(this, validationNode, target, name, isDeclaredForValidation);

      if (isOwnDeclaration) {
        this._addDeclaredOutput(frame, name, 'var', null, node);
        this.emit(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "var", context, null);`);
      } else {
        if (!(visibleDeclaration && visibleDeclaration.type === 'var')) {
          this.fail(
            `Cannot assign to undeclared variable output '${name}'. Use 'var ${name}' to declare it first.`,
            target.lineno,
            target.colno,
            node,
            target
          );
        }
      }

      id = this._tmpid();
      this.emit.line(`let ${id};`);
      let declarationFrame = frame;
      while (declarationFrame && declarationFrame.createScope === false) {
        declarationFrame = declarationFrame.parent;
      }
      declarationFrame = declarationFrame || frame;
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
      const pathValueId = this._tmpid();
      this.emit(`let ${pathValueId} = `);
      this._compileExpression(node.value, frame, true);
      this.emit.line(';');
      this.buffer.emitOwnWaitedConcurrencyResolve(frame, pathValueId, node.value || node);

      this.emit(ids[0] + ' = ');
      this.emit('runtime.setPath(');
      this.buffer.emitAddRawSnapshot(frame, targetName, node);
      this.emit(', ');
      this._compileAggregate(node.path, frame, '[', ']', false, false);
      this.emit(', ');
      this.emit(pathValueId);
      this.emit(')');
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.value && !isDeclarationOnly) {
      this.emit(ids.join(' = ') + ' = ');
      this._compileExpression(node.value, frame, true, node.value);
      this.emit.line(';');
      this.buffer.emitOwnWaitedConcurrencyResolve(frame, ids[0], node.value);
      hasAssignedValue = true;
    } else if (node.body) {
      this.emit(ids.join(' = ') + ' = ');
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        this.compile(n.body, f);
      }, undefined, node.body);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (!isDeclaration) {
      this.fail('set var assignment requires a value or capture body.', node.lineno, node.colno, node);
    }

    // 3. Second pass: emit output commands + export.
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
        if (this.asyncMode) {
          this.emit.line(`  context.addExport("${name}");`);
        } else {
          this.emit.line(`  context.addExport("${name}", ${valueId});`);
        }
        this.emit.line('}');
      }

      if (!this.scriptMode && hasAssignedValue && !this.asyncMode) {
        this.emit.line('if(frame.topLevel) {');
        this.emit.line(`  context.setVariable("${name}", ${valueId});`);
        this.emit.line('}');
      }
    });
  }

  analyzeSwitch(node) {
    if (node.default) {
      //the default only has a body, no case node
      node.default._analysis = { createScope: true };
    }
    return {};
  }

  analyzeCase(node) {
    return { createScope: true };
  }

  //We evaluate the conditions in series, not in parallel to avoid unnecessary computation
  compileSwitch(node, frame) {
    const switchResult = this.buffer.asyncBufferNode(node, frame, false, false, node.expr, (blockFrame) => {
      const branchPositions = [];
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

            // Collect handlers from this branch
            if (this.asyncMode) {
              branchHandlers.push(new Set(c.body._analysis.usedOutputs || []));
            }
          }, c.body); // Pass body as code position
          this.emit.line('break;');
        } else {
          // Empty case body (fall-through)
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

          // Collect handlers from default
          if (this.asyncMode) {
            branchHandlers.push(new Set(node.default._analysis.usedOutputs || []));
          }
        }, node.default); // Pass default as code position
      } else if (this.asyncMode) {
        // No default case - add empty handler placeholder for collection.
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

      // Fill in the poison handling code (handler poisoning)
      if (this.asyncMode) {
        // Combine handlers from all branches
        const allHandlers = new Set();
        branchHandlers.forEach(handlers => {
          handlers.forEach(h => allHandlers.add(h));
        });

        const hasHandlers = allHandlers.size > 0;

        if (hasHandlers) {
          for (const handler of allHandlers) {
            this.emit.insertLine(catchPoisonPos,
              `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${handler}");`);
          }
        }
      }
    });

    frame = switchResult.frame;
  }

  analyzeGuard(node) {
    node.body._analysis = { createScope: true };
    if (node.recoveryBody) {
      const recoveryAnalysis = { createScope: true };
      if (typeof node.errorVar === 'string' && node.errorVar) {
        recoveryAnalysis.declares = [{ name: node.errorVar, type: 'var', initializer: null }];
      } else if (node.errorVar instanceof nodes.Symbol) {
        node.errorVar._analysis = { declarationTarget: true };
        recoveryAnalysis.declares = [{ name: node.errorVar.value, type: 'var', initializer: null }];
      }
      node.recoveryBody._analysis = recoveryAnalysis;
    }
    return {};
  }

  compileGuard(node, frame) {
    if (!this.asyncMode) {
      this.fail('guard block only supported in async mode', node.lineno, node.colno);
    }

    const guardTargets = this._getGuardTargets(node, frame);
    const variableTargetsAll = guardTargets.variableTargetsAll;
    const variableValidationTargets = guardTargets.variableValidationTargets;
    const hasSequenceTargets = !!guardTargets.sequenceTargets;
    // Guard state is used for sequence lock detection/repair bookkeeping.
    const needsGuardState = variableTargetsAll || hasSequenceTargets;
    const guardStateVar = needsGuardState ? this._tmpid() : null;
    validateGuardVariablesDeclared(variableValidationTargets, this, node);

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
        let guardRepairLinePos = null;
        const outputGuardInitLinePos = this.codebuf.length;
        let outputGuardStateVar = null;
        this.emit.line('');
        if (guardStateVar) {
          this.emit.line(`const ${guardStateVar} = runtime.guard.init(cb);`);
        }
        // Sequence lock repair must run before guard body starts scheduling work.
        guardRepairLinePos = this.codebuf.length;
        this.emit.line('');

        // 3. Compile Body
        this.compile(node.body, blockFrame);

        // Resolve and Validate Sequence Targets
        // Sequence lock mutations are tracked via used output handlers.
        const resolvedSequenceTargets = new Set();
        const modifiedLocks = new Set();
        const bodyUsedOutputs = Array.from(node.body._analysis.usedOutputs || []);
        if (bodyUsedOutputs.length > 0) {
          for (const outputName of bodyUsedOutputs) {
            if (outputName && outputName.startsWith('!')) {
              modifiedLocks.add(outputName);
            }
          }
        }

        const shouldGuardAllSequencesImplicitly =
          variableTargetsAll &&
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
                const includeReadLocks = false;
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
          this.emit.insertLine(
            guardRepairLinePos,
            `runtime.guard.repairSequenceOutputs(${this.buffer.currentBuffer}, ${guardStateVar}, ${JSON.stringify(Array.from(resolvedSequenceTargets))});`
          );
        }

        let guardHandlers = this._getGuardedOutputNames(
          bodyUsedOutputs,
          guardTargets,
          blockFrame,
          node.body._analysis
        );
        if (resolvedSequenceTargets.size > 0) {
          const merged = new Set(guardHandlers);
          for (const lockName of resolvedSequenceTargets) {
            merged.add(lockName);
          }
          guardHandlers = Array.from(merged);
        }
        const bodyDeclaredOutputs = Array.from((node.body._analysis.declaredOutputs || new Map()).keys());
        if (bodyDeclaredOutputs.length > 0) {
          const merged = new Set(guardHandlers);
          for (const name of bodyDeclaredOutputs) {
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
        //this.emit.line('await astate.waitAllClosures(1);');

        // 5. Check Buffer/Variables for Poison
        const guardErrorsVar = this._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${this.buffer.currentBuffer}, ${JSON.stringify(guardHandlers)}, ${outputGuardStateVar || 'null'});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        if (node.recoveryBody) {
          this.emit.asyncBlock(node, blockFrame, true, (f) => {
            if (node.errorVar) {
              // Guard recovery error variable is exposed as an internal var output
              // so async reads use snapshot semantics instead of frame mutation.
              this._addDeclaredOutput(f, node.errorVar, 'var', null, node);
              this.emit.line(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${node.errorVar}", "var", context, null);`);
              this.buffer.asyncAddValueToBuffer(node, f, (resultVar) => {
                this.emit(
                  `${resultVar} = new runtime.ValueCommand({ handler: '${node.errorVar}', args: [new runtime.PoisonError(${guardErrorsVar})], pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`
                );
              }, node, node.errorVar);
            }
            this.compile(node.recoveryBody, f);
          });
        }

        this.emit.line('} else {');
        this.emit.line('}');
      } finally {
        this.guardDepth = previousGuardDepth;
      }
    });

    frame = guardResult.frame;
  }

  _getGuardedOutputNames(usedOutputs, guardTargets, frame, analysis) {
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
      // Template implicit text output uses an internal handler name (__text__...).
      // Preserve selector ergonomics: guarding `text` targets the active text handler.
      if (!this.scriptMode && guardedSet.has('text')) {
        guardedSet.add(this.buffer.currentTextOutputName);
      }
      const guardedTypes = new Set(hasTypedHandlers ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0 || !frame) {
          return false;
        }
        const outputDecl = analysis ? this.analysis.findDeclaration(analysis, name) : null;
        if (outputDecl) {
          return guardedTypes.has(outputDecl.type);
        }
        if (!this.scriptMode && name === this.buffer.currentTextOutputName && guardedTypes.has('text')) {
          return true;
        }
        return guardedTypes.has(name);
      });
    }

    if (guardTargets.variableTargetsAll) {
      // In async mode, script/template vars are output-backed; guard var should
      // therefore target var outputs touched inside the guard block.
      return used.filter((name) => {
        if (name && name.charAt(0) === '!') {
          return false;
        }
        const outputDecl = analysis ? this.analysis.findDeclaration(analysis, name) : null;
        return !!(outputDecl && outputDecl.type === 'var');
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
    const variableTargetsAll = variableTargetsRaw === '*';
    const hasVariableTargetsSelector = variableTargetsRaw !== null;
    const variableValidationTargets = [];

    if (Array.isArray(variableTargetsRaw) && variableTargetsRaw.length > 0) {
      const resolvedHandlers = new Set(Array.isArray(handlerSelector) ? handlerSelector : []);

      for (const name of variableTargetsRaw) {
        const outputDecl = this.analysis.findDeclaration(guardNode._analysis, name);
        const isDeclaredVar = !!(outputDecl && outputDecl.type === 'var');

        if (isDeclaredVar) {
          variableValidationTargets.push(name);
        }
        if (outputDecl) {
          resolvedHandlers.add(name);
        }
        if (!this.scriptMode && !isDeclaredVar && !outputDecl && name === 'text') {
          resolvedHandlers.add(this.buffer.currentTextOutputName);
          continue;
        }
        if (!isDeclaredVar && !outputDecl) {
          variableValidationTargets.push(name);
        }
      }

      if (handlerSelector !== '*') {
        handlerSelector = resolvedHandlers.size > 0 ? Array.from(resolvedHandlers) : null;
      }
    }
    const sequenceTargets = Array.isArray(guardNode && guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!handlerSelector || !!typeTargets || hasVariableTargetsSelector || !!sequenceTargets;

    return {
      handlerSelector,
      typeTargets,
      variableTargetsAll,
      variableValidationTargets: variableValidationTargets.length > 0 ? variableValidationTargets : null,
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
      let catchPoisonPos;
      let trueBranchHandlers = new Set();
      let falseBranchHandlers = new Set();
      let allHandlers = new Set();

      if (this.asyncMode) {
        const condResultId = this._tmpid();
        // Async mode: Add try-catch wrapper for poison condition handling
        this.emit('try {');
        this.emit(`const ${condResultId} = `);
        this._compileAwaitedExpression(node.cond, blockFrame, false);
        this.emit(';');
        this.emit('');

        this.emit(`if (${condResultId}) {`);

        // Use node.body as the position node for the true branch block
        this.emit.asyncBlock(node, blockFrame, branchCreatesScope, (f) => {
          this.compile(node.body, f);
        }, node.body); // Pass body as code position

        this.emit('} else {');

        if (node.else_) {
          // Use node.else_ as the position node for the false branch block
          this.emit.asyncBlock(node, blockFrame, branchCreatesScope, (f) => {
            this.compile(node.else_, f);
          }, node.else_); // Pass else as code position
        }
        this.emit('}');

        // Add catch block to poison variables when condition fails
        const errorContext = this._createErrorContext(node, node.cond);
        this.emit('} catch (e) {');
        this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContext.lineno}, ${errorContext.colno}, "${errorContext.errorContextString}", context.path);`);
        catchPoisonPos = this.codebuf.length;
        this.emit('');
        this.emit('}');  // No re-throw - execution continues with poisoned vars

        trueBranchHandlers = new Set(node.body._analysis.usedOutputs || []);
        falseBranchHandlers = node.else_
          ? new Set(node.else_._analysis.usedOutputs || [])
          : new Set();
        allHandlers = new Set([...trueBranchHandlers, ...falseBranchHandlers]);

        // Fill in the poison handling code for handlers when condition fails.
        const hasHandlers = allHandlers.size > 0;

        if (hasHandlers) {
          for (const handler of allHandlers) {
            this.emit.insertLine(catchPoisonPos,
              `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${handler}");`);
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

  analyzeIf(node) {
    node.body._analysis = { createScope: true };
    if (node.else_) {
      node.else_._analysis = { createScope: true };
    }
    return {};
  }

  _analyzeLoopNodeDeclarations(node, analysisPass, declarationsInBody = false) {
    if (node.name instanceof nodes.Symbol) {
      node.name._analysis = { declarationTarget: true };
    } else if (node.name instanceof nodes.Array || node.name instanceof nodes.NodeList) {
      node.name.children.forEach((child) => {
        child._analysis = { declarationTarget: true };
      });
    }
    const declares = [];
    const declaredNames = analysisPass._extractSymbols(node.name);
    declaredNames.forEach((name) => {
      declares.push({ name, type: 'var', initializer: null });
    });
    if (!declaredNames.includes('loop')) {
      declares.push({ name: 'loop', type: 'var', initializer: null, internal: true, isLoopMeta: true });
    }
    if (declarationsInBody) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        createScope: true,
        loopOwner: node,
        declares
      });
      if (node.else_) {
        node.else_._analysis = Object.assign({}, node.else_._analysis, {
          createScope: true
        });
      }
      return {};
    }
    return { createScope: true, declares };
  }

  analyzeWhile(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass);
  }

  //todo - condition with sequence locks (test 2 identicsal sequence locks in the condition expression)
  compileWhile(node, frame) {
    this.loop.compileWhile(node, frame);
  }

  analyzeFor(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileFor(node, frame) {
    this.loop.compileFor(node, frame);
  }

  analyzeAsyncEach(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
  }

  compileAsyncEach(node, frame) {
    this.loop.compileAsyncEach(node, frame);
  }

  analyzeAsyncAll(node, analysisPass) {
    return this._analyzeLoopNodeDeclarations(node, analysisPass, true);
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
      'if (!Object.prototype.hasOwnProperty.call(kwargs, "caller")) {',
      '  kwargs.caller = undefined;',
      '}'
    );

    let err = this._tmpid();
    if (node.isAsync) {
      this.emit.lines(
        `let ${err} = null;`,
        'function cb(err) {',
        `if(err) {${err} = err;}`,
        '}');
    }

    let returnStatement;
    const snapshotVar = this._tmpid();
    this.emit.managedBlock(currFrame, false, true, (managedFrame, bufferId) => {
      if (node.isAsync) {
        // Async macro bindings are var outputs so assignment/read semantics
        // match value-command ordering instead of frame-local var behavior.
        this._declareMacroBindingValueOutput(managedFrame, bufferId, 'caller', node);
        args.forEach((arg) => {
          this._declareMacroBindingValueOutput(managedFrame, bufferId, arg.value, arg);
        });
        if (kwargs) {
          kwargs.children.forEach((pair) => {
            this._declareMacroBindingValueOutput(managedFrame, bufferId, pair.key.value, pair.key);
          });
        }

        this._emitMacroBindingInit(
          managedFrame,
          bufferId,
          'caller',
          () => {
            this.emit('kwargs.caller');
          },
          node
        );

        args.forEach((arg) => {
          this._emitMacroBindingInit(
            managedFrame,
            bufferId,
            arg.value,
            () => {
              this.emit(`l_${arg.value}`);
            },
            arg
          );
        });

        if (kwargs) {
          kwargs.children.forEach((pair) => {
            const name = pair.key.value;
            this._emitMacroBindingInit(
              managedFrame,
              bufferId,
              name,
              () => {
                this.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}") ? kwargs["${name}"] : `);
                this._compileExpression(pair.value, managedFrame, false);
              },
              pair
            );
          });
        }
      } else {
        // Sync mode keeps frame-local macro binding behavior.
        this.emit.line('frame.set("caller", kwargs.caller);');
        managedFrame.set('caller', 'kwargs.caller');
        args.forEach((arg) => {
          this.emit.line(`frame.set("${arg.value}", l_${arg.value});`);
          managedFrame.set(arg.value, `l_${arg.value}`);
        });

        if (kwargs) {
          kwargs.children.forEach((pair) => {
            const name = pair.key.value;
            this.emit(`frame.set("${name}", `);
            this.emit(`Object.prototype.hasOwnProperty.call(kwargs, "${name}")`);
            this.emit(` ? kwargs["${name}"] : `);
            this._compileExpression(pair.value, managedFrame, false);
            this.emit(');');
          });
        }
      }

      this.emit.withScopedSyntax(() => {
        this.compile(node.body, managedFrame);
      });

      this.emit.line('frame = ' + ((keepFrame) ? 'frame.pop();' : 'callerFrame;'));

      if (node.isAsync) {
        const errorCheck = `if (${err}) throw ${err};`;
        if (this.scriptMode) {
          returnStatement = `astate.waitAllClosures().then(() => {${bufferId}.markFinishedAndPatchLinks();${errorCheck}return undefined;})`;
        } else {
          // Snapshot must be enqueued before this managed buffer is finished.
          this.emit.line(`const ${snapshotVar} = ${bufferId}.addSnapshot("${this.buffer.currentTextOutputName}", {lineno: ${node.lineno}, colno: ${node.colno}});`);

          const needsSafeString = !this.scriptMode;
          const safeStringCall = needsSafeString
            ? `runtime.markSafe(${snapshotVar})`
            : snapshotVar;

          returnStatement = `astate.waitAllClosures().then(() => {${bufferId}.markFinishedAndPatchLinks();${errorCheck}return ${safeStringCall};})`;
        }
      } else {
        // Sync case
        const needsSafeString = !this.scriptMode;
        returnStatement = needsSafeString
          ? `new runtime.SafeString(${bufferId})`
          : bufferId;
      }
    }, keepFrame ? this.buffer.currentBuffer : null, node.body);

    this.emit.line(`return ${returnStatement};`);

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

  _declareMacroBindingValueOutput(frame, bufferId, name, node) {
    const bindingNode = node || { lineno: 0, colno: 0 };

    // Keep macro arg/kwarg/caller declaration rules aligned with normal var declarations.
    const alreadyDeclared = this._isDeclared(frame, name, node) ||
      this._isOutputDeclaredInCurrentScope(node, frame, name);
    validateDeclarationTarget(this, name, alreadyDeclared, bindingNode, bindingNode);
    this._addDeclaredVar(frame, name);

    const existing = this._findSyntheticOutputDeclarationInCurrentScope(frame, name);
    if (existing) {
      this.fail(
        `Cannot declare output '${name}': already declared`,
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }

    // Macro invocation bindings are emitted as var outputs for async ordering semantics.
    this._setSyntheticOutputDeclaration(frame, name, {
      type: 'var',
      initializer: null
    });
    this.emit.line(`runtime.declareOutput(frame, ${bufferId}, "${name}", "var", context, null);`);
  }

  _emitMacroBindingInit(frame, bufferId, name, emitValueExpression, positionNode = null) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    this.emit(`${bufferId}.add(new runtime.ValueCommand({ handler: '${name}', args: [`);
    emitValueExpression();
    this.emit(`], pos: {lineno: ${lineno}, colno: ${colno}} }), "${name}");`);
  }

  analyzeMacro(node) {
    const declares = [];
    const declaresInParent = [];
    declares.push({ name: 'caller', type: 'var', initializer: null });
    node.args.children.forEach((arg) => {
      if (arg instanceof nodes.Symbol) {
        arg._analysis = { declarationTarget: true };
        declares.push({ name: arg.value, type: 'var', initializer: null });
      } else if (arg instanceof nodes.Dict) {
        arg.children.forEach((pair) => {
          declares.push({ name: pair.key.value, type: 'var', initializer: null });
        });
      }
    }, undefined, node);
    const macroDecl = { name: node.name.value, type: 'var', initializer: null };
    declares.push(macroDecl);
    declaresInParent.push(macroDecl);
    return { createScope: true, scopeBoundary: true, declares, declaresInParent };
  }

  compileMacro(node, frame) {
    var funcId = this._compileMacro(node, frame, false);

    // Expose the macro to the templates
    var name = node.name.value;
    if (this.asyncMode) {
      // Expose the macro as a var output.
      this._addDeclaredOutput(frame, name, 'var', null, node);
      this.emit.line(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "var", context, null);`);
      this.buffer.asyncAddValueToBuffer(node, frame, (resultVar) => {
        this.emit(
          `${resultVar} = new runtime.ValueCommand({ handler: '${name}', args: [${funcId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`
        );
      }, node, name);
      // Only root-compile macro declarations can ever be exported.
      // Nested lexical scopes (frame.parent) cannot become top-level at runtime,
      // so skip emitting export plumbing for them.
      if (name.charAt(0) !== '_' && !frame.parent) {
        this.emit.line('if(frame.topLevel) {');
        if (this.scriptMode) {
          this.emit.line(`  context.addExport("${name}", ${funcId});`);
        } else {
          this.emit.line(`  context.addExport("${name}");`);
        }
        this.emit.line('}');
      }
      return;
    }

    frame.set(name, funcId);

    if (frame.parent) {
      this.emit.line(`frame.set("${name}", ${funcId});`);
    } else {
      const isPublicMacro = node.name.value.charAt(0) !== '_';
      if (isPublicMacro) {
        this.emit.line(`context.addExport("${name}", ${funcId});`);
      }
      this.emit.line(`context.setVariable("${name}", ${funcId});`);
    }
  }

  analyzeImport(node) {
    node.target._analysis = { declarationTarget: true };
    return {
      declares: [{ name: node.target.value, type: 'var', initializer: null }]
    };
  }

  compileImport(node, frame) {
    this.inheritance.compileImport(node, frame);
  }

  analyzeFromImport(node) {
    const declares = [];
    node.names.children.forEach((nameNode) => {
      if (nameNode instanceof nodes.Pair && nameNode.value instanceof nodes.Symbol) {
        nameNode.value._analysis = { declarationTarget: true };
        declares.push({ name: nameNode.value.value, type: 'var', initializer: null });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode._analysis = { declarationTarget: true };
        declares.push({ name: nameNode.value, type: 'var', initializer: null });
      }
    });
    return { declares };
  }

  compileFromImport(node, frame) {
    this.inheritance.compileFromImport(node, frame);
  }

  analyzeBlock(node) {
    return { createScope: true, scopeBoundary: false };
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

  analyzeInclude(node) {
    if (this.scriptMode) {
      return {};
    }
    const textOutput = this.analysis.getCurrentTextOutput(node._analysis);
    const includeVisibleOutputs = this.analysis.getIncludeVisibleVarOutputs(node._analysis)
      .map((entry) => entry.runtimeName);
    const uses = textOutput
      ? [textOutput, ...includeVisibleOutputs]
      : includeVisibleOutputs;
    return {
      uses,
      mutates: textOutput ? [textOutput] : []
    };
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

  analyzeCapture(node) {
    return {
      createScope: true,
      scopeBoundary: false,
      textOutput: this.scriptMode ? null : `${CompileBuffer.DEFAULT_TEMPLATE_TEXT_OUTPUT}${this._tmpid()}`
    };
  }

  compileCapture(node, frame) {
    // we need to temporarily override the current buffer id as 'output'
    // so the set block writes to the capture output instead of the buffer
    const buffer = this.buffer.currentBuffer;
    const textOutput = this.buffer.currentTextOutputVer;
    const textOutputName = this.buffer.currentTextOutputName;
    const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
    this.buffer.currentBuffer = 'output';
    this.buffer.currentTextOutputVer = 'output_textOutputVar';
    if (!this.scriptMode) {
      this.buffer.currentTextOutputName = captureTextOutputName;
    }
    if (node.isAsync) {
      const res = this._tmpid();
      // Capture-only: pass explicit parent buffer override because capture
      // temporarily rebinds currentBuffer to async callback scope for body writes.
      // Remove with capture removal.
      const prevCaptureParentBuffer = buffer;
      this.buffer.currentBuffer = 'currentBuffer';
      this.emit.asyncBlockValue(node, frame, (n, f) => {
        //@todo - do this only if a child uses frame, from within _emitAsyncBlockValue
        this.emit.line('let output = currentBuffer;');
        //this.emit.line('if (!output) { throw new Error("Capture block requires async block output buffer"); }');
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
          this.emit.line(`let output_textOutputVar = runtime.declareOutput(frame, currentBuffer, "${captureTextOutputName}", "text", context, null);`);
          this.compile(n.body, f);//write to output
          //this.emit.line('await astate.waitAllClosures(1)');
          this.emit.line(`let ${res} = await currentBuffer.addSnapshot("${captureTextOutputName}", {lineno: ${node.body.lineno}, colno: ${node.body.colno}});`);
        }
        //@todo - return the output immediately as a promise - waitAllClosuresAndFlattem
      }, res, node.body, true, !this.scriptMode, prevCaptureParentBuffer);
      this.buffer.currentBuffer = prevCaptureParentBuffer;
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
    this.buffer.currentTextOutputVer = textOutput;
    this.buffer.currentTextOutputName = textOutputName;
  }

  // @todo - get rid of the asyncAddToBufferBegin after we have switch var to the new value implementation
  analyzeOutput(node) {
    const textOutput = !this.scriptMode
      ? this.analysis.getCurrentTextOutput(node._analysis)
      : null;
    return (this.scriptMode) ? {}
      : {
        uses: [textOutput],
        mutates: [textOutput]
      };
  }

  compileOutput(node, frame) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared outputs and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textHandler = this.buffer.currentTextOutputName;
    if (this.asyncMode) {
      const children = node.children;
      children.forEach(child => {
        if (child instanceof nodes.TemplateData) {
          if (child.value) {
            this.buffer.addToBuffer(node, frame, function () {
              this.compileLiteral(child, frame);
            }, child, textHandler, true);
          }
          return;
        }
        // This is temporary, it is not exactly about mutating output, but about
        // Adding any command to the buffer
        // In the future, when we make the CommandBuffer tree synchronously before any expression evaluation,
        // This will not be needed anymore
        const forceWrapRootExpression = this._expressionAddsCommands(child) && !this.buffer.currentWaitedOutputName;
        frame = this.buffer.asyncAddToBufferScoped(
          node,
          frame,
          child,
          textHandler,
          textHandler,
          true,
          true,
          (innerFrame, valueId) => {
            // Keep command args unresolved for apply-time resolution/error handling.
            this._compileExpression(child, innerFrame, forceWrapRootExpression, child);
          },
          (innerFrame, valueId) => {
            // Step 3: expression-root waited emission for limited-loop own waited output.
            this.buffer.emitOwnWaitedConcurrencyResolve(innerFrame, valueId, child);
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
          }, child, textHandler, false);
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
      }, child, textHandler, false);
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

  // temp implementation, will use mutatedOutputs instead
  // Will create the CommandBuffer tree before any expression evaluation
  // (but each node will know its current command buffer)
  _expressionAddsCommands(node) {
    if (!node) {
      return false;
    }

    let mutatesOutput = false;
    const visit = (current) => {
      if (!current || mutatesOutput) {
        return;
      }

      if (current instanceof nodes.FunCall) {
        const callee = current.name;
        if (callee instanceof nodes.Symbol && callee.value === 'caller') {
          mutatesOutput = true;
          return;
        }
        const root = this.sequential._extractStaticPathRoot(callee);
        if (root === 'caller') {
          mutatesOutput = true;
          return;
        }
      }

      if (current.typename === 'Caller') {
        mutatesOutput = true;
        return;
      }

      // Mutation-only detection: sequence PATH reads (1) are observational and must
      // not force wrapping; LOCK/CONTENDED entries indicate side-effecting calls.
      if (current.sequenceOperations && current.sequenceOperations.size > 0) {
        for (const value of current.sequenceOperations.values()) {
          if (value !== 1) {
            mutatesOutput = true;
            return;
          }
        }
      }

      const children = this._getImmediateChildren(current);
      children.forEach(visit);
    };

    visit(node);
    return mutatesOutput;
  }

  analyzeRoot(node) {
    const declares = [];
    if (!this.scriptMode) {
      declares.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_OUTPUT, type: 'text', initializer: null });
    }
    const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
      ? node._analysis.sequenceLocks
      : [];
    sequenceLocks.forEach((lockName) => {
      declares.push({ name: lockName, type: 'sequential_path', initializer: null });
    });
    return {
      createScope: true,
      scopeBoundary: true,
      declares,
      textOutput: this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_OUTPUT
    };
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
      const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
        ? node._analysis.sequenceLocks
        : [];
      this.sequential.preDeclareSequenceLocks(frame, sequenceLocks);

      this.async.propagateIsAsync(node);
      // this.sequential._declareSequentialLocks(node, frame); // Old logic removed
    }

    this.emit.beginEntryFunction(node, 'root', frame);
    this.emit.line(`frame.markOutputBufferScope(${this.buffer.currentBuffer});`);
    const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
      ? node._analysis.sequenceLocks
      : [];
    for (const name of sequenceLocks) {
      this.emit.line(`runtime.declareOutput(frame, ${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
    }
    // Always declare parentTemplate (needed even for dynamic-only extends)
    this.emit.line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    if (this.asyncMode) {
      this.emit.line('context.resolveExports(frame, runtime);');
    }
    if (this.asyncMode) {
      this.emit.line('if (!compositionMode) {');
      this.emit.line('astate.waitAllClosures().then(async () => {');

      if (this.hasDynamicExtends) {
        // Dynamic extends: resolve from var output or context only.
        // Do not fall back to frame lookup.
        this.emit.line(`  let finalParent = await runtime.contextOrVarLookup(context, frame, "__parentTemplate", ${this.buffer.currentBuffer});`);
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
        this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line(`    cb(null, await ${this.buffer.currentTextOutputVer}.finalSnapshot());`);
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
      // Prelink must be emitted before block body compilation so snapshot commands
      // produced by block symbol reads are reachable on the proper handler lanes.
      const blockPrelinkPos = this.codebuf.length;
      this.emit.line('');
      this.compile(block.body, tmpFrame);
      if (this.asyncMode) {
        const usedOutputs = Array.from(block.body._analysis.usedOutputs || []);
        const prelinkHandlers = usedOutputs.filter((hname) => hname !== this.buffer.currentTextOutputName);
        this.emitLinkWithParentCompositionBuffer(
          prelinkHandlers,
          'parentBuffer',
          this.buffer.currentBuffer,
          'parentBuffer._outputs',
          blockPrelinkPos
        );
      }
      if (this.asyncMode) {
        // Block functions in async mode return final text snapshots directly.
        this.emit.line(`${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.emit.line(`return ${this.buffer.currentTextOutputVer}.finalSnapshot();`);
        this.emit.endEntryFunction(block, true);
      } else {
        this.emit.endEntryFunction(block);
      }
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
          this.buffer.emitOwnWaitedConcurrencyResolve(f, resultVar, child);
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

  analyzeOutputDeclaration(node) {
    node.name._analysis = { declarationTarget: true };
    const name = node.name.value;
    return {
      declares: [{ name, type: node.outputType, initializer: node.initializer || null }],
      uses: [name]
    };
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

    if (outputType === 'var' && node.initializer) {
      const initNode = node.initializer;
      const lineno = initNode.lineno !== undefined ? initNode.lineno : node.lineno;
      const colno = initNode.colno !== undefined ? initNode.colno : node.colno;
      this.buffer.asyncAddValueToBuffer(initNode, frame, function (resultVar, f) {
        this.emit(`${resultVar} = new runtime.ValueCommand({ handler: '${name}', args: [`);
        this._compileExpression(initNode, f, true, initNode);
        this.emit(`], pos: {lineno: ${lineno}, colno: ${colno}} })`);
      }, initNode, name);
    }
  }


  analyzeOutputCommand(node) {
    // @todo - uses, mutates shall be collected by the expression analysis, not by the output
    // and also we have to check all commands
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = this.sequential._extractStaticPath(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const handler = path[0];

    const isObservation = callNode &&
      path.length === 2 &&
      (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError' || path[1] === '__checkpoint');
    return isObservation ? { uses: [handler] } : { uses: [handler], mutates: [handler] };
  }

  compileOutputCommand(node, frame) {
    if (!this.scriptMode) {
      this.fail('Output commands are only supported in script mode', node.lineno, node.colno, node);
    }
    this.buffer.compileOutputCommand(node, frame);
  }

}

module.exports = {
  compile: function compile(src, asyncFilters, extensions, name, opts = {}) {
    return AsyncFrame.withCompilerContext(() => {
      // Shared id pool for this compilation unit. Renaming and compiler codegen
      // both allocate from here so loop aliases and compiler tmp ids stay unique.
      const idPool = {
        value: 0,
        next() {
          this.value += 1;
          return this.value;
        }
      };
      const compileOptions = Object.assign({}, opts, { idPool });
      const c = new Compiler(name, compileOptions);

      // Run the extension preprocessors against the source.
      const preprocessors = (extensions || []).map(ext => ext.preprocess).filter(f => !!f);

      const processedSrc = preprocessors.reduce((s, processor) => processor(s), src);

      const ast = transformer.transform(
        parser.parse(processedSrc, extensions, opts),
        asyncFilters,
        name,
        compileOptions
      );
      if (c.asyncMode) {
        c.analysisState = c.analysis.run(ast);
        c.rename.run(ast);
      } else {
        c.analysisState = null;
      }
      c.compile(ast);
      return c.getCode();
    });
  },

  Compiler: Compiler
};

