/**
 * Cascada Script Processor
 *
 * Cascada scripts provide a cleaner syntax for writing Cascada templates with less visual noise.
 * Key Differences from Templates
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
 *    - Multi-line expressions are properly converted to template syntax
 *
 * 5. **Comments**
 *    - Use standard JavaScript comments: `// single line` and `/* multi-line * /`
 *    - These are converted to Cascada comments: `{# comment #}`
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
 * This module processes Cascada script files and converts them to Nunjucks/Cascada template files.
 * It uses a line-by-line approach where each input line produces exactly one output line of template code.
 *
 * Key features:
 * - Each line is classified based on its content and position in multi-line constructs
 * - 'print' keyword is converted to {{ ... }} expression syntax
 * - Reserved keywords are converted to {% ... %} tag syntax
 * - Regular code lines are converted to {% do ... %} tags
 * - Comments are properly handled and converted to template comments
 * - Multi-line expressions are properly tracked across lines
 * - Block structure validation ensures proper nesting of tags
 *
 * The converter uses whitespace control (-) to ensure clean output.
 */

// Line type classifications
const LINE_TYPE = {
  // Comment lines
  COMMENT_SINGLE: 'COMMENT_SINGLE',
  COMMENT_MULTI_START: 'COMMENT_MULTI_START',
  COMMENT_MULTI_MIDDLE: 'COMMENT_MULTI_MIDDLE',
  COMMENT_MULTI_END: 'COMMENT_MULTI_END',

  // Tag/code structure
  TAG_START: 'TAG_START',
  TAG_CONTINUATION: 'TAG_CONTINUATION',
  TAG_END: 'TAG_END',

  // Print statements
  PRINT_START: 'PRINT_START',
  PRINT_CONTINUATION: 'PRINT_CONTINUATION',
  PRINT_END: 'PRINT_END',
  PRINT_STANDALONE: 'PRINT_STANDALONE', // New type for standalone print statements

  // Regular code (will become "do" tags)
  CODE_STANDALONE: 'CODE_STANDALONE',
  CODE_START: 'CODE_START',
  CODE_CONTINUATION: 'CODE_CONTINUATION',
  CODE_END: 'CODE_END',

  // Block structure indicators (these are in addition to the line type)
  BLOCK_START: 'BLOCK_START',
  BLOCK_MIDDLE: 'BLOCK_MIDDLE',
  BLOCK_END: 'BLOCK_END',

  // Empty line
  EMPTY: 'EMPTY'
};

// Configuration objects for syntax elements
const SYNTAX = {
  continuation: {
    endChars: '{([,?:-+=|&.!*/%^<>~',
    endOperators: ['&&', '||', '==', '!=', '>=', '<=', '+=', '-=', '*=', '/=', '//', '**', '===', '!=='],
    endKeywords: ['in ', 'is ', 'and ', 'or '],

    startChars: '})]{([?:-+=|&.!*/%^<>~',
    startOperators: ['&&', '||', '==', '!=', '>=', '<='],
    startKeywords: ['and', 'or', 'not', 'in', 'is', 'else', 'elif']
  },

  tags: {
    block: [
      'for', 'if', 'block', 'macro', 'filter', 'call', 'raw', 'verbatim', 'while', 'try'
    ],
    line: [
      'set', 'include', 'extends', 'from', 'import', 'depends', 'do', 'resume', 'except', 'print'
    ],
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
    }
  }
};

// Define line type transitions for continuations
const LINE_TYPE_TRANSITIONS = {
  [LINE_TYPE.TAG_START]: {
    continue: LINE_TYPE.TAG_CONTINUATION,
    end: LINE_TYPE.TAG_END
  },
  [LINE_TYPE.PRINT_START]: {
    continue: LINE_TYPE.PRINT_CONTINUATION,
    end: LINE_TYPE.PRINT_END
  },
  [LINE_TYPE.CODE_START]: {
    continue: LINE_TYPE.CODE_CONTINUATION,
    end: LINE_TYPE.CODE_END
  },
  [LINE_TYPE.TAG_CONTINUATION]: {
    continue: LINE_TYPE.TAG_CONTINUATION,
    end: LINE_TYPE.TAG_END
  },
  [LINE_TYPE.PRINT_CONTINUATION]: {
    continue: LINE_TYPE.PRINT_CONTINUATION,
    end: LINE_TYPE.PRINT_END
  },
  [LINE_TYPE.CODE_CONTINUATION]: {
    continue: LINE_TYPE.CODE_CONTINUATION,
    end: LINE_TYPE.CODE_END
  }
};

