/**
 * Cascada Script to Template Transpiler
 *
 * This module transpiles Cascada Script syntax into the underlying Nunjucks/Cascada
 * template engine syntax. Uses script-lexer for token extraction and handling.
 *
 * Key Syntax Transformations:
 *
 * 1.  **No Tag Delimiters**
 *     - Logic is written without `{% ... %}` or `{{ ... }}`. The transpiler
 *       adds them automatically with whitespace control.
 *
 * 2.  **Explicit Variable Handling**
 *     - `var user = ...`      → `{% var user = ... %}`
 *     - `user = "new name"`   → `{% set user = "new name" %}`
 *
 * 3.  **Explicit Channel Variables**
 *     - `text text` declares a text channel variable; `text("Hello")` emits text.
 *       `text("Hello")`       → `{% command text("Hello") %}`
 *     - Data assembly uses explicit data channels with path-based commands.
 *       `data data` + `data.user.id = 1` → `{% command data.set(["user","id"], 1) %}`
 *       `data.tags.push("a")` → `{% command data.push(["tags"], "a") %}`
 *     - Sink channels call methods directly on declared sinks.
 *       `sink db = makeDb(); db.insert(...)` → `{% command db.insert(...) %}`
 *
 * 4.  **`capture` Removal**
 *     - `capture ... endcapture` is no longer supported in scripts and raises an error.
 *
 * 6.  **Implicit `do` Statements**
 *     - Any standalone expression becomes a `do` statement for executing logic.
 *       `items.push("new")`   → `{% do items.push("new") %}`
 *
 * 7.  **Modern Syntax Features**
 *     - **Multi-line Expressions**: Expressions can span multiple lines based
 *       on operators or unclosed brackets and are automatically concatenated.
 *     - **Comments**: Standard `//` and `/* ... * /` comments are converted
 *       to Nunjucks/Cascada `{# ... #}` comments.
 *
 * Script Syntax Example:
 *
 * ```
 * // Assemble a user object from a profile
 * var userProfile = fetchProfile(1)
 *
 * data.user.id = userProfile.id
 * data.user.name = userProfile.name
 *
 * for task in userProfile.tasks
 *   data.user.tasks.push(task.title)
 * endfor
 * ```
 *
 * Converts to:
 *
 * ```
 * {#- Assemble a user object from a profile -#}
 * {%- var userProfile = fetchProfile(1) -%}
 *
 * {%- command data.set(["user","id"], userProfile.id) -%}
 * {%- command data.set(["user","name"], userProfile.name) -%}
 *
 * {%- for task in userProfile.tasks -%}
 *   {%- command data.push(["user","tasks"], task.title) -%}
 * {%- endfor -%}
 * ```
 *
 * The transpiler uses a line-by-line, token-based approach with a state machine
 * to handle complex cases like multi-line expressions, nested comments, and
 * block structure validation, ensuring robust and accurate conversion.
 */

// Import the script parser
const { parseTemplateLine, TOKEN_TYPES } = require('./script-lexer');
const { RESERVED_DECLARATION_NAMES } = require('../compiler/validation');

class ScriptTranspiler {
  constructor() {
    // Comment type constants
    this.COMMENT_TYPE = {
      SINGLE: 'single',
      MULTI: 'multi'
    };

    // Block type constants for validation
    this.BLOCK_TYPE = {
      START: 'START',
      MIDDLE: 'MIDDLE',
      END: 'END'
    };

    // Define block-related configuration
    this.SYNTAX = {
      // Block-related tags
      blockTags: ['for', 'each', 'while', 'if', 'switch', 'block', 'macro', 'filter', 'raw', 'verbatim', 'call', 'guard'],
      lineTags: [/*'set',*/'include', 'extends', 'from', 'import', 'depends', 'var', 'extern', 'return', 'data', 'text', 'sink', 'sequence'],

      // Middle tags with their parent block types
      middleTags: {
        'else': ['if', 'for'],
        'elif': ['if'],
        'case': ['switch'],
        'default': ['switch'],
        'recover': ['guard']
      },

      // Block pairs define how blocks start and end
      blockPairs: {
        'for': 'endfor',
        'each': 'endeach',
        'while': 'endwhile',
        'if': 'endif',
        'switch': 'endswitch',
        'block': 'endblock',
        'macro': 'endmacro',
        'filter': 'endfilter',
        'call': 'endcall',
        // Internal tag emitted by this transpiler to support:
        //   var x = call ... endcall
        //   x = call ... endcall
        'call_assign': 'endcall_assign',
        'raw': 'endraw',
        'verbatim': 'endverbatim',
        'set': 'endset', //only when no = in the set, then the block has to be closed
        'var': 'endvar', //only when no = in the var, then the block has to be closed
        'guard': 'endguard'
      },

      // Tags that should never be treated as multi-line
      neverContinued: [
        'else', 'elif', 'case', 'default',
        'endif', 'endfor', 'endswitch', 'endblock', 'endmacro',
        'endfilter', 'endcall', 'endcall_assign', 'endraw', 'endverbatim',
        'endwhile', 'endvar', 'recover'
      ],

      // Continuation detection
      continuation: {
        // Characters at end of line that indicate continuation
        endChars: '{([,?:-+=|&.!*/%^<>~',

        // Operators at end of line that indicate continuation
        endOperators: ['&&', '||', '==', '!=', '>=', '<=', '+=', '-=', '*=', '/=', '//', '**', '===', '!=='],

        // Keywords at end of line that indicate continuation
        endKeywords: ['in ', 'is ', 'and ', 'or '],

        // Characters at start of line that indicate it's a continuation
        startChars: '})]{([?:-+=|&.!*/%^<>~',

        // Operators at start of line that indicate it's a continuation
        startOperators: ['&&', '||', '==', '!=', '>=', '<='],

        // Keywords at start of line that indicate it's a continuation
        startKeywords: ['and', 'or', 'not', 'in', 'is', 'else', 'elif']
      }
    };

    // Build set of all reserved keywords for quick lookups
    this.RESERVED_KEYWORDS = new Set([
      ...this.SYNTAX.blockTags,
      ...this.SYNTAX.lineTags,
      ...Object.keys(this.SYNTAX.middleTags),
      ...Object.values(this.SYNTAX.blockPairs)
    ]);

    // Reserved declaration names are not allowed for script vars or channels.
    this.RESERVED_DECLARATION_NAMES = RESERVED_DECLARATION_NAMES;

    // Track block stack for declaration/assignment blocks
    this.setBlockStack = []; // 'var' or 'set'
    // Track call vs call_assign nesting so endcall closes the correct block kind.
    this.callBlockStack = [];

    this.DATA_COMMANDS = {
      operators: {
        //'=': '.set',
        '+=': '.add',
        '-=': '.subtract',
        '++': '.increment',
        '--': '.decrement',
        '*=': '.multiply',
        '/=': '.divide',
        '&=': '.bitAnd',
        '|=': '.bitOr',
        '&&=': '.and',
        '||=': '.or',
        '&&': true,
        '||': true
      },
      operatorStart: ['=', '+', '-', '*', '/', '&', '|'],
    };

    // Channel scopes track declared channels in nested blocks.
    this.channelScopes = [this._createChannelScope()];

    // Aliases for injected core channels in generated templates.
    this.CORE_CHANNEL_ALIASES = {
      data: 'dat',
      text: 'tex',
      value: 'val'
    };

    this._useCoreChannelAliases = false;
  }

