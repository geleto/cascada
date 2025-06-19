/**
 * Cascada Script to Template Converter
 *
 * Converts Cascada script syntax to Nunjucks/Cascada template syntax.
 * Uses script-lexer for token extraction and handling.
 *
 * Cascada scripts provide a cleaner syntax for writing Cascada templates with less visual noise.
 * This module converts Cascada script files to standard Nunjucks/Cascada template syntax.
 *
 * Key Differences from Templates:
 *
 * 1. **No Tag Delimiters**
 *    - Skip `{%` and `%}` around tags
 *    - Skip `{{` and `}}` around expressions
 *
 * 2. **Output with `print`**
 *    - Use `print expression` instead of `{{ expression }}`
 *    - Example: `print user.name` → `{{ user.name }}`
 *
 * 3. **Implicit `do` Statements**
 *    - Any code line not starting with a reserved keyword becomes a `do` statement
 *    - Example: `items.push("new")` → `{% do items.push("new") %}`
 *
 * 4. **Multi-line Expressions**
 *    - Expressions can span multiple lines for readability
 *    - Lines are automatically joined when they end with operators, open brackets, etc.
 *    - Empty lines and comments within expressions preserve continuation
 *    - Multi-line expressions are properly converted to template syntax
 *
 * 5. **Comments**
 *    - Use standard JavaScript comments: `// single line` and `/* multi-line * /`
 *    - These are converted to Cascada comments: `{# comment #}`
 *    - Comments within tags are preserved and attached to the output
 *
 * 6. **Strings**
 *    - Multi-line strings with backslash continuation are supported
 *    - Backticks are supported, but without string interpolation
 *    - Use single or double quotes for strings
 *
 * 7. **Tags**
 *    - The delimiters are omitted
 *    - Can span multiple lines
 *    - Can break in the middle of expressions
 *    - Can have // comments at the end of a line
 *    - Can have /* comments in the middle of a line
 *    - Block structure is validated (e.g., if/endif, for/endfor)
 *    - Middle tags (else, elif, etc.) are validated against their parent blocks
 *
 * Script syntax example:
 *
 * ```
 * if user.isLoggedIn
 *   print "Hello, " + user.name
 *   for item in cart.items
 *     items.push(processItem(item))
 *     print item.name
 *   endfor
 * else
 *   print "Please log in"
 * endif
 * ```
 *
 * Converts to:
 *
 * ```
 * {% if user.isLoggedIn %}
 *   {{ "Hello, " + user.name }}
 *   {% for item in cart.items %}
 *     {% do items.push(processItem(item)) %}
 *     {{ item.name }}
 *   {% endfor %}
 * {% else %}
 *   {{ "Please log in" }}
 * {% endif %}
 * ```
 *
 * This implementation uses a line-by-line approach where each input line produces
 * exactly one output line of template code, with special handling for continuation lines.
 *
 * Key features:
 * - Token-based parsing with accurate identification of strings, comments, and code
 * - Modular processing for different line types (print, tag, code, comment)
 * - Intelligent continuation detection for multi-line expressions
 * - Comment preservation within complex expressions
 * - Robust block structure validation with detailed error messages
 * - Middle tag validation against appropriate parent blocks
 * - Clean whitespace control with (-) for optimal output
 * - Proper handling of empty lines and comments in multi-line expressions
 *
 * The implementation leverages a specialized script parser to accurately identify tokens
 * within each line, making it robust against complex syntax patterns and edge cases.
 */

