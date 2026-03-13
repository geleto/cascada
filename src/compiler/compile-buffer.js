/**
 * CompileBuffer - Output buffer management module
 *
 * Handles all output buffering operations for Cascada's deferred output system.
 * Manages buffer stacks, async buffer operations, and output command compilation.
 */

const nodes = require('../nodes');
const {
  validateOutputCommandScope,
  validateOutputObservationCall
} = require('./validation');
const OUTPUT_COMMAND_CLASS = {
  data: 'DataCommand',
  sink: 'SinkCommand',
  sequence: 'SequenceCallCommand',
  text: 'TextCommand',
  var: 'ValueCommand'
};
const DEFAULT_TEMPLATE_TEXT_OUTPUT = '__text__';

class CompileBuffer {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentBuffer = null;
    this.currentTextOutputVer = null;
    this.currentTextOutputName = DEFAULT_TEMPLATE_TEXT_OUTPUT;
    this.currentWaitedOutputName = null;
    // Temp value ids for split buffer writes (asyncAddToBufferBegin/End), supports nesting.
    // @otodo - evaluate these buffers, we shall be able to store
    // the values in the frame, the only probblem is when node.isAsync
    // is false in asyncMode, then new frame is not created?
  }

  // === BUFFER STACK MANAGEMENT ===

  /**
   * Initialize a managed scope-root buffer.
   *
   * @param {string} bufferId
   * @param {string|null} parentBufferId
   * @param {string} textOutputId
   */
  initManagedBuffer(bufferId, parentBufferId, textOutputId) {
    if (this.compiler.asyncMode) {
      const textId = textOutputId || `${bufferId}_textOutputVar`;
      const parentArg = parentBufferId || 'null';
      this.compiler.emit.line(`let ${bufferId} = runtime.createCommandBuffer(context, ${parentArg}, frame);`);
      if (!this.compiler.scriptMode) {
        this.compiler.emit.line(`let ${textId} = runtime.declareOutput(frame, ${bufferId}, "${this.currentTextOutputName}", "text", context, null);`);
      }
    } else {
      this.compiler.emit.line(`let ${bufferId} = "";`);
    }
  }

  /**
   * Get the current buffer identifier
   */
  getCurrentBuffer() {
    return this.currentBuffer;
  }

  // Scope current waited output binding for the emitted code region.
  // Pass null to explicitly compile without an own waited output.
  withOwnWaitedOutput(waitedOutputName, emitFunc) {
    const prevWaitedOutputName = this.currentWaitedOutputName;
    this.currentWaitedOutputName = waitedOutputName;
    try {
      return emitFunc();
    } finally {
      this.currentWaitedOutputName = prevWaitedOutputName;
    }
  }

  // Compile a region with no own waited output binding.
  skipOwnWaitedOutput(emitFunc) {
    return this.withOwnWaitedOutput(null, emitFunc);
  }

  _getBufferAccess() {
    // In async mode, buffers are CommandBuffer instances (use .output).
    return this.compiler.asyncMode ? `${this.currentBuffer}.output` : this.currentBuffer;
  }

  _emitTemplateTextCommandExpression(valueExpression, positionNode, normalizeArgs = false) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `new runtime.TextCommand({ handler: "${this.currentTextOutputName}", args: [${valueExpression}], normalizeArgs: ${normalizeArgs}, pos: {lineno: ${lineno}, colno: ${colno}} })`;
  }

  _emitPositionLiteral(positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `{lineno: ${lineno}, colno: ${colno}}`;
  }

  _compileCommandConstruction(node, frame) {
    const isCallNode = node.call instanceof nodes.FunCall;
    const staticPath = this.compiler.sequential._extractStaticPath(isCallNode ? node.call.name : node.call);
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is handler(...) or handler.command(...) or handler.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    const handler = staticPath[0];
    this.registerOutputUsage(frame, handler);
    const outputDecl = this.compiler.async._getDeclaredOutput(frame, handler);
    const outputType = node.outputType || (outputDecl ? outputDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;
    const isObservationCall = isCallNode &&
      !subpath &&
      (command === 'snapshot' || command === 'isError' || command === 'getError');

    validateOutputCommandScope(this.compiler, {
      frame,
      node,
      handler,
      outputType,
      hasOutputDecl: !!outputDecl,
      declaredInCurrentScope: !!(frame && frame.declaredOutputs && frame.declaredOutputs.has(handler)),
      isCallNode,
      isObservationCall
    });

    if (isObservationCall) {
      validateOutputObservationCall(this.compiler, { node, command, handler, outputType });
      if (command === 'snapshot') {
        this.compiler.emit(`new runtime.SnapshotCommand({ handler: '${handler}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      if (command === 'isError') {
        this.compiler.emit(`new runtime.IsErrorCommand({ handler: '${handler}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      this.compiler.emit(`new runtime.GetErrorCommand({ handler: '${handler}', pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    if (outputType === 'sequence') {
      if (isCallNode) {
        this.registerOutputMutation(frame, handler);
        if (!command) {
          this.compiler.fail('Invalid sequence command syntax: expected sequenceOutput.method(...)', node.lineno, node.colno, node);
        }
        this.compiler.emit(`new runtime.SequenceCallCommand({ handler: '${handler}', command: '${command}', `);
        if (subpath && subpath.length > 0) {
          this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
        }
        this.compiler.emit('args: ');
        this.compiler._compileAggregate(node.call.args, frame, '[', ']', false, true);
        this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }

      if (!command) {
        this.compiler.fail('Invalid sequence read syntax: expected sequenceOutput.path', node.lineno, node.colno, node);
      }
      this.compiler.emit(`new runtime.SequenceGetCommand({ handler: '${handler}', command: '${command}', `);
      if (subpath && subpath.length > 0) {
        this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }
      this.compiler.emit(`pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    const commandClass = OUTPUT_COMMAND_CLASS[outputType];
    if (!commandClass) {
      this.compiler.fail(
        `Unsupported output command target '${handler}'. Output commands must target declared outputs (data/text/var/sink/sequence).`,
        node.lineno,
        node.colno,
        node
      );
    }
    this.registerOutputMutation(frame, handler);

    this.compiler.emit(`new runtime.${commandClass}({ handler: '${handler}', `);
    if (command) {
      this.compiler.emit(`command: '${command}', `);
    }
    if (outputType === 'text') {
      this.compiler.emit('normalizeArgs: true, ');
    }
    if (outputType === 'sink' && subpath && subpath.length > 0) {
      this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
    }
    let argList = node.call.args;
    const asyncArgs = argList.isAsync;
    if (outputType === 'data') {
      // For data outputs, we create a new "virtual" AST for the arguments,
      // where the first argument is a path like "user.posts[0].title" that
      // needs to be converted into a JavaScript array like ['user', 'posts', 0, 'title'].
      const originalArgs = node.call.args.children;
      if (originalArgs.length === 0) {
        this.compiler.fail(`data command '${command}' requires at least a path argument.`, node.lineno, node.colno, node);
      }

      const pathArg = originalArgs[0];

      // Convert the path argument into a flat array of segments (Literal/Symbol)
      // @todo - move this to the transformer phase?
      // expected by the runtime data handlers.
      const pathNodeList = this.compiler._flattenPathToNodeList(pathArg);
      const dataPathNode = new nodes.Array(pathArg.lineno, pathArg.colno, pathNodeList.children);
      dataPathNode.isAsync = pathNodeList.isAsync;
      dataPathNode.mustResolve = true;

      // Our array node at the front.
      const newArgs = [dataPathNode, ...originalArgs.slice(1)];

      argList = new nodes.NodeList(node.call.args.lineno, node.call.args.colno, newArgs);
      argList.isAsync = asyncArgs;
    }

    this.compiler.emit('args: ');
    // Output commands are constructed with unresolved args; resolution/normalization
    // happens once in runtime right before command.apply().
    this.compiler._compileAggregate(argList, frame, '[', ']', false, true);
    this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
  }

  registerOutputUsage(frame, outputName) {
    let df = frame;
    while (df) {
      if (df.declaredOutputs && df.declaredOutputs.has(outputName)) {
        break;
      }
      // Outputs follow lexical scoping only (same as variables).
      df = df.parent;
    }

    let current = frame;
    while (current) {
      current.usedOutputs = current.usedOutputs || new Set();
      current.usedOutputs.add(outputName);
      if (current === df) {
        break;
      }
      current = current.parent;
    }
  }

  registerOutputMutation(frame, outputName) {
    let df = frame;
    while (df) {
      if (df.declaredOutputs && df.declaredOutputs.has(outputName)) {
        break;
      }
      // Outputs follow lexical scoping only (same as variables).
      df = df.parent;
    }

    let current = frame;
    while (current) {
      current.mutatedOutputs = current.mutatedOutputs || new Set();
      current.mutatedOutputs.add(outputName);
      if (current === df) {
        break;
      }
      current = current.parent;
    }
  }

  emitAddCommand(frame, outputName, valueExpr, positionNode = null, emitTextCommand = false) {
    this.registerOutputUsage(frame, outputName);
    if (emitTextCommand) {
      this.compiler.emit.line(
        `${this.currentBuffer}.addText(${valueExpr}, ${this._emitPositionLiteral(positionNode)}, "${outputName}")`
      );
      return;
    }
    this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${outputName}");`);
  }

  emitOwnWaitedConcurrencyResolve(frame, valueExpr, positionNode = null) {
    // Limited-loop timing hook:
    // Emit a WaitResolveCommand only when current compilation scope owns a
    // waited output (`__waited__*`). Outside that scope this is a no-op.
    //
    // This command is for iteration-completion timing only (used by waitApplied).
    // It must not change functional error propagation semantics.
    const waitedOutputName = this.currentWaitedOutputName;
    if (!this.compiler.asyncMode || !waitedOutputName) {
      return;
    }
    // Register as usage, not mutation: waited commands are bookkeeping and
    // should not participate in output-mutation wrapping decisions.
    this.registerOutputUsage(frame, waitedOutputName);
    // WaitResolveCommand resolves plain promises and aggregate roots; runtime
    // command apply intentionally swallows resolution errors (timing-only wait).
    this.compiler.emit.line(
      `${this.currentBuffer}.add(new runtime.WaitResolveCommand({ handler: "${waitedOutputName}", args: [${valueExpr}], pos: ${this._emitPositionLiteral(positionNode)} }), "${waitedOutputName}");`
    );
  }

  emitAddSequenceGet(frame, outputName, commandName, subpath, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceGet("${outputName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSequenceCall(frame, outputName, commandName, subpath, argsExpr, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.registerOutputMutation(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceCall("${outputName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${argsExpr}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSnapshot(frame, outputName, positionNode, asExpression = false) {
    this.registerOutputUsage(frame, outputName);
    const snapshotExpr = `${this.currentBuffer}.addSnapshot("${outputName}", ${this._emitPositionLiteral(positionNode)})`;
    if (asExpression) {
      return snapshotExpr;
    }
    this.compiler.emit(snapshotExpr);
  }

  // Emit an ordered raw snapshot command (no nested poison inspection).
  emitAddRawSnapshot(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addRawSnapshot("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddIsError(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addIsError("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddGetError(frame, outputName, positionNode) {
    this.registerOutputUsage(frame, outputName);
    this.compiler.emit(
      `${this.currentBuffer}.addGetError("${outputName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  // === HANDLER ANALYSIS ===

  /**
   * Recursively collect all output handlers written to within a node's subtree.
   * Used to determine which handlers need poison markers when branch is skipped.
   *
   * @param {Node} node - AST node to analyze
   * @returns {Set<string>} Set of handler names (template text handler, data, etc.)
   */
  // === OUTPUT COMMAND COMPILATION ===

  /**
   * Compile output command: handler.method(args)
   * Handles output variables (data/text/value/sink) and custom sinks
   */
  compileOutputCommand(node, frame) {
    // Preserve output routing in asyncAddToBuffer; validation remains in _compileCommandConstruction.
    const pathNode = node.call instanceof nodes.FunCall ? node.call.name : node.call;
    const handler = this.compiler.sequential._extractStaticPathRoot(pathNode);

    this.asyncAddValueToBuffer(node, frame, (resultVar, f) => {
      this.compiler.emit(`${resultVar} = `);
      this._compileCommandConstruction(node, f);
    }, node, handler);
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, outputName, emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      if (emitTextCommand) {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, outputName, valueId, positionNode, true);
        return;
      } else {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, outputName, valueId);
        return;
      }
    } else {
      this.compiler.emit(`${this.currentBuffer} += `);
      renderFunction.call(this.compiler, frame);
    }
    if (!this.compiler.asyncMode) {
      this.compiler.emit.line(';');
    }
  }

  /**
   * Add value to buffer (async mode with error handling)
   */
  asyncAddToBuffer(node, frame, renderFunction, positionNode = node, handlerName = null, outputName, emitTextCommand = false) {
    const returnId = this.compiler._tmpid();
    if (this.compiler.asyncMode) {
      this.compiler.emit.asyncClosureDepth++;
      frame = frame.push(false, false);
      this.registerOutputUsage(frame, outputName);
      // Observation commands are emitted through dedicated helpers like:
      this.registerOutputMutation(frame, outputName);

      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);
      this.compiler.emit.line(`${this.currentBuffer}.add((() => {`);
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(';');
      const valueExpr = emitTextCommand
        ? this._emitTemplateTextCommandExpression(returnId, positionNode)
        : returnId;
      this.compiler.emit.line(`return ${valueExpr};`);
      this.compiler.emit.line(`})(), "${outputName}");`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const asyncMetaArg = this.compiler.emit.getAsyncBlockArgs(node, frame);
      this.compiler.emit.line(`, runtime, frame, ${asyncMetaArg}, ${this.currentBuffer}, false, cb);`);

      frame = frame.pop();

    } else {
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      if (this.compiler.asyncMode) {
        this.emitAddCommand(frame, outputName, returnId, positionNode, emitTextCommand);
      } else {
        this.compiler.emit.line(`${this.currentBuffer} += ${returnId};`);
      }
    }
  }

  /**
   * Add a value to the buffer without producer slot-fill wrapping.
   * Use when value construction does not require addAsyncArgsCommand producer semantics.
   * The value is added directly to the current buffer (no extra async block).
   */
  asyncAddValueToBuffer(node, frame, renderFunction, positionNode = node, outputName, emitTextCommand = false) {
    void node;
    const returnId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${returnId};`);
    renderFunction.call(this.compiler, returnId, frame);
    this.compiler.emit.line(';');
    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(returnId, positionNode)
      : returnId;
    this.emitAddCommand(frame, outputName, valueExpr, positionNode, emitTextCommand);
  }

  /**
   * Begin async buffer addition (split pattern)
   */
  asyncAddToBufferScoped(
    node,
    frame,
    positionNode = node,
    handlerName = null,
    outputName,
    emitTextCommand = false,
    normalizeTextArgs = false,
    emitFunc = null,
    afterValueReady = null
  ) {
    void handlerName;
    if (!this.compiler.asyncMode) {
      this.compiler.emit(`${this.currentBuffer} += `);
      if (typeof emitFunc === 'function') {
        emitFunc(frame, null);
      }
      this.compiler.emit.line(';');
      return frame;
    }

    this.compiler.emit.line(`astate.asyncBlock(async (astate, frame) => {`);
    const valueId = this.compiler._tmpid();
    this.compiler.emit.line(`${this.currentBuffer}.add((() => {`);
    this.compiler.emit(`let ${valueId} = `);
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame.push(false, false);
    this.registerOutputUsage(innerFrame, outputName);
    this.registerOutputMutation(innerFrame, outputName);

    if (typeof emitFunc === 'function') {
      emitFunc(innerFrame, valueId);
    }

    this.compiler.emit.line(';');
    if (typeof afterValueReady === 'function') {
      afterValueReady(innerFrame, valueId);
    }

    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(valueId, positionNode, normalizeTextArgs)
      : valueId;
    this.compiler.emit.line(`return ${valueExpr};`);
    this.compiler.emit.line(`})(), "${outputName}");`);

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line('}');
    const asyncMetaArg = this.compiler.emit.getAsyncBlockArgs(node, innerFrame);
    this.compiler.emit.line(`, runtime, frame, ${asyncMetaArg}, ${this.currentBuffer}, false, cb);`);
    return innerFrame.pop();
  }

  /**
   * Compile a node inside an async buffer boundary.
   * Uses local save/restore of current buffer aliases instead of begin/end caller pairing.
   *
   * emitFunc may return:
   * - any value -> exposed as result
   * - { result, sequential } -> custom result + dynamic sequential flag for asyncBlockEnd
   */
  asyncBufferNode(node, frame, createScope = false, sequential = false, positionNode = node, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = this.currentBuffer;
      let nextFrame = this.compiler.emit.asyncBlockBegin(node, frame, createScope, positionNode);
      const nestedBufferId = this.compiler._tmpid();
      this.compiler.emit.line(`let ${nestedBufferId} = currentBuffer;`);
      const prevBuffer = this.currentBuffer;
      const prevTextOutput = this.currentTextOutputVer;
      const prevTextOutputName = this.currentTextOutputName;
      this.currentBuffer = nestedBufferId;
      this.currentTextOutputVer = null;

      let callbackValue;
      try {
        if (typeof emitFunc === 'function') {
          callbackValue = emitFunc(nextFrame, nestedBufferId, prevBuffer);
        }
      } finally {
        const dynamicSequential = callbackValue?.sequential ?? sequential;
        nextFrame = this.compiler.emit.asyncBlockEnd(
          node,
          nextFrame,
          createScope,
          dynamicSequential,
          positionNode,
          parentBufferArg,
          true,
          callbackValue?.hasConcurrencyLimit
        );
        this.currentBuffer = prevBuffer;
        this.currentTextOutputVer = prevTextOutput;
        this.currentTextOutputName = prevTextOutputName;
      }

      const result = callbackValue && typeof callbackValue === 'object' &&
        Object.prototype.hasOwnProperty.call(callbackValue, 'result')
        ? callbackValue.result
        : callbackValue;
      return { frame: nextFrame, result };
    }

    if (createScope) {
      let nextFrame = frame.push();
      this.compiler.emit.line('frame = frame.push();');
      const result = typeof emitFunc === 'function' ? emitFunc(nextFrame, this.currentBuffer, this.currentBuffer) : undefined;
      this.compiler.emit.line('frame = frame.pop();');
      return { frame: nextFrame.pop(), result };
    }

    const result = typeof emitFunc === 'function' ? emitFunc(frame, this.currentBuffer, this.currentBuffer) : undefined;
    return { frame, result };
  }
}

module.exports = CompileBuffer;
module.exports.DEFAULT_TEMPLATE_TEXT_OUTPUT = DEFAULT_TEMPLATE_TEXT_OUTPUT;

