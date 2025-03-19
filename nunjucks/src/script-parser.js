/**
 * # State Machine Parser for Template Language Tokens
 *
 * ## Introduction
 *
 * This state machine parser is designed to identify and extract tokens from a template language
 * (similar to Nunjucks) syntax within a single line of code. It specifically focuses on detecting
 * three key types of constructs:
 *
 * 1. **String literals** - Single quotes, double quotes, and template literals
 * 2. **Comments** - Single-line and multi-line comments
 * 3. **Regular expressions** - Using the Nunjucks-style r/pattern/flags syntax
 *
 * The parser processes a single line at a time, with minimal state carried from previous
 * lines. Specifically, it tracks if the current line begins as part of a multi-line
 * comment and if a string with an escape character at the end needs to be continued.
 *
 * ## Requirements
 *
 * ### Input
 * 1. A single line of text (string)
 * 2. A boolean flag indicating if the line starts inside a multi-line comment
 * 3. A stringState object to track string continuation across lines (for escaped characters)
 *
 * ### Output
 * An array of token objects, each containing:
 * - type: The token type (e.g., 'STRING', 'COMMENT', 'REGEX', 'CODE')
 * - start: The start index within the line (inclusive)
 * - end: The end index within the line (exclusive)
 * - value: The actual content of the token
 * - subtype: Optional additional information (e.g., 'SINGLE_QUOTED', 'DOUBLE_QUOTED', etc.)
 *
 * ### States
 * 1. NORMAL: Processing regular code
 * 2. STRING: Inside a string (subtype determines single-quote, double-quote, or template literal)
 * 3. REGEX: Inside a regex pattern (after seeing r/)
 * 4. SINGLE_LINE_COMMENT: Inside a // comment
 * 5. MULTI_LINE_COMMENT: Inside a /* * / comment
 *
 * ### Transition Rules
 * - **NORMAL → STRING**: When a quote character (', ", `) is encountered
 * - **NORMAL → REGEX**: When r/ is encountered (with appropriate context and pattern validation)
 * - **NORMAL → SINGLE_LINE_COMMENT**: When // is encountered
 * - **NORMAL → MULTI_LINE_COMMENT**: When /* is encountered
 * - **STRING → NORMAL**: When an unescaped closing quote matching the opening quote is encountered
 * - **REGEX → NORMAL**: When an unescaped closing forward slash is encountered
 * - **SINGLE_LINE_COMMENT**: Remains in this state until end of line
 * - **MULTI_LINE_COMMENT → NORMAL**: When * / is encountered
 *
 * ### Special Handling Requirements
 * 1. **Escaped characters**: Handle escaped quotes (\', \", \`) and escaped slashes (\/)
 * 2. **String continuation**: Track strings that end with an escape character for continuation across lines
 * 3. **Context detection**: r/ is recognized as a regex only when it appears in a valid context
 *    (not inside a variable name or after certain characters)
 * 4. **Pattern validation**: Use lookahead to verify a complete regex pattern exists with closing slash
 *    to distinguish from division operations (e.g., r/2 vs r/pattern/)
 * 5. **Regex flags**: Capture any flags after the closing slash of a regex (g, i, m, y, s, u, d)
 * 6. **Flag validation**: Detect and mark duplicate flags as malformed (e.g., r/pattern/gg)
 * 7. **Multi-line comment continuation**: If a multi-line comment doesn't close within the line,
 *    the next line should be informed
 * 8. **Ignoring divisions**: Distinguish between the division operator (/) and regex delimiters
 * 9. **Indentation handling**: Extract and track indentation (spaces and tabs) at the start of each line
 */

// Token-related constants
const STATES = {
  NORMAL: 'NORMAL',
  STRING: 'STRING',
  REGEX: 'REGEX',
  SINGLE_LINE_COMMENT: 'SINGLE_LINE_COMMENT',
  MULTI_LINE_COMMENT: 'MULTI_LINE_COMMENT'
};

