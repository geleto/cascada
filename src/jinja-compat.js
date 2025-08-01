function installCompat() {
  'use strict';

  /* eslint-disable camelcase */

  // This must be called like `nunjucks.installCompat` so that `this`
  // references the nunjucks instance
  var runtime = this.runtime;
  var lib = this.lib;
  // Handle slim case where these 'modules' are excluded from the built source
  var Compiler = this.compiler.Compiler;
  var Parser = this.parser.Parser;
  var nodes = this.nodes;
  var lexer = this.lexer;

  var orig_contextOrFrameLookup = runtime.contextOrFrameLookup;
  var orig_memberLookup = runtime.memberLookup;
  var orig_Compiler_assertType;
  var orig_Parser_parseAggregate;
  if (Compiler) {
    orig_Compiler_assertType = Compiler.prototype.assertType;
  }
  if (Parser) {
    orig_Parser_parseAggregate = Parser.prototype.parseAggregate;
  }

  function uninstall() {
    runtime.contextOrFrameLookup = orig_contextOrFrameLookup;
    runtime.memberLookup = orig_memberLookup;
    if (Compiler) {
      Compiler.prototype.assertType = orig_Compiler_assertType;
    }
    if (Parser) {
      Parser.prototype.parseAggregate = orig_Parser_parseAggregate;
    }
  }

  runtime.contextOrFrameLookup = function contextOrFrameLookup(context, frame, key) {
    var val = orig_contextOrFrameLookup.apply(this, arguments);
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

  if (process.env.BUILD_TYPE !== 'SLIM' && nodes && Compiler && Parser) { // i.e., not slim mode
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

    Compiler.prototype.assertType = function assertType(node) {
      if (node instanceof Slice) {
        return;
      }
      orig_Compiler_assertType.apply(this, arguments);
    };
    Compiler.prototype.compileSlice = function compileSlice(node, frame) {
      this.emit('(');
      this._compileExpression(node.start, frame);
      this.emit('),(');
      this._compileExpression(node.stop, frame);
      this.emit('),(');
      this._compileExpression(node.step, frame);
      this.emit(')');
    };

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

  function sliceLookup(obj, start, stop, step) {
    obj = obj || [];
    if (start === null) {
      start = (step < 0) ? (obj.length - 1) : 0;
    }
    if (stop === null) {
      stop = (step < 0) ? -1 : obj.length;
    } else if (stop < 0) {
      stop += obj.length;
    }

    if (start < 0) {
      start += obj.length;
    }

    const results = [];

    for (let i = start; ; i += step) {
      if (i < 0 || i > obj.length) {
        break;
      }
      if (step > 0 && i >= stop) {
        break;
      }
      if (step < 0 && i <= stop) {
        break;
      }
      results.push(runtime.memberLookup(obj, i));
    }
    return results;
  }

  function hasOwnProp(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  const ARRAY_MEMBERS = {
    pop(index) {
      if (index === undefined) {
        return this.pop();
      }
      if (index >= this.length || index < 0) {
        throw new Error('KeyError');
      }
      return this.splice(index, 1);
    },
    append(element) {
      return this.push(element);
    },
    remove(element) {
      for (let i = 0; i < this.length; i++) {
        if (this[i] === element) {
          return this.splice(i, 1);
        }
      }
      throw new Error('ValueError');
    },
    count(element) {
      var count = 0;
      for (let i = 0; i < this.length; i++) {
        if (this[i] === element) {
          count++;
        }
      }
      return count;
    },
    index(element) {
      var i;
      if ((i = this.indexOf(element)) === -1) {
        throw new Error('ValueError');
      }
      return i;
    },
    find(element) {
      return this.indexOf(element);
    },
    insert(index, elem) {
      return this.splice(index, 0, elem);
    }
  };
  const OBJECT_MEMBERS = {
    items() {
      return lib._entries(this);
    },
    values() {
      return lib._values(this);
    },
    keys() {
      return lib.keys(this);
    },
    get(key, def) {
      var output = this[key];
      if (output === undefined) {
        output = def;
      }
      return output;
    },
    has_key(key) {
      return hasOwnProp(this, key);
    },
    pop(key, def) {
      var output = this[key];
      if (output === undefined && def !== undefined) {
        output = def;
      } else if (output === undefined) {
        throw new Error('KeyError');
      } else {
        delete this[key];
      }
      return output;
    },
    popitem() {
      const keys = lib.keys(this);
      if (!keys.length) {
        throw new Error('KeyError');
      }
      const k = keys[0];
      const val = this[k];
      delete this[k];
      return [k, val];
    },
    setdefault(key, def = null) {
      if (!(key in this)) {
        this[key] = def;
      }
      return this[key];
    },
    update(kwargs) {
      lib._assign(this, kwargs);
      return null; // Always returns None
    }
  };
  OBJECT_MEMBERS.iteritems = OBJECT_MEMBERS.items;
  OBJECT_MEMBERS.itervalues = OBJECT_MEMBERS.values;
  OBJECT_MEMBERS.iterkeys = OBJECT_MEMBERS.keys;

  runtime.memberLookup = function memberLookup(obj, val, autoescape) {
    if (arguments.length === 4) {
      return sliceLookup.apply(this, arguments);
    }
    obj = obj || {};

    // If the object is an object, return any of the methods that Python would
    // otherwise provide.
    if (lib.isArray(obj) && hasOwnProp(ARRAY_MEMBERS, val)) {
      return ARRAY_MEMBERS[val].bind(obj);
    }
    if (lib.isObject(obj) && hasOwnProp(OBJECT_MEMBERS, val)) {
      return OBJECT_MEMBERS[val].bind(obj);
    }

    return orig_memberLookup.apply(this, arguments);
  };

  return uninstall;
}

module.exports = installCompat;
