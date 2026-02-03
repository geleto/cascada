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
 *     - `extern config`       → `{% extern config %}`
 *
 * 3.  **Output Commands with `@`**
 *     - `@text(...)` is the dedicated command for generating text output.
 *       `@text("Hello")`      → `{% output text text("Hello") %}`
 *     - Data assembly commands build structured objects. The modern path-based
 *       syntax is converted to a generic handler call.
 *       `@data.user.id = 1`   → `{% output data data.set('user.id', 1) %}`
 *       `@data.tags.push("a")`→ `{% output data data.push('user.tags', "a") %}`
 *     - Generic commands are passed through.
 *       `@db.insert(...)`     → `{% output db db.insert(...) %}`
 *
 * 4.  **Output Focus Directives with `:`**
 *     - Script-level directives control the final output format.
 *       `:data`               → `{% option focus="data" %}`
 *
 * 5.  **Block Assignment with `capture`**
 *     - `var user = capture :data ... endcapture` becomes a `var` block.
 *       → `{% var user :data %}{#...#}{% endvar %}`
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
 * :data
 *
 * var userProfile = fetchProfile(1)
 *
 * @data.user.id = userProfile.id
 * @data.user.name = userProfile.name
 *
 * for task in userProfile.tasks
 *   @data.user.tasks.push(task.title)
 * endfor
 * ```
 *
 * Converts to:
 *
 * ```
 * {#- Assemble a user object from a profile -#}
 * {%- option focus="data" -%}
 *
 * {%- var userProfile = fetchProfile(1) -%}
 *
 * {%- output data data.set('user.id', userProfile.id) -%}
 * {%- output data data.set('user.name', userProfile.name) -%}
 *
 * {%- for task in userProfile.tasks -%}
 *   {%- output data data.push('user.tasks', task.title) -%}
 * {%- endfor -%}
 * ```
 *
 * The transpiler uses a line-by-line, token-based approach with a state machine
 * to handle complex cases like multi-line expressions, nested comments, and
 * block structure validation, ensuring robust and accurate conversion.
 */

// Import the script parser
const { parseTemplateLine, TOKEN_TYPES } = require('./script-lexer');

//this is only temporary, the implementation is vibe-coded and will be removed later
const ENABLE_INSERT_IMPLICIT_RETURN = true;

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
      lineTags: [/*'set',*/'include', 'extends', 'from', 'import', 'depends', 'option', 'var', 'extern', 'return', 'data', 'text', 'value', 'sink'],

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
        'guard': 'endguard',
        'capture': 'endcapture'
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

    // Track block stack for var/set blocks
    this.setBlockStack = []; // 'var' or 'set'
    // Track "var/set = call ... endcall" blocks so we can rewrite endcall -> endcall_assign.
    this.callAssignStack = [];

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

    // Output scopes track declared outputs in nested blocks.
    this.outputScopes = [this._createOutputScope()];
  }

  getCurrentOutputScope() {
    return this.outputScopes[this.outputScopes.length - 1];
  }

  _createOutputScope(parentAccess = 'inherit') {
    return {
      outputs: new Map(),
      parentAccess
    };
  }

  pushOutputScope(parentAccess = 'inherit') {
    this.outputScopes.push(this._createOutputScope(parentAccess));
  }

  popOutputScope() {
    if (this.outputScopes.length === 1) {
      return;
    }
    this.outputScopes.pop();
  }

  isOutputInScope(name) {
    let readOnly = false;
    for (let i = this.outputScopes.length - 1; i >= 0; i--) {
      const scope = this.outputScopes[i];
      if (scope.outputs.has(name)) {
        const info = scope.outputs.get(name);
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

  declareOutput(name, type) {
    const scope = this.getCurrentOutputScope();
    if (scope.outputs.has(name)) {
      throw new Error(`Output '${name}' already declared in this scope`);
    }
    scope.outputs.set(name, { type });
  }

  ensureOutputDeclared(name, type) {
    if (!this.isOutputInScope(name)) {
      this.declareOutput(name, type);
    }
  }

  /**
   * Validates path segments for the @data command syntax
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
   * @param {Boolean} wrapAssignmentValue - Whether to wrap assignment value in parens (for @data)
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
        // Comparison (==) is invalid in these contexts (LHS assignment or @data command).
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
        // Map operators to commands (e.g., += to .add) for @data usage. set_path currently only supports = (.set).

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
   * Breaks down a new @data command syntax into its components
   * @param {Array} tokens - Array of tokens from script-lexer
   * @param {number} lineIndex - Current line index for error reporting
   * @return {Object} Object with path, command, and args properties. Args may not be ')' terminated in a multi-line command.
   */
  _deconstructDataCommand(tokens, lineIndex) {
    let prefixBuffer = '';

    // Find where @data ends
    let i = 0;
    for (; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'COMMENT') continue;
      if (token.type !== 'CODE') throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Expected @data prefix.`);

      let found = false;
      for (let j = 0; j < token.value.length; j++) {
        const char = token.value[j];
        if (char.trim() === '') continue;
        prefixBuffer += char;

        if (prefixBuffer === '@data') {
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

        if (!'@data'.startsWith(prefixBuffer)) throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Expected @data prefix.`);
      }
      if (found) break;
    }

    // If loop finishes without returning, we failed
    throw new Error(`Invalid command syntax at line ${lineIndex + 1}: incomplete @data command.`);
  }

  /**
   * Converts new @data command syntax to the generic syntax
   * @param {Object} tcom - Parsed command object with path, command, and extra args (ending in ')' unless multiline
   * @return {string} The generic syntax command string
   */
  _transpileDataCommand(tcom, multiline, handlerName = 'data') {
    // Convert new syntax to generic syntax
    // @data: @data.user.name.set("Alice")
    // generic: @data.set(user.name, "Alice")
    // @data: @data.merge({ version: "1.1" })
    // generic: @data.merge(null, { version: "1.1" })

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

    return `@${handlerName}.${tcom.command}(${pathArgument}${addComma ? ',' : ''}${args}`;
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

  /**
   * Combines code tokens into a string
   * @param {Array} tokens - Array of tokens (excluding comments)
   * @return {string} Combined code string
   */
  _tokensToCode(tokens) {
    return tokens.map(token => token.value).join('');//.trim();
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

  _processVar(parseResult, lineIndex, isAssignment = false) {
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
      if (isAssignment) {
        // This should not be possible if _isAssignment works correctly
        throw new Error(`Invalid assignment state: "${content}" at line ${lineIndex + 1}`);
      }
      // These are declarations assigned to 'none'
      if (!this._isValidIdentifierList(content)) {
        throw new Error(`Invalid variable name in: "${content}" at line ${lineIndex + 1}`);
      }
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'var';
      parseResult.codeContent = `${content} = none`; // All vars assigned to none
      parseResult.blockType = null;

    } else {
      // CASE: Has assignment (e.g., `var x, y = 10` or `var x, y = capture...`)
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

      // Check for capture block
      const exprStr = content.substring(assignPos + 1).trim();
      const firstExprWord = this._getFirstWord(exprStr);

      if (firstExprWord === 'capture') {
        const captureContent = exprStr.substring('capture'.length).trim();
        parseResult.lineType = 'TAG';
        parseResult.blockType = 'START';
        parseResult.tagName = isAssignment ? 'set' : 'var';
        // For capture, the valid syntax is {% capture varName %} content {% endcapture %}
        // But here we support `var x = capture` or `x = capture`.
        // The transpiler usually emits `{% capture x %}...`

        // We need to pass the variable name to the capture tag
        parseResult.codeContent = `${targetsStr} ${captureContent}`;
        this.setBlockStack.push(parseResult.tagName);
      } else if (firstExprWord === 'call') {
        // "var x = call ... endcall" / "x = call ... endcall"
        // becomes an internal block tag that the parser/compiler understand.
        // This avoids a synthetic capture wrapper and keeps return semantics clean.
        const afterCall = exprStr.substring('call'.length).trim();
        parseResult.lineType = 'TAG';
        parseResult.blockType = 'START';
        parseResult.tagName = 'call_assign';
        parseResult.codeContent = `${isAssignment ? 'set' : 'var'} ${targetsStr} = ${afterCall}`;
        this.callAssignStack.push(true);
      } else {
        // Standard variable/set
        parseResult.lineType = 'TAG';
        parseResult.tagName = isAssignment ? 'set' : 'var';
        // content is already correct: "x = 10" or "var x = 10" -> "x = 10"
        parseResult.codeContent = content; // If isAssignment checks passed, this is fine
        parseResult.blockType = null;
      }
    }
  }

  _formatOutputCommand(outputType, commandContent, includeOutputType = false) {
    if (includeOutputType) {
      return `${outputType} ${commandContent}`;
    }
    return commandContent;
  }

  _isSnapshotCall(afterTrimmed) {
    return /^\.\s*snapshot\s*\(/.test(afterTrimmed);
  }

  _parseDataCommandFromOutput(after, lineIndex) {
    const { lex } = require('./script-lexer');
    const tokens = lex(after);

    const parsed = this._parsePathSegments(tokens, 0, true, true, true, lineIndex);
    const { segments, remainingBuffer, append, operator } = parsed;

    if (!remainingBuffer) {
      throw new Error(`Invalid output command syntax at line ${lineIndex + 1}: Missing arguments.`);
    }

    if (!remainingBuffer.startsWith('(')) {
      throw new Error(`Invalid output command syntax at line ${lineIndex + 1}: Expected '(...)' for arguments.`);
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
        throw new Error(`Invalid output command syntax at line ${lineIndex + 1}: Command cannot be a bracket expression.`);
      }
      command = commandSegment.slice(1);
      pathSegments = segments.slice(0, -1);
    }

    if (!this._isValidIdentifier(command)) {
      throw new Error(`Invalid output command syntax at line ${lineIndex + 1}: '${command}' is not a valid identifier.`);
    }

    if (pathSegments.length > 0) {
      this._validatePathSegments(pathSegments);
    }

    return {
      command,
      args,
      append,
      segments: pathSegments,
      directCall: pathSegments.length === 0 && !operator
    };
  }

  _processOutputOperation(parseResult, lineIndex) {
    const code = parseResult.codeContent;
    const trimmed = code.trimStart();
    const outputName = this._getLeadingIdentifier(trimmed);
    if (!outputName) return false;

    const outputInfo = this.isOutputInScope(outputName);
    if (!outputInfo) return false;
    const outputType = outputInfo.type;

    const after = trimmed.substring(outputName.length);
    const afterTrimmed = after.trimStart();
    if (!afterTrimmed) return false;

    const opStart = afterTrimmed[0];
    if (opStart === '=') return false;
    if (!['.', '(', '['].includes(opStart)) return false;

    if (this._isSnapshotCall(afterTrimmed)) {
      return false;
    }

    if (!outputInfo.writable) {
      throw new Error(`Output '${outputName}' is read-only in this scope at line ${lineIndex + 1}`);
    }

    if (outputType === 'data') {
      const parsed = this._parseDataCommandFromOutput(after, lineIndex);

      if (parsed.directCall) {
        // Direct method call on output root (e.g., myData.set(...)) - keep as-is.
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'output_command';
        parseResult.blockType = null;
        parseResult.codeContent = this._formatOutputCommand(outputType, trimmed, false);
        if (outputType === 'data' || outputType === 'text' || outputType === 'value') {
          parseResult.requiredOutputs = new Set([outputType]);
        }
        return true;
      }

      if (parsed.command === 'snapshot' && parsed.segments.length === 0) {
        return false;
      }

      const genericSyntaxCommand = this._transpileDataCommand(parsed, false, outputName);
      let commandContent = genericSyntaxCommand.substring(1); // remove '@'

      if (parsed.append) {
        if (parseResult.continuesToNext) {
          parseResult.expectedContinuationEnd = parsed.append;
        } else {
          commandContent += parsed.append;
        }
      }

      parseResult.lineType = 'TAG';
      parseResult.tagName = 'output_command';
      parseResult.blockType = null;
      parseResult.codeContent = this._formatOutputCommand(outputType, commandContent, false);
      if (outputType === 'data' || outputType === 'text' || outputType === 'value') {
        parseResult.requiredOutputs = new Set([outputType]);
      }
      return true;
    }

    if (outputType === 'value' && opStart !== '(') {
      return false;
    }

    parseResult.lineType = 'TAG';
    parseResult.tagName = 'output_command';
    parseResult.blockType = null;
    parseResult.codeContent = this._formatOutputCommand(outputType, trimmed, false);
    if (outputType === 'data' || outputType === 'text' || outputType === 'value') {
      parseResult.requiredOutputs = new Set([outputType]);
    }
    return true;
  }

  _processOutputCommand(parseResult, lineIndex) {
    // Find the @ symbol position and preserve all whitespace after it
    const atIndex = parseResult.codeContent.indexOf('@');
    let commandContent = parseResult.codeContent.substring(atIndex + 1); // Remove @ but keep all whitespace

    // Handle special syntax @value = ... -> @value(...)
    if (commandContent.trim().startsWith('value')) {
      const trimmed = commandContent.trim();
      const afterValue = trimmed.substring(5).trim(); // 5 is length of 'value'
      if (afterValue.startsWith('=')) {
        const expr = afterValue.substring(1).trim();
        // Preserve indentation/whitespace before 'value'
        const leadingSpace = commandContent.substring(0, commandContent.indexOf('value'));
        // Transform to function call syntax.
        // We add the closing parenthesis. If the expression is multiline,
        // we might ideally want the ')' at the end of the block.
        // Simple transformation: value(expr)
        // If expr contains newlines (e.g. from a prior transformation?), it keeps them.
        // Here we are processing a single logical line from the parser's perspective (though it might be continued later).
        commandContent = `${leadingSpace}value(${expr})`;
      }
    }

    // Check if this is a @text command (the current command for text output)
    let ccontent = commandContent.trim();
    let isText = ccontent.startsWith('text(') || this._getFirstWord(ccontent) === 'text';

    if (isText) {
      const outputInfo = this.isOutputInScope('text');
      if (outputInfo && outputInfo.writable === false) {
        throw new Error(`Output 'text' is read-only in this scope at line ${lineIndex + 1}`);
      }
      this.ensureOutputDeclared('text', 'text');
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'output_command';
      parseResult.blockType = null;
      parseResult.codeContent = commandContent.trimStart();
      parseResult.requiredOutputs = new Set(['text']);
    } else {
      // Check if this is the @data command syntax
      let isDataCommand = false;
      if (ccontent.startsWith('data')) {
        isDataCommand = ccontent.startsWith('data.') || ccontent.startsWith('data=') || ccontent.startsWith('data[');
        if (!isDataCommand) {
          //check if the first word is a valid identifier
          const afterData = ccontent.substring('data'.length).trim();
          // @data =, @data .push(, @data[](root indexing), @data[0](root indexing)
          isDataCommand = afterData.startsWith('.') || afterData.startsWith('=') || afterData.startsWith('[');
        }
      }
      if (isDataCommand) {
        // Parse the @data-specific syntax and convert to the generic syntax
        const parsedCommand = this._deconstructDataCommand(parseResult.tokens, lineIndex);
        const outputInfo = this.isOutputInScope('data');
        if (outputInfo && outputInfo.writable === false) {
          const isSnapshot = parsedCommand.command === 'snapshot' && !parsedCommand.path;
          if (!isSnapshot) {
            throw new Error(`Output 'data' is read-only in this scope at line ${lineIndex + 1}`);
          }
        }
        this.ensureOutputDeclared('data', 'data');
        let genericSyntaxCommand = this._transpileDataCommand(parsedCommand);
        if (parsedCommand.append) {
          if (parseResult.continuesToNext) {
            parseResult.expectedContinuationEnd = parsedCommand.append;//append at end of multiline
          } else {
            genericSyntaxCommand += parsedCommand.append;//append now
          }
        }

        // Update the parseResult with the converted command (strip leading "@")
        const rewritten = genericSyntaxCommand.startsWith('@')
          ? genericSyntaxCommand.substring(1)
          : genericSyntaxCommand;
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'output_command';
        parseResult.blockType = null;
        parseResult.codeContent = rewritten;
        parseResult.requiredOutputs = new Set(['data']);
      } else {
        // All other @ commands are treated as function commands
        // @print was deprecated and replaced with @text(value)
        parseResult.lineType = 'TAG';
        parseResult.tagName = 'output_command';
        parseResult.blockType = null;

        if ((this._getLeadingIdentifier(commandContent) || '_') === 'value') {
          const outputInfo = this.isOutputInScope('value');
          if (outputInfo && outputInfo.writable === false) {
            throw new Error(`Output 'value' is read-only in this scope at line ${lineIndex + 1}`);
          }
          this.ensureOutputDeclared('value', 'value');
          parseResult.lineType = 'TAG';
          parseResult.tagName = 'output_command';
          parseResult.blockType = null;
          parseResult.codeContent = commandContent.trimStart();
          parseResult.requiredOutputs = new Set(['value']);
        } else {
          parseResult.codeContent = commandContent; // The content for the Nunjucks tag
          const handlerName = this._getLeadingIdentifier(commandContent);
          if (handlerName) {
            const outputInfo = this.isOutputInScope(handlerName);
            if (outputInfo && outputInfo.writable === false) {
              throw new Error(`Output '${handlerName}' is read-only in this scope at line ${lineIndex + 1}`);
            }
            parseResult.requiredOutputs = new Set([handlerName]);
          }
        }
      }
    }
  }

  _processFocusDirective(parseResult, lineIndex) {
    // Handle :data/text/handleName output focus directive
    const code = parseResult.codeContent.trim();
    const focus = code.substring(1); // Remove : but keep the directive name
    if (!focus) {
      throw new Error(`Invalid output focus: "${parseResult.codeContent}"`);
    }
    parseResult.lineType = 'TAG';
    parseResult.tagName = 'option';
    parseResult.blockType = null;//no block
    parseResult.codeContent = `focus="${focus}"`;
  }

  _processExtern(parseResult, lineIndex) {
    const code = parseResult.codeContent.trim();
    const externContent = code.substring('extern'.length).trim();

    if (!externContent) {
      throw new Error(`extern declaration must specify variable names at line ${lineIndex + 1}`);
    }

    if (!this._isValidIdentifierList(externContent)) {
      throw new Error(`Invalid variable name in extern declaration: "${externContent}" at line ${lineIndex + 1}`);
    }

    parseResult.lineType = 'TAG';
    parseResult.tagName = 'extern';
    parseResult.codeContent = externContent;
    parseResult.blockType = null; // extern is always a line tag
  }

  _parseOutputDeclaration(codeContent, lineIndex) {
    const trimmed = codeContent.trim();
    const outputType = this._getFirstWord(trimmed);
    if (!outputType) return null;
    if (!(outputType === 'data' || outputType === 'text' || outputType === 'value' || outputType === 'sink')) {
      return null;
    }

    const remainder = trimmed.substring(outputType.length).trim();
    const nameMatch = remainder.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (!nameMatch) {
      throw new Error(`Invalid output declaration at line ${lineIndex + 1}`);
    }
    const name = nameMatch[1];
    const initializer = remainder.substring(name.length).trim();
    return { outputType, name, initializer };
  }

  _processOutputDeclaration(parseResult, lineIndex) {
    const decl = this._parseOutputDeclaration(parseResult.codeContent, lineIndex);
    if (!decl) {
      throw new Error(`Invalid output declaration at line ${lineIndex + 1}`);
    }

    this.declareOutput(decl.name, decl.outputType);

    parseResult.lineType = 'TAG';
    parseResult.tagName = decl.outputType;
    parseResult.codeContent = parseResult.codeContent.substring(decl.outputType.length + 1).trim();
    parseResult.blockType = null;
  }

  _isOutputDeclarationLine(firstWord, codeContent) {
    if (!firstWord || !codeContent) return false;
    if (firstWord === 'sink') {
      // Sink declarations must have an assignment (e.g., "sink x = value")
      return /^sink\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(codeContent);
    }
    if (firstWord === 'data' || firstWord === 'text' || firstWord === 'value') {
      // Matches variable declarations with optional initialization
      // Examples: "let myVar", "const foo = 5", "var x = 'hello'"
      // Pattern: keyword + identifier + optional (= value)
      return new RegExp(`^${firstWord}\\s+[A-Za-z_][A-Za-z0-9_]*(\\s*=.*)?$`).test(codeContent);
    }
    return false;
  }

  /**
   * Only '@text' needs more validations and continuation handling because the content is
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

    parseResult.isCommentOnly = codeTokens.length === 0 && comments.length > 0;
    parseResult.isEmpty = line.trim() === '';
    parseResult.codeContent = this._tokensToCode(codeTokens);

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
      this._processOutputCommand(parseResult, lineIndex);
    } else if (code.startsWith(':')) {
      this._processFocusDirective(parseResult, lineIndex);
    } else if (firstWord === 'var') {
      this._processVar(parseResult, lineIndex);
    } else if (firstWord === 'extern') {
      this._processExtern(parseResult, lineIndex);
    } else if (this._isOutputDeclarationLine(firstWord, code)) {
      this._processOutputDeclaration(parseResult, lineIndex);
    } else if (!continuesFromPrev && this._processOutputOperation(parseResult, lineIndex)) {
      // Output operation was processed
    } else if ((firstWord === 'data' || firstWord === 'text' || firstWord === 'value' || firstWord === 'sink') &&
      this._isAssignment(code, lineIndex)) {
      this._processVar(parseResult, lineIndex, true);
    } else if (firstWord === 'endcapture') {
      if (this.setBlockStack.length === 0) {
        throw new Error(`Unexpected 'endcapture' at line ${lineIndex + 1} - no matching var/set block found`);
      }
      const tag = this.setBlockStack.pop();
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'end' + tag;
      parseResult.codeContent = parseResult.codeContent.substring('endcapture'.length).trim();
      parseResult.blockType = this.BLOCK_TYPE.END;
    } else if (this.RESERVED_KEYWORDS.has(firstWord)) {
      // Standard keyword processing
      parseResult.lineType = 'TAG';
      parseResult.codeContent = parseResult.codeContent.substring(firstWord.length + 1);//skip the first word
      parseResult.blockType = this._getBlockType(firstWord, code);
      parseResult.tagName = firstWord;

      if (firstWord === 'endcall' && this.callAssignStack.length > 0) {
        // Close "var/set = call ... endcall" assignment blocks.
        // The start tag is emitted as `call_assign`, so we rewrite endcall -> endcall_assign.
        this.callAssignStack.pop();
        parseResult.tagName = 'endcall_assign';
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

      // Check if this is an option tag that should continue the previous macro/var/set definition
      // Check if this is an option tag that should continue the previous macro/var/set definition
      let isOptionContinuation = false;
      if (presult.tagName === 'option' && prevLineIndex !== -1) {
        const prevTag = parseResults[prevLineIndex].tagName;
        if (['macro', 'call'].includes(prevTag)) {
          isOptionContinuation = true;
        } else if (['var', 'set'].includes(prevTag)) {
          // Only allow if it's a block set/var (no =) or capture assignment
          const prevTokens = parseResults[prevLineIndex].tokens;
          const hasEquals = prevTokens.some(t => t.type === 'CODE' && t.value.includes('='));
          const hasCapture = prevTokens.some(t => t.type === 'CODE' && /\bcapture\b/.test(t.value));
          if (!hasEquals || hasCapture) {
            isOptionContinuation = true;
          }
        }
      }

      if ((presult.lineType === 'TAG' && !isOptionContinuation) || presult.lineType === 'TEXT') {
        //start of a new tag or text, save it for continuation
        tagLineParseResult = presult;
      } else {
        //p.lineType == 'CODE'
        if (presult.isEmpty || presult.isCommentOnly) {
          //skip for now, we may add isContinuation = true later
          continue;
        }
        if (prevLineIndex != -1 && (parseResults[prevLineIndex].continuesToNext || presult.continuesFromPrev || isOptionContinuation)) {
          //this is continuation
          if (isOptionContinuation) {
            // Revert option tag to raw content for continuation (e.g. ": data" instead of focusing directive)
            presult.codeContent = this._tokensToCode(this._filterOutComments(presult.tokens));
          }

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

  _updateOutputScopesForLine(processedLine) {
    if (!processedLine || processedLine.isContinuation) return;

    if (processedLine.blockType === this.BLOCK_TYPE.MIDDLE) {
      // New branch scope (else/elif/case/default/recover)
      const current = this.getCurrentOutputScope();
      const parentAccess = current ? current.parentAccess : 'inherit';
      this.popOutputScope();
      this.pushOutputScope(parentAccess);
      return;
    }

    if (processedLine.blockType === this.BLOCK_TYPE.START) {
      let parentAccess = 'inherit';
      if (processedLine.tagName === 'macro' || processedLine.tagName === 'var' || processedLine.tagName === 'set') {
        parentAccess = 'none';
      } else if (processedLine.tagName === 'call' || processedLine.tagName === 'call_assign') {
        parentAccess = 'readonly';
      }
      this.pushOutputScope(parentAccess);
      return;
    }

    if (processedLine.blockType === this.BLOCK_TYPE.END) {
      this.popOutputScope();
    }
  }

  _generateOutput(processedLine, nextIsContinuation, lastNonContinuationLineType, lineIndex) {
    let output = processedLine.indentation;
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
      if (processedLine.codeContent) {
        //add space between tag and code content
        output += ' ';
      }
    }
    output += processedLine.codeContent;

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
  scriptToTemplate(scriptStr) {
    this.outputScopes = [this._createOutputScope()];
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
      this._updateOutputScopesForLine(processedLine);

      if (processedLine.injectLines && processedLine.injectLines.length > 0) {
        processedLine.injectLines.forEach((injected) => {
          const injectedLine = this._processLine(injected, state, i);
          processedLines.push(injectedLine);
          this._updateOutputScopesForLine(injectedLine);
        });
      }
    }

    this._processContinuationsAndComments(processedLines);

    const hasExplicitReturn = this._hasTopLevelReturn(processedLines);
    const focusDirective = this._getRootFocus(processedLines);
    const forceRootOutputs = ENABLE_INSERT_IMPLICIT_RETURN && !hasExplicitReturn && !focusDirective;

    const withOutputDeclarations = this._insertOutputDeclarations(processedLines, {
      forceRootOutputs,
      // Do not force core outputs into every macro/call/capture scope.
      // Only inject outputs that are actually required/used (plus root defaults when needed).
      // This avoids conflicts with common parameter/variable names like "value".
      forceMacroCallOutputs: false,
      forceCaptureOutputs: false
    });
    const outputLines = ENABLE_INSERT_IMPLICIT_RETURN
      ? this._insertImplicitReturns(withOutputDeclarations)
      : withOutputDeclarations;

    let output = '';
    let lastNonContinuationLineType = null;
    for (let i = 0; i < outputLines.length; i++) {
      if (!outputLines[i].isContinuation) {
        lastNonContinuationLineType = outputLines[i].lineType;
      }
      output += this._generateOutput(outputLines[i], outputLines[i + 1]?.isContinuation, lastNonContinuationLineType, i);
      if (i != outputLines.length - 1) {
        output += '\n';
      }
    }

    // Validate block structure
    this._validateBlockStructure(processedLines);

    const rootConflicts = this._getRootConflicts();

    if (ENABLE_INSERT_IMPLICIT_RETURN && !hasExplicitReturn) {
      const returnExpr = focusDirective
        ? this._buildFocusedReturnExpression(focusDirective, rootConflicts)
        : this._buildUnfocusedReturnExpression(rootConflicts);
      const implicitReturn = `{% return ${returnExpr} %}`;
      if (output.length > 0) {
        output += '\n';
      }
      output += implicitReturn;
    }

    return output;
  }

  _hasTopLevelReturn(processedLines) {
    const ignoreStack = [];

    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i];
      if (line.isContinuation || line.lineType !== 'TAG') {
        continue;
      }

      if (line.blockType === this.BLOCK_TYPE.START) {
        if (line.tagName === 'macro' || line.tagName === 'var' || line.tagName === 'set' || line.tagName === 'call' || line.tagName === 'call_assign') {
          ignoreStack.push(line.tagName);
        }
      } else if (line.blockType === this.BLOCK_TYPE.END) {
        const top = ignoreStack[ignoreStack.length - 1];
        if ((line.tagName === 'endmacro' && top === 'macro') ||
          (line.tagName === 'endvar' && top === 'var') ||
          (line.tagName === 'endset' && top === 'set') ||
          (line.tagName === 'endcall' && top === 'call') ||
          (line.tagName === 'endcall_assign' && top === 'call_assign')) {
          ignoreStack.pop();
        }
      }

      if (line.tagName === 'return' && ignoreStack.length === 0) {
        return true;
      }
    }

    return false;
  }

  _extractFocusFromTag(processedLines, startIndex) {
    let combined = processedLines[startIndex].codeContent || '';
    for (let i = startIndex + 1; i < processedLines.length; i++) {
      const line = processedLines[i];
      if (!line.isContinuation) break;
      if (line.codeContent) {
        combined += ' ' + line.codeContent.trim();
      }
    }

    const match = combined.match(/:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return match ? match[1] : null;
  }

  _makeImplicitReturnLine(focus, indentation) {
    let codeContent;
    if (focus) {
      codeContent = `${focus}.snapshot()`;
    } else {
      codeContent = this._buildUnfocusedReturnExpression(this._getRootConflicts());
    }
    return {
      indentation: indentation || '',
      lineType: 'TAG',
      tagName: 'return',
      codeContent,
      blockType: null,
      comments: [],
      isContinuation: false,
      isEmpty: false,
      isCommentOnly: false,
      continuesToNext: false,
      continuesFromPrev: false,
      tokens: []
    };
  }

  _getRootFocus(processedLines) {
    let focusDirective = null;
    processedLines.forEach((line) => {
      if (line.tagName !== 'option') {
        return;
      }
      const match = line.codeContent && line.codeContent.match(/focus\s*=\s*["']([^"']+)["']/);
      if (match && match[1]) {
        focusDirective = match[1];
      }
    });
    return focusDirective;
  }

  _getRootConflicts() {
    return this._lastRootOutputScope ? this._lastRootOutputScope.conflictingNames : null;
  }

  _getSnapshotTargetName(name, conflicts) {
    if (conflicts && conflicts.has(name)) {
      return `@${name}`;
    }
    return name;
  }

  _buildFocusedReturnExpression(focusDirective, conflicts) {
    if (!focusDirective) return 'undefined';
    if (focusDirective === 'data' || focusDirective === 'text' || focusDirective === 'value') {
      const target = this._getSnapshotTargetName(focusDirective, conflicts);
      return `${target}.snapshot()`;
    }
    const rootScope = this._lastRootOutputScope;
    if (rootScope && rootScope.declaredOutputs && rootScope.declaredOutputs.has(focusDirective)) {
      const target = this._getSnapshotTargetName(focusDirective, conflicts);
      return `${target}.snapshot()`;
    }
    throw new Error(`Output focus '${focusDirective}' must be declared (e.g. 'sink ${focusDirective} = ...')`);
  }

  _buildFocusedReturnExpressionForScope(focusDirective, conflicts, declaredOutputs, forceDirectCore = false) {
    if (!focusDirective) return 'undefined';
    if (focusDirective === 'data' || focusDirective === 'text' || focusDirective === 'value') {
      if (forceDirectCore || (declaredOutputs && declaredOutputs.has(focusDirective))) {
        const target = this._getSnapshotTargetName(focusDirective, conflicts);
        return `${target}.snapshot()`;
      }
      if (forceDirectCore) {
        return 'undefined';
      }
      return `@${focusDirective}.snapshot()`;
    }
    if (declaredOutputs && declaredOutputs.has(focusDirective)) {
      const target = this._getSnapshotTargetName(focusDirective, conflicts);
      return `${target}.snapshot()`;
    }
    throw new Error(`Output focus '${focusDirective}' must be declared in this scope (e.g. 'sink ${focusDirective} = ...')`);
  }

  _buildUnfocusedReturnExpression(conflicts) {
    const rootScope = this._lastRootOutputScope;
    const includeOutputs = new Set();
    const declaredOutputs = rootScope?.declaredOutputs || new Set();
    const requiredOutputs = rootScope?.requiredOutputs || new Set();

    if (rootScope) {
      // Only core outputs are implicitly returned. Custom command handlers must
      // be returned explicitly via sinks (or explicit return statements).
      requiredOutputs.forEach((name) => {
        if (name === 'data' || name === 'text' || name === 'value') {
          includeOutputs.add(name);
        }
      });
      declaredOutputs.forEach((name) => includeOutputs.add(name));
    }

    if (this._lastOutputScopes) {
      this._lastOutputScopes.forEach((scope) => {
        if (!scope || scope === rootScope) return;
        if (scope.type === 'capture') return;
        const scopeDeclared = scope.declaredOutputs || new Set();
        (scope.requiredOutputs || new Set()).forEach((name) => {
          // Only carry core outputs implicitly; sinks must be declared.
          if ((name === 'data' || name === 'text' || name === 'value') && !scopeDeclared.has(name)) {
            includeOutputs.add(name);
          }
        });
      });
    }

    if (includeOutputs.size === 0) {
      return '{}';
    }

    const parts = [];
    includeOutputs.forEach((name) => {
      let target;
      if (declaredOutputs.has(name)) {
        target = this._getSnapshotTargetName(name, conflicts);
      } else if (name === 'data' || name === 'text' || name === 'value') {
        target = this._getSnapshotTargetName(name, conflicts);
      } else {
        target = name;
      }
      parts.push(`${name}: ${target}.snapshot()`);
    });

    return `{${parts.join(', ')} }`;
  }

  _getOutputsToInject(scope) {
    const required = new Set();
    // Only auto-inject core outputs. Sinks require explicit initializers and
    // custom command handlers should be accessed via declared sinks.
    (scope.requiredOutputs || []).forEach((name) => {
      if (name === 'data' || name === 'text' || name === 'value') {
        required.add(name);
      }
    });
    if (scope.focus && (scope.focus === 'data' || scope.focus === 'text' || scope.focus === 'value')) {
      required.add(scope.focus);
    }
    return Array.from(required);
  }

  _makeOutputDeclarationLine(outputType, indentation) {
    return {
      indentation: indentation || '',
      lineType: 'TAG',
      tagName: outputType,
      codeContent: outputType,
      blockType: null,
      comments: [],
      isContinuation: false,
      isEmpty: false,
      isCommentOnly: false,
      continuesToNext: false,
      continuesFromPrev: false,
      tokens: []
    };
  }

  _formatInlineOutputDeclaration(outputType, indentation) {
    const indent = indentation || '';
    if (outputType !== 'data' && outputType !== 'text' && outputType !== 'value') {
      return '';
    }
    return `${indent}{%- ${outputType} ${outputType} -%}`;
  }

  _collectIdentifierConflicts(targetsStr, conflicts) {
    if (!targetsStr) return;
    targetsStr.split(',').forEach((raw) => {
      const name = raw.split('=')[0].trim();
      if (!name) return;
      if (name === 'data' || name === 'text' || name === 'value') {
        conflicts.add(name);
      }
    });
  }

  _parseMacroParams(codeContent) {
    if (!codeContent) return [];
    const openIdx = codeContent.indexOf('(');
    if (openIdx === -1) return [];
    const closeIdx = codeContent.indexOf(')', openIdx + 1);
    if (closeIdx === -1) return [];
    const paramsStr = codeContent.substring(openIdx + 1, closeIdx).trim();
    if (!paramsStr) return [];
    return paramsStr.split(',').map((p) => p.trim()).filter(Boolean);
  }

  _parseCallParams(codeContent) {
    if (!codeContent) return [];
    const withoutFocus = codeContent.replace(/:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/, '').trim();
    const match = withoutFocus.match(/\)\s*\(([^)]*)\)\s*$/);
    if (!match) return [];
    const paramsStr = match[1].trim();
    if (!paramsStr) return [];
    return paramsStr.split(',').map((p) => p.trim()).filter(Boolean);
  }

  _insertOutputDeclarations(processedLines, options = {}) {
    const scopes = [];
    const scopeStack = [];
    const rootScope = {
      type: 'root',
      startIndex: 0,
      endIndex: processedLines.length,
      endTag: null,
      focus: this._getRootFocus(processedLines),
      declaredOutputs: new Set(),
      requiredOutputs: new Set(),
      conflictingNames: new Set(),
      insertionIndex: 0,
      indentation: ''
    };
    this._lastRootOutputScope = rootScope;
    scopes.push(rootScope);
    scopeStack.push(rootScope);
    this._lastOutputScopes = scopes;
    this._lastOutputScopeByStart = new Map();
    this._lastOutputScopeByStart.set(rootScope.startIndex, rootScope);

    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i];

      if (!line.isContinuation && line.lineType === 'TAG') {
        const isMacroStart = line.blockType === this.BLOCK_TYPE.START && line.tagName === 'macro';
        const isCallStart = line.blockType === this.BLOCK_TYPE.START && (line.tagName === 'call' || line.tagName === 'call_assign');
        const isCaptureStart = line.blockType === this.BLOCK_TYPE.START &&
          (line.tagName === 'var' || line.tagName === 'set');

        if (isMacroStart || isCallStart || isCaptureStart) {
          const focus = this._extractFocusFromTag(processedLines, i);
          const scope = {
            type: isMacroStart ? 'macro' : (isCallStart ? 'call' : 'capture'),
            startIndex: i,
            endIndex: null,
            endTag: isMacroStart
              ? 'endmacro'
              : (isCallStart ? (line.tagName === 'call_assign' ? 'endcall_assign' : 'endcall') : `end${line.tagName}`),
            focus,
            declaredOutputs: new Set(),
            requiredOutputs: new Set(),
            conflictingNames: new Set(),
            insertionIndex: null,
            indentation: ''
          };
          scopes.push(scope);
          scopeStack.push(scope);
          this._lastOutputScopeByStart.set(scope.startIndex, scope);

          if (isMacroStart) {
            const params = this._parseMacroParams(line.codeContent);
            this._collectIdentifierConflicts(params.join(','), scope.conflictingNames);
          } else if (isCallStart) {
            const params = this._parseCallParams(line.codeContent);
            this._collectIdentifierConflicts(params.join(','), scope.conflictingNames);
          }
        }
      }

      if (!line.isContinuation && line.lineType === 'TAG' &&
        (line.tagName === 'data' || line.tagName === 'text' || line.tagName === 'value' || line.tagName === 'sink')) {
        const name = this._getFirstWord(line.codeContent || '');
        if (name) {
          scopeStack[scopeStack.length - 1].declaredOutputs.add(name);
        }
      }

      if (!line.isContinuation && line.lineType === 'TAG' && line.tagName === 'output') {
        const handlerName = this._getFirstWord(line.codeContent || '');
        if (handlerName === 'data' || handlerName === 'text' || handlerName === 'value') {
          scopeStack[scopeStack.length - 1].requiredOutputs.add(handlerName);
        }
      }

      if (line.requiredOutputs && line.requiredOutputs.size > 0) {
        line.requiredOutputs.forEach((outputName) => {
          scopeStack[scopeStack.length - 1].requiredOutputs.add(outputName);
        });
      }

      if (!line.isContinuation && line.lineType === 'TAG' &&
        (line.tagName === 'var' || line.tagName === 'extern')) {
        const lhs = (line.codeContent || '').split('=')[0].trim();
        this._collectIdentifierConflicts(lhs, scopeStack[scopeStack.length - 1].conflictingNames);
      }

      if (!line.isContinuation && line.lineType === 'TAG' && line.blockType === this.BLOCK_TYPE.END) {
        const scope = scopeStack[scopeStack.length - 1];
        if (scope && scope.endTag === line.tagName) {
          scope.endIndex = i;
          scopeStack.pop();
        }
      }
    }

    scopes.forEach((scope) => {
      let insertionIndex = 0;
      if (scope.type === 'root') {
        let i = 0;
        while (i < processedLines.length) {
          const line = processedLines[i];
          if (line.isEmpty || line.isCommentOnly) {
            i++;
            continue;
          }
          if (!line.isContinuation && line.lineType === 'TAG' && line.tagName === 'option') {
            i++;
            while (i < processedLines.length && processedLines[i].isContinuation) {
              i++;
            }
            continue;
          }
          break;
        }
        insertionIndex = i;
      } else {
        let i = scope.startIndex + 1;
        while (i < processedLines.length && processedLines[i].isContinuation) {
          i++;
        }
        insertionIndex = i;
      }
      scope.insertionIndex = insertionIndex;

      const startIndentation = processedLines[scope.startIndex]?.indentation || '';
      let indentation = scope.type === 'root' ? '' : (startIndentation + '  ');
      for (let i = insertionIndex; i < (scope.endIndex ?? processedLines.length); i++) {
        const line = processedLines[i];
        if (line.isEmpty || line.isCommentOnly || line.isContinuation) {
          continue;
        }
        indentation = line.indentation || indentation;
        break;
      }
      scope.indentation = indentation;
    });

    const injectionMap = new Map();
    scopes.forEach((scope) => {
      const outputsToInject = new Set(this._getOutputsToInject(scope));
      if (options.forceRootOutputs && scope.type === 'root') {
        outputsToInject.add('data');
        outputsToInject.add('text');
        outputsToInject.add('value');
      }
      if (options.forceMacroCallOutputs && (scope.type === 'macro' || scope.type === 'call')) {
        outputsToInject.add('data');
        outputsToInject.add('text');
        outputsToInject.add('value');
      }
      if (options.forceCaptureOutputs && scope.type === 'capture') {
        outputsToInject.add('data');
        outputsToInject.add('text');
        outputsToInject.add('value');
      }
      const inlineChunks = [];
      outputsToInject.forEach((outputType) => {
        if (!scope.declaredOutputs.has(outputType)) {
          inlineChunks.push(this._formatInlineOutputDeclaration(outputType, scope.indentation));
        }
      });
      if (inlineChunks.length) {
        injectionMap.set(scope.insertionIndex, (injectionMap.get(scope.insertionIndex) || []).concat(inlineChunks));
      }
    });

    injectionMap.forEach((chunks, index) => {
      if (!chunks || chunks.length === 0) return;
      let targetIndex = index;
      while (targetIndex < processedLines.length && processedLines[targetIndex].isContinuation) {
        targetIndex++;
      }
      if (targetIndex >= processedLines.length) {
        processedLines.push({
          indentation: '',
          lineType: 'TEXT',
          tagName: null,
          codeContent: '',
          blockType: null,
          comments: [],
          isContinuation: false,
          isEmpty: true,
          isCommentOnly: false,
          continuesToNext: false,
          continuesFromPrev: false,
          tokens: []
        });
      }
      const line = processedLines[targetIndex];
      line.inlinePrefix = (line.inlinePrefix || '') + chunks.join('');
    });

    return processedLines;
  }

  _insertImplicitReturns(processedLines) {
    const result = [];
    const scopeStack = [];

    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i];

      if (!line.isContinuation && line.lineType === 'TAG') {
        const isMacroStart = line.blockType === this.BLOCK_TYPE.START && line.tagName === 'macro';
        const isCallStart = line.blockType === this.BLOCK_TYPE.START && (line.tagName === 'call' || line.tagName === 'call_assign');
        const isCaptureStart = line.blockType === this.BLOCK_TYPE.START &&
          (line.tagName === 'var' || line.tagName === 'set');

        if (isMacroStart || isCallStart || isCaptureStart) {
          const focus = this._extractFocusFromTag(processedLines, i);
          const scopeInfo = this._lastOutputScopeByStart ? this._lastOutputScopeByStart.get(i) : null;
          scopeStack.push({
            type: isMacroStart ? 'macro' : (isCallStart ? 'call' : 'capture'),
            endTag: isMacroStart
              ? 'endmacro'
              : (isCallStart ? (line.tagName === 'call_assign' ? 'endcall_assign' : 'endcall') : `end${line.tagName}`),
            focus,
            hasExplicitReturn: false,
            scopeInfo
          });
        }

        if (line.tagName === 'return') {
          const scope = scopeStack[scopeStack.length - 1];
          if (scope) {
            scope.hasExplicitReturn = true;
          }
        }

        if (line.blockType === this.BLOCK_TYPE.END) {
          const scope = scopeStack[scopeStack.length - 1];
          if (scope && line.tagName === scope.endTag) {
            if (!scope.hasExplicitReturn) {
              if (scope.scopeInfo && scope.focus && (scope.type === 'capture' || scope.type === 'macro' || scope.type === 'call')) {
                const declaredOutputs = scope.scopeInfo.declaredOutputs;
                const forceDirectCore = true;
                const returnExpr = this._buildFocusedReturnExpressionForScope(
                  scope.focus,
                  scope.scopeInfo.conflictingNames,
                  declaredOutputs,
                  forceDirectCore
                );
                result.push({
                  indentation: line.indentation || '',
                  lineType: 'TAG',
                  tagName: 'return',
                  codeContent: returnExpr,
                  blockType: null,
                  comments: [],
                  isContinuation: false,
                  isEmpty: false,
                  isCommentOnly: false,
                  continuesToNext: false,
                  continuesFromPrev: false,
                  tokens: []
                });
              } else if (scope.scopeInfo && !scope.focus && (scope.type === 'macro' || scope.type === 'call' || scope.type === 'capture')) {
                const declaredOutputs = scope.scopeInfo.declaredOutputs || new Set();
                const requiredOutputs = scope.scopeInfo.requiredOutputs || new Set();
                const includeOutputs = new Set();
                requiredOutputs.forEach((name) => {
                  if (name === 'data' || name === 'text' || name === 'value') {
                    includeOutputs.add(name);
                  }
                });
                declaredOutputs.forEach((name) => includeOutputs.add(name));
                let returnExpr;
                if (includeOutputs.size === 0) {
                  returnExpr = '{}';
                } else {
                  const parts = [];
                  includeOutputs.forEach((name) => {
                    let target;
                    if (declaredOutputs.has(name) || name === 'data' || name === 'text' || name === 'value') {
                      target = this._getSnapshotTargetName(name, scope.scopeInfo.conflictingNames);
                    } else {
                      target = name;
                    }
                    parts.push(`${name}: ${target}.snapshot()`);
                  });
                  returnExpr = `{${parts.join(', ')} }`;
                }

                result.push({
                  indentation: line.indentation || '',
                  lineType: 'TAG',
                  tagName: 'return',
                  codeContent: returnExpr,
                  blockType: null,
                  comments: [],
                  isContinuation: false,
                  isEmpty: false,
                  isCommentOnly: false,
                  continuesToNext: false,
                  continuesFromPrev: false,
                  tokens: []
                });
              } else if (scope.focus && scope.scopeInfo) {
                const returnExpr = this._buildFocusedReturnExpressionForScope(
                  scope.focus,
                  scope.scopeInfo.conflictingNames,
                  scope.scopeInfo.declaredOutputs,
                  true
                );
                result.push({
                  indentation: line.indentation || '',
                  lineType: 'TAG',
                  tagName: 'return',
                  codeContent: returnExpr,
                  blockType: null,
                  comments: [],
                  isContinuation: false,
                  isEmpty: false,
                  isCommentOnly: false,
                  continuesToNext: false,
                  continuesFromPrev: false,
                  tokens: []
                });
              } else {
                result.push(this._makeImplicitReturnLine(scope.focus, line.indentation));
              }
            }
            scopeStack.pop();
          }
        }
      }

      result.push(line);
    }

    return result;
  }

}

module.exports = new ScriptTranspiler();
