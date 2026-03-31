const {
  RESERVED_DECLARATION_NAMES,
  validateGuardVariablesDeclared,
  validateChannelDeclarationNode
} = require('./validation');

const parser = require('../parser');
const transformer = require('../transformer');
const nodes = require('../nodes');
const CompileSequential = require('./compile-sequential');
const CompileEmit = require('./compile-emit');
const CompileInheritance = require('./compile-inheritance');
const CompileLoop = require('./compile-loop');
const CompileBuffer = require('./compile-buffer');
const CompileAnalysis = require('./compile-analysis');
const CompileMacro = require('./compile-macro');
const CompileBoundaries = require('./compile-boundaries');
const CompileRename = require('./compile-rename');
const CompilerBase = require('./compiler-base');
const { Frame } = require('../runtime/frame');

const RETURN_CHANNEL_NAME = '__return__';

class Compiler extends CompilerBase {
  init(templateName, options) {
    // Initialize base properties like codebuf, asyncMode, etc.
    super.init(options);

    // Properties specific to the full statement-aware compiler
    this.templateName = typeof templateName === 'string' ? templateName : undefined;
    this.hasExtends = false;
    this.inBlock = false;

    // Instantiate and link helper modules
    this.sequential = new CompileSequential(this);
    this.emit = new CompileEmit(this);
    this.async = null;
    this.inheritance = new CompileInheritance(this);
    this.loop = new CompileLoop(this);
    this.buffer = new CompileBuffer(this);
    this.analysis = new CompileAnalysis(this);
    this.macro = new CompileMacro(this);
    this.boundaries = new CompileBoundaries(this);
    this.rename = new CompileRename(this);
    this.analysisState = null;
  }

  isReservedDeclarationName(name) {
    return RESERVED_DECLARATION_NAMES.has(name);
  }

  emitDeclareReturnChannel(bufferExpr) {
    this.emit.line(
      `runtime.declareBufferChannel(${bufferExpr}, "${RETURN_CHANNEL_NAME}", "var", context, runtime.RETURN_UNSET);`
    );
  }