  getCurrentChannelScope() {
    return this.channelScopes[this.channelScopes.length - 1];
  }

  _createChannelScope(parentAccess = 'inherit') {
    return {
      channels: new Map(),
      parentAccess
    };
  }

  pushChannelScope(parentAccess = 'inherit') {
    this.channelScopes.push(this._createChannelScope(parentAccess));
  }

  popChannelScope() {
    if (this.channelScopes.length === 1) {
      return;
    }
    this.channelScopes.pop();
  }

  isChannelInScope(name) {
    let readOnly = false;
    for (let i = this.channelScopes.length - 1; i >= 0; i--) {
      const scope = this.channelScopes[i];
      if (scope.channels.has(name)) {
        const info = scope.channels.get(name);
        return { type: info.type, writable: !readOnly };
      }
      if (scope.parentAccess === 'none') {
        return null;
      }
      if (scope.parentAccess === 'readonly') {
        readOnly = true;
      }
    }
    return null;
  }

  declareChannel(name, type) {
    const scope = this.getCurrentChannelScope();
    if (scope.channels.has(name)) {
      const existingType = scope.channels.get(name).type;
      if (type === 'var' && existingType !== 'var') {
        throw new Error(`Cannot declare variable '${name}' because a channel with the same name is already declared.`);
      }
      if (type !== 'var' && existingType === 'var') {
        throw new Error(`Cannot declare channel '${name}' because a variable with the same name is already declared`);
      }
      if (type === 'var') {
        throw new Error(`Identifier '${name}' has already been declared.`);
      }
      throw new Error(`Channel '${name}' already declared in this scope`);
    }

    // Keep script-transpiler validation aligned with compiler behavior:
    // channel declarations cannot shadow declarations from parent scopes.
    for (let i = this.channelScopes.length - 2; i >= 0; i--) {
      const parentScope = this.channelScopes[i];
      if (parentScope.channels.has(name)) {
        const parentType = parentScope.channels.get(name).type;
        if (type === 'var' && parentType !== 'var') {
          throw new Error(`Cannot declare variable '${name}' because a channel with the same name is already declared.`);
        }
        if (type !== 'var' && parentType === 'var') {
          throw new Error(`Cannot declare channel '${name}' because a variable with the same name is already declared`);
        }
        if (type === 'var') {
          throw new Error(`Identifier '${name}' has already been declared.`);
        }
        throw new Error(`Channel '${name}' cannot shadow a channel declared in a parent scope`);
      }
    }

    scope.channels.set(name, { type });
  }

  /**
   * Validates path segments for the data command syntax
   * @param {Array} segments - Array of path segments
   * @throws {Error} If any segment is invalid
   */
  _validatePathSegments(segments) {
    for (const segment of segments) {
      if (segment.startsWith('.')) {
        // Property segment - extract the identifier part (remove leading dot)
        const identifier = segment.slice(1);
        if (!identifier) {
          throw new Error(`Invalid path: empty path component (consecutive dots).`);
        }
        if (!this._isValidIdentifier(identifier)) {
          throw new Error(`Invalid path component: '${identifier}' is not a valid identifier.`);
        }
      }
      // bracket segments (starting with '[') don't need validation of their contents
    }
  }