// Import the script parser
const { parseTemplateLine, TOKEN_TYPES } = require('./script-lexer');

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
      blockTags: ['for', 'if', 'block', 'macro', 'filter', 'raw', 'verbatim', 'while', 'try'], //asyncEach, asyncAll
      lineTags: ['set', 'include', 'extends', 'from', 'import', 'depends', 'option'],

      // Middle tags with their parent block types
      middleTags: {
        'else': ['if', 'for'],
        'elif': ['if'],
        'resume': ['try'],
        'except': ['try']
      },

      // Block pairs define how blocks start and end
      blockPairs: {
        'for': 'endfor',
        'if': 'endif',
        'block': 'endblock',
        'macro': 'endmacro',
        'filter': 'endfilter',
        'call': 'endcall',
        'raw': 'endraw',
        'verbatim': 'endverbatim',
        'while': 'endwhile',
        'try': 'endtry',
        'set': 'endset'//only when no = in the set, then the block has to be closed
      },

      // Tags that should never be treated as multi-line
      neverContinued: [
        'else', 'endif', 'endfor', 'endblock', 'endmacro',
        'endfilter', 'endcall', 'endraw', 'endverbatim',
        'endwhile', 'endtry'
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
  }

  /**
   * Extracts the first word from a string, ensuring it's a complete word
   * @param {string} text - The text to extract from
   * @return {string} The first word
   */
  _getFirstWord(text) {
    // Get the first space-separated word
    const match = text.trim().match(/^([@:]?[a-zA-Z0-9_]+)(?:\s|$)/);
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
      // Include $ in identifier characters
      if (/[a-zA-Z0-9_$]/.test(charBefore)) {
        return false;
      }
    }

    // Check character after (if not at end)
    const afterIndex = position + length;
    if (afterIndex < text.length) {
      const charAfter = text[afterIndex];
      // Include $ in identifier characters
      if (/[a-zA-Z0-9_$]/.test(charAfter)) {
        return false;
      }
    }

    return true;
  }

  _isValidPathChar(char) {
    return /[a-zA-Z0-9_.]/.test(char);
  }

  /**
   * Checks if a character is a valid start for a value expression.
   */
  _isAllowedValueStart(char) {
    // Identifier, Digit, Quote, or Grouping Character
    return /[a-zA-Z_$\d"'{[(]/.test(char) || char === '`';
  }

  /**
   * Analyzes a stream of tokens for a Cascada Script output command line.
   * Unary + and are not allowed after a path, use (-x)
   *
   * @param {Array<object>} tokens The array of tokens from the lexer.
   * @returns {{command: string, path: string | null, value: string | null}}
   * @throws {Error} If the command syntax is invalid.
   */
  _analyzeCommandSyntax(tokens, lineIndex) {
    let state = 'PARSING_COMMAND';
    let skippingWhitespace = true;

    let bracketLevel = 0;
    let commandBuffer = '';
    let pathBuffer = '';
    let valueBuffer = '';
    let separatorBuffer = '';
    let isValueStart = true;

    const setState = (newState) => {
      state = newState;
      skippingWhitespace = true;
    };

    const switchState = (newState) => {
      state = newState;
    };

    for (const token of tokens) {
      if (token.type === 'COMMENT') continue;

      if (token.type === 'STRING' && state === 'PARSING_PATH' && bracketLevel === 0) {
        // There can be no string in the path, this is a value
        switchState('PARSING_VALUE');
        skippingWhitespace = false;
        isValueStart = false;
        valueBuffer = pathBuffer + token.value;
        pathBuffer = '';
        continue;
      }

      if (token.type !== 'CODE') {
        // Strings, regexes, etc.
        switch (state) {
          case 'PARSING_COMMAND':
            throw new Error(`Invalid command syntax at line ${lineIndex + 1}: Command name cannot be a string, regex, or comment.`);
          case 'PARSING_PATH':
            if (bracketLevel > 0) {
              pathBuffer += token.value;
            } else {
              valueBuffer = pathBuffer + separatorBuffer + token.value;
              pathBuffer = '';
              separatorBuffer = '';
              switchState('PARSING_VALUE');
              isValueStart = false;
            }
            break;
          case 'PARSING_VALUE':
            valueBuffer += token.value;
            isValueStart = false;
            break;
        }
        continue;
      }

      for (const char of token.value) {
        if (skippingWhitespace) {
          if (/\s/.test(char)) {
            if (state === 'PARSING_VALUE') {
              separatorBuffer += char; // Capture separator whitespace
            }
            continue;
          }
          skippingWhitespace = false;
        }

        switch (state) {
          case 'PARSING_COMMAND':
            if (/\s/.test(char)) {
              setState('PARSING_PATH');
            } else {
              commandBuffer += char;
            }
            break;
          case 'PARSING_PATH':
            if (char === '[') {
              pathBuffer += char;
              bracketLevel++;
            } else if (char === ']') {
              pathBuffer += char;
              bracketLevel--;
              if (bracketLevel < 0) throw new Error(`Invalid path syntax at line ${lineIndex + 1}: Unmatched closing bracket ']'.`);
            } else if (bracketLevel === 0) {
              if (/\s/.test(char)) {
                // *** FIX STARTS HERE ***
                if (pathBuffer.endsWith('.')) {
                  // Invalid path termination (e.g., "user."). Backtrack.
                  valueBuffer = pathBuffer + char;
                  pathBuffer = '';
                  switchState('PARSING_VALUE');
                  skippingWhitespace = false; // The space is part of the value now
                } else {
                  // Path looks valid so far, switch to parsing the value.
                  setState('PARSING_VALUE');
                  separatorBuffer += char;
                }
                // *** FIX ENDS HERE ***
              } else if (this._isValidPathChar(char)) {
                pathBuffer += char;
              } else {
                // Path is broken by an invalid character. Backtrack.
                valueBuffer = pathBuffer + char;
                pathBuffer = '';
                switchState('PARSING_VALUE');
              }
            } else {
              pathBuffer += char;
            }
            break;
          case 'PARSING_VALUE':
            if (isValueStart) {
              if (!this._isAllowedValueStart(char)) {
                // Path-breaker found. Backtrack.
                valueBuffer = pathBuffer + separatorBuffer + char;
                pathBuffer = '';
                separatorBuffer = '';
              } else {
                valueBuffer += char;
              }
              isValueStart = false;
            } else {
              valueBuffer += char;
            }
            break;
        }
      }
    }

    if (bracketLevel > 0) throw new Error(`Invalid path syntax at line ${lineIndex + 1}: Unmatched opening bracket '['.`);
    if (state === 'PARSING_PATH') {
      valueBuffer = pathBuffer;
      pathBuffer = '';
    }
    if (pathBuffer && valueBuffer.trim() === '') {
      valueBuffer = pathBuffer;
      pathBuffer = '';
    }

    return {
      command: commandBuffer.substring(1),
      path: !pathBuffer ? null : pathBuffer.trim(),
      value: !valueBuffer ? null : valueBuffer.trim()
    };
  }


  /**
   * Determines the block type for a tag
   * @param {string} tag - The tag to check
   * @return {string|null} The block type (START, MIDDLE, END) or null
   */
  _getBlockType(tag, code) {
    if (tag === 'set') {
      if (code.includes('=')) {
        //a set with assignment is a line tag
        return null;//not a block
      }
      return this.BLOCK_TYPE.START;
    }
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
    if (this.SYNTAX.continuation.endChars.includes(lastChar)) return true;

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
   * Checks if a command follows function-style syntax
   * Function-style: identifier(.identifier)*(...)
   * Statement-style: identifier(.identifier)* ...other
   * @param {string} commandContent - The command content after the @ symbol
   * @return {boolean} True if it's function-style
   */
  _isCommandFunctionStyle(commandContent) {
    // Find the first opening parenthesis
    const parenthesisIndex = commandContent.indexOf('(');
    if (parenthesisIndex === -1) {
      return false;//quick and dirty initial test
    }

    // Extract the part before the parenthesis and validate it
    const beforeParenthesis = commandContent.substring(0, parenthesisIndex).trim();
    if (!beforeParenthesis) {
      return false;
    }

    // Split by dots and validate each part as an identifier
    const parts = beforeParenthesis.split('.');
    for (const part of parts) {
      if (!this._isValidIdentifier(part)) {
        return false;
      }
    }

    return true;
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

    // Handle special @-command syntax before checking for standard keywords.
    const firstWord = this._getFirstWord(parseResult.codeContent);
    const code = parseResult.codeContent.trim();
    if (code.startsWith('@')) {
      // Find the @ symbol position and preserve all whitespace after it
      const atIndex = parseResult.codeContent.indexOf('@');
      const commandContent = parseResult.codeContent.substring(atIndex + 1); // Remove @ but keep all whitespace
      let isFunctionStyle = this._isCommandFunctionStyle(commandContent.trim());

      let isPrint = this._getFirstWord(commandContent) === 'print';
      if (isPrint) {
        // there are two types of print commands:
        // 1. @print path expression - converted to statement_command tag
        // 2. @print expression - converted to {{ }}
        // the second type can also look like  @print obj1.value + obj2.value
        // we have to distinguish it from @print obj1.value obj2.value
        // => For the second type, we have to check if:
        // - the first argument is a path
        // - the second argument is not an expression operator

        const analysis = this._analyzeCommandSyntax(parseResult.tokens, lineIndex);
        if (!analysis.path) {
          // no path just value, will be converted to {{ }}
          if (!analysis.value) {
            throw new Error(`Invalid print command: "${commandContent}" at line ${lineIndex + 1}`);
          }
          parseResult.lineType = 'PRINT';
          parseResult.blockType = null;
          parseResult.codeContent = analysis.value;
        } else {
          isPrint = false;
        }
      }

      if (!isPrint) {
        parseResult.lineType = 'TAG';
        parseResult.tagName = isFunctionStyle ? 'function_command' : 'statement_command';
        parseResult.blockType = null;
        parseResult.codeContent = commandContent; // The content for the Nunjucks tag
      }
    } else if (code.startsWith(':')) {
      // Handle :data/text/handleName output focus directive
      const focus = code.substring(1); // Remove : but keep the directive name
      if (!focus) {
        throw new Error(`Invalid output focus: "${parseResult.codeContent}"`);
      }
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'option';
      parseResult.blockType = null;//no block
      parseResult.codeContent = `focus="${focus}"`;
    } else {
      // Standard keyword processing
      if (this.RESERVED_KEYWORDS.has(firstWord)) {
        parseResult.lineType = 'TAG';
        parseResult.codeContent = parseResult.codeContent.substring(firstWord.length + 1);//skip the first word
        parseResult.blockType = this._getBlockType(firstWord, code);
        parseResult.tagName = firstWord;
      } else {
        parseResult.lineType = 'CODE';
        parseResult.blockType = null;
      }
    }

    parseResult.continuesToNext = this._willContinueToNextLine(codeTokens, parseResult.codeContent, firstWord);
    parseResult.continuesFromPrev = this._continuesFromPrevious(parseResult.codeContent);

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
      if (presult.lineType === 'TAG' || presult.lineType === 'PRINT') {
        //start of a new tag or print, save it for continuation
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
        } else {
          // this is do tag, code not part of continuation but it can be start of continuation
          tagLineParseResult = presult;//all comments from continuations are added here
        }
      }
      prevLineIndex = i;//only empty or comment-only lines are skipped by continueFromIndex, for other cases it is i-1
    }
  }

  _generateOutput(processedLine, nextIsContinuation, lastNonContinuationLineType) {
    let output = processedLine.indentation;

    if (processedLine.isEmpty) {
      return output;
    }

    if (processedLine.isCommentOnly) {
      output += `{#- ${processedLine.comments.join('; ')} -#}`;
      return output;
    }

    if (!processedLine.isContinuation) {
      switch (processedLine.lineType) {
        case 'TAG':
          output += `{%- ${processedLine.tagName}`;
          /*if (processedLine.tagName) {
            // For internal commands, prepend the tag name that the Nunjucks parser expects
            if (processedLine.tagName === 'function_command' || processedLine.tagName === 'statement_command') {
              output += processedLine.tagName + ' ';
            }
          }*/
          break;
        case 'PRINT':
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
      //close the tag
      switch (lastNonContinuationLineType) {
        case 'CODE':
        case 'TAG':
          output += ' -%}';//close tag or do
          break;
        case 'PRINT':
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
    }

    this._processContinuationsAndComments(processedLines);

    let output = '';
    let lastNonContinuationLineType = null;
    for (let i = 0; i < processedLines.length; i++) {
      if (!processedLines[i].isContinuation) {
        lastNonContinuationLineType = processedLines[i].lineType;
      }
      output += this._generateOutput(processedLines[i], processedLines[i + 1]?.isContinuation, lastNonContinuationLineType);
      if (i != processedLines.length - 1) {
        output += '\n';
      }
    }

    // Validate block structure
    this._validateBlockStructure(processedLines);

    return output;
  }
}

module.exports = new ScriptTranspiler();
