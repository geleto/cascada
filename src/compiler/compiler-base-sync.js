
import * as nodes from '../nodes.js';
import {CompilerCommon} from './compiler-common.js';

const compareOps = {
  '==': '==',
  '===': '===',
  '!=': '!=',
  '!==': '!==',
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>='
};

class CompilerBaseSync extends CompilerCommon {
  init(options) {
    super.init(Object.assign({}, options, { asyncMode: false }));
  }

  compileSymbol(node, frame) {
    const name = node.value;
    if (node.isCompilerInternal) {
      this.emit(name);
      return;
    }
    const frameValue = frame.lookup(name);
    if ((node.sequential || node.sequentialRepair) && frameValue) {
      this._failNonContextSequenceRoot(node);
    }
    if (frameValue) {
      this.emit(frameValue);
      return;
    }
    this.emit(`frame.lookupOrContext(context, "${name}")`);
  }

  _compileAggregate(node, frame, startChar, endChar, resolveItems, expressionRoot, compileThen, asyncThen) {
    this._compileSyncAggregate(node, frame, startChar, endChar, expressionRoot, compileThen, asyncThen);
  }

  _binFuncEmitter(node, frame, funcName, separator = ',') {
    this._emitSyncBinFunc(node, frame, funcName, separator);
  }

  _binOpEmitter(node, frame, str) {
    this._emitSyncBinOp(node, frame, str);
  }

  _unaryOpEmitter(node, frame, operator) {
    this._emitSyncUnaryOp(node, frame, operator);
  }

  compileInlineIf(node, frame) {
    this.emit('(');
    this.compile(node.cond, frame);
    this.emit('?');
    this.compile(node.body, frame);
    this.emit(':');
    if (node.else_ !== null) {
      this.compile(node.else_, frame);
    } else {
      this.emit('""');
    }
    this.emit(')');
  }

  compileIs(node, frame) {
    const testName = node.right.name ? node.right.name.value : node.right.value;
    const testFunc = `env.getTest("${testName}")`;
    const failMsg = `test not found: ${testName}`.replace(/"/g, '\\"');
    const errorContext = this._generateErrorContext(node, node.right);
    this.emit(`(${testFunc} ? ${testFunc}.call(context, `);
    this.compile(node.left, frame);
    if (node.right.args) {
      this.emit(', ');
      this.compile(node.right.args, frame);
    }
    this.emit(`) : (() => { var err = runtime.handleError(new Error("${failMsg}"), ${node.right.lineno}, ${node.right.colno}, "${errorContext}", context.path); throw err; })())`);
    this.emit(' === true');
  }

  compileOr(node, frame) {
    this._binOpEmitter(node, frame, ' || ');
  }

  compileAnd(node, frame) {
    this._binOpEmitter(node, frame, ' && ');
  }

  compilePeekError(node, frame) {
    this.emit('runtime.peekError(');
    this.compile(node.target, frame);
    this.emit(')');
  }

  compileCompare(node, frame) {
    this.compile(node.expr, frame);

    node.ops.forEach((op) => {
      this.emit(` ${compareOps[op.type]} `);
      this.compile(op.expr, frame);
    });
  }

  compileLookupVal(node, frame) {
    this.emit('runtime.memberLookup((');
    this.compile(node.target, frame);
    this.emit('),');
    this.compile(node.val, frame);
    this.emit(')');
  }

  compileFunCall(node, frame) {
    const funcName = this._getNodeName(node.name).replace(/"/g, '\\"');
    this.emit('(lineno = ' + node.lineno + ', colno = ' + node.colno + ', ');
    this.emit('runtime.callWrap(');
    this.compile(node.name, frame);
    this.emit(', "' + funcName + '", context, ');
    this._compileAggregate(node.args, frame, '[', ']', false, false);
    this.emit(`, ${this.buffer.currentBuffer}))`);
  }

  compileFilter(node, frame) {
    this.assertType(node.name, nodes.Symbol);
    this.emit('env.getFilter("' + node.name.value + '").call(context, ');
    this._compileAggregate(node.args, frame, '', '', false, false);
    this.emit(')');
  }

  compileFilterAsync(node, frame) {
    const symbol = node.symbol.value;
    this.assertType(node.name, nodes.Symbol);
    this.emit('env.getFilter("' + node.name.value + '").call(context, ');
    this._compileAggregate(node.args, frame, '', '', false, false);
    this.emit.line(', ' + this._makeCallback(symbol));
    this.emit.addScopeLevel();
  }

  compileAwaited(node, frame) {
    this.compile(node, frame);
  }

  _compileAwaitedExpression(node, frame) {
    this._compileExpression(node, frame);
  }

  compileExpression(node, frame, positionNode, excludeFromWaitedRootTracking = false) {
    this._compileExpression(node, frame, positionNode);
  }

  compileCaller(node, frame) {
    this.macro.compileSyncCaller(node, frame);
  }

  _compileSyncAggregate(node, frame, startChar, endChar, expressionRoot, compileThen, asyncThen) {
    if (compileThen) {
      const result = this._tmpid();
      this.emit.line(`(${asyncThen ? 'async ' : ''}function(${result}){`);
      compileThen.call(this, result, node.children.length);
      this.emit('})(');
    }

    this.emit(startChar);
    this._compileArguments(node, frame, expressionRoot, startChar);
    this.emit(endChar);

    if (compileThen) {
      this.emit(')');
    }
  }

  _emitSyncBinFunc(node, frame, funcName, separator) {
    this.emit(`${funcName}(`);
    this.compile(node.left, frame);
    this.emit(separator);
    this.compile(node.right, frame);
    this.emit(')');
  }

  _emitSyncBinOp(node, frame, str) {
    this.compile(node.left, frame);
    this.emit(str);
    this.compile(node.right, frame);
  }

  _emitSyncUnaryOp(node, frame, operator) {
    this.emit(operator);
    this.compile(node.target, frame);
  }
}

export {CompilerBaseSync};
