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
 * 2. **Output with `text`**
 *    - Use `text expression` instead of `{{ expression }}`
 *    - Example: `text user.name` → `{{ user.name }}`
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
 *   text "Hello, " + user.name
 *   for item in cart.items
 *     items.push(processItem(item))
 *     text item.name
 *   endfor
 * else
 *   text "Please log in"
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
 * - Modular processing for different line types (text, tag, code, comment)
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
      lineTags: [/*'set',*/'include', 'extends', 'from', 'import', 'depends', 'option', 'var', 'extern'],

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
        //'set': 'endset', //only when no = in the set, then the block has to be closed
        'var': 'endvar' //only when no = in the var, then the block has to be closed
      },

      // Tags that should never be treated as multi-line
      neverContinued: [
        'else', 'endif', 'endfor', 'endblock', 'endmacro',
        'endfilter', 'endcall', 'endraw', 'endverbatim',
        'endwhile', 'endtry', 'endvar'
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

  _isAssignment(code, lineIndex) {
    const assignPos = code.indexOf('=');
    if (assignPos === -1) return false;

    // for now we only support assignment to a variable
    if (!this._isValidIdentifierList(code.substring(0, assignPos).trim())) return false;

    const expr = code.substring(assignPos + 1).trim();

    if (expr.startsWith('=')) {
      // This is probablya comparison operator, not an assignment and we don't want a line with just a comparison
      throw new Error(`Invalid assignment/comparison: "${code}" at line ${lineIndex + 1}`);
    }
    return true;
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
      const exprStr = content.substring(assignPos + 1).trim();

      if (!this._isValidIdentifierList(targetsStr)) {
        throw new Error(`Invalid variable name in declaration: "${targetsStr}" at line ${lineIndex + 1}`);
      }

      parseResult.lineType = 'TAG';
      parseResult.tagName = isAssignment ? 'set' : 'var';

      if (this._getFirstWord(exprStr) === 'capture') {
        // Handle block assignment (`= capture`)
        const captureContent = exprStr.substring('capture'.length).trim();
        // The content of the tag is the list of variables and the focus directive
        parseResult.codeContent = `${targetsStr} ${captureContent}`;
        parseResult.blockType = this.BLOCK_TYPE.START;
        this.setBlockStack.push(parseResult.tagName);
      } else {
        // Handle value assignment (`= value`)
        parseResult.codeContent = content; // The full "targets = expression" string
        parseResult.blockType = null;
      }
    }
  }

  _processOutputCommand(parseResult, lineIndex) {
    // Find the @ symbol position and preserve all whitespace after it
    const atIndex = parseResult.codeContent.indexOf('@');
    const commandContent = parseResult.codeContent.substring(atIndex + 1); // Remove @ but keep all whitespace
    // Check if this is a @text command (the current command for text output)
    let ccontent = commandContent.trim();
    let isText = ccontent.startsWith('text(') || this._getFirstWord(ccontent) === 'text';
    if (isText) {
      //skip the 'text'
      ccontent = ccontent.substring('text'.length).trim();
      // Check if @text has parentheses (function call syntax)
      const hasParentheses = ccontent.startsWith('(');
      let expression = '';
      if (hasParentheses) {
        // @text(value) - extract the value and convert to {{ }}
        const openParenIndex = ccontent.indexOf('(');
        const closeParenIndex = ccontent.lastIndexOf(')');
        /*if (openParenIndex === -1 || closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
          throw new Error(`Invalid text command syntax: "${ccontent}" at line ${lineIndex + 1}`);
        }*/
        expression = ccontent.substring(
          openParenIndex + 1,
          closeParenIndex === -1 ? ccontent.length : closeParenIndex
        ).trim();

        if (closeParenIndex && !expression) {
          throw new Error(`Invalid text command: "${ccontent}" at line ${lineIndex + 1}`);
        }

        if (closeParenIndex === -1) {
          //we expect the last continuation line to end with ')' which shall be ignored
          parseResult.continuesToNext = true;
          parseResult.expectedContinuationEnd = ')';
        }
      } else {
        //make sure there is no content after the 'text', we expect '(' on the next line (@todo)
        if (ccontent.length > 0) {
          throw new Error(`Expected '(' after 'text' at line ${lineIndex + 1}`);
        }
        parseResult.continuesToNext = true;
        parseResult.expectedContinuationEnd = ')';
      }
      parseResult.lineType = 'TEXT';
      parseResult.blockType = null;
      parseResult.codeContent = expression;
    } else {
      // All other @ commands are treated as function commands
      // @print was deprecated and replaced with @text(value)
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'output_command';
      parseResult.blockType = null;
      parseResult.codeContent = commandContent; // The content for the Nunjucks tag
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
    if (code.startsWith('@')) {
      this._processOutputCommand(parseResult, lineIndex);
    } else if (code.startsWith(':')) {
      this._processFocusDirective(parseResult, lineIndex);
    } else if (firstWord === 'var') {
      this._processVar(parseResult, lineIndex);
    } else if (firstWord === 'extern') {
      this._processExtern(parseResult, lineIndex);
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
    } else if (this._isAssignment(code, lineIndex)) {
      this._processVar(parseResult, lineIndex, true);
    }
    else {
      // a code line
      parseResult.lineType = 'CODE';
      parseResult.blockType = null;
    }

    parseResult.continuesToNext = parseResult.continuesToNext || this._willContinueToNextLine(codeTokens, parseResult.codeContent, firstWord);
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

  _generateOutput(processedLine, nextIsContinuation, lastNonContinuationLineType, lineIndex) {
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
          break;
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
      output += this._generateOutput(processedLines[i], processedLines[i + 1]?.isContinuation, lastNonContinuationLineType, i);
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