  emitReturnChannelSnapshot(bufferExpr, positionNode, resultVar) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    this.emit.line(
      `const ${resultVar}_snapshot = ${bufferExpr}.addSnapshot("${RETURN_CHANNEL_NAME}", {lineno: ${lineno}, colno: ${colno}});`
    );
    this.emit.line(`${bufferExpr}.markFinishedAndPatchLinks();`);
    this.emit.line(`let ${resultVar} = ${resultVar}_snapshot.then((value) => value === runtime.RETURN_UNSET ? undefined : value);`);
  }

  //@todo - move to compile-base
  _compileChildren(node, frame) {
    node.children.forEach((child) => {
      this.compile(child, frame);
    });
  }

  /**
   * Emit a runtime prelink call that attaches `childBufferExpr` to channel lanes
   * on `parentBufferExpr` when those lanes are present in `presenceMapExpr`.
   *
   * `insertPos` is used for block functions where prelinking must be injected
   * before block body code is emitted.
   */
  emitLinkWithParentCompositionBuffer(channelNames, parentBufferExpr, childBufferExpr, presenceMapExpr, insertPos = null) {
    const snippet = `runtime.linkWithParentCompositionBuffer(${parentBufferExpr}, ${childBufferExpr}, ${JSON.stringify(channelNames)}, ${presenceMapExpr});`;

    if (typeof insertPos === 'number') {
      this.emit.insertLine(insertPos, snippet);
    } else {
      this.emit.line(snippet);
    }
  }

  analyzeCallExtension(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    return textChannel
      ? { uses: [textChannel], mutates: [textChannel] }
      : {};
  }

  analyzeCallExtensionAsync(node) {
    return this.analyzeCallExtension(node);
  }

  compileCallExtension(node, frame) {
    this._compileCallExtension(node, frame, false);
  }

  /**
   * CallExtension - no callback, can return either value or promise
   * CallExtensionAsync - uses callback, async = true. This was the way to handle the old nunjucks async
   * @todo - rewrite with _emitAggregate
   */
  _compileCallExtension(node, frame, async) {
    const asyncFrame = this.asyncMode ? null : frame;
    var args = node.args;
    var contentArgs = node.contentArgs;
    var autoescape = typeof node.autoescape === 'boolean' ? node.autoescape : true;
    var noExtensionCallback = !async;//assign the return value directly, no callback
    var resolveArgs = node.resolveArgs && this.asyncMode;
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
          // These are nested call arguments, not statement/root expressions,
          // so they intentionally bypass waited-root tracking.
          if (this.asyncMode && !resolveArgs) {
            this.emit('runtime.normalizeFinalPromise(');
            this._compileExpression(arg, asyncFrame);
            this.emit(')');
          } else {
            this._compileExpression(arg, callFrame);
          }

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
            if (this.asyncMode && !resolveArgs) {
              //when args are not resolved, the contentArgs are promises
              this.emit('runtime.normalizeFinalPromise(');
              this.emit._compileRenderBoundary(node, callFrame, function () {
                this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                this.compile(arg, asyncFrame);
              }, arg); // Use content arg node for position
              this.emit(')');
            }
            else {
              //when not resolve args, the contentArgs are callback functions
              this.emit.line('function(cb) {');
              this.emit.line('if(!cb) { cb = function(err) { if(err) { throw err; }}}');

              this.emit.withScopedSyntax(() => {
                this.emit._compileCallbackRenderBoundary(node, callFrame, function () {
                  this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
                  this.compile(arg, asyncFrame);
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
      emitExtensionInvocation(null, ext);
      this.emit.line(';');
      return;
    }

    if (this.asyncMode) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
      const returnId = this._tmpid();
      this.emit(`let ${returnId} = `);
      emitExtensionInvocation(null, ext);
      this.emit.line(';');
      const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, positionNode, true);
      this.emit.line(`${this.buffer.currentBuffer}.add(${textCmdExpr}, "${this.buffer.currentTextChannelName}");`);
    } else if (noExtensionCallback) {
      const ext = this._tmpid();
      this.emit.line(`let ${ext} = env.getExtension("${node.extName}");`);
      this.buffer.addToBuffer(node, frame, () => {
        this.emit('runtime.suppressValue(');
        emitExtensionInvocation(frame, ext);
        this.emit(`, ${autoescape} && env.opts.autoescape)`);
      }, positionNode, this.buffer.currentTextChannelName, false);
    } else {
      //use the original nunjucks callback mechanism
      this.emit(`env.getExtension("${node.extName}")["${node.prop}"](context`);
      emitCallArgs(frame);

      const res = this._tmpid();
      this.emit.line(', ' + this._makeCallback(res));
      frame = this.boundaries.compileTextBoundary(
        this.buffer,
        node,
        frame,
        positionNode,
        () => {
          this.emit(`runtime.suppressValue(${res}, ${autoescape} && env.opts.autoescape);`);
        },
        {
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

  analyzeSet(node, analysisPass) {
    const declares = [];
    const mutates = [];
    const isDeclaration = node.varType === 'declaration';
    const targets = node.targets;
    if (this.scriptMode) {
      switch (node.varType) {
        case 'declaration':
        case 'assignment':
          break;
        default:
          this.fail(`Unknown varType '${node.varType}' for set/var statement.`, node.lineno, node.colno, node);
      }
    } else if (node.varType !== 'assignment' && node.varType !== 'declaration') {
      this.fail(`'${node.varType}' is not allowed in template mode. Use 'set' or declaration tags.`, node.lineno, node.colno, node);
    }
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
          declares.push({ name, type: 'var', initializer: null, explicit: !!isDeclaration });
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
    return this.compileSyncSet(node, frame);
  }

  compileSyncSet(node, frame) {
    const ids = [];

    // 1. First pass: Validate, declare, and prepare temporary JS variables for all targets.
    node.targets.forEach((target) => {
      let id;

      // Sync mode relies on a fresh temp for JS assignment.
      id = this._tmpid();
      this.emit.line(`var ${id};`);
      ids.push(id);
    });

    // 2. Compile the value/body assignment.
    if (node.path) {
      // Validation for set_path
      if (ids.length !== 1) {
        this.fail('set_path only supports a single target.', node.lineno, node.colno, node);
      }
      this.emit(ids[0] + ' = ');

      this.emit('runtime.setPath(');
      this.emit(`frame.lookup("${node.targets[0].value}"), `);
      this.compile(node.path, frame);
      this.emit(', ');
      this.compile(node.value, frame);
      this.emit(')');
      this.emit.line(';');
    } else if (node.value) { // e.g., set x = 123
      this.emit(ids.join(' = ') + ' = ');
      this.compileExpression(node.value, frame, node.value);
      this.emit.line(';');
    } else { // e.g., set x = capture ...
      this.emit(ids.join(' = ') + ' = ');
      this.compile(node.body, frame);
      this.emit.line(';');
    }


    // 3. Second pass: Set the variables in the frame and update context/exports.
    node.targets.forEach((target, i) => {
      const id = ids[i];
      const name = target.value;
      this.emit.line(`frame.set("${name}", ${id}, true);`);
      this.emit.line('if (frame.topLevel) {');
      this.emit.line(`context.setVariable("${name}", ${id});`);
      if (name.charAt(0) !== '_') {
        this.emit.line(`context.addResolvedExport("${name}", ${id});`);
      }
      this.emit.line('}');
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
      this.fail('async var channel assignments are only supported in async mode', node.lineno, node.colno, node);
    }
    const asyncFrame = null;
    const ids = [];
    const isDeclarationOnly = !!node.declarationOnly;
    const exportFromRootScope = this.analysis.isRootScopeOwner(node._analysis);

    // 1. First pass: validate + declarations + temp ids (mirrors compileSet structure).
    node.targets.forEach((target) => {
      const name = target.value;
      let id;

      const visibleDeclaration = this.analysis.findDeclaration(node._analysis, name);
      const isOwnDeclaration = !!(visibleDeclaration && visibleDeclaration.declarationOrigin === node._analysis);

      if (isOwnDeclaration) {
        this.emit(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "var", context, null);`);
      } else {
        if (!(visibleDeclaration && visibleDeclaration.type === 'var')) {
          this.fail(
            `Compiler error: analysis did not resolve a visible var declaration for '${name}'.`,
            target.lineno,
            target.colno,
            node,
            target
          );
        }
      }

      id = this._tmpid();
      this.emit.line(`let ${id};`);
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
      this.compileExpression(node.value, asyncFrame, node.value);
      this.emit.line(';');
      this.emit(ids[0] + ' = ');
      this.emit('runtime.setPath(');
      this.buffer.emitAddRawSnapshot(targetName, node);
      this.emit(', ');
      this._compileAggregate(node.path, asyncFrame, '[', ']', false, false);
      this.emit(', ');
      this.emit(pathValueId);
      this.emit(')');
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.value && !isDeclarationOnly) {
      this.emit(ids.join(' = ') + ' = ');
      this.compileExpression(node.value, asyncFrame, node.value);
      this.emit.line(';');
      hasAssignedValue = true;
    } else if (node.body) {
      this.emit(ids.join(' = ') + ' = ');
      this.compile(node.body, asyncFrame);
      this.emit.line(';');
      hasAssignedValue = true;
    }

    // 3. Second pass: emit channel commands + export.
    node.targets.forEach((target, i) => {
      const name = target.value;
      const valueId = ids[i];

      if (hasAssignedValue) {
        this.emit.line(`${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${valueId}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${name}');`);
      }

      if (name.charAt(0) !== '_' && hasAssignedValue) {
        if (exportFromRootScope) {
          this.emit.line(`context.addDeferredExport("${name}", "${name}", ${this.buffer.currentBuffer});`);
        }
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
    const boundaryFrame = this.asyncMode ? null : frame;
    const switchResult = this.buffer._compileControlFlowBoundary(node, boundaryFrame, (callbackFrame) => {
      const blockFrame = this.asyncMode ? null : callbackFrame;
      let catchPoisonPos;

      if (this.asyncMode) {
        // Add try-catch wrapper for error handling
        this.emit('try {');
        this.emit('const switchResult = ');
        this._compileAwaitedExpression(node.expr, blockFrame);
        this.emit(';');
        this.emit('');
        // Note: awaited result cannot be a resolved PoisonedValue, so no check needed

        // Emit switch statement
        this.emit('switch (switchResult) {');
      } else {
        // Sync mode - no error handling needed
        this.emit('switch (');
        this._compileAwaitedExpression(node.expr, blockFrame);
        this.emit(') {');
      }

      // Compile cases — synchronously, no inner asyncBlock wrappers
      node.cases.forEach((c) => {
        this.emit('case ');
        this._compileAwaitedExpression(c.cond, blockFrame);
        this.emit(': ');

        if (c.body.children.length) {
          this.compile(c.body, blockFrame);
          this.emit.line('break;');
        }
      });

      // Compile default case, if present — synchronously
      if (node.default) {
        this.emit('default: ');
        this.compile(node.default, blockFrame);
      }

      this.emit('}'); // Close switch

      if (this.asyncMode) {
        // Add catch block to poison variables and channels when switch expression fails
        const errorCtx = this._createErrorContext(node, node.expr);
        this.emit('} catch (e) {');
        this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorCtx.lineno}, ${errorCtx.colno}, "${errorCtx.errorContextString}", context.path);`);
        catchPoisonPos = this.codebuf.length;
        this.emit('');
        this.emit('}'); // No re-throw - execution continues with poisoned vars

        // Collect channels from all branches via _analysis (available before compilation)
        const allChannels = new Set();
        node.cases.forEach(c => {
          (c.body._analysis.usedChannels || []).forEach(ch => allChannels.add(ch));
        });
        if (node.default) {
          (node.default._analysis.usedChannels || []).forEach(ch => allChannels.add(ch));
        }

        if (allChannels.size > 0) {
          for (const channelName of allChannels) {
            this.emit.insertLine(catchPoisonPos,
              `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`);
          }
        }
      }
    });

    if (!this.asyncMode) {
      frame = switchResult.frame;
    }
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

    const guardTargets = this._getGuardTargets(node);
    const variableTargetsAll = guardTargets.variableTargetsAll;
    const variableValidationTargets = guardTargets.variableValidationTargets;
    const hasSequenceTargets = !!guardTargets.sequenceTargets;
    // Guard state is used for sequence lock detection/repair bookkeeping.
    const needsGuardState = variableTargetsAll || hasSequenceTargets;
    const guardStateVar = needsGuardState ? this._tmpid() : null;
    validateGuardVariablesDeclared(variableValidationTargets, this, node);

    const guardResult = this.buffer._compileControlFlowBoundary(node, null, () => {
      const blockFrame = null;
      const previousGuardDepth = this.guardDepth;
      this.guardDepth = previousGuardDepth + 1;

      try {
        // 2. Link for explicit reversion (optional, if we want to support manual revert)
        this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
        let guardRepairLinePos = null;
        const channelGuardInitLinePos = this.codebuf.length;
        let channelGuardStateVar = null;
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
        // Sequence lock mutations are tracked via used channel names.
        const resolvedSequenceTargets = new Set();
        const modifiedLocks = new Set();
        const bodyUsedChannels = Array.from(node.body._analysis.usedChannels || []);
        if (bodyUsedChannels.length > 0) {
          for (const channelName of bodyUsedChannels) {
            if (channelName && channelName.startsWith('!')) {
              modifiedLocks.add(channelName);
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

        let guardChannels = this._getGuardedChannelNames(
          bodyUsedChannels,
          guardTargets,
          node.body._analysis
        );
        if (resolvedSequenceTargets.size > 0) {
          const merged = new Set(guardChannels);
          for (const lockName of resolvedSequenceTargets) {
            merged.add(lockName);
          }
          guardChannels = Array.from(merged);
        }
        const bodyDeclaredChannels = Array.from((node.body._analysis.declaredChannels || new Map()).keys());
        if (bodyDeclaredChannels.length > 0) {
          const merged = new Set(guardChannels);
          for (const name of bodyDeclaredChannels) {
            merged.add(name);
          }
          guardChannels = Array.from(merged);
        }
        if (guardChannels.length > 0) {
          channelGuardStateVar = this._tmpid();
          this.emit.insertLine(
            channelGuardInitLinePos,
            `const ${channelGuardStateVar} = runtime.guard.initChannelSnapshots(${JSON.stringify(guardChannels)}, ${this.buffer.currentBuffer}, cb);`
          );
        }

        // 4. Check Buffer/Variables for Poison
        const guardErrorsVar = this._tmpid();
        this.emit.line(
          `const ${guardErrorsVar} = await runtime.guard.finalizeGuard(${guardStateVar || 'null'}, ${this.buffer.currentBuffer}, ${JSON.stringify(guardChannels)}, ${channelGuardStateVar || 'null'});`
        );
        this.emit.line(`if (${guardErrorsVar}.length > 0) {`);

        if (node.recoveryBody) {
          if (node.errorVar) {
            // Guard recovery error variable is already declared in analysis;
            // recovery runs inside the existing guard boundary, so only the
            // runtime var-channel registration and command emit are needed here.
            this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${node.errorVar}", "var", context, null);`);
            this.emit.line(
              `${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${node.errorVar}', args: [new runtime.PoisonError(${guardErrorsVar})], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${node.errorVar}');`
            );
          }
          this.compile(node.recoveryBody, blockFrame);
        }

        this.emit.line('} else {');
        this.emit.line('}');
      } finally {
        this.guardDepth = previousGuardDepth;
      }
    });

    frame = guardResult.frame;
  }

  _getGuardedChannelNames(usedChannels, guardTargets, analysis) {
    let used = [];
    if (usedChannels instanceof Set) {
      used = Array.from(usedChannels);
    } else if (Array.isArray(usedChannels)) {
      used = usedChannels;
    }

    if (!guardTargets) {
      return [];
    }

    if (guardTargets.channelSelector === '*') {
      return used;
    }

    const hasNamedChannels = Array.isArray(guardTargets.channelSelector) && guardTargets.channelSelector.length > 0;
    const hasTypedChannels = Array.isArray(guardTargets.typeTargets) && guardTargets.typeTargets.length > 0;
    if (hasNamedChannels || hasTypedChannels) {
      const guardedSet = new Set(hasNamedChannels ? guardTargets.channelSelector : []);
      // Template implicit text output uses an internal channel name (__text__...).
      // Preserve selector ergonomics: guarding `text` targets the active text channel.
      if (!this.scriptMode && guardedSet.has('text')) {
        guardedSet.add(this.buffer.currentTextChannelName);
      }
      const guardedTypes = new Set(hasTypedChannels ? guardTargets.typeTargets : []);
      return used.filter((name) => {
        if (guardedSet.has(name)) {
          return true;
        }
        if (guardedTypes.size === 0) {
          return false;
        }
        const channelDecl = this.analysis.findDeclaration(analysis, name);
        if (channelDecl) {
          return guardedTypes.has(channelDecl.type);
        }
        if (!this.scriptMode && name === this.buffer.currentTextChannelName && guardedTypes.has('text')) {
          return true;
        }
        return guardedTypes.has(name);
      });
    }

    if (guardTargets.variableTargetsAll) {
      // In async mode, script/template vars are channel-backed; guard var should
      // therefore target var channels touched inside the guard block.
      return used.filter((name) => {
        if (name && name.charAt(0) === '!') {
          return false;
        }
        const channelDecl = this.analysis.findDeclaration(analysis, name);
        return !!(channelDecl && channelDecl.type === 'var');
      });
    }

    // No selectors at all means global guard.
    if (!guardTargets.hasAnySelectors) {
      return used;
    }

    // Variable/sequence-only guards do not guard channels.
    return [];
  }

  _getGuardTargets(guardNode) {
    const channelTargetsRaw = Array.isArray(guardNode && guardNode.channelTargets) &&
      guardNode.channelTargets.length > 0
      ? guardNode.channelTargets
      : null;
    let channelSelector = !channelTargetsRaw
      ? null
      : (channelTargetsRaw.includes('@') ? '*' : channelTargetsRaw);
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
      const resolvedChannels = new Set(Array.isArray(channelSelector) ? channelSelector : []);

      for (const name of variableTargetsRaw) {
        const channelDecl = this.analysis.findDeclaration(guardNode._analysis, name);
        const isDeclaredVar = !!(channelDecl && channelDecl.type === 'var');

        if (isDeclaredVar) {
          variableValidationTargets.push(name);
        }
        if (channelDecl) {
          resolvedChannels.add(name);
        }
        if (!this.scriptMode && !isDeclaredVar && !channelDecl && name === 'text') {
          resolvedChannels.add(this.buffer.currentTextChannelName);
          continue;
        }
        if (!isDeclaredVar && !channelDecl) {
          variableValidationTargets.push(name);
        }
      }

      if (channelSelector !== '*') {
        channelSelector = resolvedChannels.size > 0 ? Array.from(resolvedChannels) : null;
      }
    }
    const sequenceTargets = Array.isArray(guardNode && guardNode.sequenceTargets) && guardNode.sequenceTargets.length > 0
      ? guardNode.sequenceTargets
      : null;

    const hasAnySelectors = !!channelSelector || !!typeTargets || hasVariableTargetsSelector || !!sequenceTargets;

    return {
      channelSelector,
      typeTargets,
      variableTargetsAll,
      variableValidationTargets: variableValidationTargets.length > 0 ? variableValidationTargets : null,
      sequenceTargets,
      hasAnySelectors
    };
  }

  //todo! - get rid of the callback
  compileIf(node, frame, async) {
    if (this.asyncMode) {
      async = false;//old type of async
    }

    const boundaryFrame = this.asyncMode ? null : frame;
    const ifResult = this.buffer._compileControlFlowBoundary(node, boundaryFrame, (callbackFrame) => {
      const blockFrame = this.asyncMode ? null : callbackFrame;
      let catchPoisonPos;

      if (this.asyncMode) {
        const condResultId = this._tmpid();
        // Async mode: Add try-catch wrapper for poison condition handling
        this.emit('try {');
        this.emit(`const ${condResultId} = `);
        this._compileAwaitedExpression(node.cond, blockFrame);
        this.emit(';');
        this.emit('');

        this.emit(`if (${condResultId}) {`);

        // True branch — synchronous inside the runControlFlowBoundary async fn
        this.compile(node.body, blockFrame);

        this.emit('} else {');

        // False branch — synchronous
        if (node.else_) {
          this.compile(node.else_, blockFrame);
        }
        this.emit('}');

        // Add catch block to poison variables when condition fails
        const errorContext = this._createErrorContext(node, node.cond);
        this.emit('} catch (e) {');
        this.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${errorContext.lineno}, ${errorContext.colno}, "${errorContext.errorContextString}", context.path);`);
        catchPoisonPos = this.codebuf.length;
        this.emit('');
        this.emit('}');  // No re-throw - execution continues with poisoned vars

        const trueBranchChannels = new Set(node.body._analysis.usedChannels || []);
        const falseBranchChannels = node.else_
          ? new Set(node.else_._analysis.usedChannels || [])
          : new Set();
        const allBranchChannels = new Set([...trueBranchChannels, ...falseBranchChannels]);

        // Fill in the poison handling code for channels when condition fails.
        if (allBranchChannels.size > 0) {
          for (const channelName of allBranchChannels) {
            this.emit.insertLine(catchPoisonPos,
              `    ${this.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`);
          }
        }
      } else {
        // Sync mode (unchanged)
        this.emit('if(');
        this._compileAwaitedExpression(node.cond, blockFrame);
        this.emit('){');

        this.emit.withScopedSyntax(() => {
          let trueFrame = blockFrame;
          this.compile(node.body, trueFrame);
          if (async) {
            this.emit('cb()');
          }
        });

        this.emit('} else {');

        if (node.else_) {
          this.emit.withScopedSyntax(() => {
            let falseFrame = blockFrame;
            this.compile(node.else_, falseFrame);
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

    if (!this.asyncMode) {
      frame = ifResult.frame;
    }
  }

  analyzeIfAsync(node) {
    return this.analyzeIf(node);
  }

  compileIfAsync(node, frame) {
    if (this.asyncMode) {
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
    if (node.concurrentLimit) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: node.body._analysis && node.body._analysis.waitedOutputName
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
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
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass);
    // Sequential loop bodies own a dedicated __waited__ channel.
    // Analysis runs before async propagation, so assign the runtime channel name here.
    if (node.body) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: (node.body._analysis && node.body._analysis.waitedOutputName)
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
    }
    return result;
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
    const result = this._analyzeLoopNodeDeclarations(node, analysisPass, true);
    // Sequential each-bodies own a dedicated __waited__ channel.
    // Analysis runs before async propagation, so assign the runtime channel name here.
    if (node.body) {
      node.body._analysis = Object.assign({}, node.body._analysis, {
        waitedOutputName: (node.body._analysis && node.body._analysis.waitedOutputName)
          ? node.body._analysis.waitedOutputName
          : `__waited__${this._tmpid()}`
      });
    }
    return result;
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
    return this.macro._compileMacro(node, frame, keepFrame);
  }

  analyzeMacro(node) {
    return this.macro.analyzeMacro(node);
  }

  compileMacro(node, frame) {
    return this.macro.compileMacro(node, frame);
  }

  analyzeImport(node) {
    node.target._analysis = { declarationTarget: true };
    this.importedBindings.add(node.target.value);
    return {
      // Imported bindings are callable-ambiguous in async mode: a later call may
      // target either a macro boundary or a plain function. Mark them here so
      // compileFunCall can give imported callables their own structural boundary.
      declares: [{ name: node.target.value, type: 'var', initializer: null, imported: true }]
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
        this.importedBindings.add(nameNode.value.value);
        declares.push({ name: nameNode.value.value, type: 'var', initializer: null, imported: true });
      } else if (nameNode instanceof nodes.Symbol) {
        nameNode._analysis = { declarationTarget: true };
        this.importedBindings.add(nameNode.value);
        declares.push({ name: nameNode.value, type: 'var', initializer: null, imported: true });
      }
    });
    return { declares };
  }

  compileFromImport(node, frame) {
    this.inheritance.compileFromImport(node, frame);
  }

  analyzeBlock(node) {
    return { createScope: true, scopeBoundary: false, parentReadOnly: true };
  }

  compileBlock(node, frame) {
    this.inheritance.compileBlock(node, frame);
  }

  compileSuper(node, frame) {
    this.inheritance.compileSuper(node, frame);
  }

  analyzeExtends(node) {
    if (!this.asyncMode) {
      return {};
    }
    return {
      uses: ['__parentTemplate'],
      mutates: ['__parentTemplate']
    };
  }

  compileExtends(node, frame) {
    this.inheritance.compileExtends(node, frame);
  }

  analyzeInclude(node) {
    if (this.scriptMode) {
      return {};
    }
    const textChannel = this.analysis.getCurrentTextChannel(node._analysis);
    const includeVisibleChannels = this.analysis.getIncludeVisibleVarChannels(node._analysis)
      .map((entry) => entry.runtimeName);
    const uses = textChannel
      ? [textChannel, ...includeVisibleChannels]
      : includeVisibleChannels;
    return {
      uses,
      mutates: textChannel ? [textChannel] : []
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
      textOutput: `${CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL}${this._tmpid()}`
    };
  }

  compileCapture(node, frame) {
    if (this.scriptMode) {
      this.fail('Capture blocks are only supported in template mode', node.lineno, node.colno, node);
    }

    if (this.asyncMode) {
      this.boundaries.compileCaptureBoundary(
        this.buffer,
        node,
        function () {
          this.compile(node.body, null);
        },
        node.body
      );
    } else {
      // Sync capture still uses the legacy local output variable path.
      const buffer = this.buffer.currentBuffer;
      const textChannelVar = this.buffer.currentTextChannelVar;
      const textChannelName = this.buffer.currentTextChannelName;
      const captureTextOutputName = node && node._analysis ? node._analysis.textOutput : null;
      this.buffer.currentBuffer = 'output';
      this.buffer.currentTextChannelVar = 'output_textChannelVar';
      this.buffer.currentTextChannelName = captureTextOutputName;
      this.emit.line('(function() {');
      this.emit.line('let output = "";');
      this.emit.withScopedSyntax(() => {
        this.compile(node.body, frame);
      });
      this.emit.line('return output;');
      this.emit.line('})()');
      this.buffer.currentBuffer = buffer;
      this.buffer.currentTextChannelVar = textChannelVar;
      this.buffer.currentTextChannelName = textChannelName;
    }
  }

  // @todo - get rid of the asyncAddToBufferBegin after we have switch var to the new value implementation
  analyzeOutput(node) {
    const textChannel = !this.scriptMode
      ? this.analysis.getCurrentTextChannel(node._analysis)
      : null;
    return (this.scriptMode) ? {}
      : {
        uses: [textChannel],
        mutates: [textChannel]
      };
  }

  compileOutput(node, frame) {
    if (this.scriptMode) {
      this.fail(
        'Script mode does not support template output nodes. Use declared channels and command instead.',
        node && node.lineno,
        node && node.colno,
        node || undefined
      );
    }
    const textChannelName = this.buffer.currentTextChannelName;
    if (this.asyncMode) {
      const children = node.children;
      children.forEach(child => {
        if (child instanceof nodes.TemplateData) {
          if (child.value) {
            this.buffer.addToBuffer(node, null, function () {
              this.compileLiteral(child, null);
            }, child, textChannelName, true);
          }
          return;
        }
        if (child._analysis?.mutatedChannels?.size > 0) {
          // Remaining intentional boundary case:
          // expressions like caller() can still attach composition structure while
          // evaluating, so this is not just "wait for a text value then emit text".
          // Keep a dedicated child buffer here; pure value-only output stays on the
          // synchronous TextCommand path below.
          this.boundaries.compileTextBoundary(
            this.buffer,
            node,
            null,
            child,
            () => {
              this.compileExpression(child, null, child);
            },
            {
              emitInCurrentBuffer: true
            }
          );
        } else {
          // Pure value expression: add TextCommand synchronously, no async block needed.
          // Any promise in args is resolved at apply time by resolveCommandArgumentsForApply.
          const returnId = this._tmpid();
          this.emit.line(`let ${returnId};`);
          this.emit(`${returnId} = `);
          this.compileExpression(child, null, child);
          this.emit.line(';');
          const textCmdExpr = this.buffer._emitTemplateTextCommandExpression(returnId, child, true);
          this.emit.line(`${this.buffer.currentBuffer}.add(${textCmdExpr}, "${textChannelName}");`);
        }
      });
      return;
    }

    const children = node.children;
    children.forEach(child => {
      if (child instanceof nodes.TemplateData) {
        if (child.value) {
          this.buffer.addToBuffer(node, frame, function () {
            this.compileLiteral(child, frame);
          }, child, textChannelName, false);
        }
        return;
      }

      this.buffer.addToBuffer(node, frame, function () {
        this.emit('runtime.suppressValue(');
        if (this.throwOnUndefined) {
          this.emit('runtime.ensureDefined(');
        }
        this.compileExpression(child, frame, child);
        if (this.throwOnUndefined) {
          this.emit(`,${child.lineno},${child.colno}, context)`);
        }
        this.emit(', env.opts.autoescape)');
      }, child, textChannelName, false);
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

  analyzeRoot(node) {
    const declares = this._getRootDeclarations(node);
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
      textOutput: this._getRootTextOutput()
    };
  }

  _getRootDeclarations(node) {
    const declares = [];
    if (this.scriptMode) {
      declares.push({ name: RETURN_CHANNEL_NAME, type: 'var', initializer: null, internal: true });
    } else {
      declares.push({ name: CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL, type: 'text', initializer: null });
    }

    if (this.asyncMode && !this.scriptMode) {
      const hasExtendsNode = node.children.some((child) => child instanceof nodes.Extends);
      const hasParentTemplateDeclaration = node.children.some((child) =>
        child instanceof nodes.Set &&
        child.varType === 'declaration' &&
        child.targets &&
        child.targets[0] &&
        child.targets[0].value === '__parentTemplate'
      );
      if (hasExtendsNode && !hasParentTemplateDeclaration) {
        declares.push({ name: '__parentTemplate', type: 'var', initializer: null, internal: true });
      }
    }

    return declares;
  }

  _getRootTextOutput() {
    return this.scriptMode ? null : CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL;
  }

  _emitAsyncRootFinalParentLookup() {
    if (this.hasExtends) {
      this.emit.line(`  let finalParent = await runtime.channelLookup("__parentTemplate", ${this.buffer.currentBuffer});`);
    } else {
      this.emit.line('  let finalParent = null;');
    }
  }

  _emitScriptRootLeafResult(node) {
    const returnVar = this._tmpid();
    this.emitReturnChannelSnapshot(this.buffer.currentBuffer, node, returnVar);
    this.emit.line(`    cb(null, runtime.normalizeFinalPromise(await ${returnVar}));`);
  }

  _emitAsyncTemplateRootLeafResult() {
    this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`    cb(null, await ${this.buffer.currentTextChannelVar}.finalSnapshot());`);
  }

  _emitAsyncRootCompletion(node) {
    this.emit.line('if (!compositionMode) {');
    this.emit.line('(async () => {');

    this._emitAsyncRootFinalParentLookup();

    this.emit.line('  if(finalParent) {');
    this.emit.line(`    ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line('    finalParent.rootRenderFunc(env, context.forkForPath(finalParent.path), runtime, cb, compositionMode);');
    this.emit.line('  } else {');

    if (this.scriptMode) {
      this._emitScriptRootLeafResult(node);
    } else {
      this._emitAsyncTemplateRootLeafResult();
    }

    this.emit.line('  }');
    this.emit.line('})().catch(e => {');
    this.emit.line(`  var err = runtime.handleError(e, ${node.lineno}, ${node.colno}, "${this._generateErrorContext(node)}", context.path);`);
    this.emit.line('  cb(err);');
    this.emit.line('});');
    this.emit.line('} else {');
    this.emit.line(`  ${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`  return ${this.buffer.currentBuffer};`);
    this.emit.line('}');
  }

  _emitSyncRootCompletion() {
    this.emit.line('if(parentTemplate) {');
    this.emit.line('  let parentContext = context.forkForPath(parentTemplate.path);');
    this.emit.line('  parentTemplate.rootRenderFunc(env, parentContext, frame, runtime, cb);');
    this.emit.line('} else {');
    this.emit.line(`  cb(null, ${this.buffer.currentBuffer});`);
    this.emit.line('}');
  }

  _compileAsyncRootBody(node) {
    this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
    this.emit.line(`context.linkDeferredExportsToBuffer(${this.buffer.currentBuffer});`);
    if (this.scriptMode) {
      this.emitDeclareReturnChannel(this.buffer.currentBuffer);
    }
    const sequenceLocks = Array.isArray(node._analysis && node._analysis.sequenceLocks)
      ? node._analysis.sequenceLocks
      : [];
    for (const name of sequenceLocks) {
      this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "sequential_path", context, null);`);
    }
    if (this.hasStaticExtends && !this.hasDynamicExtends) {
      this.emit.line(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "__parentTemplate", "var", context, null);`);
    }
    this._compileChildren(node, null);
    this.emit.line('context.resolveExports(output);');
    this._emitAsyncRootCompletion(node);
  }

  _compileSyncRootBody(node, frame) {
    this.emit.line(`runtime.markChannelBufferScope(${this.buffer.currentBuffer});`);
    this.emit.line('let parentTemplate = null;');
    this._compileChildren(node, frame);
    this._emitSyncRootCompletion();
  }

  _compileAsyncBlockEntry(block) {
    const name = block.name.value;
    const blockLinkedChannels = Array.from(block.body._analysis.usedChannels || [])
      .filter((hname) => hname !== CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHANNEL);
    this.emit.beginEntryFunction(block, `b_${name}`, blockLinkedChannels);
    this.emit.line(`context = context.forkForPath(${JSON.stringify(this.templateName)});`);
    this.compile(block.body, null);
    this.emit.line(`${this.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
    this.emit.line(`return ${this.buffer.currentTextChannelVar}.finalSnapshot();`);
    this.emit.endEntryFunction(block, true);
  }

  _compileSyncBlockEntry(block, frame) {
    const name = block.name.value;
    const blockFrame = frame.new();
    this.emit.beginEntryFunction(block, `b_${name}`);
    this.emit.line('var frame = frame.push(true);');
    this.compile(block.body, blockFrame);
    this.emit.endEntryFunction(block);
  }

  _compileBlockEntries(node, frame) {
    const blockNames = [];
    const blocks = node.findAll(nodes.Block);

    blocks.forEach((block) => {
      const name = block.name.value;

      if (blockNames.indexOf(name) !== -1) {
        this.fail(`Block "${name}" defined more than once.`, block.lineno, block.colno, block);
      }
      blockNames.push(name);

      if (this.asyncMode) {
        this._compileAsyncBlockEntry(block);
      } else {
        this._compileSyncBlockEntry(block, frame);
      }
    });

    return blocks;
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
    this.hasExtends = this.hasStaticExtends || this.hasDynamicExtends;

    frame = this.asyncMode ? null : new Frame();
    // this.sequential._declareSequentialLocks(node, frame); // Old logic removed

    this.emit.beginEntryFunction(node, 'root');
    if (this.asyncMode) {
      this._compileAsyncRootBody(node);
    } else {
      this._compileSyncRootBody(node, frame);
    }

    // Pass the node to _emitFuncEnd for error position info (used in sync catch)
    this.emit.endEntryFunction(node, true);

    this.inBlock = true;
    const blocks = this._compileBlockEntries(node, frame);

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
    node.children.forEach(child => {
      this.compileExpression(child, this.asyncMode ? null : frame, child);
      this.emit.line(';');
    });
  }

  compileReturn(node, frame) {
    const hasValue = !!node.value;

    if (this.asyncMode) {
      const resultVar = this._tmpid();
      this.emit(`let ${resultVar} = `);
      if (hasValue) {
        this.compileExpression(node.value, null, node);
      } else {
        this.emit('undefined');
      }
      this.emit.line(';');
      this.emit.line(
        `${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${RETURN_CHANNEL_NAME}', args: [${resultVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${RETURN_CHANNEL_NAME}");`
      );
      return;
    }

    this.emit('cb(null, ');
    if (hasValue) {
      this.compileExpression(node.value, frame, node);
    } else {
      this.emit('undefined');
    }
    this.emit.line(');');
    this.emit.line('return;');
  }

  analyzeReturn() {
    return {
      mutates: [RETURN_CHANNEL_NAME]
    };
  }

  analyzeChannelDeclaration(node) {
    node.name._analysis = { declarationTarget: true };
    const name = node.name.value;
    return {
      declares: [{ name, type: node.channelType, initializer: node.initializer || null }],
      uses: [name]
    };
  }

  compileChannelDeclaration(node) {
    const channelType = node.channelType;
    const nameNode = node.name;
    validateChannelDeclarationNode(this, {
      node,
      nameNode,
      channelType,
      hasInitializer: !!node.initializer,
      asyncMode: this.asyncMode,
      scriptMode: this.scriptMode,
      isNameSymbol: nameNode instanceof nodes.Symbol
    });
    const name = nameNode.value;

    this.emit(`runtime.declareBufferChannel(${this.buffer.currentBuffer}, "${name}", "${channelType}", context, `);
    if (channelType === 'sink' || channelType === 'sequence') {
      this.compile(node.initializer, null);
    } else {
      this.emit('null');
    }
    this.emit.line(');');

    if (channelType === 'var' && node.initializer) {
      const initNode = node.initializer;
      const lineno = initNode.lineno !== undefined ? initNode.lineno : node.lineno;
      const colno = initNode.colno !== undefined ? initNode.colno : node.colno;
      const initValueId = this._tmpid();
      this.emit(`let ${initValueId} = `);
      this.compileExpression(initNode, null, initNode);
      this.emit.line(';');
      this.emit.line(`${this.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${name}', args: [${initValueId}], pos: {lineno: ${lineno}, colno: ${colno}} }), '${name}');`);
    }
  }


  analyzeChannelCommand(node) {
    // @todo - uses, mutates shall be collected by the expression analysis, not by channel commands
    // and also we have to check all commands
    const callNode = node.call instanceof nodes.FunCall ? node.call : null;
    const path = this.sequential._extractStaticPath(callNode ? callNode.name : node.call);
    if (!path || path.length === 0) {
      return {};
    }
    const channelName = path[0];
    // isObservation — does this channel command read rather than mutate?
    // Two cases emit an observable (isObservable=true) command at runtime:
    //   1. Call to a read-only method: snapshot(), isError(), getError()
    //      (emits SnapshotCommand / IsErrorCommand / GetErrorCommand).
    //      __checkpoint is excluded — it has no compile path yet.
    //   2. Non-call property read on a sequence channel (emits SequenceGetCommand).
    //      Non-sequence non-call accesses are mutations, so the declaration type
    //      is checked before classifying.
    // Everything else is a mutation: { uses, mutates } makes the async block wait
    // for pending observables and triggers copy-on-write in DataOutput.
    const channelDecl = channelName ? this.analysis.findDeclaration(node._analysis, channelName) : null;
    const isSequenceGet = !callNode && channelDecl && channelDecl.type === 'sequence';
    const isObservation = isSequenceGet ||
      (callNode && path.length === 2 &&
       (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError'));
    return isObservation ? { uses: [channelName] } : { uses: [channelName], mutates: [channelName] };
  }

  compileChannelCommand(node) {
    if (!this.scriptMode) {
      this.fail('Channel commands are only supported in script mode', node.lineno, node.colno, node);
    }
    this.buffer.compileChannelCommand(node);
  }

}

module.exports = {
  compile: function compile(src, asyncFilters, extensions, name, opts = {}) {
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
  },

  Compiler: Compiler
};

