/**
 * Cascada Script to Template Converter
 *
 * Converts Cascada script syntax to Nunjucks/Cascada template syntax.
 * Uses script-parser for token extraction and handling.
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
const { parseTemplateLine, TOKEN_TYPES } = require('./script-parser');

// Comment type constants
const COMMENT_TYPE = {
  SINGLE: 'single',
  MULTI: 'multi'
};

// Block type constants for validation
const BLOCK_TYPE = {
  START: 'START',
  MIDDLE: 'MIDDLE',
  END: 'END'
};

// Define block-related configuration
const SYNTAX = {
  // Block-related tags
  blockTags: ['for', 'if', 'block', 'macro', 'filter', 'call', 'raw', 'verbatim', 'while', 'try'],
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
    'try': 'endtry'
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
const RESERVED_KEYWORDS = new Set([
  'print',
  ...SYNTAX.blockTags,
  ...SYNTAX.lineTags,
  ...Object.keys(SYNTAX.middleTags),
  ...Object.values(SYNTAX.blockPairs)
]);

/**
 * Extracts the first word from a string, ensuring it's a complete word
 * @param {string} text - The text to extract from
 * @return {string} The first word
 */
function getFirstWord(text) {
  // Get the first space-separated word
  const match = text.trim().match(/^(@?[a-zA-Z0-9_]+)(?:\s|$)/);
  return match ? match[1] : '';
}

/**
 * Checks if a string is a complete word (not part of another identifier)
 * @param {string} text - The text to check
 * @param {number} position - Position in text where word starts
 * @param {number} length - Length of the word
 * @return {boolean} True if it's a complete word
 */
