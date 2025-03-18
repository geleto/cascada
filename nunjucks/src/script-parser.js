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
 * - subtype: Optional additional information (e.g., 'SINGLE_QUOTED', 'MULTI_LINE', etc.)
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
 *
 * ### Edge Cases
 * 1. Handle escaped backslashes (e.g., \\ in strings)
 * 2. Handle empty strings ('', "", ``)
 * 3. Handle empty regex patterns (r//)
 * 4. Properly detect regex vs. division operations
 * 5. Handle template literals with expressions (though expressions inside template literals are not fully parsed)
 * 6. Handle line breaks within strings (via the stringState tracking)
 *
 * ### Data Structures
 * - **Token object**:
 *   {
 *     type: 'STRING' | 'COMMENT' | 'REGEX' | 'CODE',
 *     subtype: 'SINGLE_QUOTED' | 'DOUBLE_QUOTED' | 'TEMPLATE' | 'SINGLE_LINE' | 'MULTI_LINE' | 'REGEX',
 *     start: number,
 *     end: number,
 *     value: string,
 *     flags?: string, // Only for regex tokens
 *     incomplete?: boolean, // For incomplete tokens at end of line
 *     isMalformed?: boolean // For malformed regex patterns
 *   }
 *
 * - **Parser state**:
 *   {
 *     line: string,
 *     index: number,
 *     currentState: 'NORMAL' | 'STRING' | 'REGEX' | 'SINGLE_LINE_COMMENT' | 'MULTI_LINE_COMMENT',
 *     currentToken: Token | null,
 *     tokens: Token[],
 *     codeStart: number | null,
 *     escaped: boolean, // For tracking escaped characters
 *     stringDelimiter: string, // For tracking the string type (', ", or `)
 *   }
 *
 * - **String state**:
 *   {
 *     escaped: boolean, // Was the last character an escape character
 *     delimiter: string // The string delimiter (', ", or `)
 *   }
 *
 * ### Return Value
 * The function returns:
 * 1. An array of token objects
 * 2. A boolean indicating if the next line will start inside a multi-line comment
 * 3. A stringState object, if the line ends inside a string with an escape character
 *
 * {
 *   tokens: Token[],
 *   inMultiLineComment: boolean,
 *   stringState: { escaped: boolean, delimiter: string } | null
 * }
 *
 * This design gives you all the necessary components to build a robust single-line token parser
 * that can be integrated with your existing multi-line expression processing system.
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
    state.currentToken = createToken(TOKEN_TYPES.STRING, subtype, index, char);
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

  // Check for the end of the string
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

  // Check for the end of the comment
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

  // Handle unfinished tokens
  if (currentToken) {
    currentToken.end = line.length;

    // Mark strings and regexes as incomplete
    if (currentState === STATES.STRING || currentState === STATES.REGEX) {
      currentToken.incomplete = true;

      if (currentState === STATES.REGEX) {
        currentToken.isMalformed = true;
      }
    }

    state.tokens.push(currentToken);
  } else if (codeStart !== null && codeStart < line.length) {
    // Handle any trailing code
    state.tokens.push(createCodeToken(
      codeStart,
      line.length,
      line.substring(codeStart, line.length)
    ));
  }
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

/**
 * Parse a line of template language code
 */
function parseTemplateLine(line, inMultiLineComment = false, stringState = null) {
  // Initialize parser state
  const state = {
    line,
    index: 0,
    tokens: [],
    currentState: inMultiLineComment ? STATES.MULTI_LINE_COMMENT : STATES.NORMAL,
    currentToken: null,
    codeStart: inMultiLineComment ? null : 0,
    escaped: false,
    stringDelimiter: ''
  };

  // Handle continuation from previous line
  if (stringState && stringState.escaped) {
    // Continuing a string from previous line
    state.currentState = STATES.STRING;
    state.escaped = true;
    state.stringDelimiter = stringState.delimiter;

    const subtype = stringState.delimiter === '\'' ? TOKEN_SUBTYPES.SINGLE_QUOTED :
      stringState.delimiter === '"' ? TOKEN_SUBTYPES.DOUBLE_QUOTED :
        TOKEN_SUBTYPES.TEMPLATE;
    state.currentToken = createToken(TOKEN_TYPES.STRING, subtype, 0, '');
    state.codeStart = null;
  } else if (inMultiLineComment) {
    // Continuing a multi-line comment
    state.currentToken = createToken(TOKEN_TYPES.COMMENT, TOKEN_SUBTYPES.MULTI_LINE, 0, '');
  }

  // Process the line character by character
  while (state.index < line.length) {
    processCharacter(state);
    state.index++;
  }

  // Handle any unfinished business
  finalizeEndOfLine(state);

  // Return the result with continuation state
  return {
    tokens: state.tokens,
    inMultiLineComment: state.currentState === STATES.MULTI_LINE_COMMENT,
    stringState: state.currentState === STATES.STRING ? {
      escaped: state.escaped,
      delimiter: state.stringDelimiter
    } : null
  };
}

// Export
module.exports = {
  STATES,
  TOKEN_TYPES,
  TOKEN_SUBTYPES,
  parseTemplateLine,
  isValidRegexContext,
  hasCompleteRegexPattern
};