// Create a set with all reserved keywords, including end tags
const RESERVED_KEYWORDS = new Set([
  ...SYNTAX.tags.block,
  ...SYNTAX.tags.line,
  'else',
  'elif'
]);

// Add all end tags to reserved keywords
Object.values(SYNTAX.tags.blockPairs).forEach(endTag => {
  RESERVED_KEYWORDS.add(endTag);
});

// Helper to get the first word of a string
function getFirstWord(s) {
  return s.trimStart().split(/\s+/)[0] || null;
}

/**
 * Adds a comment to the end of a line if one exists
 */
function addInlineComment(line, comment) {
  if (!comment) return line;
  return `${line} {# ${comment} #}`;
}

/**
 * Finds the position of '//' that represents a comment delimiter,
 * excluding '//' inside string literals
 * @param {string} line The line to check
 * @return {number} Position of comment or -1 if not found
 */
function findCommentOutsideString(line) {
  let inString = false;
  let quoteChar = null;
  let escapeNext = false;

  for (let i = 0; i < line.length; i++) {
    // Check if this character is escaped
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    // Set escape flag for next character
    if (line[i] === '\\') {
      escapeNext = true;
      continue;
    }

    // Handle quotes - toggle string state on unescaped quotes
    if ((line[i] === '"' || line[i] === '\'')) {
      if (!inString) {
        inString = true;
        quoteChar = line[i];
      } else if (quoteChar === line[i]) {
        inString = false;
      }
    }

    // Check for comment start, but only if not inside a string
    if (line[i] === '/' && line[i + 1] === '/' && !inString) {
      return i;
    }
  }

  return -1;
}

/**
 * Determine the block type for a line
 */
function determineBlockType(firstWord) {
  if (SYNTAX.tags.block.includes(firstWord)) {
    return LINE_TYPE.BLOCK_START;
  }
  else if (['else', 'elif', 'resume', 'except'].includes(firstWord)) {
    return LINE_TYPE.BLOCK_MIDDLE;
  }
  else if (Object.values(SYNTAX.tags.blockPairs).includes(firstWord)) {
    return LINE_TYPE.BLOCK_END;
  }

  return null;
}

/**
 * Determine if a line is a continuation of a previous expression
 * or if the next line should continue this line.
 */
