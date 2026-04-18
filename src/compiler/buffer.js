/**
 * CompileBuffer - channel buffer management module
 *
 * Handles all channel buffering operations for Cascada's deferred output system.
 * Manages buffer stacks, async buffer operations, and channel command compilation.
 */

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
  }

  // === BUFFER STACK MANAGEMENT ===

  /**
   * Initialize a managed scope-root buffer.
   *
   * @param {string} bufferId
   * @param {string|null} parentBufferId
   * @param {string} textChannelVar
   */
  initManagedBuffer(bufferId, parentBufferId, textChannelVar, linkedChannelsArg = null) {
    if (this.compiler.asyncMode) {
      const textId = textChannelVar || `${bufferId}_textChannelVar`;
      const parentArg = parentBufferId || 'null';
      this.compiler.emit.line(`let ${bufferId} = runtime.createCommandBuffer(context, ${parentArg}, ${linkedChannelsArg}, ${parentArg});`);
      if (!this.compiler.scriptMode && textChannelVar !== null) {
        this.compiler.emit.line(`let ${textId} = runtime.declareBufferChannel(${bufferId}, "${this.currentTextChannelName}", "text", context, null);`);
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

  emitAddCommand(channelName, valueExpr, positionNode = null, emitTextCommand = false) {
    if (emitTextCommand) {
      this.compiler.emit.line(
        `${this.currentBuffer}.addText(${valueExpr}, ${this._emitPositionLiteral(positionNode)}, "${channelName}")`
      );
      return;
    }
    this.compiler.emit.line(`${this.currentBuffer}.add(${valueExpr}, "${channelName}");`);
  }

  emitOwnWaitedConcurrencyResolve(valueExpr, positionNode = null) {
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

  emitAddSequenceGet(channelName, commandName, subpath, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceGet("${channelName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSequenceCall(channelName, commandName, subpath, argsExpr, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addSequenceCall("${channelName}", "${commandName}", ${JSON.stringify(subpath || [])}, ${argsExpr}, ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddSnapshot(channelName, positionNode, asExpression = false) {
    const snapshotExpr = `${this.currentBuffer}.addSnapshot("${channelName}", ${this._emitPositionLiteral(positionNode)})`;
    if (asExpression) {
      return snapshotExpr;
    }
    this.compiler.emit(snapshotExpr);
  }

  // Emit an ordered raw snapshot command (no nested poison inspection).
  emitAddRawSnapshot(channelName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addRawSnapshot("${channelName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddIsError(channelName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addIsError("${channelName}", ${this._emitPositionLiteral(positionNode)})`
    );
  }

  emitAddGetError(channelName, positionNode) {
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

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, channelName, emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      const valueId = this.compiler._tmpid();
      this.compiler.emit(`let ${valueId} = `);
      renderFunction.call(this.compiler, frame);
      this.compiler.emit.line(';');
      this.emitAddCommand(channelName, valueId, positionNode, emitTextCommand);
      return;
    }
    this.compiler.emit(`${this.currentBuffer} += `);
    renderFunction.call(this.compiler, frame);
    this.compiler.emit.line(';');
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
  /**
   * Add a value to the buffer without producer slot-fill wrapping.
   * Use when value construction does not require addAsyncArgsCommand producer semantics.
   * The value is added directly to the current buffer (no extra async block).
   */
  asyncAddValueToBuffer(renderFunction, positionNode, channelName, emitTextCommand = false) {
    const returnId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${returnId};`);
    renderFunction.call(this.compiler, returnId);
    this.compiler.emit.line(';');
    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(returnId, positionNode)
      : returnId;
    this.emitAddCommand(channelName, valueExpr, positionNode, emitTextCommand);
  }

  /**
   * Emit deferred text output that still needs a structural child buffer.
   *
   * Use this only when the expression may add or link command structure later,
   * so the parent cannot safely enqueue the final TextCommand synchronously.
   * The expression itself still compiles against the parent buffer; the helper
   * owns a child text buffer that receives the eventual TextCommand and closes
   * when that deferred structural work is done.
   */
  /**
   * Compile a node inside an async buffer boundary.
   * Uses local save/restore of current buffer aliases instead of begin/end caller pairing.
   *
   * emitFunc may return:
   * - any value -> exposed as result
   * - { result, sequential } -> custom result + dynamic sequential flag for asyncBlockEnd
   */
  /**
   * Emit a `runtime.runControlFlowBoundary` call for control-flow nodes (if, switch).
   * Compared to `asyncBufferNode`, this does NOT wrap the branch bodies in their own
   * async blocks — the emitFunc is expected to compile branches synchronously.
   *
   * For non-async nodes falls through to a plain synchronous call (like asyncBufferNode).
   */
  _compileAsyncControlFlowBoundary(node, emitFunc = null) {
    return this.compiler.boundaries.compileAsyncControlFlowBoundary(this, node, emitFunc);
  }

  _compileSyncControlFlowBoundary(node, frame, emitFunc = null) {
    return this.compiler.boundaries.compileSyncControlFlowBoundary(this, node, frame, emitFunc);
  }

}

module.exports = CompileBuffer;
module.exports.DEFAULT_TEMPLATE_TEXT_CHANNEL = DEFAULT_TEMPLATE_TEXT_CHANNEL;
module.exports.DEFAULT_TEMPLATE_TEXT_OUTPUT = DEFAULT_TEMPLATE_TEXT_CHANNEL;