const TOKEN_TYPES = {
  STRING: 'STRING',
  COMMENT: 'COMMENT',
  REGEX: 'REGEX',
  CODE: 'CODE'
};

const TOKEN_SUBTYPES = {
  SINGLE_QUOTED: 'SINGLE_QUOTED',
  DOUBLE_QUOTED: 'DOUBLE_QUOTED',
  TEMPLATE: 'TEMPLATE',
  SINGLE_LINE: 'SINGLE_LINE',
  MULTI_LINE: 'MULTI_LINE',
  REGEX: 'REGEX'
};

const VALID_REGEX_FLAGS = new Set(['g', 'i', 'm', 'y', 's', 'u', 'd']);

/**
 * Extract indentation (whitespace) at the beginning of a line
 */
function extractIndentation(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : '';
}

/**
 * Creates a token object
 */
function createToken(type, subtype, start, value = '') {
  const token = {
    type,
    subtype,
    start,
    end: null,
    value
  };

  // Add regex-specific properties if needed
  if (type === TOKEN_TYPES.REGEX) {
    token.flags = '';
    token.incomplete = false;
    token.isMalformed = false;
  }

  return token;
}

/**
 * Creates a code token
 */
function createCodeToken(start, end, value) {
  return {
    type: TOKEN_TYPES.CODE,
    start,
    end,
    value
  };
}

/**
 * Finalizes any code token in progress
 */
function finalizeCodeToken(state) {
  const { tokens, line, codeStart, index } = state;

  if (codeStart === null || codeStart >= index) {
    state.codeStart = null;
    return;
  }

  tokens.push(createCodeToken(
    codeStart,
    index,
    line.substring(codeStart, index)
  ));

  state.codeStart = null;
}

/**
 * Checks if a character at the given index could be part of a valid regex pattern
 */
function isValidRegexContext(line, index) {
  // Valid at start of line
  if (index === 0) return true;

  // Not valid if preceded by an identifier character or certain operators
  const prevChar = line.charAt(index - 1);
  return !/[a-zA-Z0-9_$)]/.test(prevChar);
}

/**
 * Performs lookahead to verify a complete regex pattern exists
 */
function hasCompleteRegexPattern(line, index) {
  // We expect 'r' at index, followed by '/'
  if (index + 1 >= line.length || line[index + 1] !== '/') {
    return false;
  }

  // Look for an unescaped closing '/'
  let i = index + 2;
  let escaped = false;

  while (i < line.length) {
    const char = line[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '/') {
      return true; // Found the closing slash
    }

    i++;
  }

  return false;
}

/**
 * Process a character in the NORMAL state
 */
function processNormalState(state) {
  const { line, index } = state;
  const char = line[index];
  const nextChar = index < line.length - 1 ? line[index + 1] : '';

  // Check for the start of a string
  if (char === '\'' || char === '"' || char === '`') {
    finalizeCodeToken(state);

    // Start string state
    state.currentState = STATES.STRING;
    state.stringDelimiter = char;

    const subtype = char === '\'' ? TOKEN_SUBTYPES.SINGLE_QUOTED :
      char === '"' ? TOKEN_SUBTYPES.DOUBLE_QUOTED :
        TOKEN_SUBTYPES.TEMPLATE;

    // For template literals, we'll need to track expression depth
    if (char === '`') {
      state.templateDepth = 0;
      state.bracketBalance = 0;
    }

    // Create token with the correct position
    state.currentToken = createToken(TOKEN_TYPES.STRING, subtype, index, char);
    return;
  }

  // Check for $ followed by { in a template literal - should be part of the string
  // This prevents the normal state from processing these as separate tokens
  if (state.currentState === STATES.STRING && state.stringDelimiter === '`' &&
      char === '$' && nextChar === '{') {
    state.currentToken.value += char;
    return;
  }

  // Check for the start of a regex
  if (char === 'r' && nextChar === '/' &&
      isValidRegexContext(line, index) &&
      hasCompleteRegexPattern(line, index)) {

    finalizeCodeToken(state);
    state.currentState = STATES.REGEX;
    state.currentToken = createToken(TOKEN_TYPES.REGEX, TOKEN_SUBTYPES.REGEX, index, 'r/');
    state.index++; // Skip the '/'
    return;
  }

  // Check for the start of a comment
  if (char === '/') {
    if (nextChar === '/') {
      // Single-line comment
      finalizeCodeToken(state);
      state.currentState = STATES.SINGLE_LINE_COMMENT;
      state.currentToken = createToken(TOKEN_TYPES.COMMENT, TOKEN_SUBTYPES.SINGLE_LINE, index, '//');
      state.index++; // Skip the second '/'
    } else if (nextChar === '*') {
      // Multi-line comment
      finalizeCodeToken(state);
      state.currentState = STATES.MULTI_LINE_COMMENT;
      state.currentToken = createToken(TOKEN_TYPES.COMMENT, TOKEN_SUBTYPES.MULTI_LINE, index, '/*');
      state.index++; // Skip the '*'
    } else if (state.codeStart === null) {
      state.codeStart = index;
    }
    return;
  }

  // Regular code
  if (state.codeStart === null) {
    state.codeStart = index;
  }
}

