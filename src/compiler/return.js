
const RETURN_CHAIN_NAME = '__return__';
const RETURN_IS_UNSET_FUNCTION_NAME = '__return_is_unset__';
const RESERVED_RETURN_SENTINEL_SYMBOL_NAME = '__RETURN_UNSET__';

class CompileReturn {
  constructor(compiler) {
    this.compiler = compiler;
  }

  createChainDeclaration() {
    return {
      name: RETURN_CHAIN_NAME,
      type: 'var',
      initializer: null,
      internal: true
    };
  }

  isReturnChainReference(name, declaration = null) {
    return name === RETURN_CHAIN_NAME ||
      !!(declaration && declaration.runtimeName === RETURN_CHAIN_NAME);
  }

  analyzeStatement() {
    return {
      mutates: [RETURN_CHAIN_NAME]
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
    this.emitChainWrite(node, resultVar);
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
      uses: [RETURN_CHAIN_NAME],
      mutates: []
    };
  }

  emitIsUnsetCall(node) {
    const compiler = this.compiler;
    this._validateIsUnsetCall(node);
    if (!compiler.analysis.findDeclaration(node._analysis, RETURN_CHAIN_NAME)) {
      compiler.fail(
        'Return-state guard is only valid inside a callable or script body that declares a return chain',
        node.lineno,
        node.colno,
        node
      );
    }
    // Unlike an ordinary function call or comparison, this internal guard uses
    // ReturnIsUnsetCommand and therefore cannot surface poison stored in the
    // returned value.
    compiler.emit(`${compiler.buffer.currentBuffer}.addCommand(new runtime.ReturnIsUnsetCommand({ chainName: "${RETURN_CHAIN_NAME}", pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${RETURN_CHAIN_NAME}")`);
  }

  emitDeclareChain(bufferExpr) {
    this.compiler.emit.line(
      `runtime.declareBufferChain(${bufferExpr}, "${RETURN_CHAIN_NAME}", "var", context, runtime.RETURN_UNSET);`
    );
  }

  emitChainWrite(node, resultVar) {
    const compiler = this.compiler;
    compiler.emit.line(
      `${compiler.buffer.currentBuffer}.addCommand(new runtime.VarCommand({ chainName: '${RETURN_CHAIN_NAME}', args: [${resultVar}], pos: {lineno: ${node.lineno}, colno: ${node.colno}} }), "${RETURN_CHAIN_NAME}");`
    );
  }

  emitFinalSnapshot(bufferExpr, resultVar) {
    const compiler = this.compiler;
    compiler.emit.line(`${bufferExpr}.finish();`);
    compiler.emit.line(
      `const ${resultVar}_snapshot = ${bufferExpr}.getChain("${RETURN_CHAIN_NAME}").finalSnapshot();`
    );
    compiler.emit.line(`let ${resultVar} = ${resultVar}_snapshot.then((value) => value === runtime.RETURN_UNSET ? null : value);`);
  }

  excludeGuardCaptureChains(chainNames) {
    const filtered = new Set(chainNames);
    // __return__ is internal return-state infrastructure, not a user variable;
    // guard state capture/restore must not include it because recovery must not undo a return.
    filtered.delete(RETURN_CHAIN_NAME);
    return Array.from(filtered);
  }

  getSequentialLoopAdvanceCheckChain({ sequentialLoopBody, whileConditionNode, bodyChains }) {
    return sequentialLoopBody &&
      !whileConditionNode &&
      bodyChains &&
      bodyChains.has(RETURN_CHAIN_NAME)
      ? RETURN_CHAIN_NAME
      : null;
  }
}

export {CompileReturn};
export {RETURN_CHAIN_NAME};
export {RESERVED_RETURN_SENTINEL_SYMBOL_NAME};
export {RETURN_IS_UNSET_FUNCTION_NAME};
