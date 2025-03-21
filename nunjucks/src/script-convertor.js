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
  lineTags: ['set', 'include', 'extends', 'from', 'import', 'depends'],

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
  const match = text.trim().match(/^([a-zA-Z0-9_]+)(?:\s|$)/);
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
function willContinueToNextLine(tokens, codeContent, firstWord) {
  // Check if any tokens are incomplete (parser tells us this)
  const hasIncompleteToken = tokens.some(token => token.incomplete);
  if (hasIncompleteToken) return true;

  // Check if it's a tag that never continues
  if (SYNTAX.neverContinued.includes(firstWord)) {
    return false;
  }

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
 * @param {boolean} prevContinues - Whether the previous line indicated it continues
 * @return {boolean} True if continuing from previous line
 */
function isContinuationFromPrevious(codeContent, prevContinues) {
  if (!codeContent) return prevContinues;
  codeContent = codeContent.trim();
  const firstWord = getFirstWord(codeContent);
  if (RESERVED_KEYWORDS.has(firstWord)) {
    return false; // New tags start fresh, regardless of previous continuation
  }
  if (prevContinues) return true;
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
  }
  return false;
}

/**
 * Processes comments in a line
 * @param {Array} comments - Array of comment objects
 * @param {string} indent - Line indentation
 * @param {boolean} isCommentOnly - Whether line only has comments
 * @param {boolean} inMultiLineComment - Whether we're in a multi-line comment
 * @param {boolean} endOfMultiLine - Whether this is end of multi-line comment
 * @param {Object} state - Line processing state
 * @return {Object|null} Line info if handled as comment-only, null otherwise
 */
function processComments(comments, indent, isCommentOnly, inMultiLineComment, endOfMultiLine, state) {
  // If no comments, nothing to process
  if (comments.length === 0) return null;

  // Handle comment-only lines
  if (isCommentOnly) {
    // Handle comment-only line during continuation
    if (state.willContinue) {
      // Comment-only line during continuation - add to buffer
      state.commentBuffer = state.commentBuffer || [];
      comments.forEach(comment => {
        state.commentBuffer.push(comment.content);
      });

      // Output as a plain comment for readability
      return {
        type: 'COMMENT',
        content: comments.map(c => c.content).join('; '),
        indentation: indent,
        outputLine: `${indent}{# ${comments.map(c => c.content).join('; ')} #}`,
        blockType: null,
        willContinue: state.willContinue // Preserve continuation state
      };
    }

    // Regular comment-only line
    if (comments[0].type === COMMENT_TYPE.SINGLE ||
        (comments[0].type === COMMENT_TYPE.MULTI && !inMultiLineComment)) {
      // Start of comment (single or multi)
      return {
        type: 'COMMENT',
        content: comments.map(c => c.content).join('; '),
        indentation: indent,
        outputLine: `${indent}{# ${comments.map(c => c.content).join('; ')} #}`,
        blockType: null,
        willContinue: false
      };
    } else {
      // Middle or end of multi-line comment
      let output;
      if (inMultiLineComment && endOfMultiLine) {
        // End of multi-line comment
        output = `${indent}   ${comments[0].content} #}`;
      } else {
        // Middle of multi-line comment
        output = `${indent}   ${comments[0].content}`;
      }

      return {
        type: 'COMMENT',
        content: comments[0].content,
        indentation: indent,
        outputLine: output,
        blockType: null,
        willContinue: false
      };
    }
  }

  // For code lines with comments, add all comments to buffer
  state.commentBuffer = state.commentBuffer || [];
  comments.forEach(comment => {
    state.commentBuffer.push(comment.content);
  });

  return null;
}

/**
 * Generates output for a code line
 * @param {string} lineType - Type of line (PRINT, TAG, CODE)
 * @param {string} content - Code content
 * @param {string} indent - Line indentation
 * @param {boolean} isContinuation - Whether line is continuation
 * @param {boolean} willContinue - Whether line will continue
 * @param {Object} state - Line processing state
 * @return {string} Output line
 */
function generateOutput(lineType, content, indent, isContinuation, willContinue, state) {
  let output;

  if (isContinuation) {
    // Continuation line - just the content
    output = `${indent}${content}`;

    // Check if this is the end of a continuation
    if (!willContinue) {
      // Add appropriate closing tag
      switch (lineType) {
        case 'PRINT':
          output += ' -}}';
          break;
        case 'TAG':
        case 'CODE':
          output += ' -%}';
          break;
      }

      // Add comment buffer if there are any comments
      if (state.commentBuffer && state.commentBuffer.length > 0) {
        output += ` {# ${state.commentBuffer.join('; ')} #}`;
        state.commentBuffer = [];
      }
    }
  } else {
    // New line - add appropriate opening tag
    switch (lineType) {
      case 'PRINT':{
        // Strip 'print' and get the content
        const printContent = content.substring(5).trim();
        output = `${indent}{{- ${printContent}`;

        // Add closing tag if the line doesn't continue
        if (!willContinue) {
          output += ' -}}';

          // Add comment buffer if there are any comments
          if (state.commentBuffer && state.commentBuffer.length > 0) {
            output += ` {# ${state.commentBuffer.join('; ')} #}`;
            state.commentBuffer = [];
          }
        }
        break;
      }

      case 'TAG':
        output = `${indent}{%- ${content}`;

        // Add closing tag if the line doesn't continue
        if (!willContinue) {
          output += ' -%}';

          // Add comment buffer if there are any comments
          if (state.commentBuffer && state.commentBuffer.length > 0) {
            output += ` {# ${state.commentBuffer.join('; ')} #}`;
            state.commentBuffer = [];
          }
        }
        break;

      case 'CODE':
        output = `${indent}{%- do ${content}`;

        // Add closing tag if the line doesn't continue
        if (!willContinue) {
          output += ' -%}';

          // Add comment buffer if there are any comments
          if (state.commentBuffer && state.commentBuffer.length > 0) {
            output += ` {# ${state.commentBuffer.join('; ')} #}`;
            state.commentBuffer = [];
          }
        }
        break;
    }
  }

  return output;
}

