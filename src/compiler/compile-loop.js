'use strict';

const nodes = require('../nodes');

class CompileLoop {
  constructor(compiler) {
    this.compiler = compiler;
  }

  compileWhile(node, frame) {
    if (!node.isAsync) {
      // Synchronous case: remains the same, no changes needed.
      // @todo - use compileFor for the loop variable, etc...
      this.compiler.emit('while (');
      this.compiler._compileExpression(node.cond, frame, false);
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

    const fakeForNode = new nodes.For(
      node.lineno, node.colno,
      new nodes.Symbol(node.lineno, node.colno, 'while_iterator_placeholder'), //arr
      new nodes.Symbol(node.lineno, node.colno, 'iterationCount'), //name
      node.body, //body
      null //else
    );
    fakeForNode.isAsync = true;
    fakeForNode.loopRuntimeName = node.loopRuntimeName;

    // Delegate to _compileFor, passing the condition node to be injected into the body
    this._compileFor(fakeForNode, frame, true, iteratorCompiler, node.cond);
  }

  compileFor(node, frame) {
    this._compileFor(node, frame, false);
  }

  _compileFor(node, frame, sequentialLoopBody = false, iteratorCompiler = null, whileConditionNode = null) {
    const useLoopValues = node.isAsync;
    if (useLoopValues && !node.loopRuntimeName) {
      this.compiler.fail(
        'Internal compiler error: missing loopRuntimeName for async loop value bindings.',
        node.lineno,
        node.colno,
        node
      );
    }
    const forResult = this.compiler.buffer.asyncBufferNode(node, frame, true, false, node.arr, (blockFrame) => {
      // Evaluate the array expression
      const arr = this.compiler._tmpid();

      if (iteratorCompiler) {
        // Gets the `{ "var": 1 }` style counts from compileWhile.
        iteratorCompiler(node.arr, blockFrame, arr);
      } else {
        // Loop source expression is control-flow input, not iteration-body work.
        // Keep it out of the loop body's own waited output tracking scope.
        this.compiler.buffer.skipOwnWaitedOutput(() => {
          this.compiler.emit(`let ${arr} = `);
          this.compiler._compileExpression(node.arr, blockFrame, false);
          this.compiler.emit.line(';');
        });
      }

      // Compile concurrentLimit expression if present
      const limitVar = node.concurrentLimit ? this.compiler._tmpid() : null;
      if (node.concurrentLimit) {
        // concurrentLimit expression is scheduler/control metadata for the loop.
        // It must not be tracked as iteration-body waited output work.
        this.compiler.buffer.skipOwnWaitedOutput(() => {
          this.compiler.emit(`let ${limitVar} = `);
          this.compiler._compileExpression(node.concurrentLimit, blockFrame, false);
          this.compiler.emit.line(';');
        });
      }

      // Determine loop variable names
      const loopVars = [];
      const registerLoopVarBinding = (name) => {
        if (node.isAsync && useLoopValues) {
          return;
        }
        blockFrame.set(name, name);
        if (node.isAsync) {
          this.compiler._addDeclaredVar(blockFrame, name);
        }
      };

      if (node.name instanceof nodes.Array) {
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

      const bodyHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.body, blockFrame) : null;

      //compile the loop body function
      const hasConcurrentLimit = Boolean(node.concurrentLimit);
      const bodyFrame = this._compileLoopBody(
        node,
        blockFrame,
        arr,
        loopVars,
        sequentialLoopBody,
        hasConcurrentLimit,
        whileConditionNode,
        useLoopValues
      );
      const bodyWriteCounts = bodyFrame.writeCounts;
      if (bodyWriteCounts) {
        // @todo - in the future will require writes+reads to be sequential,
        // update _compileLoopBody too as it handles sequential differently
        sequentialLoopBody = true;
      }

      // Compile else block and collect metadata
      let elseFuncId = 'null';
      let elseWriteCounts = null;
      let elseHandlers = null;

      if (node.else_) {
        elseFuncId = this.compiler._tmpid();
        this.compiler.emit(`let ${elseFuncId} = `);

        const elseFrame = this._compileLoopElse(node, blockFrame, sequentialLoopBody);

        // Collect metadata from else compilation
        elseWriteCounts = this.compiler.async.countsTo1(elseFrame.writeCounts);
        elseHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.else_, blockFrame) : null;
      }

      // Set up loop frame with combined write counts for mutual exclusion
      // This ensures the loop frame expects writes from either body OR else, not both
      if (node.isAsync) {
        const combinedWriteCounts = this.compiler.async._combineWriteCounts([
          bodyWriteCounts ? this.compiler.async.countsTo1(bodyWriteCounts) : null,
          elseWriteCounts
        ].filter(Boolean));

        if (combinedWriteCounts && Object.keys(combinedWriteCounts).length > 0) {
          blockFrame.writeCounts = combinedWriteCounts;
        }
      }

      // Build asyncOptions code string if in async mode
      let asyncOptionsCode = 'null';
      if (node.isAsync) {
        asyncOptionsCode = `{
          sequential: ${sequentialLoopBody},
          bodyWriteCounts: ${JSON.stringify(this.compiler.async.countsTo1(bodyWriteCounts) || {})},
          bodyHandlers: ${JSON.stringify(bodyHandlers ? Array.from(bodyHandlers) : [])},
          elseWriteCounts: ${JSON.stringify(elseWriteCounts || {})},
          elseHandlers: ${JSON.stringify(elseHandlers ? Array.from(elseHandlers) : [])},
          concurrentLimit: ${node.concurrentLimit ? limitVar : 'null'},
          errorContext: { lineno: ${node.lineno}, colno: ${node.colno}, errorContextString: "${this.compiler._generateErrorContext(node)}", path: context.path }
        }`;
      }

      // Call the runtime iterate loop function
      // For sync loops: not awaited (fire-and-forget Promise). iterate() executes synchronously
      // internally (no awaits hit) and executes else block before returning.
      this.compiler.emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, frame, ${node.isAsync ? this.compiler.buffer.currentBuffer : 'null'}, [`);
      loopVars.forEach((varName, index) => {
        if (index > 0) {
          this.compiler.emit(', ');
        }
        this.compiler.emit(`"${varName}"`);
      });
      this.compiler.emit(`], ${asyncOptionsCode});`);

      // End buffer block for the node (using node.arr position)
      /*if (iteratorCompiler || frame.writeCounts) {
        // condition and loop body counts are a single unit of work and
        // are isolated to not affect the outer frame write counts
        // All writes will be released by finalizeLoopWrites
        // Cap the outer frame's writeCounts to 1 per variable
        // The loop as a whole counts as 1 write to the parent, regardless of iterations
        // The capping happens per loop frame before popping, and the parent naturally accumulates these capped counts.
        frame.writeCounts = this.compiler.async.countsTo1(frame.writeCounts);
      }*/
      // else - all write counts are from the loop body and are 1 anyway (counts are counted inside (>1) and outside (=1))
    });

    frame = forResult.frame;
  }

  _compileLoopBody(node, frame, arr, loopVars, sequentialLoopBody, hasConcurrencyLimit = false, whileConditionNode = null, useLoopValues = false) {
    const bodyCreatesScope = this.compiler.scriptMode || this.compiler.asyncMode;
    if (node.isAsync) {
      this.compiler.emit('(async function(');//@todo - think this over, does it need async block?
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

    // Use node.body as the position for the inner buffer block (loop body execution)
    if (node.isAsync) {
      // when sequential, the loop body IIFE will await all closures (waitAllClosures)
      // we return the IIFE promise so that awaiting the loop body will wait for all closures
      this.compiler.emit('return ');
    }
    const bodyResult = this.compiler.buffer.asyncBufferNode(node, frame, bodyCreatesScope, false, node.body, (bodyFrame) => {
      const limitedWaitedOutputName = hasConcurrencyLimit ? `__waited__${this.compiler._tmpid()}` : null;
      if (useLoopValues) {
        loopVars.forEach((name) => {
          this._declareLoopValueOutput(bodyFrame, name, node);
        });
        // Internal metadata binding for rewritten loop symbol (e.g. loop#3).
        this._declareLoopValueOutput(bodyFrame, node.loopRuntimeName, node, undefined, true);
      }
      if (limitedWaitedOutputName) {
        this.compiler._addDeclaredOutput(bodyFrame, limitedWaitedOutputName, 'value', null, node);
        this.compiler.emit.line(`runtime.declareOutput(frame, ${this.compiler.buffer.currentBuffer}, "${limitedWaitedOutputName}", "value", context, null);`);
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
        } else if (node.name instanceof nodes.Array) {
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
          const varName = node.name.value;
          this._emitLoopVarIterationBinding(node, varName, varName, bodyFrame, useLoopValues);
        }

        // Compile Loop Condition (if while loop)
        // We do this after destructuring but before body, in the same async block
        let preBodyWriteCounts = null;
        let skipBranchWritesPos = -1;
        let catchPoisonPos = null;
        let whileCondId;

        if (whileConditionNode) {
          whileCondId = this.compiler._tmpid();

          if (node.isAsync) {
            this.compiler.emit(`let ${whileCondId};`);
            this.compiler.emit('try {');
            this.compiler.emit(`${whileCondId} = `);
            // While condition is control-flow gating and excluded from waited output tracking.
            this.compiler.buffer.skipOwnWaitedOutput(() => {
              this.compiler._compileAwaitedExpression(whileConditionNode, bodyFrame, false);
            });
            this.compiler.emit.line(';');
            const whileErrorContext = this.compiler._createErrorContext(node, whileConditionNode);
            this.compiler.emit('} catch (e) {');
            this.compiler.emit(`  const contextualError = runtime.isPoisonError(e) ? e : runtime.handleError(e, ${whileErrorContext.lineno}, ${whileErrorContext.colno}, "${whileErrorContext.errorContextString}", context.path);`);
            catchPoisonPos = this.compiler.codebuf.length;
            this.compiler.emit.line(''); // Placeholder for poison injection

            // We set whileCond to false so the loop logic (if !whileCond) below triggers termination
            // But first we ensure 'return runtime.STOP_WHILE' is reached to stop iteration cleanly
            this.compiler.emit(`  ${whileCondId} = false;`);
            this.compiler.emit('}');
          } else {
            this.compiler.emit(`const ${whileCondId} = `);
            // While condition is control-flow gating and excluded from waited output tracking.
            this.compiler.buffer.skipOwnWaitedOutput(() => {
              this.compiler._compileAwaitedExpression(whileConditionNode, bodyFrame, false);
            });
            this.compiler.emit.line(';');
          }

          this.compiler.emit(`if (!${whileCondId}) {`);
          skipBranchWritesPos = this.compiler.codebuf.length;
          this.compiler.emit.line(''); // Placeholder for skipBranchWrites
          this.compiler.emit.line('  return runtime.STOP_WHILE;');
          this.compiler.emit.line('}');

          // Snapshot writes including condition and destructuring
          preBodyWriteCounts = bodyFrame.writeCounts ? { ...bodyFrame.writeCounts } : {};
        }

        // Compile the loop body with the updated frame
        this.compiler.emit.withScopedSyntax(() => {
          this.compiler.compile(node.body, bodyFrame);
        });

        if (whileConditionNode) {
          const bodyOnlyWrites = this._diffWriteCounts(bodyFrame.writeCounts, preBodyWriteCounts);
          if (Object.keys(bodyOnlyWrites).length > 0) {
            this.compiler.emit.insertLine(skipBranchWritesPos, `  frame.skipBranchWrites(${JSON.stringify(bodyOnlyWrites)});`);
          }

          if (catchPoisonPos !== null) {
            const totalWrites = this.compiler.async.countsTo1(bodyFrame.writeCounts);
            if (totalWrites && Object.keys(totalWrites).length > 0) {
              this.compiler.emit.insertLine(catchPoisonPos, `  frame.poisonBranchWrites(contextualError, ${JSON.stringify(totalWrites)});`);
            }
            const bodyHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.body, bodyFrame) : null;
            if (bodyHandlers && bodyHandlers.size > 0) {
              for (const handler of bodyHandlers) {
                this.compiler.emit.insertLine(catchPoisonPos, `  ${this.compiler.buffer.currentBuffer}.addPoison(contextualError, "${handler}");`);
              }
            }
          }
        }

        // Collect metadata from body compilation
        if (bodyFrame.writeCounts || sequentialLoopBody) {
          //@todo - in the future will require writes+reads to be sequential
          //only writes - will save the last write to the loop frame
        }

        const shouldAwaitLoopBody = Boolean(bodyFrame.writeCounts) || sequentialLoopBody || hasConcurrencyLimit;
        return {
          result: bodyFrame,
          sequential: shouldAwaitLoopBody,
          hasConcurrencyLimit: shouldAwaitLoopBody
        };
      };

      if (!limitedWaitedOutputName) {
        return compileIterationBody();
      }

      return this.compiler.buffer.withOwnWaitedOutput(limitedWaitedOutputName, compileIterationBody);
    });
    const bodyFrame = bodyResult.result;

    // Close the loop body function
    this.compiler.emit.line(node.isAsync ? '}).bind(context);' : '};');

    return bodyFrame;
  }

  _compileLoopElse(node, frame, sequential) {
    const awaitSequentialElse = false;//I think awaiting it like loop body is not needed
    const elseCreatesScope = this.compiler.scriptMode || this.compiler.asyncMode;

    if (node.isAsync) {
      this.compiler.emit('(async function() {');
      // must return the promise from its async block
      // which when sequential will wait for all closures
      if (awaitSequentialElse) {
        this.compiler.emit('return ');
      }
    } else {
      this.compiler.emit('function() {');
    }

    // Use node.else_ as position for the else block buffer
    const elseResult = this.compiler.buffer.asyncBufferNode(
      node,
      frame,
      elseCreatesScope,
      sequential && awaitSequentialElse,
      node.else_,
      (elseFrame) => {
        this.compiler.compile(node.else_, elseFrame);
        return elseFrame;
      }
    );
    const elseFrame = elseResult.result;

    // Sync: use closure scope to access buffer. Async: bind context for proper this binding.
    this.compiler.emit.line(node.isAsync ? '}).bind(context);' : '};');
    return elseFrame;
  }

  _declareLoopValueOutput(frame, name, _node, runtimeName, internal = false) {
    if (this.compiler.scriptMode && this.compiler.isReservedDeclarationName(name)) {
      this.compiler.fail(
        `Identifier '${name}' is reserved and cannot be used as a variable or output name.`,
        _node && _node.lineno,
        _node && _node.colno,
        _node || undefined
      );
    }
    frame.declaredOutputs = frame.declaredOutputs || new Map();
    const decl = {
      type: 'value',
      initializer: null,
      internal
    };
    if (runtimeName && runtimeName !== name) {
      // Lexical name can differ from runtime output key (notably loop aliasing).
      decl.runtimeName = runtimeName;
    }
    frame.declaredOutputs.set(name, decl);
  }

  _emitLoopValueDeclarations(node, loopVars) {
    const buffer = this.compiler.buffer.currentBuffer;
    loopVars.forEach((name) => {
      this.compiler.emit.line(`runtime.declareOutput(frame, ${buffer}, "${name}", "value", context, null);`);
    });
    this.compiler.emit.line(`runtime.declareOutput(frame, ${buffer}, "${node.loopRuntimeName}", "value", context, null);`);
  }

  _emitLoopValueAssignment(node, outputName, valueExpr, frame) {
    this.compiler.buffer.asyncAddValueToBuffer(node, frame, (resultVar) => {
      this.compiler.emit(
        `${resultVar} = new runtime.ValueCommand({ handler: '${outputName}', args: [${valueExpr}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} })`
      );
    }, node, outputName);
  }

  _emitLoopBindings(node, loopVars, loopIndex, loopLength, isLast, frame, useLoopValues) {
    if (useLoopValues) {
      this._emitLoopValueDeclarations(node, loopVars);
      this._emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast, frame);
      return;
    }
    this.compiler.emit.line(`runtime.setLoopBindings(frame, ${loopIndex}, ${loopLength}, ${isLast});`);
  }

  _emitLoopVarIterationBinding(node, varName, valueExpr, frame, useLoopValues) {
    if (useLoopValues) {
      this._emitLoopValueAssignment(node, varName, valueExpr, frame);
      return;
    }

    this.compiler.emit.line(`frame.set("${varName}", ${valueExpr});`);
    if (node.isAsync) {
      frame.set(varName, valueExpr);
      this.compiler._addDeclaredVar(frame, varName);
    }
  }

  _emitLoopMetadataValueBinding(node, loopIndex, loopLength, isLast, frame) {
    this.compiler.buffer.asyncAddValueToBuffer(node, frame, (resultVar) => {
      this.compiler.emit(
        `${resultVar} = runtime.setLoopValueBindings('${node.loopRuntimeName}', ${loopIndex}, ${loopLength}, ${isLast}, {lineno: ${node.lineno}, colno: ${node.colno}})`
      );
    }, node, node.loopRuntimeName);
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
      this.compiler.emit.line(`frame.set("loop.${b.name}", ${b.val});`);
    });
  }

  _compileAsyncLoop(node, frame, parallel) {
    if (node.isAsync) {
      this._compileFor(node, frame, !parallel);
      return;
    }
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
    this.compiler._compileExpression(node.arr, frame, false);
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

    this._compileAsyncLoopBindings(node, arr, i, len);

    // Compile loop body and collect metadata
    let _bodyWriteCounts; // eslint-disable-line no-unused-vars
    let bodyHandlers = null; // eslint-disable-line no-unused-vars

    this.compiler.emit.withScopedSyntax(() => {
      if (parallel) {
        this.compiler.emit.managedBlock(frame, false, true, (managedFrame, buf) => {
          this.compiler.compile(node.body, managedFrame);

          // Collect metadata from body compilation
          _bodyWriteCounts = managedFrame.writeCounts;
          bodyHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.body, frame) : null;

          this.compiler.emit.line('next(' + i + ',' + buf + ');');
          if (this.compiler.asyncMode) {
            this.compiler.emit.line(`${buf}.markFinishedAndPatchLinks();`);
          }
        });
      } else {
        this.compiler.compile(node.body, frame);

        // Collect metadata from body compilation
        _bodyWriteCounts = frame.writeCounts;
        bodyHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.body, frame) : null;

        this.compiler.emit.line('next(' + i + ');');
      }
    });

    const output = this.compiler._tmpid();
    this.compiler.emit.line('}, ' + this.compiler._makeCallback(output));
    this.compiler.emit.addScopeLevel();

    if (parallel) {
      if (this.compiler.asyncMode) {
        //non-async node but in async mode -> emit a buffered TextCommand through CompileBuffer
        this.compiler.buffer.addToBuffer(node, frame, function () {
          this.emit(output);
        }, node, this.compiler.buffer.currentTextOutputName, true);
      } else {
        this.compiler.emit.line(`${this.compiler.buffer.currentBuffer} += ${output};`);
      }
    }

    // Compile else block and collect metadata
    let _elseWriteCounts2;
    let elseHandlers = null;

    if (node.else_) {
      this.compiler.emit.line('if (!' + arr + '.length) {');
      this.compiler.compile(node.else_, frame);

      // Collect metadata from else compilation
      _elseWriteCounts2 = frame.writeCounts; // eslint-disable-line no-unused-vars
      elseHandlers = node.isAsync ? this.compiler.buffer.collectBranchHandlers(node.else_, frame) : null; // eslint-disable-line no-unused-vars

      this.compiler.emit.line('}');
    }

    // Combine handlers from both body and else (for consistency with _compileFor)
    // Modern async loops use _compileFor via the delegation at line 1007
    // They delegate to _compileFor when node.isAsync is true (line 1007)

    frame = frame.pop();
    this.compiler.emit.line('frame = frame.pop();');
  }

  compileAsyncEach(node, frame) {
    this._compileAsyncLoop(node, frame, false);
  }

  compileAsyncAll(node, frame) {
    this._compileAsyncLoop(node, frame, true);
  }


  _diffWriteCounts(total, subset) {
    const diff = {};
    if (!total) return diff;
    for (const k in total) {
      const t = total[k];
      const s = subset ? subset[k] || 0 : 0;
      if (t > s) {
        diff[k] = t - s;
      }
    }
    return diff;
  }
}

module.exports = CompileLoop;