/**
 * Process a character in the STRING state
 */
function processStringState(state) {
  const { currentToken, line, index } = state;
  const char = line[index];
  const prevChar = index > 0 ? line[index - 1] : '';

  // Handle escaped characters
  if (state.escaped) {
    currentToken.value += char;
    state.escaped = false;
    return;
  }

  if (char === '\\') {
    currentToken.value += char;
    state.escaped = true;
    return;
  }

  // Special handling for template literals
  if (state.stringDelimiter === '`') {
    // Add the character to the current token
    currentToken.value += char;

    // Initialize template tracking variables if they don't exist
    if (state.expressionDepth === undefined) {
      state.expressionDepth = 0;
      state.bracketStack = [];
    }

    // Handle expression start
    if (char === '{' && prevChar === '$' && state.bracketStack.length === 0) {
      state.expressionDepth++;
      state.bracketStack.push('{');
      return;
    }

    // Track bracket nesting inside expressions
    if (state.expressionDepth > 0) {
      if (char === '{' && state.bracketStack[state.bracketStack.length - 1] !== '`') {
        state.bracketStack.push('{');
      } else if (char === '}' && state.bracketStack[state.bracketStack.length - 1] === '{') {
        state.bracketStack.pop();
        if (state.bracketStack.length === 0) {
          state.expressionDepth--;
        }
      } else if (char === '`') {
        // Track nested template literals inside expressions
        if (prevChar !== '\\') {
          if (state.bracketStack[state.bracketStack.length - 1] === '`') {
            state.bracketStack.pop(); // End of nested template
          } else {
            state.bracketStack.push('`'); // Start of nested template
          }
        }
      }
      return;
    }

    // Check for the end of the template literal (only when not in expression)
    if (char === '`' && state.expressionDepth === 0 && prevChar !== '\\') {
      currentToken.end = index + 1;
      state.tokens.push(currentToken);

      // Return to normal state
      state.currentToken = null;
      state.currentState = STATES.NORMAL;
      state.codeStart = index + 1;
      state.stringDelimiter = '';
      state.expressionDepth = undefined;
      state.bracketStack = undefined;
    }
    return;
  }

  // Check for the end of the string (non-template literals)
  if (char === state.stringDelimiter) {
    currentToken.value += char;
    currentToken.end = index + 1;
    state.tokens.push(currentToken);

    // Return to normal state
    state.currentToken = null;
    state.currentState = STATES.NORMAL;
    state.codeStart = index + 1;
    state.stringDelimiter = '';
    return;
  }

  // Regular character in string
  currentToken.value += char;
}

/**
 * Process a character in the REGEX state
 */