/**
 * Process a single line
 * @param {string} line - The input line
 * @param {Object} state - Line processing state
 * @return {Object} Processed line info
 */
function processLine(line, state) {
  // Parse line with script parser
  const parseResult = parseTemplateLine(
    line,
    state.inMultiLineComment,
    state.stringState
  );

  // Update parser state for next line
  state.inMultiLineComment = parseResult.inMultiLineComment;
  state.stringState = parseResult.stringState;

  // Get indentation from parser
  const indent = parseResult.indentation;

  // Handle empty lines - but preserve the actual line content
  if (line.trim() === '') {
    return {
      type: 'EMPTY',
      content: '',
      indentation: indent,
      outputLine: line, // Preserve the original line including whitespace
      blockType: null,
      willContinue: state.willContinue // Preserve continuation state for empty lines
    };
  }

  // Extract comments and handle them first
  const comments = extractComments(parseResult.tokens);

  // Check if this is a comment-only line
  const codeTokens = filterOutComments(parseResult.tokens);
  const isCommentOnly = codeTokens.length === 0 && comments.length > 0;

  // Process comments first
  const commentResult = processComments(
    comments,
    indent,
    isCommentOnly,
    state.inMultiLineComment,
    !parseResult.inMultiLineComment,
    state
  );

  // If comment processing returned a result, we're done with this line
  if (commentResult) {
    return commentResult;
  }

  // Process code line
  const codeContent = tokensToCode(codeTokens);

  // Check if this line is a continuation from previous
  const isContinuation = isContinuationFromPrevious(codeContent, state.willContinue);

  // Get first word for tag detection
  const firstWord = getFirstWord(codeContent);

  // Determine line type and block type
  let lineType, blockType;

  if (isContinuation) {
    // This line continues from previous
    lineType = state.currentLineType;
    blockType = state.currentBlockType;
  } else {
    // New line - determine its type
    if (firstWord === 'print') {
      lineType = 'PRINT';
      blockType = null;
    } else if (RESERVED_KEYWORDS.has(firstWord)) {
      lineType = 'TAG';
      blockType = getBlockType(firstWord);
    } else {
      lineType = 'CODE';
      blockType = null;
    }

    // Store current line type and block type for continuations
    state.currentLineType = lineType;
    state.currentBlockType = blockType;
  }

  // Determine if line will continue to next line
  const willContinue = willContinueToNextLine(codeTokens, codeContent, firstWord);
  state.willContinue = willContinue;

  // Generate output for this line
  const outputLine = generateOutput(
    lineType,
    codeContent,
    indent,
    isContinuation,
    willContinue,
    state
  );

  // Return processed line info
  return {
    type: lineType,
    content: codeContent,
    indentation: indent,
    outputLine,
    blockType,
    willContinue,
    isContinuation
  };
}

/**
 * Validate block structure of processed lines
 * @param {Array} processedLines - Array of processed line info objects
 * @return {Object} Validation result with valid flag and error message
 */
function validateBlockStructure(processedLines) {
  const stack = [];

  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i];

    if (!line.blockType || line.isContinuation) continue;

    if (line.blockType === BLOCK_TYPE.START) {
      const tag = getFirstWord(line.content);
      stack.push({ tag, line: i + 1 });
    }
    else if (line.blockType === BLOCK_TYPE.MIDDLE) {
      const tag = getFirstWord(line.content);

      if (!stack.length) {
        return {
          valid: false,
          error: `Line ${i + 1}: '${tag}' outside of any block (content: "${line.content}")`
        };
      }

      const topTag = stack[stack.length - 1].tag;
      const validParents = SYNTAX.middleTags[tag] || [];

      if (!validParents.includes(topTag)) {
        return {
          valid: false,
          error: `Line ${i + 1}: '${tag}' not valid in '${topTag}' block (content: "${line.content}")`
        };
      }
    }
    else if (line.blockType === BLOCK_TYPE.END) {
      const tag = getFirstWord(line.content);

      if (!stack.length) {
        return {
          valid: false,
          error: `Line ${i + 1}: Unexpected '${tag}' (content: "${line.content}")`
        };
      }

      const topTag = stack[stack.length - 1].tag;
      const expectedEndTag = SYNTAX.blockPairs[topTag];

      if (expectedEndTag !== tag) {
        return {
          valid: false,
          error: `Line ${i + 1}: Unexpected '${tag}', was expecting '${expectedEndTag}' (content: "${line.content}")`
        };
      }

      stack.pop();
    }
  }

  if (stack.length > 0) {
    const { tag, line } = stack[stack.length - 1];
    return { valid: false, error: `Unclosed '${tag}' at line ${line}` };
  }

  return { valid: true };
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
    commentBuffer: [],
    willContinue: false,
    currentLineType: null,
    currentBlockType: null
  };

  // Process each line
  const processedLines = lines.map(line => processLine(line, state));

  // Validate block structure
  const validationResult = validateBlockStructure(processedLines);
  if (!validationResult.valid) {
    return { template: null, error: validationResult.error };
  }

  // Generate the final template
  const template = processedLines
    .map(line => line.outputLine)
    .join('\n');// + '\n';

  return { template, error: null };
}

module.exports = { scriptToTemplate, getFirstWord, isCompleteWord, getBlockType,
  extractComments, filterOutComments, tokensToCode, willContinueToNextLine,
  isContinuationFromPrevious, processComments, generateOutput,
  processLine, validateBlockStructure };