function isStartOfContinuation(line, lineIndex, allLines) {
  const trimmed = line.trim();

  // Check for unclosed string delimiter
  let inString = false;
  let quoteChar = null;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    // Handle escape characters
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (trimmed[i] === '\\') {
      escapeNext = true;
      continue;
    }

    // Toggle string state on quotes
    if ((trimmed[i] === '"' || trimmed[i] === '\'')) {
      if (!inString) {
        inString = true;
        quoteChar = trimmed[i];
      } else if (quoteChar === trimmed[i]) {
        inString = false;
      }
    }
  }

  // If we end in an open string, this line must continue
  if (inString) {
    return true;
  }

  // If this line ends with an explicit backslash continuation
  if (trimmed.endsWith('\\')) {
    return true;
  }

  // Check if line ends with continuation characters
  const lastChar = trimmed.slice(-1);
  if (SYNTAX.continuation.endChars.includes(lastChar)) {
    return true;
  }

  // Check continuation operators
  if (SYNTAX.continuation.endOperators.some(op => trimmed.endsWith(op))) {
    return true;
  }

  // Check continuation keywords
  if (SYNTAX.continuation.endKeywords.some(keyword =>
    trimmed.endsWith(keyword.trim()) || (trimmed + ' ').endsWith(keyword))) {
    return true;
  }

  // Check if next non-comment line indicates continuation
  if (lineIndex + 1 < allLines.length) {
    let nextNonCommentIndex = lineIndex + 1;
    let nextLine = '';

    while (nextNonCommentIndex < allLines.length) {
      nextLine = allLines[nextNonCommentIndex].trim();
      if (!nextLine || nextLine.startsWith('//') || nextLine.startsWith('/*')) {
        nextNonCommentIndex++;
      } else {
        break;
      }
    }

    if (nextNonCommentIndex < allLines.length) {
      // Add this check before isContinuationOfExpression
      const nextFirstWord = getFirstWord(nextLine);
      const nextBlockType = determineBlockType(nextFirstWord);

      // If next line is a block structure, it's NOT a continuation
      if (nextBlockType) {
        return false;
      }

      if (isContinuationOfExpression(nextLine)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determine if a line looks like a continuation of a previous line's expression
 */
function isContinuationOfExpression(line) {
  if (!line.trim()) return false;

  const trimmed = line.trim();

  // Check if line starts with continuation characters
  const firstChar = trimmed[0];
  if (SYNTAX.continuation.startChars.includes(firstChar)) {
    return true;
  }

  // Check continuation operators
  if (SYNTAX.continuation.startOperators.some(op => trimmed.startsWith(op))) {
    return true;
  }

  // Check continuation keywords
  const firstWord = getFirstWord(trimmed);
  return SYNTAX.continuation.startKeywords.includes(firstWord);
}

/**
 * Parse and classify each line of the script
 */
function parseLines(lines) {
  const parsedLines = [];
  let prevLineType = null;
  let currentCommentBuffer = null; // Buffer for multi-line comments

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.indexOf(trimmed);

    if (!trimmed) {
      parsedLines.push({ content: '', indentation: 0, type: LINE_TYPE.EMPTY, blockType: null });
      continue;
    }

    let lineInfo = { content: trimmed, indentation: indent, type: null, blockType: null };

    if (trimmed.startsWith('//')) {
      lineInfo.content = trimmed.substring(2).trim();
      lineInfo.type = LINE_TYPE.COMMENT_SINGLE;
    } else if (trimmed.startsWith('/*') && trimmed.includes('*/')) {
      lineInfo.content = trimmed.substring(2, trimmed.indexOf('*/')).trim();
      lineInfo.type = LINE_TYPE.COMMENT_SINGLE;
    } else if (trimmed.startsWith('/*')) {
      lineInfo.content = trimmed.substring(2).trim();
      lineInfo.type = LINE_TYPE.COMMENT_MULTI_START;
    } else if (prevLineType === LINE_TYPE.COMMENT_MULTI_START || prevLineType === LINE_TYPE.COMMENT_MULTI_MIDDLE) {
      if (trimmed.includes('*/')) {
        lineInfo.content = trimmed.substring(0, trimmed.indexOf('*/')).trim();
        if (lineInfo.content.startsWith('*')) lineInfo.content = lineInfo.content.substring(1).trim();
        lineInfo.type = LINE_TYPE.COMMENT_MULTI_END;
      } else {
        lineInfo.content = trimmed;
        if (lineInfo.content.startsWith('*')) lineInfo.content = lineInfo.content.substring(1).trim();
        lineInfo.type = LINE_TYPE.COMMENT_MULTI_MIDDLE;
      }
    } else {
      const commentPos = findCommentOutsideString(trimmed);
      if (commentPos >= 0) {
        const code = trimmed.substring(0, commentPos).trim();
        const comment = trimmed.substring(commentPos + 2).trim();
        lineInfo.content = code;
        if ([LINE_TYPE.PRINT_START, LINE_TYPE.PRINT_CONTINUATION, LINE_TYPE.TAG_START, LINE_TYPE.TAG_CONTINUATION, LINE_TYPE.CODE_START, LINE_TYPE.CODE_CONTINUATION].includes(prevLineType)) {
          currentCommentBuffer = currentCommentBuffer ? `${currentCommentBuffer}; ${comment}` : comment; // Buffer for multi-line
        } else {
          lineInfo.inlineComment = comment; // Immediate use for single-line
        }
      }

      const firstWord = getFirstWord(lineInfo.content);

      if (prevLineType === LINE_TYPE.PRINT_START || prevLineType === LINE_TYPE.PRINT_CONTINUATION) {
        const isLastLine = !isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = isLastLine ? LINE_TYPE.PRINT_END : LINE_TYPE.PRINT_CONTINUATION;
        if (isLastLine && currentCommentBuffer) {
          lineInfo.inlineComment = currentCommentBuffer;
          currentCommentBuffer = null;
        }
      } else if (prevLineType === LINE_TYPE.CODE_START || prevLineType === LINE_TYPE.CODE_CONTINUATION) {
        const isLastLine = !isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = isLastLine ? LINE_TYPE.CODE_END : LINE_TYPE.CODE_CONTINUATION;
        if (isLastLine && currentCommentBuffer) {
          lineInfo.inlineComment = currentCommentBuffer;
          currentCommentBuffer = null;
        }
      } else if (prevLineType === LINE_TYPE.TAG_START || prevLineType === LINE_TYPE.TAG_CONTINUATION) {
        const isLastLine = !isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = isLastLine ? LINE_TYPE.TAG_END : LINE_TYPE.TAG_CONTINUATION;
        if (isLastLine && currentCommentBuffer) {
          lineInfo.inlineComment = currentCommentBuffer;
          currentCommentBuffer = null;
        }
      } else if (firstWord === 'print') {
        lineInfo.content = lineInfo.content.substring(5).trim();
        const willContinue = isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = willContinue ? LINE_TYPE.PRINT_START : LINE_TYPE.PRINT_STANDALONE;
      } else if (RESERVED_KEYWORDS.has(firstWord)) {
        lineInfo.blockType = determineBlockType(firstWord);
        const willContinue = isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = willContinue ? LINE_TYPE.TAG_START : LINE_TYPE.TAG_END;
      } else {
        const willContinue = isStartOfContinuation(lineInfo.content, i, lines);
        lineInfo.type = willContinue ? LINE_TYPE.CODE_START : LINE_TYPE.CODE_STANDALONE;
      }
    }

    parsedLines.push(lineInfo);
    prevLineType = lineInfo.type;
  }

  return parsedLines;
}

/**
 * Validate the block structure of the script
 */
function validateBlockStructure(parsedLines) {
  const stack = [];

  for (let i = 0; i < parsedLines.length; i++) {
    const line = parsedLines[i];

    // Skip non-block lines
    if (!line.blockType) {
      continue;
    }

    if (line.blockType === LINE_TYPE.BLOCK_START) {
      const tag = getFirstWord(line.content);
      stack.push({ tag, line: i + 1 });
    } else if (line.blockType === LINE_TYPE.BLOCK_MIDDLE) {
      const tag = getFirstWord(line.content);

      if (!stack.length) {
        return {
          valid: false,
          error: `Line ${i + 1}: '${tag}' outside of any block (content: "${line.content}")`
        };
      }

      const topTag = stack[stack.length - 1].tag;
      if (tag === 'else') {
        if (topTag !== 'if' && topTag !== 'for') {
          return {
            valid: false,
            error: `Line ${i + 1}: '${tag}' outside of 'if' or 'for' block (content: "${line.content}")`
          };
        }
      } else if (tag === 'elif' && topTag !== 'if') {
        return {
          valid: false,
          error: `Line ${i + 1}: '${tag}' outside of 'if' block (content: "${line.content}")`
        };
      }
    } else if (line.blockType === LINE_TYPE.BLOCK_END) {
      const tag = getFirstWord(line.content);

      if (!stack.length) {
        return {
          valid: false,
          error: `Line ${i + 1}: Unexpected '${tag}' (content: "${line.content}")`
        };
      }

      const topTag = stack[stack.length - 1].tag;
      const expectedEndTag = SYNTAX.tags.blockPairs[topTag];

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
 * Convert parsed lines to template lines
 */
function convertLinesToTemplate(parsedLines) {
  const templateLines = [];
  for (const line of parsedLines) {
    if (!line.type) continue;
    const indent = ' '.repeat(line.indentation);
    let output = '';
    switch (line.type) {
      case LINE_TYPE.EMPTY:
        output = '';
        break;
      case LINE_TYPE.COMMENT_SINGLE:
        output = `${indent}{# ${line.content} #}`;
        break;
      case LINE_TYPE.COMMENT_MULTI_START:
        output = `${indent}{# ${line.content}`;
        break;
      case LINE_TYPE.COMMENT_MULTI_MIDDLE:
        output = `${indent}   ${line.content}`;
        break;
      case LINE_TYPE.COMMENT_MULTI_END:
        output = `${indent}   ${line.content} #}`;
        break;
      case LINE_TYPE.PRINT_START:
        output = `${indent}{{- ${line.content}`;
        break;
      case LINE_TYPE.PRINT_CONTINUATION:
        output = `${indent}${line.content}`;
        break;
      case LINE_TYPE.PRINT_END:
        output = `${indent}${line.content} -}}`;
        break;
      case LINE_TYPE.PRINT_STANDALONE:
        output = `${indent}{{- ${line.content} -}}`;
        break;
      case LINE_TYPE.TAG_START:
        output = `${indent}{%- ${line.content} -}`;
        break;
      case LINE_TYPE.TAG_CONTINUATION:
        output = `${indent}${line.content}`;
        break;
      case LINE_TYPE.TAG_END:
        output = `${indent}{%- ${line.content} -%}`;
        break;
      case LINE_TYPE.CODE_STANDALONE:
        output = `${indent}{%- do ${line.content} -%}`;
        break;
      case LINE_TYPE.CODE_START:
        output = `${indent}{%- do ${line.content}`;
        break;
      case LINE_TYPE.CODE_CONTINUATION:
        output = `${indent}${line.content}`;
        break;
      case LINE_TYPE.CODE_END:
        output = `${indent}${line.content} -%}`;
        break;
      default:
        output = `${indent}${line.content || ''}`;
    }
    if (line.inlineComment && [LINE_TYPE.PRINT_END, LINE_TYPE.PRINT_STANDALONE, LINE_TYPE.TAG_END, LINE_TYPE.CODE_END, LINE_TYPE.CODE_STANDALONE].includes(line.type)) {
      output = addInlineComment(output, line.inlineComment);
    }
    templateLines.push(output);
  }
  return templateLines;
}

/**
 * Main function to convert script to template
 */
function scriptToTemplate(scriptStr) {
  // Handle special case of standalone end tag
  const trimmed = scriptStr.trim();
  let firstWord = getFirstWord(trimmed);

  if (Object.values(SYNTAX.tags.blockPairs).includes(firstWord) && trimmed === firstWord) {
    // Preserve indentation for standalone end tags
    const indent = scriptStr.indexOf(trimmed);
    return {
      template: `${' '.repeat(indent)}{% ${firstWord} %}\n`,
      error: null
    };
  }

  // Split the script into lines
  const lines = scriptStr.split('\n');

  // Parse and classify each line
  const parsedLines = parseLines(lines);

  // Validate block structure
  const validationResult = validateBlockStructure(parsedLines);
  if (!validationResult.valid) {
    return { template: null, error: validationResult.error };
  }

  // Convert parsed lines to template lines
  const templateLines = convertLinesToTemplate(parsedLines);

  // Join the template with newlines and return
  return {
    template: templateLines.join('\n') + '\n',
    error: null
  };
}

module.exports = {
  scriptToTemplate,
  getFirstWord,
  validateBlockStructure,
  parseLines,
  isStartOfContinuation,
  isContinuationOfExpression,
  convertLinesToTemplate,
  findCommentOutsideString,
  determineBlockType,
  addInlineComment,
  LINE_TYPE,
  SYNTAX,
  LINE_TYPE_TRANSITIONS
};
