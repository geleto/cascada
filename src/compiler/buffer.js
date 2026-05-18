/**
 * CompileBuffer - chain buffer management module
 *
 * Handles all command-buffer operations for Cascada's deferred chain system.
 * Manages buffer stacks, async buffer operations, and chain command compilation.
 */

import * as nodes from '../language/nodes.js';

import {CHAIN_TYPE_FACTS} from '../chain-types.js';
import {validateChainObservationCall} from './validation.js';
const DEFAULT_TEMPLATE_TEXT_CHAIN = '__text__';
const BUFFER_STATE_KEYS = [
  'currentBuffer',
  'currentTextChainVar',
  'currentTextChainName',
  'currentWaitedChainName',
  'currentWaitedOwnerBuffer'
];

class CompileBuffer {
  constructor(compiler) {
    this.compiler = compiler;
    this.currentBuffer = null;
    this.currentTextChainVar = null;
    this.currentTextChainName = DEFAULT_TEMPLATE_TEXT_CHAIN;
    this.currentWaitedChainName = null;
    this.currentWaitedOwnerBuffer = null;
    // Temp value ids for split buffer writes (asyncAddToBufferBegin/End), supports nesting.
  }

  // === BUFFER STACK MANAGEMENT ===

  /**
   * Initialize a managed scope-root buffer.
   *
   * @param {string} bufferId
   * @param {string|null} parentBufferId
   * @param {string} textChainVar
   */
  initManagedBuffer(bufferId, parentBufferId, textChainVar, linkedChains = null) {
    if (this.compiler.asyncMode) {
      const textId = textChainVar || `${bufferId}_textChainVar`;
      const parentArg = parentBufferId || 'null';
      const linkedChainsArg = Array.isArray(linkedChains) && linkedChains.length > 0
        ? JSON.stringify(linkedChains)
        : 'null';
      this.compiler.emit.line(`let ${bufferId} = new runtime.CommandBuffer(context, ${parentArg}, ${linkedChainsArg}, ${parentArg});`);
      if (!this.compiler.scriptMode) {
        this.compiler.emit.line(`let ${textId} = runtime.declareBufferChain(${bufferId}, "${this.currentTextChainName}", "text", context, null);`);
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

  _snapshotBufferState() {
    const state = {};
    BUFFER_STATE_KEYS.forEach((key) => {
      state[key] = this[key];
    });
    return state;
  }

  withBufferState(stateOverrides, emitFunc) {
    const previousState = this._snapshotBufferState();
    Object.assign(this, stateOverrides);

    try {
      return emitFunc();
    } finally {
      Object.assign(this, previousState);
    }
  }

  // Scope current waited chain binding for the emitted code region.
  // Pass null to explicitly compile without an own waited chain.
  withOwnWaitedChain(waitedChainName, emitFunc, ownerBufferExpr = null) {
    return this.withBufferState({
      currentWaitedChainName: waitedChainName,
      currentWaitedOwnerBuffer: waitedChainName ? (ownerBufferExpr || this.currentBuffer) : null
    }, emitFunc);
  }

  // Compile a region with no own waited chain binding.
  skipOwnWaitedChain(emitFunc) {
    return this.withOwnWaitedChain(null, emitFunc);
  }

  _getBufferAccess() {
    // In async mode, buffers are CommandBuffer instances (use .output).
    return this.compiler.asyncMode ? `${this.currentBuffer}.output` : this.currentBuffer;
  }

  _emitTemplateTextCommandExpression(valueExpression, positionNode, normalizeArgs = false) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `new runtime.TextCommand({ chainName: "${this.currentTextChainName}", args: [${valueExpression}], normalizeArgs: ${normalizeArgs}, pos: {lineno: ${lineno}, colno: ${colno}} })`;
  }

  _emitPositionLiteral(positionNode) {
    const lineno = positionNode && positionNode.lineno !== undefined ? positionNode.lineno : 0;
    const colno = positionNode && positionNode.colno !== undefined ? positionNode.colno : 0;
    return `{lineno: ${lineno}, colno: ${colno}}`;
  }

  emitFinishedTextBoundaryPromise(bufferExpr, textChainName, positionNode, transformExpr = null, addToCurrentWaited = false) {
    const textPromiseId = this.compiler._tmpid();
    const finalExpr = `${bufferExpr}.getChain("${textChainName}").finalSnapshot()`;
    const chainedExpr = transformExpr
      ? `Promise.resolve(${finalExpr}).then((value) => ${transformExpr.replace(/__VALUE__/g, 'value')})`
      : finalExpr;

    this.compiler.emit.line(`${bufferExpr}.finish();`);
    this.compiler.emit.line(`const ${textPromiseId} = ${chainedExpr};`);
    if (addToCurrentWaited && this.compiler.asyncMode && this.currentWaitedChainName) {
      this.emitLimitedLoopCompletion(textPromiseId, positionNode);
    }
    return textPromiseId;
  }

  _compileCommandConstruction(node) {
    const isCallNode = node.call instanceof nodes.FunCall;
    const staticPath = this.compiler.sequential._extractStaticPath(isCallNode ? node.call.name : node.call);
    if (!staticPath || staticPath.length === 0) {
      this.compiler.fail(
        'Invalid command syntax. Expected format is chain(...) or chain.command(...) or chain.subpath.command(...).',
        node.lineno, node.colno, node
      );
    }

    const chainName = staticPath[0];
    const chainDecl = node._analysis.lookupDeclaration || null;
    const chainType = node.chainType || (chainDecl ? chainDecl.type : null);
    const command = staticPath.length >= 2 ? staticPath[staticPath.length - 1] : null;
    const path = staticPath.length > 1 ? staticPath.slice(1) : null;
    const receiverPath = staticPath.length > 2 ? staticPath.slice(1, -1) : null;
    const isObservationCall = isCallNode &&
      !receiverPath &&
      (command === 'snapshot' || command === 'isError' || command === 'getError');

    if (isObservationCall) {
      validateChainObservationCall(this.compiler, { node, command, chainName, chainType });
      if (command === 'snapshot') {
        this.compiler.emit(`new runtime.SnapshotCommand({ chainName: '${chainName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      if (command === 'isError') {
        this.compiler.emit(`new runtime.IsErrorCommand({ chainName: '${chainName}', pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }
      this.compiler.emit(`new runtime.GetErrorCommand({ chainName: '${chainName}', pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    if (chainType === 'sequence') {
      if (isCallNode) {
        if (!command) {
          this.compiler.fail('Invalid sequence command syntax: expected sequenceChain.method(...)', node.lineno, node.colno, node);
        }
        this.compiler.emit(`new runtime.SequenceCallCommand({ chainName: '${chainName}', methodName: '${command}', `);
        if (receiverPath && receiverPath.length > 0) {
          this.compiler.emit(`path: ${JSON.stringify(receiverPath)}, `);
        }
        this.compiler.emit('args: ');
        this.compiler._compileAggregate(node.call.args, null, '[', ']', false, true);
        this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
        return;
      }

      if (!command) {
        this.compiler.fail('Invalid sequence read syntax: expected sequenceChain.path', node.lineno, node.colno, node);
      }
      this.compiler.emit(`new runtime.SequenceGetCommand({ chainName: '${chainName}', `);
      if (path && path.length > 0) {
        this.compiler.emit(`path: ${JSON.stringify(path)}, `);
      }
      this.compiler.emit(`pos: ${this._emitPositionLiteral(node)} })`);
      return;
    }

    const chainFacts = CHAIN_TYPE_FACTS[chainType] || null;
    if (!(chainFacts && chainFacts.commandClass)) {
      this.compiler.fail(
        `Compiler error: analysis did not resolve a declared chain target for '${chainName}'.`,
        node.lineno,
        node.colno,
        node
      );
    }
    this.compiler.emit(`new runtime.${chainFacts.commandClass}({ chainName: '${chainName}', `);
    if (command) {
      this.compiler.emit(`operation: '${command}', `);
    }
    if (chainType === 'text') {
      this.compiler.emit('normalizeArgs: true, ');
    }
    let argList = node.call.args;
    if (chainType === 'data') {
      // For data chains, we create a new "virtual" AST for the arguments,
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
      dataPathNode.mustResolve = true;

      // Our array node at the front.
      const newArgs = [dataPathNode, ...originalArgs.slice(1)];

      argList = new nodes.NodeList(node.call.args.lineno, node.call.args.colno, newArgs);
    }

    this.compiler.emit('args: ');
    // Chain commands are constructed with unresolved args; resolution/normalization
    // happens once in runtime right before command.apply().
    this.compiler._compileAggregate(argList, null, '[', ']', false, true);
    this.compiler.emit(`, pos: ${this._emitPositionLiteral(node)} })`);
  }

  emitAddCommand(chainName, valueExpr, positionNode = null, emitTextCommand = false) {
    if (emitTextCommand) {
      this.compiler.emit.line(
        `${this.currentBuffer}.addCommand(new runtime.TextCommand({ chainName: "${chainName}", args: [${valueExpr}], pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
      );
      return;
    }
    this.compiler.emit.line(`${this.currentBuffer}.addCommand(${valueExpr}, "${chainName}");`);
  }

  emitAddChainCommandByType({
    bufferExpr = this.currentBuffer,
    chainType,
    chainName,
    chainNameExpr = JSON.stringify(chainName),
    operation = null,
    path = null,
    argsExpr,
    valueExpr = null,
    positionNode = null,
    normalizeArgs = null,
    initializeIfNotSet = false
  }) {
    const chainFacts = CHAIN_TYPE_FACTS[chainType] || null;
    if (!(chainFacts && chainFacts.commandClass)) {
      this.compiler.fail(`Unsupported chain command type '${chainType}'.`, 0, 0);
    }
    if (argsExpr === undefined && valueExpr !== null) {
      if (!(chainFacts && chainFacts.supportsValueInitializer)) {
        this.compiler.fail(`Chain command type '${chainType}' does not support value initializer shorthand.`, 0, 0);
      }
      if (chainType === 'var') {
        argsExpr = `[${valueExpr}]`;
      } else if (chainType === 'text') {
        operation = operation || 'set';
        argsExpr = `[${valueExpr}]`;
        normalizeArgs = normalizeArgs === null ? true : normalizeArgs;
      } else if (chainType === 'data') {
        operation = operation || 'set';
        argsExpr = `[null, ${valueExpr}]`;
      }
    }
    if (argsExpr === undefined) {
      this.compiler.fail(`Missing args expression for chain command type '${chainType}'.`, 0, 0);
    }
    const props = [
      `chainName: ${chainNameExpr}`,
      `args: ${argsExpr}`,
      `pos: ${this._emitPositionLiteral(positionNode)}`
    ];
    if (operation) {
      props.splice(1, 0, `operation: ${JSON.stringify(operation)}`);
    }
    if (path && path.length > 0) {
      props.splice(operation ? 2 : 1, 0, `path: ${JSON.stringify(path)}`);
    }
    if (normalizeArgs !== null) {
      props.push(`normalizeArgs: ${normalizeArgs ? 'true' : 'false'}`);
    }
    if (initializeIfNotSet) {
      props.push('initializeIfNotSet: true');
    }
    this.compiler.emit.line(
      `${bufferExpr}.addCommand(new runtime.${chainFacts.commandClass}({ ${props.join(', ')} }), ${chainNameExpr});`
    );
  }

  // Register produced work with the current waited-loop timing chain.
  // This records completion of the value created at the current source
  // position, not completion of any command that later consumes that value.
  //
  // Keep that distinction: output command promises are tied to chain
  // consumption, and coupling loop-slot release to text/data draining would
  // make limited-concurrency loops stall behind later snapshot/finalSnapshot
  // traversal.
  emitLimitedLoopCompletion(valueExpr, positionNode = null) {
    // In __waited__ scope, root work contributes one timing-only
    // WaitResolveCommand to the owning iteration buffer's chain.
    const waitedChainName = this.currentWaitedChainName;
    const waitedOwnerBuffer = this.currentWaitedOwnerBuffer || this.currentBuffer;
    if (!this.compiler.asyncMode || !waitedChainName) {
      return;
    }
    // Register as usage, not mutation: __waited__ tracks completion, not chain state.
    this.compiler.emit.line(
      `${waitedOwnerBuffer}.addCommand(new runtime.WaitResolveCommand({ chainName: "${waitedChainName}", args: [${valueExpr}], pos: ${this._emitPositionLiteral(positionNode)} }), "${waitedChainName}");`
    );
  }

  emitAddSequenceGet(chainName, path, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addCommand(new runtime.SequenceGetCommand({ chainName: "${chainName}", path: ${JSON.stringify(path)}, pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
    );
  }

  emitAddSequenceCall(chainName, methodName, receiverPath, argsExpr, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addCommand(new runtime.SequenceCallCommand({ chainName: "${chainName}", methodName: "${methodName}", path: ${JSON.stringify(receiverPath || [])}, args: ${argsExpr}, pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
    );
  }

  emitAddSnapshot(chainName, positionNode, asExpression = false) {
    const snapshotExpr = `${this.currentBuffer}.addCommand(new runtime.SnapshotCommand({ chainName: "${chainName}", pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`;
    if (asExpression) {
      return snapshotExpr;
    }
    this.compiler.emit(snapshotExpr);
  }

  // Emit an ordered raw snapshot command (no nested poison inspection).
  emitAddRawSnapshot(chainName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addCommand(new runtime.RawSnapshotCommand({ chainName: "${chainName}", pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
    );
  }

  emitAddIsError(chainName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addCommand(new runtime.IsErrorCommand({ chainName: "${chainName}", pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
    );
  }

  emitAddGetError(chainName, positionNode) {
    this.compiler.emit(
      `${this.currentBuffer}.addCommand(new runtime.GetErrorCommand({ chainName: "${chainName}", pos: ${this._emitPositionLiteral(positionNode)} }), "${chainName}")`
    );
  }

  // === HANDLER ANALYSIS ===

  /**
   * Recursively collect all chains written to within a node's subtree.
   * Used to determine which chains need poison markers when branch is skipped.
   *
   * @param {Node} node - AST node to analyze
   * @returns {Set<string>} Set of chain names (template text chain, data, etc.)
   */
  // === OUTPUT COMMAND COMPILATION ===

  /**
   * Compile chain command: chain.method(args)
   * Handles declared chains (data/text/value/sequence)
   */
  compileChainCommand(node) {
    // Preserve chain routing in asyncAddToBuffer; validation remains in _compileCommandConstruction.
    const pathNode = node.call instanceof nodes.FunCall ? node.call.name : node.call;
    const chainName = this.compiler.sequential._extractStaticPathRoot(pathNode);

    this.asyncAddValueToBuffer((resultVar) => {
      this.compiler.emit(`${resultVar} = `);
      this._compileCommandConstruction(node);
    }, node, chainName);
  }

  // === BUFFER EMISSION ===

  /**
   * Add value to buffer (sync mode)
   */
  addToBuffer(node, frame, renderFunction, positionNode = node, chainName, emitTextCommand = false) {
    if (this.compiler.asyncMode) {
      const valueId = this.compiler._tmpid();
      this.compiler.emit(`let ${valueId} = `);
      renderFunction.call(this.compiler, frame);
      this.compiler.emit.line(';');
      this.emitAddCommand(chainName, valueId, positionNode, emitTextCommand);
      return;
    }
    this.compiler.emit(`${this.currentBuffer} += `);
    renderFunction.call(this.compiler, frame);
    this.compiler.emit.line(';');
  }

  /**
   * Add a value to the buffer without producer slot-fill wrapping.
   * Use when value construction does not require addAsyncArgsCommand producer semantics.
   * The value is added directly to the current buffer (no extra async block).
   */
  asyncAddValueToBuffer(renderFunction, positionNode, chainName, emitTextCommand = false) {
    const returnId = this.compiler._tmpid();
    this.compiler.emit.line(`let ${returnId};`);
    renderFunction.call(this.compiler, returnId);
    this.compiler.emit.line(';');
    const valueExpr = emitTextCommand
      ? this._emitTemplateTextCommandExpression(returnId, positionNode)
      : returnId;
    this.emitAddCommand(chainName, valueExpr, positionNode, emitTextCommand);
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

CompileBuffer.DEFAULT_TEMPLATE_TEXT_CHAIN = DEFAULT_TEMPLATE_TEXT_CHAIN;
CompileBuffer.DEFAULT_TEMPLATE_TEXT_OUTPUT = DEFAULT_TEMPLATE_TEXT_CHAIN;
export {CompileBuffer};
export {DEFAULT_TEMPLATE_TEXT_CHAIN};
export {DEFAULT_TEMPLATE_TEXT_CHAIN as DEFAULT_TEMPLATE_TEXT_OUTPUT};

