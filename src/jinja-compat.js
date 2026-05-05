import * as compiler from './compiler/compiler.js';
import * as lexer from './lexer.js';
import * as lib from './lib.js';
import * as nodes from './nodes.js';
import * as parser from './parser.js';
import * as runtime from './runtime/runtime.js';

function installCompat() {

  /* eslint-disable camelcase */

  var Compiler = compiler.Compiler;
  var CompilerSync = compiler.CompilerSync;
  var CompilerAsync = compiler.CompilerAsync;
  var CompilerCommon = compiler.CompilerCommon;
  var compilerClasses = Array.from(new Set(
    [Compiler, CompilerSync, CompilerAsync, CompilerCommon].filter(Boolean)
  ));
  var Parser = parser.Parser;

  var orig_Frame_lookupOrContext = runtime.Frame.prototype.lookupOrContext;
  var orig_Compiler_assertTypes = new Map();
  var orig_Compiler_compileLookupVal = new Map();
  var orig_Parser_parseAggregate;
  if (compilerClasses.length) {
    compilerClasses.forEach((CompilerClass) => {
      orig_Compiler_assertTypes.set(CompilerClass, CompilerClass.prototype.assertType);
      orig_Compiler_compileLookupVal.set(CompilerClass, CompilerClass.prototype.compileLookupVal);
    });
  }
  if (Parser) {
    orig_Parser_parseAggregate = Parser.prototype.parseAggregate;
  }

  function uninstall() {
    runtime.Frame.prototype.lookupOrContext = orig_Frame_lookupOrContext;
    orig_Compiler_assertTypes.forEach((assertType, CompilerClass) => {
      CompilerClass.prototype.assertType = assertType;
      delete CompilerClass.prototype.compileSlice;
    });
    orig_Compiler_compileLookupVal.forEach((compileLookupVal, CompilerClass) => {
      CompilerClass.prototype.compileLookupVal = compileLookupVal;
    });
    if (Parser) {
      Parser.prototype.parseAggregate = orig_Parser_parseAggregate;
    }
  }

  runtime.Frame.prototype.lookupOrContext = function lookupOrContext(context, key) {
    var val = orig_Frame_lookupOrContext.call(this, context, key);
    if (val !== undefined) {
      return val;
    }
    switch (key) {
      case 'True':
        return true;
      case 'False':
        return false;
      case 'None':
        return null;
      default:
        return undefined;
    }
  };

  function getTokensState(tokens) {
    return {
      index: tokens.index,
      lineno: tokens.lineno,
      colno: tokens.colno
    };
  }

  if (nodes && compilerClasses.length && Parser) {
    class Slice extends nodes.Node {
      get typename() { return 'Slice'; }
      get fields() { return ['start', 'stop', 'step']; }

      init(lineno, colno, start, stop, step) {
        start = start || new nodes.Literal(lineno, colno, null);
        stop = stop || new nodes.Literal(lineno, colno, null);
        step = step || new nodes.Literal(lineno, colno, 1);
        super.init(lineno, colno, start, stop, step);
      }
    }

    compilerClasses.forEach((CompilerClass) => {
      const origAssertType = orig_Compiler_assertTypes.get(CompilerClass);
      CompilerClass.prototype.assertType = function assertType(node) {
        if (node instanceof Slice) {
          return;
        }
        origAssertType.apply(this, arguments);
      };
      CompilerClass.prototype.compileSlice = function compileSlice(node, frame) {
        this.emit('(');
        this._compileExpression(node.start, frame);
        this.emit('),(');
        this._compileExpression(node.stop, frame);
        this.emit('),(');
        this._compileExpression(node.step, frame);
        this.emit(')');
      };
      CompilerClass.prototype.compileLookupVal = function compileLookupVal(node, frame) {
        this.emit('runtime.memberLookupJinjaCompat((');
        this.compile(node.target, frame);
        this.emit('),');
        this.compile(node.val, frame);
        this.emit(')');
      };
    });

    Parser.prototype.parseAggregate = function parseAggregate() {
      var origState = getTokensState(this.tokens);
      // Set back one accounting for opening bracket/parens
      origState.colno--;
      origState.index--;
      try {
        return orig_Parser_parseAggregate.apply(this);
      } catch (e) {
        const errState = getTokensState(this.tokens);
        const rethrow = () => {
          lib._assign(this.tokens, errState);
          return e;
        };

        // Reset to state before original parseAggregate called
        lib._assign(this.tokens, origState);
        this.peeked = false;

        const tok = this.peekToken();
        if (tok.type !== lexer.TOKEN_LEFT_BRACKET) {
          throw rethrow();
        } else {
          this.nextToken();
        }

        const node = new Slice(tok.lineno, tok.colno);

        // If we don't encounter a colon while parsing, this is not a slice,
        // so re-raise the original exception.
        let isSlice = false;

        for (let i = 0; i <= node.fields.length; i++) {
          if (this.skip(lexer.TOKEN_RIGHT_BRACKET)) {
            break;
          }
          if (i === node.fields.length) {
            if (isSlice) {
              this.fail('parseSlice: too many slice components', tok.lineno, tok.colno);
            } else {
              break;
            }
          }
          if (this.skip(lexer.TOKEN_COLON)) {
            isSlice = true;
          } else {
            const field = node.fields[i];
            node[field] = this.parseExpression();
            isSlice = this.skip(lexer.TOKEN_COLON) || isSlice;
          }
        }
        if (!isSlice) {
          throw rethrow();
        }
        return new nodes.Array(tok.lineno, tok.colno, [node]);
      }
    };
  }

  return uninstall;
}

export {installCompat};