function processRegexState(state) {
  const { currentToken, line, index } = state;
  const char = line[index];
  const prevChar = index > 0 ? line[index - 1] : '';

  // Add the character to the regex
  currentToken.value += char;

  // Check for the end of the regex pattern
  if (char === '/' && prevChar !== '\\' && currentToken.value.length > 2) {
    // Look for and process flags
    let flagsEnd = processRegexFlags(state);

    // Finalize the regex token
    currentToken.end = flagsEnd;
    state.tokens.push(currentToken);

    // Return to normal state
    state.currentToken = null;
    state.currentState = STATES.NORMAL;
    state.codeStart = flagsEnd;
    state.index = flagsEnd - 1; // Will be incremented in the main loop
  }
}

/**
 * Process regex flags after the closing slash
 */
function processRegexFlags(state) {
  const { currentToken, line, index } = state;
  let flagsEnd = index + 1;
  const seenFlags = new Set();

  // Collect all flags
  while (flagsEnd < line.length) {
    const flagChar = line[flagsEnd];

    if (VALID_REGEX_FLAGS.has(flagChar)) {
      if (seenFlags.has(flagChar)) {
        // Duplicate flag
        currentToken.isMalformed = true;
      }

      seenFlags.add(flagChar);
      currentToken.flags += flagChar;
      currentToken.value += flagChar;
      flagsEnd++;
    } else {
      break;
    }
  }

  return flagsEnd;
}

/**
 * Process a character in the SINGLE_LINE_COMMENT state
 */
function processSingleLineComment(state) {
  const { currentToken, line, index } = state;

  // Add the character to the comment
  currentToken.value += line[index];

  // Check if we've reached the end of the line
  if (index === line.length - 1) {
    currentToken.end = line.length;
    state.tokens.push(currentToken);

    // Reset state
    state.currentToken = null;
    state.currentState = STATES.NORMAL;
  }
}

/**
 * Process a character in the MULTI_LINE_COMMENT state
 */
function processMultiLineComment(state) {
  const { currentToken, line, index } = state;
  const char = line[index];
  const prevChar = index > 0 ? line[index - 1] : '';

  // Add the character to the comment
  currentToken.value += char;

  // Check for the end of the comment - standard JavaScript behavior
  if (char === '/' && prevChar === '*') {
    currentToken.end = index + 1;
    state.tokens.push(currentToken);

    // Reset state
    state.currentToken = null;
    state.currentState = STATES.NORMAL;
    state.codeStart = index + 1;
  }
}

/**
 * Finalize any open tokens at the end of the line
 */
function finalizeEndOfLine(state) {
  const { line, currentToken, currentState, codeStart } = state;

  // Initialize result object
  const result = {
    tokens: state.tokens,
    inMultiLineComment: state.currentState === STATES.MULTI_LINE_COMMENT,
    stringState: null,
    indentation: state.indentation
  };

  // Handle unfinished tokens
  if (currentToken) {
    currentToken.end = line.length;

    // Mark strings and regexes as incomplete
    if (currentState === STATES.STRING || currentState === STATES.REGEX) {
      currentToken.incomplete = true;

      if (currentState === STATES.REGEX) {
        currentToken.isMalformed = true;
      }

      // Special handling for strings that might continue to next line
      if (currentState === STATES.STRING) {
        // Check if the line ends with an escape character that should cause continuation
        const lastCharIndex = line.length - 1;
        const lastChar = lastCharIndex >= 0 ? line.charAt(lastCharIndex) : '';

        // Handle Unicode escapes (needs continuation)
        const endsWithUnicodeEscape = line.match(/\\u[\da-fA-F]{0,3}$/);
        if (endsWithUnicodeEscape) {
          result.stringState = {
            escaped: false,
            delimiter: state.stringDelimiter
          };
        }
        // Handle regular backslash escapes
        else if (lastChar === '\\') {
          // Count backslashes from the end to handle double escapes
          let backslashCount = 1;
          let pos = lastCharIndex - 1;

          while (pos >= 0 && line.charAt(pos) === '\\') {
            backslashCount++;
            pos--;
          }

          // Odd number of backslashes means the last one escapes something on the next line
          if (backslashCount % 2 === 1) {
            result.stringState = {
              escaped: true,
              delimiter: state.stringDelimiter
            };
          }
          // Even number means they escape each other, not the line break
          // stringState remains null, which means no continuation
        }
        // For regular unterminated strings without escape characters at the end,
        // we set stringState to continue the string
        else if (currentToken.value.charAt(0) === state.stringDelimiter &&
                !currentToken.value.endsWith(state.stringDelimiter)) {
          result.stringState = {
            escaped: false,
            delimiter: state.stringDelimiter
          };
        }
      }
    }

    // Add the token to the result
    state.tokens.push(currentToken);
  } else if (codeStart !== null && codeStart < line.length) {
    // Handle any trailing code
    state.tokens.push(createCodeToken(
      codeStart,
      line.length,
      line.substring(codeStart, line.length)
    ));
  }

  // Handle the case of a line with only indentation (no tokens)
  if (state.tokens.length === 0 && state.indentation.length > 0) {
    // For a line with only indentation, add an empty code token
    state.tokens.push(createCodeToken(
      state.indentation.length,
      state.indentation.length,
      ''
    ));
  }

  return result;
}

