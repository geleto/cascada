'use strict';

const nodes = require('../nodes');

class CompileLoop {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileWhile(node, frame) {
    if (!this.compiler.asyncMode) {
      // Synchronous case: remains the same, no changes needed.
      // @todo - use compileFor for the loop variable, etc...
      this.compiler.emit('while (');
      // While conditions are scheduler/control expressions, not waited-root work.
      this.compiler.compileExpression(node.cond, frame, node.cond, true);
      this.compiler.emit(') {');
      this.compiler.compile(node.body, frame);
      this.compiler.emit('}');
      return;
    }

    // Asynchronous case:
    // We use an infinite iterator and inject the condition check inside the loop body
    // so it shares the same async block and isolates writes correctly.

    // Use runtime helper to create the infinite iterator
    const iteratorCompiler = (arrNode, loopFrame, arrVarName) => {
      this.compiler.emit.line(`let ${arrVarName} = runtime.whileIterator();`);
    };

    this._compileFor(node, frame, {
      sequentialLoopBody: true,
      iteratorCompiler,
      whileConditionNode: node.cond,
      loopVarNames: ['iterationCount'],
      sourcePositionNode: node.cond
    });
  }

  compileFor(node, frame) {
    this._compileFor(node, frame);
  }

  _compileFor(node, frame, options = {}) {
    const sequentialLoopBody = !!options.sequentialLoopBody;
    const iteratorCompiler = options.iteratorCompiler || null;
    const whileConditionNode = options.whileConditionNode || null;
    const loopVarNames = Array.isArray(options.loopVarNames) ? options.loopVarNames : null;
    const sourcePositionNode = options.sourcePositionNode || node.arr;
    const useLoopValues = this.compiler.asyncMode;
    const parentWaitedChannelName = this.compiler.buffer.currentWaitedChannelName;
    const forResult = this.compiler.buffer._compileControlFlowBoundary(node, frame, (blockFrame) => {
      // _compileControlFlowBoundary's non-async path is a simple pass-through without scope.
      // Emit runtime frame.push/pop manually to scope loop variable bindings for sync loops.
      let innerFrame = blockFrame;
      if (!this.compiler.asyncMode) {
        innerFrame = blockFrame.push(false, true);
        this.compiler.emit.line('frame = frame.push();');
      }

      // Evaluate the array expression
      const arr = this.compiler._tmpid();

      if (iteratorCompiler) {
        // Gets the `{ "var": 1 }` style counts from compileWhile.
        iteratorCompiler(sourcePositionNode, innerFrame, arr);
      } else {
        // Loop source expression is control-flow input, not iteration-body work.
        // Keep it out of the loop body's own waited channel tracking scope.
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler.emit(`let ${arr} = `);
          // The iterable source is loop scheduler input, not a root body result.
          this.compiler.compileExpression(node.arr, innerFrame, node.arr, true);
          this.compiler.emit.line(';');
        });
      }

      // Compile concurrentLimit expression if present
      const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
      if (node.concurrentLimit) {
        // concurrentLimit expression is scheduler/control metadata for the loop.
        // It must not be tracked as iteration-body waited channel work.
        this.compiler.buffer.skipOwnWaitedChannel(() => {
          this.compiler.emit(`let ${limitVar} = `);
          // This value configures scheduling only, so exclude it from root tracking.
          this.compiler.compileExpression(node.concurrentLimit, innerFrame, node.concurrentLimit, true);
          this.compiler.emit.line(';');
        });
      }

      // Determine loop variable names
      const loopVars = [];
      const registerLoopVarBinding = (name) => {
        if (this.compiler.asyncMode && useLoopValues) {
          return;
        }
        innerFrame.set(name, name);
      };

      if (loopVarNames) {
        loopVarNames.forEach((name) => {
          loopVars.push(name);
          registerLoopVarBinding(name);
        });
      } else if (node.name instanceof nodes.Array) {
        node.name.children.forEach((child) => {
          const name = child.value;
          loopVars.push(name);
          registerLoopVarBinding(name);
        });
      } else {
        const name = node.name.value;
        loopVars.push(name);
        registerLoopVarBinding(name);
      }
      // Compile the loop body function and collect metadata
      const loopBodyFuncId = this.compiler._tmpid();
      this.compiler.emit(`let ${loopBodyFuncId} = `);

      //compile the loop body function
      const hasConcurrentLimit = Boolean(node.concurrentLimit);
      this._compileLoopBody(
        node,
        innerFrame,
        loopVars,
        sequentialLoopBody,
        hasConcurrentLimit,
        whileConditionNode,
        useLoopValues,
        loopVarNames
      );
      const bodyChannels = this.compiler.asyncMode ? new Set(node.body._analysis.usedChannels || []) : null;

      // Compile else block and collect metadata
      let elseFuncId = 'null';
      let elseChannels = null;

      if (node.else_) {
        elseFuncId = this.compiler._tmpid();
        this.compiler.emit(`let ${elseFuncId} = `);

        this._compileLoopElse(node, innerFrame);
        elseChannels = this.compiler.asyncMode ? new Set(node.else_._analysis.usedChannels || []) : null;
      }

      // Build asyncOptions code string if in async mode
      let asyncOptionsCode = 'null';
      if (this.compiler.asyncMode) {
        asyncOptionsCode = `{
          sequential: ${sequentialLoopBody},
          bodyChannels: ${JSON.stringify(bodyChannels ? Array.from(bodyChannels) : [])},
          elseChannels: ${JSON.stringify(elseChannels ? Array.from(elseChannels) : [])},
          concurrentLimit: ${node.concurrentLimit ? limitVar : 'null'},
          errorContext: { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: "${this.compiler._generateErrorContext(node)}", path: context.path }
        }`;
      }

      // Call the runtime iterate loop function
      // For sync loops: not awaited (fire-and-forget Promise). iterate() executes synchronously
      // internally (no awaits hit) and executes else block before returning.
      const loopOwnsWaitedCompletion = this.compiler.asyncMode && (sequentialLoopBody || hasConcurrentLimit);
      const shouldTrackNestedLoopCompletion = loopOwnsWaitedCompletion && !!parentWaitedChannelName;
      const iteratePromiseId = this.compiler.asyncMode ? this.compiler._tmpid() : null;
      if (this.compiler.asyncMode) {
        this.compiler.emit(`let ${iteratePromiseId} = runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, ${this.compiler.buffer.currentBuffer}, [`);
      } else {
        this.compiler.emit(`runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, null, [`);
      }
      loopVars.forEach((varName, index) => {
        if (index > 0) {
          this.compiler.emit(', ');
        }
        this.compiler.emit(`"${varName}"`);
      });
      this.compiler.emit(`], ${asyncOptionsCode});`);
      if (shouldTrackNestedLoopCompletion) {
        this.compiler.buffer.emitOwnWaitedConcurrencyResolve(iteratePromiseId, node);
      }
      if (this.compiler.asyncMode) {
        this.compiler.emit.line(`await ${iteratePromiseId};`);
      } else {
        this.compiler.emit.line('');
      }

      if (!this.compiler.asyncMode) {
        this.compiler.emit.line('frame = frame.pop();');
        innerFrame.pop();
      }
    });

    frame = forResult.frame;
  }

  _compileLoopBody(node, frame, loopVars, sequentialLoopBody, hasConcurrencyLimit = false, whileConditionNode = null, useLoopValues = false, loopVarNames = null) {
    const bodyCreatesScope = !!(node.body && node.body._analysis && node.body._analysis.createScope);
    if (this.compiler.asyncMode) {
      this.compiler.emit('(async function(');
    } else {
      this.compiler.emit('function(');
    }

    // Function parameters
    loopVars.forEach((varName, index) => {
      if (index > 0) {
        this.compiler.emit(', ');
      }
      this.compiler.emit(varName);
    });
    const loopIndex = this.compiler._tmpid();
    const loopLength = this.compiler._tmpid();
    const isLast = this.compiler._tmpid();
    const errorContext = this.compiler._tmpid();
    this.compiler.emit(`, ${loopIndex}, ${loopLength}, ${isLast}, ${errorContext}) {`);

    // Sequential and bounded loops gate the next iteration on the current
    // child buffer's __waited__ completion.
    const shouldAwaitLoopBody = sequentialLoopBody || hasConcurrencyLimit;

    if (this.compiler.asyncMode) {
      const parentBufferArg = this.compiler.buffer.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node);
      this.compiler.emit(
        `return runtime.runControlFlowBoundary(${parentBufferArg}, ${linkedChannelsArg}, context, cb, async (currentBuffer) => {`
      );
      this.compiler.emit.asyncClosureDepth++;
    }

    let bodyFrame = frame;
    let prevBuffer = null;
    let prevTextChannelVar = null;
    if (this.compiler.asyncMode) {
      prevBuffer = this.compiler.buffer.currentBuffer;
      prevTextChannelVar = this.compiler.buffer.currentTextChannelVar;
      this.compiler.buffer.currentBuffer = 'currentBuffer';
      this.compiler.buffer.currentTextChannelVar = null;
    } else if (bodyCreatesScope) {
      bodyFrame = frame.push();
      this.compiler.emit.line('frame = frame.push();');
    }

    const limitedWaitedChannelName = (hasConcurrencyLimit || sequentialLoopBody)
      ? (node.body && node.body._analysis && node.body._analysis.waitedOutputName)
      : null;
    if (limitedWaitedChannelName) {
      this.compiler.emit.line(`runtime.declareBufferChannel(${this.compiler.buffer.currentBuffer}, "${limitedWaitedChannelName}", "var", context, null);`);
    }

    const compileIterationBody = () => {
      //const makeSequentialPos = this.compiler.codebuf.length;// we will know later if it's sequential or not
      this._emitLoopBindings(node, loopVars, loopIndex, loopLength, isLast, bodyFrame, useLoopValues);

      // Handle array unpacking within the loop body
      if (loopVars.length > 1) {
        // Runtime unpacks arguments (array destructuring or object key/value)
        loopVars.forEach((varName) => {
          this._emitLoopVarIterationBinding(node, varName, varName, bodyFrame, useLoopValues);
        });
      } else if (!loopVarNames && node.name instanceof nodes.Array) {
        // Single variable destructuring: for [a] in arr
        // Runtime passes the item as-is (e.g. array), we destructure locally
        // Note: loopVars.length is 1 here
        node.name.children.forEach((child, index) => {
          const varName = child.value;
          const tid = this.compiler._tmpid();
          this.compiler.emit.line(`let ${tid} = Array.isArray(${varName}) ? ${varName}[${index}] : undefined;`);
          this._emitLoopVarIterationBinding(node, varName, tid, bodyFrame, useLoopValues);
        });

      } else {
        // Single variable loop (Symbol)
        const varName = loopVarNames ? loopVars[0] : node.name.value;
        this._emitLoopVarIterationBinding(node, varName, varName, bodyFrame, useLoopValues);
      }

      // While conditions run inside the same async block, but stay out of __waited__
      // because they drive control flow rather than iteration completion.
      let catchPoisonPos = null;
      let whileCondId;

      if (whileConditionNode) {
        whileCondId = this.compiler._tmpid();

        if (this.compiler.asyncMode) {
          this.compiler.emit(`let ${whileCondId};`);
          this.compiler.emit('try {');
          this.compiler.emit(`${whileCondId} = `);
          // While condition is control-flow gating and excluded from waited channel tracking.
          this.compiler.buffer.skipOwnWaitedChannel(() => {
            this.compiler._compileAwaitedExpression(whileConditionNode, bodyFrame);
          });
          this.compiler.emit.line(';');
          const whileErrorContext = this.compiler._createErrorContext(node, whileConditionNode);
          this.compiler.emit('} catch (e) {');
          this.compiler.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${whileErrorContext.lineno}, ${whileErrorContext.colno}, "${whileErrorContext.errorContextString}", context.path);`);
          catchPoisonPos = this.compiler.codebuf.length;
          this.compiler.emit.line(''); // Placeholder for poison injection

          // We set whileCond to false so the loop logic below terminates this iteration cleanly.
          this.compiler.emit(`  ${whileCondId} = false;`);
          this.compiler.emit('}');
        } else {
          this.compiler.emit(`const ${whileCondId} = `);
          // While condition is control-flow gating and excluded from waited channel tracking.
          this.compiler.buffer.skipOwnWaitedChannel(() => {
            this.compiler._compileAwaitedExpression(whileConditionNode, bodyFrame);
          });
          this.compiler.emit.line(';');
        }

        this.compiler.emit(`if (!${whileCondId}) {`);
        this.compiler.emit.line('  return false;');
        this.compiler.emit.line('}');
      }

      // Compile the loop body with the updated frame
      this.compiler.emit.withScopedSyntax(() => {
        this.compiler.compile(node.body, bodyFrame);
      });

      if (whileConditionNode) {
        if (catchPoisonPos !== null) {
          const bodyChannels = this.compiler.asyncMode ? new Set(node.body._analysis.usedChannels || []) : null;
          if (bodyChannels && bodyChannels.size > 0) {
            for (const channelName of bodyChannels) {
              this.compiler.emit.insertLine(catchPoisonPos, `  ${this.compiler.buffer.currentBuffer}.addPoison(contextualError, "${channelName}");`);
            }
          }
        }
      }

      // Finish the child buffer before finalSnapshot() so the parent iterator can
      // descend into it. finalSnapshot() is the authoritative "iteration done" signal.
      if (shouldAwaitLoopBody) {
        const waitedSnapshotId = this.compiler._tmpid();
        this.compiler.emit.line(`${this.compiler.buffer.currentBuffer}.markFinishedAndPatchLinks();`);
        this.compiler.emit.line(`const ${waitedSnapshotId} = ${this.compiler.buffer.currentBuffer}.getChannel("${limitedWaitedChannelName}").finalSnapshot();`);
        if (whileConditionNode) {
          this.compiler.emit.line(`await ${waitedSnapshotId};`);
          this.compiler.emit.line('return true;');
        } else {
          this.compiler.emit.line(`return ${waitedSnapshotId};`);
        }
      }

    };

    if ((sequentialLoopBody || hasConcurrencyLimit) && !limitedWaitedChannelName) {
      this.compiler.fail('compileFor: limited/sequential loop body has no waited channel — compiler analysis bug', node.lineno, node.colno, node);
    }

    if (!limitedWaitedChannelName) {
      compileIterationBody();
    } else {
      this.compiler.buffer.withOwnWaitedChannel(limitedWaitedChannelName, compileIterationBody);
    }

    if (this.compiler.asyncMode) {
      this.compiler.buffer.currentBuffer = prevBuffer;
      this.compiler.buffer.currentTextChannelVar = prevTextChannelVar;
      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('});');
    } else if (bodyCreatesScope) {
      this.compiler.emit.line('frame = frame.pop();');
      bodyFrame = bodyFrame.pop();
    }

    // Close the loop body function
    this.compiler.emit.line(this.compiler.asyncMode ? '}).bind(context);' : '};');

    return bodyFrame;
  }

  _compileLoopElse(node, frame) {
    const elseCreatesScope = !!(node.else_ && node.else_._analysis && node.else_._analysis.createScope);

    if (this.compiler.asyncMode) {
      this.compiler.emit('(async function() {');
    } else {
      this.compiler.emit('function() {');
    }

    let elseFrame = frame;
    if (elseCreatesScope) {
      if (!this.compiler.asyncMode) {
        elseFrame = frame.push();
        this.compiler.emit.line('frame = frame.push();');
      }
    }

    this.compiler.compile(node.else_, elseFrame);

    if (elseCreatesScope) {
      if (!this.compiler.asyncMode) {
        this.compiler.emit.line('frame = frame.pop();');
        elseFrame = elseFrame.pop();
      }
    }

    // Sync: use closure scope to access buffer. Async: bind context for proper this binding.
    this.compiler.emit.line(this.compiler.asyncMode ? '}).bind(context);' : '};');
    return elseFrame;
  }

  _emitLoopValueDeclarations(node, loopVars) {
    const buffer = this.compiler.buffer.currentBuffer;
    loopVars.forEach((name) => {
      this.compiler.emit.line(`runtime.declareBufferChannel(${buffer}, "${name}", "var", context, null);`);
    });
    if (node.loopRuntimeName) {
      this.compiler.emit.line(`runtime.declareBufferChannel(${buffer}, "${node.loopRuntimeName}", "var", context, null);`);
    }
  }

  _emitLoopValueAssignment(node, channelName, valueExpr) {
    this.compiler.emit.line(
      `${this.compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${channelName}', args: [${valueExpr}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), '${channelName}');`
    );
  }

  _emitLoopBindings(node, loopVars, loopIndex, loopLength, isLast, frame, useLoopValues) {
    if (useLoopValues) {
      this._emitLoopValueDeclarations(node, loopVars);
      if (node.loopRuntimeName) {
        this._emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast);
      }
      return;
    }
    this.compiler.emit.line(`runtime.setSyncFrameLoopBindings(frame, ${loopIndex}, ${loopLength}, ${isLast});`);
  }

  _emitLoopVarIterationBinding(node, varName, valueExpr, frame, useLoopValues) {
    if (useLoopValues) {
      this._emitLoopValueAssignment(node, varName, valueExpr);
      return;
    }

    this.compiler.emit.line(`frame.set("${varName}", ${valueExpr});`);
  }

  _emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast) {
    this.compiler.emit.line(
      `${this.compiler.buffer.currentBuffer}.add(runtime.setLoopValueBindings('${node.loopRuntimeName}', ${loopIndex}, ${loopLength}, ${isLast}, {lineno: ${node.lineno}, colno: ${node.colno}}), '${node.loopRuntimeName}');`
    );
  }

  _compileSyncLegacyCallbackLoopBindings(node, arr, i, len) {
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
      this.compiler.emit.line(`frame.set("loop.${b.name}", ${b.val});`);
    });
  }

  _compileSyncLegacyCallbackLoop(node, frame, parallel) {
    // This shares some code with the For tag, but not enough to
    // worry about. This iterates across an object asynchronously,
    // but not in parallel. (Legacy callback-based async loops)

    // ===== PASS 1: COMPILE BODY AND ELSE, COLLECT METADATA =====

    let i, len, arr, asyncMethod;

    i = this.compiler._tmpid();
    len = this.compiler._tmpid();
    arr = this.compiler._tmpid();
    asyncMethod = parallel ? 'asyncAll' : 'asyncEach';

    frame = frame.push();
    this.compiler.emit.line('frame = frame.push();');

    this.compiler.emit('let ' + arr + ' = runtime.fromIterator(');
    // Legacy async-loop source is scheduling input, not waited-root work.
    this.compiler.compileExpression(node.arr, frame, node.arr, true);
    this.compiler.emit.line(');');

    if (node.name instanceof nodes.Array) {
      const arrayLen = node.name.children.length;
      this.compiler.emit(`runtime.${asyncMethod}(${arr}, ${arrayLen}, function(`);

      node.name.children.forEach((name) => {
        this.compiler.emit(`${name.value},`);
      });

      this.compiler.emit(i + ',' + len + ',next) {');

      node.name.children.forEach((name) => {
        const id = name.value;
        frame.set(id, id);
        //this.compiler._addDeclaredVar(frame, id);
        this.compiler.emit.line(`frame.set("${id}", ${id});`);
      });
    } else {
      const id = node.name.value;
      this.compiler.emit.line(`runtime.${asyncMethod}(${arr}, 1, function(${id}, ${i}, ${len},next) {`);
      //this.compiler._addDeclaredVar(frame, id);
      this.compiler.emit.line('frame.set("' + id + '", ' + id + ');');
      frame.set(id, id);
    }

    this._compileSyncLegacyCallbackLoopBindings(node, arr, i, len);

    this.compiler.emit.withScopedSyntax(() => {
      if (parallel) {
        this.compiler.emit.managedBlock(frame, false, true, (managedFrame, buf) => {
          this.compiler.compile(node.body, managedFrame);

          this.compiler.emit.line('next(' + i + ',' + buf + ');');
        }, undefined, node.body);
      } else {
        this.compiler.compile(node.body, frame);

        this.compiler.emit.line('next(' + i + ');');
      }
    });

    const textResult = this.compiler._tmpid();
    this.compiler.emit.line('}, ' + this.compiler._makeCallback(textResult));
    this.compiler.emit.addScopeLevel();

    if (parallel) {
      this.compiler.emit.line(`${this.compiler.buffer.currentBuffer} += ${textResult};`);
    }

    // Compile else block
    if (node.else_) {
      this.compiler.emit.line('if (!' + arr + '.length) {');
      this.compiler.compile(node.else_, frame);
      this.compiler.emit.line('}');
    }

    frame = frame.pop();
    this.compiler.emit.line('frame = frame.pop();');
  }

  compileAsyncEach(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileFor(node, frame, { sequentialLoopBody: true });
      return;
    }
    this._compileSyncLegacyCallbackLoop(node, frame, false);
  }

  compileAsyncAll(node, frame) {
    if (this.compiler.asyncMode) {
      this._compileFor(node, frame, { sequentialLoopBody: false });
      return;
    }
    this._compileSyncLegacyCallbackLoop(node, frame, true);
  }
}

module.exports = CompileLoop;