  /**
   * Robustly parses path segments from tokens, handling strings, brackets, and comments.
   * Can optionally stop at assignment operators or argument start.
   *
   * @param {Array} tokens - Tokens to parse
   * @param {number} startIndex - Index to start parsing from
   * @param {boolean} stopAtArgs - Whether to stop at '('
   * @param {boolean} detectAssignment - Whether to detect assignment operators and return them
   * @param {Boolean} wrapAssignmentValue - Whether to wrap assignment value in parens (for data)
   * @param {number} lineIndex - For error reporting
   * @returns {Object} { segments, endIndex, append, remainingBuffer, operator }
   */
  _parsePathSegments(tokens, startIndex, stopAtArgs, detectAssignment, wrapAssignmentValue, lineIndex) {
    const context = {
      segments: [],
      currentSegment: '',
      bracketLevel: 0,
      skippingWhitespace: true,
      state: 'PARSING_PATH',
      remainingBuffer: '',
      append: '',
      operator: null,
      config: {
        stopAtArgs, detectAssignment, wrapAssignmentValue, lineIndex
      }
    };

    let i = startIndex;
    for (; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'COMMENT') continue;

      if (token.type !== 'CODE') {
        if (context.state === 'COLLECTING_REMAINING') {
          this._parsePathSegmentsCollectingRemaining(context, token.value);
          continue;
        }
        if (context.state === 'PARSING_PATH') {
          if (context.bracketLevel > 0) {
            context.currentSegment += token.value;
          } else {
            // Unexpected non-code token at root level (e.g. string literal not in brackets)
            throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Unexpected token in path.`);
          }
        }
        continue;
      }

      // CODE token
      for (let charIdx = 0; charIdx < token.value.length; charIdx++) {
        const char = token.value[charIdx];

        if (context.state === 'COLLECTING_REMAINING') {
          this._parsePathSegmentsCollectingRemaining(context, char);
          continue;
        }

        if (context.state === 'PARSING_PATH') {
          charIdx = this._parsePathSegmentsParsingPath(context, char, token, charIdx);
        }
      }
    }

    // Check final state
    if (context.state === 'PARSING_PATH' && context.currentSegment) {
      context.segments.push(context.currentSegment);
    }

    if (context.bracketLevel > 0) {
      throw new Error(`Invalid path syntax at line ${lineIndex + 1}: Unmatched opening bracket '['.`);
    }

    return { segments: context.segments, endIndex: i, append: context.append, remainingBuffer: context.remainingBuffer, operator: context.operator };
  }

  _parsePathSegmentsFinishSegment(context) {
    if (context.currentSegment) {
      context.segments.push(context.currentSegment);
      context.currentSegment = '';
    } else {
      if (context.state === 'PARSING_PATH' && context.segments.length === 0) {
        // It's allowed to have no segments yet if we are just starting
      } else {
        throw new Error(`Invalid path syntax at line ${context.config.lineIndex + 1}: Empty path segment.`);
      }
    }
  }

  _parsePathSegmentsCollectingRemaining(context, text) {
    context.remainingBuffer += text;
  }

  _parsePathSegmentsParsingPath(context, char, token, charIdx) {
    if (context.skippingWhitespace) {
      if (char.trim() === '') return charIdx;
      context.skippingWhitespace = false;
    }

    if (char === '[') {
      // Start of a bracket access (e.g. `[index]`). If not nested, this starts a new segment.
      if (context.bracketLevel === 0) this._parsePathSegmentsFinishSegment(context);
      context.currentSegment += char;
      context.bracketLevel++;
    } else if (char === ']') {
      // End of a bracket access.
      context.currentSegment += char;
      context.bracketLevel--;
      if (context.bracketLevel < 0) {
        throw new Error(`Invalid path syntax at line ${context.config.lineIndex + 1}: Unmatched closing bracket ']'.`);
      }
    } else if (char === '.' && context.bracketLevel === 0) {
      // Dot separator starts a new property segment (e.g. `.prop`). Only valid if we are not inside brackets.
      this._parsePathSegmentsFinishSegment(context);
      context.currentSegment = char;
    } else if (context.config.stopAtArgs && char === '(' && context.bracketLevel === 0) {
      // Function call start. If parsing arguments (`stopAtArgs`), this marks the end of the path and start of the arguments (remaining buffer).
      this._parsePathSegmentsFinishSegment(context);
      context.state = 'COLLECTING_REMAINING';
      context.remainingBuffer = char;
    } else if (context.config.detectAssignment && this.DATA_COMMANDS.operatorStart.includes(char) && context.bracketLevel === 0) {
      // Assignment operator start (e.g. `=`). If verifying assignment (`detectAssignment`), this transitions to collecting the value.
      // Check valid operators
      // =, +=, -=, etc.
      this._parsePathSegmentsFinishSegment(context);

      let op = char + (token.value[charIdx + 1] || '');
      let opCommand = this.DATA_COMMANDS.operators[op];

      if (op === '==') {
        // Comparison (==) is invalid in these contexts (LHS assignment or data command).
        throw new Error(`Invalid command operator at line ${context.config.lineIndex + 1}: ${op} is not a valid operator.`);
      }

      if (opCommand) {
        if (opCommand === true) {
          // 3-char operator (&&=)
          op = op + (token.value[charIdx + 2] || '');
          opCommand = this.DATA_COMMANDS.operators[op];
          if (!opCommand) throw new Error(`Invalid command operator ${op}`);
          charIdx++;
        }
        charIdx++;
        context.operator = opCommand;
        // Map operators to commands (e.g., += to .add) for data usage. set_path currently only supports = (.set).

      } else if (char === '=') {
        context.operator = '.set';
      } else {
        throw new Error(`Invalid command operator at line ${context.config.lineIndex + 1}: ${op}`);
      }
      context.state = 'COLLECTING_REMAINING';
      if (context.config.wrapAssignmentValue) {
        context.remainingBuffer = '(';
        context.append = ')';
      }
    } else if (char.trim() === '') {
      // Handling spaces: Inside brackets, spaces are part of the content. Outside, they are ignored.
      if (context.bracketLevel > 0) context.currentSegment += char;
    } else {
      // Regular character part of an identifier.
      context.currentSegment += char;
    }
    return charIdx;
  }

  /**
   * Breaks down a data command syntax into its components
   * @param {Array} tokens - Array of tokens from script-lexer
   * @param {number} lineIndex - Current line index for error reporting
   * @return {Object} Object with path, command, and args properties. Args may not be ')' terminated in a multi-line command.
   */
  _deconstructDataCommand(tokens, lineIndex) {
    let prefixBuffer = '';
    const dataPrefix = 'data';

    // Find where data ends
    let i = 0;
    for (; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'COMMENT') continue;
      if (token.type !== 'CODE') throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Expected data prefix.`);

      let found = false;
      for (let j = 0; j < token.value.length; j++) {
        const char = token.value[j];
        if (char.trim() === '') continue;
        prefixBuffer += char;

        if (prefixBuffer === dataPrefix) {
          // Found prefix in current token. The rest of this token, and subsequent tokens,
          // contain the path/command. We create a transient token list for the helper.

          let remainingInToken = token.value.slice(j + 1);
          const nextTokens = [{ type: 'CODE', value: remainingInToken }, ...tokens.slice(i + 1)];

          const result = this._parsePathSegments(nextTokens, 0, true, true, true, lineIndex);

          let { segments, remainingBuffer, append, operator } = result;

          // reconstruct logic

          if (remainingBuffer) {
            // Parse args...
            const remaining = remainingBuffer;
            if (!remaining.startsWith('(')) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Expected '(...)' for arguments.`);

            const args = remaining.substring(1);
            let command, path;

            if (operator) {
              // It was an operator (+= etc or =)
              command = operator.slice(1); // remove dot
              // segments is the path
              path = segments.join('');
            } else {
              if (segments.length === 0) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Missing command.`);
              const commandSegment = segments.pop();
              if (!commandSegment.startsWith('.')) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Command cannot be a bracket expression.`);
              command = commandSegment.slice(1);
              path = segments.length ? segments.join('') : null;
            }

            if (path && path.startsWith('.')) path = path.substring(1);
            if (!this._isValidIdentifier(command)) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: '${command}' is not a valid identifier.`);

            // Validation
            try {
              if (path) {
                // Need to re-split path for validation?
                // _validatePathSegments expects array of segments.
                // Our helper returned segments array.
                this._validatePathSegments(segments);
              }
            } catch (e) {
              throw new Error(`Invalid path syntax at line ${lineIndex + 1}: ${e.message}`);
            }

            return { path, command, args, append, segments };
          } else {
            throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Incomplete command.`);
          }
        }

        if (!dataPrefix.startsWith(prefixBuffer)) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Expected data prefix.`);
      }
      if (found) break;
    }

    // If loop finishes without returning, we failed
    throw new Error(`Invalid command syntax at line ${lineIndex + 1}: incomplete data command.`);
  }

  /**
   * Converts data command syntax to the generic syntax
   * @param {Object} tcom - Parsed command object with path, command, and extra args (ending in ')' unless multiline
   * @return {string} The generic syntax command string
   */
  _transpileDataCommand(tcom, multiline, channelName = 'data') {
    // Convert new syntax to generic syntax
    // data: data.user.name.set("Alice")
    // generic: data.set(user.name, "Alice")
    // data: data.merge({ version: "1.1" })
    // generic: data.merge(null, { version: "1.1" })

    // Always build an explicit array literal of path segments when a path is present.
    // This unifies handling for root and non-root paths.
    let pathArgument;
    const segs = tcom.segments || [];
    if (segs.length === 0) {
      // No path provided -> operate on root
      pathArgument = 'null';
    } else {
      // Convert segments to array literal:
      // - '.prop' -> '\"prop\"'
      // - '[]' -> '\"[]\"'
      // - '[expr]' -> expr (no quotes)
      const arr = [];
      for (const seg of segs) {
        if (seg.startsWith('.')) {
          const identifier = seg.slice(1);
          arr.push(JSON.stringify(identifier));
        } else if (seg.startsWith('[')) {
          const inner = seg.slice(1, -1).trim(); // remove [ ]
          if (inner === '') {
            arr.push(JSON.stringify('[]'));
          } else {
            arr.push(inner);
          }
        } else {
          // bare segment like 'user'
          arr.push(JSON.stringify(seg));
        }
      }
      pathArgument = `[${arr.join(', ')}]`;
    }
    let args = tcom.args || '';
    let refArgs = args.trim();
    if (!multiline && tcom.append) {
      refArgs = refArgs + tcom.append;//append now, otherwise will append at the end of the multiline
    }

    const addComma = refArgs.trim() !== ')';//this happens with empty args or on multiline, where we may not have the ')'

    return `@${channelName}.${tcom.command}(${pathArgument}${addComma ? ',' : ''}${args}`;
  }

  /**
   * Extracts the first word from a string, ensuring it's a complete word
   * It accepts words starting with @ and mathches : as a word separator
   * @param {string} text - The text to extract from
   * @return {string} The first word
   */
  _getFirstWord(text) {
    // Get the first space-separated word
    const match = text.trim().match(/^(@?[a-zA-Z0-9_]+)(?:[\s:]|$)/);
    return match ? match[1] : '';
  }

  _getLeadingIdentifier(text) {
    const match = text.trim().match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match ? match[1] : '';
  }