/**
 * Process a single character based on the current state
 */
function processCharacter(state) {
  const { currentState } = state;

  switch (currentState) {
    case STATES.NORMAL:
      processNormalState(state);
      break;
    case STATES.STRING:
      processStringState(state);
      break;
    case STATES.REGEX:
      processRegexState(state);
      break;
    case STATES.SINGLE_LINE_COMMENT:
      processSingleLineComment(state);
      break;
    case STATES.MULTI_LINE_COMMENT:
      processMultiLineComment(state);
      break;
  }
}

function parseTemplateLine(line, inMultiLineComment = false, stringState = null) {
  // Extract indentation from the line
  const indentation = extractIndentation(line);

  // Initialize parser state
  const state = {
    line,
    index: 0,
    tokens: [],
    currentState: inMultiLineComment ? STATES.MULTI_LINE_COMMENT : STATES.NORMAL,
    currentToken: null,
    codeStart: inMultiLineComment ? null : indentation.length,
    escaped: false,
    stringDelimiter: '',
    indentation // Store indentation in state
  };

  // Handle continuation from previous line
  if (stringState) {
    // Continuing a string from previous line (could be due to escape or Unicode)
    state.currentState = STATES.STRING;
    state.escaped = stringState.escaped;
    state.stringDelimiter = stringState.delimiter;

    const subtype = stringState.delimiter === '\'' ? TOKEN_SUBTYPES.SINGLE_QUOTED :
      stringState.delimiter === '"' ? TOKEN_SUBTYPES.DOUBLE_QUOTED :
        TOKEN_SUBTYPES.TEMPLATE;

    state.currentToken = createToken(TOKEN_TYPES.STRING, subtype, indentation.length, '');
    state.codeStart = null;
  } else if (inMultiLineComment) {
    // Continuing a multi-line comment
    state.currentToken = createToken(TOKEN_TYPES.COMMENT, TOKEN_SUBTYPES.MULTI_LINE, indentation.length, '');
  }

  // Process the line character by character
  while (state.index < line.length) {
    processCharacter(state);
    state.index++;
  }

  // Handle any unfinished business
  const result = finalizeEndOfLine(state);

  // Ensure indentation is included in the result
  // Only replace if indentation is undefined or null, not if it's an empty string
  if (result.indentation === undefined || result.indentation === null) {
    result.indentation = state.indentation;
  }

  return result;
}

// Export
module.exports = {
  STATES,
  TOKEN_TYPES,
  TOKEN_SUBTYPES,
  parseTemplateLine,
  isValidRegexContext,
  hasCompleteRegexPattern,
  extractIndentation
};