function isCompleteWord(text, position, length) {
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

/**
 * Determines the block type for a tag
 * @param {string} tag - The tag to check
 * @return {string|null} The block type (START, MIDDLE, END) or null
 */
function getBlockType(tag) {
  if (SYNTAX.blockTags.includes(tag)) return BLOCK_TYPE.START;
  if (Object.keys(SYNTAX.middleTags).includes(tag)) return BLOCK_TYPE.MIDDLE;
  if (Object.values(SYNTAX.blockPairs).includes(tag)) return BLOCK_TYPE.END;
  return null;
}

/**
 * Extracts comments from parser tokens
 * @param {Array} tokens - Array of tokens from script-parser
 * @return {Array} Array of comment objects with type and content
 */
function extractComments(tokens) {
  return tokens
    .filter(token => token.type === TOKEN_TYPES.COMMENT)
    .map(token => {
      let type = COMMENT_TYPE.SINGLE;
      let content = token.value;

      // Determine comment type and clean content
      if (content.startsWith('//')) {
        content = content.replace(/^\/\/\s?/, '').trim();
      } else if (content.startsWith('/*')) {
        type = COMMENT_TYPE.MULTI;
        content = content.replace(/^\/\*\s?|\s?\*\/$/g, '').trim();
      }

      return { type, content };
    });
}

/**
 * Filters out comment tokens from all tokens
 * @param {Array} tokens - Array of tokens from script-parser
 * @return {Array} Tokens without comments
 */
function filterOutComments(tokens) {
  return tokens.filter(token => token.type !== TOKEN_TYPES.COMMENT);
}

/**
 * Combines code tokens into a string
 * @param {Array} tokens - Array of tokens (excluding comments)
 * @return {string} Combined code string
 */
function tokensToCode(tokens) {
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
function willContinueToNextLine(tokens, codeContent, firstWord) {
  // Check if it's a tag that never continues
  if (SYNTAX.neverContinued.includes(firstWord)) {
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
  if (SYNTAX.continuation.endChars.includes(lastChar)) return true;

  // Check for continuation operators at end of line
  for (const op of SYNTAX.continuation.endOperators) {
    if (codeContent.endsWith(op)) {
      // Check if operator is standalone (not part of an identifier)
      const beforeOpIndex = codeContent.length - op.length - 1;
      if (beforeOpIndex < 0 || !/[a-zA-Z0-9_]/.test(codeContent[beforeOpIndex])) {
        return true;
      }
    }
  }

  // Check for continuation keywords at end of line
  for (const keyword of SYNTAX.continuation.endKeywords) {
    const trimmedKeyword = keyword.trim();
    if (codeContent.endsWith(trimmedKeyword)) {
      // Check if it's a complete word
      const keywordIndex = codeContent.length - trimmedKeyword.length;
      if (isCompleteWord(codeContent, keywordIndex, trimmedKeyword.length)) {
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
function continuesFromPrevious(codeContent) {
  codeContent = codeContent.trim();
  const firstWord = getFirstWord(codeContent);
  if (RESERVED_KEYWORDS.has(firstWord)) {
    return false; // New tags start fresh, regardless of previous continuation
  }
  // Check for continuation characters at start of line
  const firstChar = codeContent.trim()[0];
  if (SYNTAX.continuation.startChars.includes(firstChar)) return true;
  // Check for continuation operators at start of line
  for (const op of SYNTAX.continuation.startOperators) {
    if (codeContent.trim().startsWith(op)) {
      const afterOp = codeContent.trim().substring(op.length);
      if (afterOp.length === 0 || afterOp[0] === ' ' || SYNTAX.continuation.startChars.includes(afterOp[0])) {
        return true;
      }
    }
  }
  // Check for continuation keywords at start of line
  if (SYNTAX.continuation.startKeywords.includes(firstWord)) {
    const keywordIndex = codeContent.indexOf(firstWord);
    if (isCompleteWord(codeContent, keywordIndex, firstWord.length)) {
      return true;
    }
  }  return false;
}

/**
 * Checks if a command follows function-style syntax
 * Function-style: identifier(.identifier)*(...)
 * Statement-style: identifier(.identifier)* ...other
 * @param {string} commandContent - The command content after the @ symbol
 * @return {boolean} True if it's function-style
 */
function isCommandFunctionStyle(commandContent) {
  // Find the first opening parenthesis
  const parenIndex = commandContent.indexOf('(');
  if (parenIndex === -1) {
    return false;
  }

  // Extract the part before the parenthesis and validate it
  const beforeParen = commandContent.substring(0, parenIndex).trim();
  if (!beforeParen) {
    return false;
  }

  // Split by dots and validate each part as an identifier
  const parts = beforeParen.split('.');
  for (const part of parts) {
    if (!isValidIdentifier(part)) {
      throw new Error(`Invalid identifier in command path: "${part}" in "${commandContent}"`);
    }
  }

  return true;
}

/**
 * Checks if a string is a valid JavaScript identifier
 * @param {string} str - The string to check
 * @return {boolean} True if it's a valid identifier
 */
function isValidIdentifier(str) {
  if (!str) return false;

  // JavaScript identifier rules: start with letter, $, or _, followed by letters, digits, $, or _
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}

function processLine(line, state) {
  // Parse line with script parser
  const parseResult = parseTemplateLine(
    line,
    state.inMultiLineComment,
    state.stringState
  );
  // Extract comments and handle them first
  const comments = extractComments(parseResult.tokens);
  const codeTokens = filterOutComments(parseResult.tokens);

  parseResult.isCommentOnly = codeTokens.length === 0 && comments.length > 0;
  parseResult.isEmpty = line.trim() === '';
  parseResult.codeContent = tokensToCode(codeTokens);

  parseResult.comments = [];
  for (let i = 0; i < comments.length; i++) {
    parseResult.comments.push(comments[i].content);
  }

  // Handle special @-command syntax before checking for standard keywords.
  const firstWord = getFirstWord(parseResult.codeContent);
  const code = parseResult.codeContent.trim();
  if (code.startsWith('@')) {
    // Find the @ symbol position and preserve all whitespace after it
    const atIndex = parseResult.codeContent.indexOf('@');
    const commandContent = parseResult.codeContent.substring(atIndex + 1); // Remove @ but keep all whitespace
    let isFunctionStyle = isCommandFunctionStyle(commandContent.trim());

    parseResult.lineType = 'TAG';
    parseResult.tagName = isFunctionStyle ? 'function_command' : 'statement_command';
    parseResult.blockType = null;
    parseResult.codeContent = commandContent; // The content for the Nunjucks tag
  } else if (code.startsWith(':')) {
    // Handle :data/text/handleName output focus directive
    const focus = code.substring(1); // Remove : but keep the directive name
    if (!focus) {
      throw new Error(`Invalid output focus: "${parseResult.codeContent}"`);
    }
    if (focus === 'data') {
      parseResult.lineType = 'TAG';
      parseResult.tagName = 'option';
      parseResult.blockType = null;//no block
      parseResult.codeContent = `focus="${focus}"`;
    }
  } else {
    // Standard keyword processing
    if (RESERVED_KEYWORDS.has(firstWord)) {
      if (firstWord === 'print') {
        parseResult.lineType = 'PRINT';
        parseResult.blockType = null;
        // Strip the 'print' keyword from codeContent for output expressions
        const printPos = parseResult.codeContent.indexOf('print');
        parseResult.codeContent = parseResult.codeContent.substring(printPos + 'print'.length).trim(); // Remove 'print'
      } else {
        parseResult.lineType = 'TAG';
        parseResult.codeContent = parseResult.codeContent.substring(firstWord.length + 1);//skip the first word
        parseResult.blockType = getBlockType(firstWord);
        parseResult.tagName = firstWord;
      }
    } else {
      parseResult.lineType = 'CODE';
      parseResult.blockType = null;
    }
  }

  parseResult.continuesToNext = willContinueToNextLine(codeTokens, parseResult.codeContent, firstWord);
  parseResult.continuesFromPrev = continuesFromPrevious(parseResult.codeContent);

  //update the state used by the parser (it works only with state + current line)
  state.inMultiLineComment = parseResult.inMultiLineComment;
  state.stringState = parseResult.stringState;
  return parseResult;
}

function processContinuationsAndComments(parseResults) {
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

function generateOutput(processedLine, nextIsContinuation, lastNonContinuationLineType) {
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
function validateBlockStructure(processedLines) {
  const stack = [];

  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i];

    if (!line.blockType || line.isContinuation) continue;

    const tag = line.tagName;//getFirstWord(line.codeContent);
    if (line.blockType === BLOCK_TYPE.START) {
      stack.push({ tag, line: i + 1 });
    }
    else if (line.blockType === BLOCK_TYPE.MIDDLE) {
      if (!stack.length) {
        throw new Error(`Line ${i + 1}: '${tag}' outside of any block (content: "${line.codeContent}")`);
      }

      const topTag = stack[stack.length - 1].tag;
      const validParents = SYNTAX.middleTags[tag] || [];

      if (!validParents.includes(topTag)) {
        throw new Error(`Line ${i + 1}: '${tag}' not valid in '${topTag}' block (content: "${line.codeContent}")`);
      }
    }
    else if (line.blockType === BLOCK_TYPE.END) {
      if (!stack.length) {
        throw new Error(`Line ${i + 1}: Unexpected '${tag}' (content: "${line.codeContent}")`);
      }

      const topTag = stack[stack.length - 1].tag;
      const expectedEndTag = SYNTAX.blockPairs[topTag];

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
function scriptToTemplate(scriptStr) {
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
    const processedLine = processLine(line, state);

    // Store processed line for potential reuse in lookahead
    processedLines.push(processedLine);
  }

  processContinuationsAndComments(processedLines);

  let output = '';
  let lastNonContinuationLineType = null;
  for (let i = 0; i < processedLines.length; i++) {
    if (!processedLines[i].isContinuation) {
      lastNonContinuationLineType = processedLines[i].lineType;
    }
    output += generateOutput(processedLines[i], processedLines[i + 1]?.isContinuation, lastNonContinuationLineType);
    if (i != processedLines.length - 1) {
      output += '\n';
    }
  }

  // Validate block structure
  validateBlockStructure(processedLines);

  return output;
}

module.exports = { scriptToTemplate, getFirstWord, isCompleteWord, getBlockType,
  extractComments, filterOutComments, tokensToCode, willContinueToNextLine,
  continuesFromPrevious, generateOutput, processedLine: processLine, validateBlockStructure,
  isCommandFunctionStyle, isValidIdentifier };
