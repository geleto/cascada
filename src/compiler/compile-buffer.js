/**
 * CompileBuffer - channel buffer management module
 *
 * Handles all channel buffering operations for Cascada's deferred output system.
 * Manages buffer stacks, async buffer operations, and channel command compilation.
 */

const nodes = require('../nodes');
const {
  validateChannelObservationCall,
  trackCompileTimeFrameDepth,
  validateCompileTimeFrameBalance
} = require('./validation');
const CHANNEL_COMMAND_CLASS = {
  data: 'DataCommand',
  sink: 'SinkCommand',
  sequence: 'SequenceCallCommand',
  text: 'TextCommand',
  var: 'VarCommand'
};
const DEFAULT_TEMPLATE_TEXT_CHANNEL = '__text__';

class CompileBuffer {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentBuffer = null;
    this.currentTextChannelVar = null;
    this.currentTextChannelName = DEFAULT_TEMPLATE_TEXT_CHANNEL;
    this.currentWaitedChannelName = null;
    this.currentWaitedOwnerBuffer = null;
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
   * @param {string} textChannelVar
   */
  initManagedBuffer(bufferId, parentBufferId, textChannelVar, linkedChannels = null) {
    if (this.compiler.asyncMode) {
      const textId = textChannelVar || `${bufferId}_textChannelVar`;
      const parentArg = parentBufferId || 'null';
      const linkedChannelsArg = Array.isArray(linkedChannels) && linkedChannels.length > 0
        ? JSON.stringify(linkedChannels)
        : 'null';
      this.compiler.emit.line(`let ${bufferId} = runtime.createCommandBuffer(context, ${parentArg}, frame, ${linkedChannelsArg}, ${parentArg});`);
      if (!this.compiler.scriptMode) {
        this.compiler.emit.line(`let ${textId} = runtime.declareChannel(frame, ${bufferId}, "${this.currentTextChannelName}", "text", context, null);`);
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

  // Scope current waited channel binding for the emitted code region.
  // Pass null to explicitly compile without an own waited channel.
  withOwnWaitedChannel(waitedChannelName, emitFunc) {
    const prevWaitedChannelName = this.currentWaitedChannelName;
    const prevWaitedOwnerBuffer = this.currentWaitedOwnerBuffer;
    this.currentWaitedChannelName = waitedChannelName;
    this.currentWaitedOwnerBuffer = waitedChannelName ? this.currentBuffer : null;
    try {
      return emitFunc();
    } finally {
      this.currentWaitedChannelName = prevWaitedChannelName;
      this.currentWaitedOwnerBuffer = prevWaitedOwnerBuffer;
    }
  }

  // Compile a region with no own waited channel binding.
  skipOwnWaitedChannel(emitFunc) {
    return this.withOwnWaitedChannel(null, emitFunc);
  }

  _getBufferAccess() {
    // In async mode, buffers are CommandBuffer instances (use .output).
    return this.compiler.asyncMode ? `${this.currentBuffer}.output` : this.currentBuffer;
  }

  _emitTemplateTextCommandExpression(valueExpression, positionNode, normalizeArgs = false) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `new runtime.TextCommand({ channelName: "${this.currentTextChannelName}", args: [${valueExpression}], normalizeArgs: ${normalizeArgs}, pos: {lineno: ${lineno}, colno: ${colno}} })`;
  }

  _emitPositionLiteral(positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `{lineno: ${lineno}, colno: ${colno}}`;
  }

  emitFinishedTextBoundaryPromise(bufferExpr, textChannelName, positionNode, transformExpr = null, addToCurrentWaited = false) {
    const posExpr = this._emitPositionLiteral(positionNode);
    const textPromiseId = this.compiler._tmpid();
    const finalExpr = `${bufferExpr}.getChannel("${textChannelName}").finalSnapshot()`;
    const chainedExpr = transformExpr
      ? `Promise.resolve(${finalExpr}).then((value) => ${transformExpr.replace(/__VALUE__/g, 'value')})`
      : finalExpr;

    this.compiler.emit.line(`${bufferExpr}.markFinishedAndPatchLinks();`);
    this.compiler.emit.line(`const ${textPromiseId} = ${chainedExpr};`);
    if (addToCurrentWaited && this.compiler.asyncMode && this.currentWaitedChannelName) {
      this.compiler.emit.line(
        `${this.currentWaitedOwnerBuffer}.add(new runtime.WaitResolveCommand({ channelName: "${this.currentWaitedChannelName}", args: [${textPromiseId}], pos: ${posExpr} }), "${this.currentWaitedChannelName}");`
      );
    }
    return textPromiseId;
  }

  _compileCommandConstruction(node, frame) {
    const isCallNode = node.call instanceof nodes.FunCall;
    const staticPath = this.compiler.sequential._extractStaticPath(isCallNode ? node.call.name : node.call);
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is channel(...) or channel.command(...) or channel.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    const channelName = staticPath[0];
    const channelDecl = this.compiler.analysis.findDeclaration(node._analysis, channelName);
    const channelType = node.channelType || (channelDecl ? channelDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const subpath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;
    const isObservationCall = isCallNode &&
      !subpath &&
      (command === 'snapshot' || command === 'isError' || command === 'getError');

    if (isObservationCall) {
      validateChannelObservationCall(this.compiler, { node, command, channelName, channelType });
      if (command === 'snapshot') {
        this.compiler.emit(`new runtime.SnapshotCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      if (command === 'isError') {
        this.compiler.emit(`new runtime.IsErrorCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      this.compiler.emit(`new runtime.GetErrorCommand({ channelName: '${channelName}', pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    if (channelType === 'sequence') {
      if (isCallNode) {
        if (!command) {
          this.compiler.fail('Invalid sequence command syntax: expected sequenceChannel.method(...)', node.lineno, node.colno, node);
        }
        this.compiler.emit(`new runtime.SequenceCallCommand({ channelName: '${channelName}', command: '${command}', `);
        if (subpath && subpath.length > 0) {
          this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
        }
        this.compiler.emit('args: ');
        this.compiler._compileAggregate(node.call.args, frame, '[', ']', false, true);
        this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }

      if (!command) {
        this.compiler.fail('Invalid sequence read syntax: expected sequenceChannel.path', node.lineno, node.colno, node);
      }
      this.compiler.emit(`new runtime.SequenceGetCommand({ channelName: '${channelName}', command: '${command}', `);
      if (subpath && subpath.length > 0) {
        this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
      }
      this.compiler.emit(`pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    const commandClass = CHANNEL_COMMAND_CLASS[channelType];
    if (!commandClass) {
      this.compiler.fail(
        `Compiler error: analysis did not resolve a declared channel target for '${channelName}'.`,
        node.lineno,
        node.colno,
        node
      );
    }
    this.compiler.emit(`new runtime.${commandClass}({ channelName: '${channelName}', `);
    if (command) {
      this.compiler.emit(`command: '${command}', `);
    }
    if (channelType === 'text') {
      this.compiler.emit('normalizeArgs: true, ');
    }
    if (channelType === 'sink' && subpath && subpath.length > 0) {
      this.compiler.emit(`subpath: ${JSON.stringify(subpath)}, `);
    }
    let argList = node.call.args;
    const asyncArgs = argList.isAsync;
    if (channelType === 'data') {
      // For data channels, we create a new "virtual" AST for the arguments,
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
    // Channel commands are constructed with unresolved args; resolution/normalization
    // happens once in runtime right before command.apply().
    this.compiler._compileAggregate(argList, frame, '[', ']', false, true);
    this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
  }

  emitAddCommand(frame, channelName, valueExpr, positionNode = null, emitTextCommand = false) {
    if (emitTextCommand) {
      this.compiler.emit.line(
        `${this.currentBuffer}.addText(${valueExpr}, ${this._emitPositionLiteral(positionNode)}, "${channelName}")`
      );
      return;
    }
    this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${channelName}");`);
  }

  emitOwnWaitedConcurrencyResolve(frame, valueExpr, positionNode = null) {
    // Waited-loop bookkeeping: in __waited__ scope, root work contributes one
    // timing-only WaitResolveCommand to the owning iteration buffer's channel.
    const waitedChannelName = this.currentWaitedChannelName;
    const waitedOwnerBuffer = this.currentWaitedOwnerBuffer || this.currentBuffer;
    if (!this.compiler.asyncMode || !waitedChannelName) {
      return;
    }
    // Register as usage, not mutation: __waited__ tracks completion, not output state.
    this.compiler.emit.line(
      `${waitedOwnerBuffer}.add(new runtime.WaitResolveCommand({ channelName: "${waitedChannelName}", args: [${valueExpr}], pos: ${this._emitPositionLiteral(positionNode)} }), "${waitedChannelName}");`
    );
  }

  emitAddSequenceGet(frame, channelName, commandName, subpath, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceGet("${channelName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSequenceCall(frame, channelName, commandName, subpath, argsExpr, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceCall("${channelName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${argsExpr}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSnapshot(frame, channelName, positionNode, asExpression = false) {
    const snapshotExpr = `${this.currentBuffer}.addSnapshot("${channelName}", ${this._emitPositionLiteral(positionNode)})`;
    if (asExpression) {
      return snapshotExpr;
    }
    this.compiler.emit(snapshotExpr);
  }

  // Emit an ordered raw snapshot command (no nested poison inspection).
  emitAddRawSnapshot(frame, channelName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addRawSnapshot("${channelName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddIsError(frame, channelName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addIsError("${channelName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddGetError(frame, channelName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addGetError("${channelName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  // === HANDLER ANALYSIS ===

  /**
   * Recursively collect all channels written to within a node's subtree.
   * Used to determine which channels need poison markers when branch is skipped.
   *
   * @param {Node} node - AST node to analyze
   * @returns {Set<string>} Set of channel names (template text channel, data, etc.)
   */
  // === OUTPUT COMMAND COMPILATION ===

  /**
   * Compile channel command: channel.method(args)
   * Handles declared channels (data/text/value/sink) and custom sinks
   */
  compileChannelCommand(node, frame) {
    // Preserve channel routing in asyncAddToBuffer; validation remains in _compileCommandConstruction.
    const pathNode = node.call instanceof nodes.FunCall ? node.call.name : node.call;
    const channelName = this.compiler.sequential._extractStaticPathRoot(pathNode);

    this.asyncAddValueToBuffer(node, frame, (resultVar, f) => {
      this.compiler.emit(`${resultVar} = `);
      this._compileCommandConstruction(node, f);
    }, node, channelName);
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, channelName, emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      if (emitTextCommand) {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, channelName, valueId, positionNode, true);
        return;
      } else {
        const valueId = this.compiler._tmpid();
        this.compiler.emit(`let ${valueId} = `);
        renderFunction.call(this.compiler, frame);
        this.compiler.emit.line(';');
        this.emitAddCommand(frame, channelName, valueId);
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
   * Emit a producer-slot async block invocation and enqueue its result on the
   * current text channel.
   *
   * This is currently used by async block/super/inheritance invocation sites.
   * Those sites already own their internal composition boundary and return a
   * final text promise, but they still rely on this wrapper's producer-slot
   * behavior and local emitted scope. Keep this helper dedicated to block-style
   * invocation rather than routing them through generic async value helpers.
   */
  asyncAddBlockInvocationToBuffer(node, frame, renderFunction, positionNode = node, targetChannelName) {
    const returnId = this.compiler._tmpid();
    if (this.compiler.asyncMode) {
      this.compiler.emit.asyncClosureDepth++;
      frame = frame.push(false, false);

      this.compiler.emit.line(`astate.asyncBlock(async (astate, frame)=>{`);
      this.compiler.emit.line(`${this.currentBuffer}.add((() => {`);
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(';');
      const valueExpr = this._emitTemplateTextCommandExpression(returnId, positionNode);
      this.compiler.emit.line(`return ${valueExpr};`);
      this.compiler.emit.line(`})(), "${targetChannelName}");`);

      this.compiler.emit.asyncClosureDepth--;
      this.compiler.emit.line('}');
      const asyncMetaArg = this.compiler.emit.getAsyncBlockArgs(node, frame);
      this.compiler.emit.line(`, runtime, frame, ${asyncMetaArg}, ${this.currentBuffer}, false, cb);`);

      frame = frame.pop();

    } else {
      this.compiler.emit.line(`let ${returnId};`);
      renderFunction.call(this.compiler, returnId, frame);
      this.compiler.emit.line(`${this.currentBuffer} += ${returnId};`);
    }
  }

  /**
   * Add a value to the buffer without producer slot-fill wrapping.
   * Use when value construction does not require addAsyncArgsCommand producer semantics.
   * The value is added directly to the current buffer (no extra async block).
   */
  asyncAddValueToBuffer(node, frame, renderFunction, positionNode = node, channelName, emitTextCommand = false) {
    void node;
    const returnId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${returnId};`);
    renderFunction.call(this.compiler, returnId, frame);
    this.compiler.emit.line(';');
    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(returnId, positionNode)
      : returnId;
    this.emitAddCommand(frame, channelName, valueExpr, positionNode, emitTextCommand);
  }

  /**
   * Begin async buffer addition (split pattern)
   */
  asyncAddToBufferScoped(
    node,
    frame,
    positionNode = node,
    channelName = null,
    targetChannelName,
    emitTextCommand = false,
    normalizeTextArgs = false,
    emitFunc,
    afterValueReady = null
  ) {
    void channelName;
    if (!this.compiler.asyncMode) {
      this.compiler.emit(`${this.currentBuffer} += `);
      emitFunc(frame, null);
      this.compiler.emit.line(';');
      return frame;
    }

    const parentBufferExpr = this.currentBuffer;
    const asyncPromiseId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${asyncPromiseId} = astate.asyncBlock(async (astate, frame, currentBuffer, parentBuffer) => {`);
    const valueId = this.compiler._tmpid();
    this.compiler.emit.asyncClosureDepth++;

    const innerFrame = frame.push(false, false);
    const prevBuffer = this.currentBuffer;
    const prevTextChannelVar = this.currentTextChannelVar;
    this.currentBuffer = 'parentBuffer';
    this.currentTextChannelVar = null;
    this.compiler.emit(`let ${valueId} = `);

    emitFunc(innerFrame, valueId);

    this.compiler.emit.line(';');
    if (typeof afterValueReady === 'function') {
      afterValueReady(innerFrame, valueId);
    }

    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(valueId, positionNode, normalizeTextArgs)
      : valueId;
    this.compiler.emit.line(`currentBuffer.add(${valueExpr}, "${targetChannelName}");`);
    if (emitTextCommand) {
      this.compiler.emit.line(`currentBuffer.markFinishedAndPatchLinks();`);
    }
    this.currentBuffer = prevBuffer;
    this.currentTextChannelVar = prevTextChannelVar;

    this.compiler.emit.asyncClosureDepth--;
    this.compiler.emit.line('}');
    const asyncMetaArg = this.compiler.emit.getAsyncBlockArgs(node, innerFrame);
    this.compiler.emit.line(`, runtime, frame, ${asyncMetaArg}, ${parentBufferExpr}, true, cb);`);
    if (emitTextCommand) {
      this.emitOwnWaitedConcurrencyResolve(frame, asyncPromiseId, positionNode);
    }
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
  /**
   * Emit a `runtime.runControlFlowBlock` call for control-flow nodes (if, switch).
   * Compared to `asyncBufferNode`, this does NOT wrap the branch bodies in their own
   * async blocks — the emitFunc is expected to compile branches synchronously.
   *
   * For non-async nodes falls through to a plain synchronous call (like asyncBufferNode).
   */
  runControlFlowBlockNode(node, frame, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = this.currentBuffer;
      const linkedChannelsArg = this.compiler.emit.getLinkedChannelsArg(node, frame);
      const trackAsSingleWaitedUnit = this.compiler.asyncMode && !!this.currentWaitedChannelName;
      const controlFlowWaitedChannelName = trackAsSingleWaitedUnit ? `__waited__${this.compiler._tmpid()}` : null;
      const controlFlowPromiseId = this.compiler._tmpid();

      this.compiler.emit(
        `let ${controlFlowPromiseId} = runtime.runControlFlowBlock(astate, ${parentBufferArg}, ${linkedChannelsArg}, frame, context, cb, async (astate, frame, currentBuffer) => {`
      );
      this.compiler.emit.asyncClosureDepth++;

      const newFrame = frame.push(false, false);
      trackCompileTimeFrameDepth(newFrame, frame);

      const prevBuffer = this.currentBuffer;
      const prevTextChannelVar = this.currentTextChannelVar;
      const prevTextChannelName = this.currentTextChannelName;
      const prevWaitedChannelName = this.currentWaitedChannelName;
      const prevWaitedOwnerBuffer = this.currentWaitedOwnerBuffer;
      this.currentBuffer = 'currentBuffer';
      if (trackAsSingleWaitedUnit) {
        this.currentWaitedChannelName = controlFlowWaitedChannelName;
        this.currentWaitedOwnerBuffer = 'currentBuffer';
        this.compiler.emit.line(`runtime.declareChannel(frame, currentBuffer, "${controlFlowWaitedChannelName}", "var", context, null);`);
      }

      const callbackValue = emitFunc ? emitFunc(newFrame, 'currentBuffer', prevBuffer) : undefined;
      this.compiler.emit.asyncClosureDepth--;
      const waitedChannelArg = controlFlowWaitedChannelName ? `"${controlFlowWaitedChannelName}"` : 'null';
      this.compiler.emit.line(`}, ${waitedChannelArg});`);
      this.currentBuffer = prevBuffer;
      this.currentTextChannelVar = prevTextChannelVar;
      this.currentTextChannelName = prevTextChannelName;
      this.currentWaitedChannelName = prevWaitedChannelName;
      this.currentWaitedOwnerBuffer = prevWaitedOwnerBuffer;
      if (controlFlowPromiseId) {
        this.emitOwnWaitedConcurrencyResolve(frame, controlFlowPromiseId, node);
      }
      validateCompileTimeFrameBalance(newFrame, this.compiler, node);

      const result = callbackValue && typeof callbackValue === 'object' &&
        Object.prototype.hasOwnProperty.call(callbackValue, 'result')
        ? callbackValue.result
        : callbackValue;
      return { frame: newFrame.pop(), result };
    }

    // Non-async: pass through without async wrapping (mirrors asyncBufferNode non-async path)
    const result = typeof emitFunc === 'function' ? emitFunc(frame, this.currentBuffer, this.currentBuffer) : undefined;
    return { frame, result };
  }

  asyncBufferNode(node, frame, createScope = false, positionNode = node, emitFunc = null) {
    if (node.isAsync) {
      const parentBufferArg = this.currentBuffer;
      let nextFrame = this.compiler.emit.asyncBlockBegin(node, frame, createScope, positionNode);
      const nestedBufferId = this.compiler._tmpid();
      this.compiler.emit.line(`let ${nestedBufferId} = currentBuffer;`);
      const prevBuffer = this.currentBuffer;
      const prevTextChannelVar = this.currentTextChannelVar;
      const prevTextChannelName = this.currentTextChannelName;
      this.currentBuffer = nestedBufferId;
      this.currentTextChannelVar = null;

      const callbackValue = emitFunc ? emitFunc(nextFrame, nestedBufferId, prevBuffer) : undefined;
      nextFrame = this.compiler.emit.asyncBlockEnd(
        node,
        nextFrame,
        createScope,
        positionNode,
        parentBufferArg,
        true
      );
      this.currentBuffer = prevBuffer;
      this.currentTextChannelVar = prevTextChannelVar;
      this.currentTextChannelName = prevTextChannelName;

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
module.exports.DEFAULT_TEMPLATE_TEXT_CHANNEL = DEFAULT_TEMPLATE_TEXT_CHANNEL;
module.exports.DEFAULT_TEMPLATE_TEXT_OUTPUT = DEFAULT_TEMPLATE_TEXT_CHANNEL;

