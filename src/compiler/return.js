'use strict';

const RETURN_CHANNEL_NAME = '__return__';
const RETURN_IS_UNSET_FUNCTION_NAME = '__return_is_unset__';
const RESERVED_RETURN_SENTINEL_SYMBOL_NAME = '__RETURN_UNSET__';

class CompileReturn {
  constructor(compiler) {
    this.compiler = compiler;
  }

  createChannelDeclaration() {
    return {
      name: RETURN_CHANNEL_NAME,
      type: 'var',
      initializer: null,
      internal: true
    };
  }

  isReturnChannelReference(name, declaration = null) {
    return name === RETURN_CHANNEL_NAME ||
      !!(declaration && declaration.runtimeName === RETURN_CHANNEL_NAME);
  }

  analyzeStatement() {
    return {
      mutates: [RETURN_CHANNEL_NAME]
    };
  }

  compileStatement(node) {
    const compiler = this.compiler;
    const resultVar = compiler._tmpid();
    compiler.emit(`let ${resultVar} = `);
    if (node.value) {
      compiler.compileExpression(node.value, null, node);
    } else {
      compiler.emit('null');
    }
    compiler.emit.line(';');
    this.emitChannelWrite(node, resultVar);
  }

  isUnsetCall(node) {
    return this.compiler.scriptMode &&
      node.name?.value === RETURN_IS_UNSET_FUNCTION_NAME;
  }

  _validateIsUnsetCall(node) {
    if (node.args && node.args.children && node.args.children.length > 0) {
      this.compiler.fail(
        `${RETURN_IS_UNSET_FUNCTION_NAME} does not accept arguments`,
        node.lineno,
        node.colno,
        node
      );
    }
  }

  analyzeIsUnsetCall(node) {
    this._validateIsUnsetCall(node);
    return {
      uses: [RETURN_CHANNEL_NAME],
      mutates: []
    };
  }

  emitIsUnsetCall(node) {
    const compiler = this.compiler;
    this._validateIsUnsetCall(node);
    if (!compiler.analysis.findDeclaration(node._analysis, RETURN_CHANNEL_NAME)) {
      compiler.fail(
        'Return-state guard is only valid inside a callable or script body that declares a return channel',
        node.lineno,
        node.colno,
        node
      );
    }
    // Unlike an ordinary function call or comparison, this internal guard uses
    // ReturnIsUnsetCommand and therefore cannot surface poison stored in the
    // returned value.
    compiler.emit(`${compiler.buffer.currentBuffer}.addReturnIsUnset("${RETURN_CHANNEL_NAME}", {lineno: ${node.lineno}, colno: ${node.colno}})`);
  }

  emitDeclareChannel(bufferExpr) {
    this.compiler.emit.line(
      `runtime.declareBufferChannel(${bufferExpr}, "${RETURN_CHANNEL_NAME}", "var", context, runtime.RETURN_UNSET);`
    );
  }

  emitChannelWrite(node, resultVar) {
    const compiler = this.compiler;
    compiler.emit.line(
      `${compiler.buffer.currentBuffer}.add(new runtime.VarCommand({ channelName: '${RETURN_CHANNEL_NAME}', args: [${resultVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${RETURN_CHANNEL_NAME}");`
    );
  }

  emitFinalSnapshot(bufferExpr, resultVar) {
    const compiler = this.compiler;
    compiler.emit.line(`${bufferExpr}.markFinishedAndPatchLinks();`);
    compiler.emit.line(
      `const ${resultVar}_snapshot = ${bufferExpr}.getChannel("${RETURN_CHANNEL_NAME}").finalSnapshot();`
    );
    compiler.emit.line(`let ${resultVar} = ${resultVar}_snapshot.then((value) => value === runtime.RETURN_UNSET ? null : value);`);
  }

  excludeGuardCaptureChannels(channelNames) {
    const filtered = new Set(channelNames);
    // __return__ is internal return-state infrastructure, not a user variable;
    // guard state capture/restore must not include it because recovery must not undo a return.
    filtered.delete(RETURN_CHANNEL_NAME);
    return Array.from(filtered);
  }

  getSequentialLoopAdvanceCheckChannel({ sequentialLoopBody, whileConditionNode, bodyChannels }) {
    return sequentialLoopBody &&
      !whileConditionNode &&
      bodyChannels &&
      bodyChannels.has(RETURN_CHANNEL_NAME)
      ? RETURN_CHANNEL_NAME
      : null;
  }
}

export default CompileReturn;
export {RETURN_CHANNEL_NAME};
export {RESERVED_RETURN_SENTINEL_SYMBOL_NAME};
export {RETURN_IS_UNSET_FUNCTION_NAME};