  /**
   * Checks if a string is a complete word (not part of another identifier)
   * @param {string} text - The text to check
   * @param {number} position - Position in text where word starts
   * @param {number} length - Length of the word
   * @return {boolean} True if it's a complete word
   */
  _isCompleteWord(text, position, length) {
    // Check character before (if not at start)
    if (position > 0) {
      const charBefore = text[position - 1];
      if (/[a-zA-Z0-9_$]/.test(charBefore)) {
        return false;
      }
    }

    // Check character after (if not at end)
    if (position + length < text.length) {
      const charAfter = text[position + length];
      if (/[a-zA-Z0-9_$]/.test(charAfter)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Determines the block type for a tag
   * @param {string} tag - The tag to check
   * @return {string|null} The block type (START, MIDDLE, END) or null
   */
  _getBlockType(tag, code) {
    if (this.SYNTAX.blockTags.includes(tag)) return this.BLOCK_TYPE.START;
    if (Object.keys(this.SYNTAX.middleTags).includes(tag)) return this.BLOCK_TYPE.MIDDLE;
    if (Object.values(this.SYNTAX.blockPairs).includes(tag)) return this.BLOCK_TYPE.END;
    return null;//not a block
  }

  /**
   * Extracts comments from parser tokens
   * @param {Array} tokens - Array of tokens from script-lexer
   * @return {Array} Array of comment objects with type and content
   */
  _extractComments(tokens) {
    return tokens
      .filter(token => token.type === TOKEN_TYPES.COMMENT)
      .map(token => {
        let type = this.COMMENT_TYPE.SINGLE;
        let content = token.value;

        // Determine comment type and clean content
        if (content.startsWith('//')) {
          content = content.replace(/^\/\/\s?/, '').trim();
        } else if (content.startsWith('/*')) {
          type = this.COMMENT_TYPE.MULTI;
          content = content.replace(/^\/\*\s?|\s?\*\/$/g, '').trim();
        }

        return { type, content };
      });
  }

  /**
   * Filters out comment tokens from all tokens
   * @param {Array} tokens - Array of tokens from script-lexer
   * @return {Array} Tokens without comments
   */
  _filterOutComments(tokens) {
    return tokens.filter(token => token.type !== TOKEN_TYPES.COMMENT);
  }

  _hasNonWhitespaceCode(tokens) {
    return tokens.some(token => token.type === TOKEN_TYPES.CODE && token.value.trim() !== '');
  }

  /**
   * Combines code tokens into a string
   * @param {Array} tokens - Array of tokens (excluding comments)
   * @return {string} Combined code string
   */
  _tokensToCode(tokens) {
    return tokens.map(token => token.value).join('');
  }

  /**
   * Checks if line will continue to the next line
   * @param {Array} tokens - Array of code tokens (no comments)
   * @param {string} codeContent - The code content
   * @param {string} firstWord - The first word of the code
   * @return {boolean} True if line continues
   */
  //@todo - use the parseResult only?
  _willContinueToNextLine(tokens, codeContent, firstWord) {
    // Check if it's a tag that never continues
    if (this.SYNTAX.neverContinued.includes(firstWord)) {
      return false;
    }

    // Check if any tokens are incomplete (parser tells us this)
    const hasIncompleteToken = tokens.some(token => token.incomplete);
    if (hasIncompleteToken) return true;

    // No content means no continuation
    if (!codeContent) return false;

    codeContent = codeContent.trim();

    // Check for continuation characters at end of line
    const lastChar = codeContent.slice(-1);
    if (this.SYNTAX.continuation.endChars.includes(lastChar)) {
      // Special case: !! operator does not continue (it's a repair operator)
      if (codeContent.endsWith('!!') && !codeContent.endsWith('!!!')) {
        return false;
      }
      return true;
    }

    // Check for continuation operators at end of line
    for (const op of this.SYNTAX.continuation.endOperators) {
      if (codeContent.endsWith(op)) {
        // Check if operator is standalone (not part of an identifier)
        const beforeOpIndex = codeContent.length - op.length - 1;
        if (beforeOpIndex < 0 || !/[a-zA-Z0-9_]/.test(codeContent[beforeOpIndex])) {
          return true;
        }
      }
    }

    // Check for continuation keywords at end of line
    for (const keyword of this.SYNTAX.continuation.endKeywords) {
      const trimmedKeyword = keyword.trim();
      if (codeContent.endsWith(trimmedKeyword)) {
        // Check if it's a complete word
        const keywordIndex = codeContent.length - trimmedKeyword.length;
        if (this._isCompleteWord(codeContent, keywordIndex, trimmedKeyword.length)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Checks if line continues from the previous line
   * @param {string} codeContent - The code content
   * @return {boolean} True if continuing from previous line
   */
  _continuesFromPrevious(codeContent) {
    codeContent = codeContent.trim();
    const firstWord = this._getFirstWord(codeContent);
    if (this.RESERVED_KEYWORDS.has(firstWord)) {
      return false; // New tags start fresh, regardless of previous continuation
    }
    // Check for continuation characters at start of line
    const firstChar = codeContent.trim()[0];
    if (this.SYNTAX.continuation.startChars.includes(firstChar)) return true;
    // Check for continuation operators at start of line
    for (const op of this.SYNTAX.continuation.startOperators) {
      if (codeContent.trim().startsWith(op)) {
        const afterOp = codeContent.trim().substring(op.length);
        if (afterOp.length === 0 || afterOp[0] === ' ' || this.SYNTAX.continuation.startChars.includes(afterOp[0])) {
          return true;
        }
      }
    }
    // Check for continuation keywords at start of line
    if (this.SYNTAX.continuation.startKeywords.includes(firstWord)) {
      const keywordIndex = codeContent.indexOf(firstWord);
      if (this._isCompleteWord(codeContent, keywordIndex, firstWord.length)) {
        return true;
      }
    } return false;
  }

  /**
   * Checks if a string is a valid JavaScript identifier
   * @param {string} str - The string to check
   * @return {boolean} True if it's a valid identifier
   */
  _isValidIdentifier(str) {
    if (!str) return false;

    // JavaScript identifier rules: start with letter, $, or _, followed by letters, digits, $, or _
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
  }

  /**
   * Checks if a string is a list of valid JavaScript identifiers separated by commas
   * @param {string} str - The string to check
   * @return {boolean} True if it's a valid identifier list
   */
  _isValidIdentifierList(str) {
    if (!str) return false;
    const varNames = str.split(',').map(name => name.trim());
    for (const varName of varNames) {
      if (!this._isValidIdentifier(varName)) {
        return false;
      }
    }
    return true;
  }

  _assertNonReservedDeclarationNames(names, lineIndex) {
    for (const name of names) {
      if (this.RESERVED_DECLARATION_NAMES.has(name)) {
        throw new Error(`Identifier '${name}' is reserved and cannot be used as a variable or channel name at line ${lineIndex + 1}`);
      }
    }
  }

  /**
   * Identifies logical sections of the statement using path parsing logic
   * @param {string} codeContent - The code to parse
   * @param {number} lineIndex - For error reporting
   * @returns {Object|null} result object or null if not a path assignment
   */
  _deconstructPathAssignment(codeContent, lineIndex) {
    const { lex } = require('./script-lexer');
    // Lex the codeContent to get tokens.
    // This might be expensive for every line, but we only call it if standard var assignment check fails.
    const tokens = lex(codeContent);

    if (tokens.length === 0) return null;

    // Parse segments starting from token 0
    try {
      const result = this._parsePathSegments(tokens, 0, false, true, false, lineIndex);

      const { segments, operator, remainingBuffer } = result;

      if (!operator || operator !== '.set') {
        return null;
      }

      if (segments.length < 2) {
        // Path assignment requires at least a root and one segment (e.g. `root.prop = val`)
        // Simple assignments `root = val` are handled by standard variable processing.
        return null;
      }

      const rootSegment = segments[0];
      // root segment shouldn't start with dot or bracket
      if (rootSegment.startsWith('.') || rootSegment.startsWith('[')) return null;
      if (!this._isValidIdentifier(rootSegment)) return null;

      const root = rootSegment;
      const pathSegments = segments.slice(1);

      const value = remainingBuffer ? remainingBuffer.trim() : '';

      // Convert segments to string array representation
      const segsArr = [];
      for (const seg of pathSegments) {
        if (seg.startsWith('.')) {
          segsArr.push(JSON.stringify(seg.slice(1)));
        } else if (seg.startsWith('[')) {
          const inner = seg.slice(1, -1).trim();
          if (inner === '') segsArr.push('"[]"');
          else segsArr.push(inner);
        } else {
          // Should not happen for path segments (must be . or [])
          segsArr.push(JSON.stringify(seg));
        }
      }
      const segmentsStr = `[${segsArr.join(', ')}]`;

      return { target: root, segments: segmentsStr, value: value };
    } catch (e) {
      return null;
    }
  }

  _isAssignment(code, lineIndex) {
    const assignPos = code.indexOf('=');
    if (assignPos === -1) return false;

    const lhs = code.substring(0, assignPos).trim();

    // Standard variable assignment
    if (this._isValidIdentifierList(lhs)) return true;

    // Path assignment
    if (this._deconstructPathAssignment(code, lineIndex)) return true;

    const expr = code.substring(assignPos + 1).trim();

    if (expr.startsWith('=')) {
      throw new Error(`Invalid assignment/comparison: "${code}" at line ${lineIndex + 1}`);
    }
    return true; // Simple assignment that failed validIdentifierList checks (e.g. destructuring? Not supported yet) or maybe standard LHS invalid
  }

  _processVar(parseResult, lineIndex, isAssignment = false, declarationTag = 'var') {
    const code = parseResult.codeContent.trim();
    // Use firstWord to correctly slice content, robust to extra spaces
    const firstWord = isAssignment ? '' : this._getFirstWord(code);
    // Get content after 'var' or the full line for assignment
    const content = isAssignment ? code : code.substring(firstWord.length).trim();

    const assignPos = content.indexOf('=');

    if (assignPos === -1) {
      // No assignment
      if (!this._isValidIdentifierList(content)) {
        throw new Error(`Invalid variable name: "${content}" at line ${lineIndex + 1}`);
      }
      if (!isAssignment) {
        const declaredNames = content.split(',').map(name => name.trim()).filter(Boolean);
        this._assertNonReservedDeclarationNames(declaredNames, lineIndex);
        if (declarationTag === 'var') {
          for (const name of declaredNames) {
            this.declareChannel(name, 'var');
          }
        }
      }
      if (isAssignment) {
        // This should not be possible if _isAssignment works correctly
        throw new Error(`Invalid assignment state: "${content}" at line ${lineIndex + 1}`);
      }
      // These are declarations assigned to 'none'
      if (!this._isValidIdentifierList(content)) {
        throw new Error(`Invalid variable name in: "${content}" at line ${lineIndex + 1}`);
      }
      parseResult.lineType = 'TAG';
      parseResult.tagName = declarationTag;
      parseResult.codeContent = `${content} = none`; // All vars assigned to none
      parseResult.blockType = null;

    } else {
      // CASE: Has assignment (e.g., `var x, y = 10`)
      const targetsStr = content.substring(0, assignPos).trim();

      if (!this._isValidIdentifierList(targetsStr)) {
        const pathResult = this._deconstructPathAssignment(content, lineIndex);
        if (pathResult) {
          if (this._getFirstWord(pathResult.value) === 'capture') {
            throw new Error('Capture block not supported for path assignment');
          }
          parseResult.lineType = 'TAG';
          parseResult.tagName = 'set_path';
          parseResult.codeContent = `${pathResult.target}, ${pathResult.segments} = ${pathResult.value}`;
          parseResult.blockType = null;
          return;
        }
        // If it looks like assignment but failed path parsing/identifier check
        throw new Error(`Invalid variable name or path: "${targetsStr}" at line ${lineIndex + 1}`);
      }

      if (!isAssignment) {
        const declaredNames = targetsStr.split(',').map(name => name.trim()).filter(Boolean);
        this._assertNonReservedDeclarationNames(declaredNames, lineIndex);
        if (declarationTag === 'var') {
          for (const name of declaredNames) {
            this.declareChannel(name, 'var');
          }
        }
      }

      const exprStr = content.substring(assignPos + 1).trim();
      const firstExprWord = this._getFirstWord(exprStr);

      if (firstExprWord === 'capture') {
        throw new Error(`Capture blocks are no longer supported at line ${lineIndex + 1}`);
      } else if (firstExprWord === 'call') {
        // "var x = call ... endcall" / "x = call ... endcall"
        // becomes an internal block tag that the parser/compiler understand.
        // This avoids a synthetic capture wrapper and keeps return semantics clean.
        const afterCall = exprStr.substring('call'.length).trim();
        parseResult.lineType = 'TAG';
        parseResult.blockType = 'START';
        parseResult.tagName = 'call_assign';
        parseResult.codeContent = `${isAssignment ? 'set' : declarationTag} ${targetsStr} = ${afterCall}`;
        this.callBlockStack.push('call_assign');
      } else {
        // Standard variable/set
        parseResult.lineType = 'TAG';
        parseResult.tagName = isAssignment ? 'set' : declarationTag;
        // content is already correct: "x = 10" or "var x = 10" -> "x = 10"
        parseResult.codeContent = content; // If isAssignment checks passed, this is fine
        parseResult.blockType = null;
      }
    }
  }

  _formatChannelCommand(channelType, commandContent, includeChannelType = false) {
    if (includeChannelType) {
      return `${channelType} ${commandContent}`;
    }
    return commandContent;
  }

  _parseDataCommandFromChannel(after, lineIndex) {
    const { lex } = require('./script-lexer');
    const tokens = lex(after);

    const parsed = this._parsePathSegments(tokens, 0, true, true, true, lineIndex);
    const { segments, remainingBuffer, append, operator } = parsed;

    if (!remainingBuffer) {
      throw new Error(`Invalid channel command syntax at line ${lineIndex + 1}: Missing arguments.`);
    }

    if (!remainingBuffer.startsWith('(')) {
      throw new Error(`Invalid channel command syntax at line ${lineIndex + 1}: Expected '(...)' for arguments.`);
    }

    const args = remainingBuffer.substring(1);
    let command;
    let pathSegments;

    if (operator) {
      command = operator.slice(1);
      pathSegments = segments;
    } else {
      if (segments.length === 0) {
        return { directCall: true, command: null };
      }
      const commandSegment = segments[segments.length - 1];
      if (!commandSegment.startsWith('.')) {
        throw new Error(`Invalid channel command syntax at line ${lineIndex + 1}: Command cannot be a bracket expression.`);
      }
      command = commandSegment.slice(1);
      pathSegments = segments.slice(0, -1);
    }

    if (!this._isValidIdentifier(command)) {
      throw new Error(`Invalid channel command syntax at line ${lineIndex + 1}: '${command}' is not a valid identifier.`);
    }

    if (pathSegments.length > 0) {
      this._validatePathSegments(pathSegments);
    }

    return {
      command,
      args,
      append,
      segments: pathSegments,
      directCall: pathSegments.length === 0 && !operator,
      operatorUsed: !!operator
    };
  }

  _processOutputOperation(parseResult, lineIndex) {
    const code = parseResult.codeContent;
    const trimmed = code.trimStart();
    const channelName = this._getLeadingIdentifier(trimmed);
    if (!channelName) return false;

    const channelInfo = this.isChannelInScope(channelName);
    if (!channelInfo) return false;
    const channelType = channelInfo.type;

    const after = trimmed.substring(channelName.length);
    const afterTrimmed = after.trimStart();
    if (!afterTrimmed) return false;

    const opStart = afterTrimmed[0];
    if (opStart === '=') {
      if (channelType === 'sequence') {
        throw new Error(`sequence channel '${channelName}' does not support assignment at line ${lineIndex + 1}`);
      }

      const assignmentExpr = afterTrimmed.slice(1).trimStart();
      if (!assignmentExpr) return false;

      if (channelType === 'data') {
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'command';
        parseResult.blockType = null;
        parseResult.codeContent = this._formatChannelCommand(channelType, `${channelName}.set(null, ${assignmentExpr})`, false);
      } else if (channelType === 'text') {
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'command';
        parseResult.blockType = null;
        parseResult.codeContent = this._formatChannelCommand(channelType, `${channelName}.set(${assignmentExpr})`, false);
      } else if (channelType === 'var') {
        const firstExprWord = this._getFirstWord(assignmentExpr);
        if (firstExprWord === 'capture') {
          throw new Error(`Capture blocks are no longer supported at line ${lineIndex + 1}`);
        } else if (firstExprWord === 'call') {
          const afterCall = assignmentExpr.substring('call'.length).trim();
          parseResult.lineType = 'TAG';
          parseResult.blockType = this.BLOCK_TYPE.START;
          parseResult.tagName = 'call_assign';
          parseResult.codeContent = `set ${channelName} = ${afterCall}`;
          this.callBlockStack.push('call_assign');
        } else {
          parseResult.lineType = 'TAG';
          parseResult.tagName = 'set';
          parseResult.blockType = null;
          parseResult.codeContent = `${channelName} = ${assignmentExpr}`;
        }
      } else {
        return false;
      }

      return true;
    }
    if (!['.', '(', '['].includes(opStart)) return false;

    if (channelType === 'data') {
      const parsed = this._parseDataCommandFromChannel(after, lineIndex);

      if (parsed.directCall) {
        const argsPreview = (parsed.args || '').trimStart();
        const hasExplicitPathArg = argsPreview.startsWith('null') || argsPreview.startsWith('[');
        if (!hasExplicitPathArg && parsed.command) {
          const genericSyntaxCommand = this._transpileDataCommand(parsed, false, channelName);
          let commandContent = genericSyntaxCommand.substring(1);
          if (parsed.append) {
            if (parseResult.continuesToNext) {
              parseResult.expectedContinuationEnd = parsed.append;
            } else {
              commandContent += parsed.append;
            }
          }
          parseResult.lineType = 'TAG';
          parseResult.tagName = 'command';
          parseResult.blockType = null;
          parseResult.codeContent = this._formatChannelCommand(channelType, commandContent, false);
          return true;
        }
        // Direct method call on channel root (e.g., myData.set(...)) - keep as-is.
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'command';
        parseResult.blockType = null;
        parseResult.codeContent = this._formatChannelCommand(channelType, trimmed, false);
        return true;
      }

      if (parsed.command === 'snapshot' && parsed.segments.length === 0) {
        return false;
      }

      const genericSyntaxCommand = this._transpileDataCommand(parsed, false, channelName);
      let commandContent = genericSyntaxCommand.substring(1); // remove '@'

      if (parsed.append) {
        if (parseResult.continuesToNext) {
          parseResult.expectedContinuationEnd = parsed.append;
        } else {
          commandContent += parsed.append;
        }
      }

      parseResult.lineType = 'TAG';
      parseResult.tagName = 'command';
      parseResult.blockType = null;
      parseResult.codeContent = this._formatChannelCommand(channelType, commandContent, false);
      return true;
    }

    if (channelType === 'sequence') {
      const parsed = this._parseDataCommandFromChannel(after, lineIndex);
      if (parsed.operatorUsed) {
        throw new Error(`sequence channel '${channelName}' does not support property assignment at line ${lineIndex + 1}`);
      }
      if (parsed.command === 'snapshot' && parsed.segments.length === 0) {
        return false;
      }
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'command';
      parseResult.blockType = null;
      parseResult.codeContent = this._formatChannelCommand(channelType, trimmed, false);
      return true;
    }

    if (channelType === 'var') {
      if (opStart === '(') {
        throw new Error(`var channel '${channelName}' does not support callable assignment at line ${lineIndex + 1}; use '${channelName} = ...'`);
      }
      return false;
    }

    parseResult.lineType = 'TAG';
    parseResult.tagName = 'command';
    parseResult.blockType = null;
    parseResult.codeContent = this._formatChannelCommand(channelType, trimmed, false);
    return true;
  }

  _parseChannelDeclaration(codeContent, lineIndex) {
    const trimmed = codeContent.trim();
    const channelType = this._getFirstWord(trimmed);
    if (!channelType) return null;
    if (!(channelType === 'data' || channelType === 'text' || channelType === 'sink' || channelType === 'sequence')) {
      return null;
    }

    const remainder = trimmed.substring(channelType.length).trim();
    const nameMatch = remainder.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (!nameMatch) {
      throw new Error(`Invalid channel declaration at line ${lineIndex + 1}`);
    }
    const name = nameMatch[1];
    if (this.RESERVED_DECLARATION_NAMES.has(name)) {
      throw new Error(`Identifier '${name}' is reserved and cannot be used as a variable or channel name at line ${lineIndex + 1}`);
    }
    const initializer = remainder.substring(name.length).trim();
    return { channelType, name, initializer };
  }

  _processChannelDeclaration(parseResult, lineIndex) {
    const decl = this._parseChannelDeclaration(parseResult.codeContent, lineIndex);
    if (!decl) {
      throw new Error(`Invalid channel declaration at line ${lineIndex + 1}`);
    }

    this.declareChannel(decl.name, decl.channelType);

    parseResult.lineType = 'TAG';
    parseResult.tagName = decl.channelType;
    parseResult.codeContent = parseResult.codeContent.substring(decl.channelType.length + 1).trim();
    parseResult.blockType = null;
  }

  _isChannelDeclarationLine(firstWord, codeContent) {
    if (!firstWord || !codeContent) return false;
    if (firstWord === 'sink' || firstWord === 'sequence') {
      // sink/sequence declarations must have an assignment
      return new RegExp(`^${firstWord}\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=`).test(codeContent);
    }
    if (firstWord === 'data' || firstWord === 'text') {
      // Matches variable declarations with optional initialization
      // Examples: "let myVar", "const foo = 5", "var x = 'hello'"
      // Pattern: keyword + identifier + optional (= value)
      return new RegExp(`^${firstWord}\\s+[A-Za-z_][A-Za-z0-9_]*(\\s*=.*)?$`).test(codeContent);
    }
    return false;
  }

  /**
   * Only 'text' needs more validations and continuation handling because the content is
   * between the '()' and for other cases content goes directly to the template tag unmodified
   */
  _processLine(line, state, lineIndex) {
    // Parse line with script parser
    const parseResult = parseTemplateLine(
      line,
      state.inMultiLineComment,
      state.stringState
    );
    // Extract comments and handle them first
    const comments = this._extractComments(parseResult.tokens);
    const codeTokens = this._filterOutComments(parseResult.tokens);

    parseResult.isCommentOnly = !this._hasNonWhitespaceCode(codeTokens) && comments.length > 0;
    parseResult.isEmpty = line.trim() === '';
    const rawCodeContent = this._tokensToCode(codeTokens);
    parseResult.codeContent = rawCodeContent.trimStart();
    if (/^guard\b/.test(parseResult.codeContent.trim())) {
      parseResult.codeContent = parseResult.codeContent.replace(
        /^(\s*guard\s+)(.*)$/,
        (_match, prefix, selectors) => {
          const normalized = selectors
            .split(',')
            .map((s) => {
              const trimmed = s.trim();
              return trimmed;
            })
            .join(', ');
          return `${prefix}${normalized}`;
        }
      );
    }

    parseResult.comments = [];
    for (let i = 0; i < comments.length; i++) {
      parseResult.comments.push(comments[i].content);
    }

    const firstWord = this._getFirstWord(parseResult.codeContent);
    const code = parseResult.codeContent.trim();
    const continuesFromPrev = this._continuesFromPrevious(code);

    // Check for semicolons in CODE tokens
    for (const token of parseResult.tokens) {
      if (token.type === 'CODE' && token.value.includes(';')) {
        throw new Error(`Semicolons are not allowed in Cascada Script: "${code}" at line ${lineIndex + 1}`);
      }
    }

    if (code.startsWith('@')) {
      throw new Error(`Legacy '@' channel commands are no longer supported at line ${lineIndex + 1}`);
    } else if (firstWord === 'value' && this._isAssignment(code, lineIndex)) {
      throw new Error(`Explicit 'value' declarations are no longer supported at line ${lineIndex + 1}`);
    } else if (firstWord === 'var') {
      this._processVar(parseResult, lineIndex);
    } else if (this._isChannelDeclarationLine(firstWord, code)) {
      this._processChannelDeclaration(parseResult, lineIndex);
    } else if (!continuesFromPrev && this._processOutputOperation(parseResult, lineIndex)) {
      // Channel operation was processed
    } else if ((firstWord === 'data' || firstWord === 'text' || firstWord === 'sink' || firstWord === 'sequence') &&
      this._isAssignment(code, lineIndex)) {
      this._processVar(parseResult, lineIndex, true);
    } else if (firstWord === 'endcapture') {
      throw new Error(`'endcapture' is no longer supported at line ${lineIndex + 1}`);
    } else if (this.RESERVED_KEYWORDS.has(firstWord)) {
      // Standard keyword processing
      parseResult.lineType = 'TAG';
      parseResult.codeContent = parseResult.codeContent.substring(firstWord.length + 1);//skip the first word
      parseResult.blockType = this._getBlockType(firstWord, code);
      parseResult.tagName = firstWord;

      if (firstWord === 'call' && parseResult.blockType === this.BLOCK_TYPE.START) {
        throw new Error(`Bare call blocks are not supported at line ${lineIndex + 1}; assign the call result (e.g. var x = call ... endcall).`);
      }

      if (firstWord === 'endcall') {
        // Close the innermost call-like block.
        // Only rewrite endcall -> endcall_assign when it closes a call_assign block.
        const topCallTag = this.callBlockStack.pop();
        if (topCallTag === 'call_assign') {
          parseResult.tagName = 'endcall_assign';
        }
      } else if (firstWord === 'endcall_assign') {
        // Keep stack consistent if endcall_assign appears directly.
        if (this.callBlockStack[this.callBlockStack.length - 1] === 'call_assign') {
          this.callBlockStack.pop();
        }
      }
    } else if (this._isAssignment(code, lineIndex)) {
      this._processVar(parseResult, lineIndex, true);
    }
    else {
      // a code line
      parseResult.lineType = 'CODE';
      parseResult.blockType = null;
    }

    parseResult.continuesToNext = parseResult.continuesToNext || this._willContinueToNextLine(codeTokens, parseResult.codeContent, firstWord);
    parseResult.continuesFromPrev = continuesFromPrev;

    //update the state used by the parser (it works only with state + current line)
    state.inMultiLineComment = parseResult.inMultiLineComment;
    state.stringState = parseResult.stringState;
    return parseResult;
  }

  _processContinuationsAndComments(parseResults) {
    let prevLineIndex = -1;//skips empty or comment-only lines, -1 for the initial empty/comment-only lines
    let tagLineParseResult;
    for (let i = 0; i < parseResults.length; i++) {
      const presult = parseResults[i];

      if (presult.lineType === 'TAG' || presult.lineType === 'TEXT') {
        //start of a new tag or text, save it for continuation
        tagLineParseResult = presult;
      } else {
        //p.lineType == 'CODE'
        if (presult.isEmpty || presult.isCommentOnly) {
          //skip for now, we may add isContinuation = true later
          continue;
        }
        if (prevLineIndex != -1 && (parseResults[prevLineIndex].continuesToNext || presult.continuesFromPrev)) {
          //this is continuation
          //mark everything between prevLineIndex+1 and i as continuation
          for (let j = prevLineIndex + 1; j <= i; j++) {
            parseResults[j].isContinuation = true;
            //merge the comments, the same for all continuation lines
            tagLineParseResult.comments = tagLineParseResult.comments.concat(parseResults[j].comments);
            //if (presult.lineType === 'TAG') {
            //  parseResults[j].tagName =  presult.tagName;
            //}
          }
          presult.comments = tagLineParseResult.comments;//we need the comments in the last line of continuation
          //inherit expectedContinuationEnd to the last continuation line
          //check if any line in the continuation sequence has expectedContinuationEnd
          let continuationEnd = tagLineParseResult.expectedContinuationEnd;
          for (let j = prevLineIndex + 1; j <= i; j++) {
            if (parseResults[j].expectedContinuationEnd) {
              continuationEnd = parseResults[j].expectedContinuationEnd;
              break;
            }
          }
          if (continuationEnd) {
            presult.expectedContinuationEnd = continuationEnd;
          }
        } else {
          // this is do tag, code not part of continuation but it can be start of continuation
          tagLineParseResult = presult;//all comments from continuations are added here
        }
      }
      prevLineIndex = i;//only empty or comment-only lines are skipped by continueFromIndex, for other cases it is i-1
    }
  }

  _updateChannelScopesForLine(processedLine) {
    if (!processedLine || processedLine.isContinuation) return;

    if (processedLine.blockType === this.BLOCK_TYPE.MIDDLE) {
      // New branch scope (else/elif/case/default/recover)
      const current = this.getCurrentChannelScope();
      const parentAccess = current ? current.parentAccess : 'inherit';
      this.popChannelScope();
      this.pushChannelScope(parentAccess);
      return;
    }

    if (processedLine.blockType === this.BLOCK_TYPE.START) {
      let parentAccess = 'inherit';
      if (processedLine.tagName === 'macro' || processedLine.tagName === 'var' || processedLine.tagName === 'set') {
        parentAccess = 'none';
      } else if (processedLine.tagName === 'call' || processedLine.tagName === 'call_assign') {
        parentAccess = 'readonly';
      }
      this.pushChannelScope(parentAccess);
      return;
    }

    if (processedLine.blockType === this.BLOCK_TYPE.END) {
      this.popChannelScope();
    }
  }

  _generateOutput(processedLine, nextIsContinuation, lastNonContinuationLineType, lineIndex) {
    let output = processedLine.indentation;
    let codeContent = processedLine.codeContent;

    if (!processedLine.isContinuation && processedLine.lineType === 'TAG') {
      if (processedLine.tagName === 'command') {
        codeContent = this._mapCoreChannelCall(codeContent);
      } else if (processedLine.tagName === 'data' || processedLine.tagName === 'text') {
        codeContent = this._mapCoreChannelName(codeContent || '');
      }
    }
    if (processedLine.inlinePrefix) {
      output = processedLine.inlinePrefix + output;
    }

    if (processedLine.isEmpty) {
      return output;
    }

    if (processedLine.isCommentOnly) {
      output += `{#- ${processedLine.comments.join('; ')} -#}`;
      return output;
    }

    if (!processedLine.isContinuation) {
      switch (processedLine.lineType) {
        case 'TAG': {
          let tagName = processedLine.tagName;
          if (tagName === 'each') {
            tagName = 'asyncEach';
          }
          output += `{%- ${tagName}`;
          break;
        }
        case 'TEXT':
          output += '{{-';
          break;
        case 'CODE':
          output += '{%- do';
          break;
      }
      if (codeContent) {
        //add space between tag and code content
        output += ' ';
      }
    }
    output += codeContent || '';

    if (!nextIsContinuation) {
      // Handle expectedContinuationEnd - remove the expected character from the last continuation line
      if (processedLine.expectedContinuationEnd && processedLine.isContinuation) {
        // This is the last line of a continuation that expects a specific ending character
        const trimmedContent = processedLine.codeContent.trim();
        if (trimmedContent.endsWith(processedLine.expectedContinuationEnd)) {
          // Remove the expected character from the end of the output
          const lastIndex = output.lastIndexOf(processedLine.expectedContinuationEnd);
          if (lastIndex !== -1) {
            // Remove the character but keep any whitespace after it
            output = output.substring(0, lastIndex) + output.substring(lastIndex + 1);
          } else {
            throw new Error(`Expected '${processedLine.expectedContinuationEnd}' at line ${lineIndex + 1}`);
          }
        }
      }

      //close the tag
      switch (lastNonContinuationLineType) {
        case 'CODE':
        case 'TAG':
          output += ' -%}';//close tag or do
          break;
        case 'TEXT':
          output += ' -}}';
          break;
      }

      //add the comments
      if (processedLine.comments.length) {
        output += `{#- ${processedLine.comments.join('; ')} -#}`;
      }
    }

    return output;
  }

  /**
   * Validate block structure of processed lines
   * @param {Array} processedLines - Array of processed line info objects
   * @throws {Error} If block structure is invalid
   */
  _validateBlockStructure(processedLines) {
    const stack = [];

    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i];

      if (!line.blockType || line.isContinuation) continue;

      const tag = line.tagName;//getFirstWord(line.codeContent);
      if (line.blockType === this.BLOCK_TYPE.START) {
        stack.push({ tag, line: i + 1 });
      }
      else if (line.blockType === this.BLOCK_TYPE.MIDDLE) {
        if (!stack.length) {
          throw new Error(`Line ${i + 1}: '${tag}' outside of any block (content: "${line.codeContent}")`);
        }

        const topTag = stack[stack.length - 1].tag;
        const validParents = this.SYNTAX.middleTags[tag] || [];

        if (!validParents.includes(topTag)) {
          throw new Error(`Line ${i + 1}: '${tag}' not valid in '${topTag}' block (content: "${line.codeContent}")`);
        }
      }
      else if (line.blockType === this.BLOCK_TYPE.END) {
        if (!stack.length) {
          throw new Error(`Line ${i + 1}: Unexpected '${tag}' (content: "${line.codeContent}")`);
        }

        const topTag = stack[stack.length - 1].tag;
        const expectedEndTag = this.SYNTAX.blockPairs[topTag];

        if (expectedEndTag !== tag) {
          throw new Error(`Line ${i + 1}: Unexpected '${tag}', was expecting '${expectedEndTag}' (content: "${line.codeContent}")`);
        }

        stack.pop();
      }
    }

    if (stack.length > 0) {
      throw new Error(`Unclosed block '${stack[stack.length - 1].tag}' at line ${stack[stack.length - 1].line}`);
    }
  }

  /**
   * Convert Cascada script to Nunjucks/Cascada template
   * @param {string} scriptStr - The input script string
   * @return {Object} Object with template string and possible error
   */
  scriptToTemplate(scriptStr, options = {}) {
    this._useCoreChannelAliases = !!options.useCoreOutputAliases;
    this.channelScopes = [this._createChannelScope()];
    this.callBlockStack = [];
    // Split into lines
    const lines = scriptStr.split('\n');

    // Initialize state
    const state = {
      inMultiLineComment: false,
      stringState: null,
    };

    // Process each line with lookahead for continuation detection
    const processedLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const processedLine = this._processLine(line, state, i);

      // Store processed line for potential reuse in lookahead
      processedLines.push(processedLine);
      if (!processedLine.isContinuation &&
        processedLine.lineType === 'TAG' &&
        processedLine.blockType === this.BLOCK_TYPE.START &&
        processedLine.tagName === 'call') {
        this.callBlockStack.push('call');
      }
      this._updateChannelScopesForLine(processedLine);

      if (processedLine.injectLines && processedLine.injectLines.length > 0) {
        processedLine.injectLines.forEach((injected) => {
          const injectedLine = this._processLine(injected, state, i);
          processedLines.push(injectedLine);
          this._updateChannelScopesForLine(injectedLine);
        });
      }
    }

    this._processContinuationsAndComments(processedLines);

    let output = '';
    let lastNonContinuationLineType = null;
    for (let i = 0; i < processedLines.length; i++) {
      if (!processedLines[i].isContinuation) {
        lastNonContinuationLineType = processedLines[i].lineType;
      }
      output += this._generateOutput(processedLines[i], processedLines[i + 1]?.isContinuation, lastNonContinuationLineType, i);
      if (i != processedLines.length - 1) {
        output += '\n';
      }
    }

    // Validate block structure
    this._validateBlockStructure(processedLines);

    return output;
  }

  _mapCoreChannelName(name) {
    if (!this._useCoreChannelAliases) {
      return name;
    }
    return this.CORE_CHANNEL_ALIASES[name] || name;
  }

  _mapCoreChannelCall(callString) {
    if (!this._useCoreChannelAliases) {
      return callString;
    }
    if (!callString) return callString;
    const match = callString.match(/^(\s*)([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/);
    if (!match) return callString;
    const mapped = this._mapCoreChannelName(match[2]);
    if (mapped === match[2]) return callString;
    return `${match[1]}${mapped}${match[3]}`;
  }

}

const transpiler = new ScriptTranspiler();
module.exports = transpiler;

