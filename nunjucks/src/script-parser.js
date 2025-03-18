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

// Constants
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

/**
 * Determine if 'r/' is a valid start of a regex.
 * It must be at the beginning of the line or preceded by a non-alphanumeric-underscore character.
 */
function isValidRegexContext(line, index) {
  if (index === 0) return true; // Valid at start of line
  const alphanumeric = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  return !alphanumeric.includes(line.charAt(index - 1).toLowerCase());
}

/**
 * Check if a potential regex pattern starting at 'r/' is a complete, valid regex.
 * This performs lookahead to confirm there's a closing slash before committing.
 */
function isCompleteRegexPattern(line, startIndex) {
  // We're already at 'r', so check the next character is '/'
  if (startIndex + 1 >= line.length || line[startIndex + 1] !== '/') {
    return false;
  }

  // Skip past 'r/'
  let index = startIndex + 2;
  let escaped = false;

  // Look for an unescaped closing '/'
  while (index < line.length) {
    const char = line[index];

    if (escaped) {
      // Previous character was escape - this character is escaped
      escaped = false;
    } else if (char === '\\') {
      // Escape character found
      escaped = true;
    } else if (char === '/') {
      // Found an unescaped closing slash - we have a complete regex!
      return true;
    }

    index++;
  }

  // No closing slash found, not a complete regex
  return false;
}

/**
 * Finalize any CODE token in progress.
 */
function finalizeCodeToken(tokens, line, codeStart, endPos) {
  if (codeStart === null || codeStart >= endPos) return null;
  const codeValue = line.substring(codeStart, endPos);
  tokens.push({
    type: TOKEN_TYPES.CODE,
    start: codeStart,
    end: endPos,
    value: codeValue
  });
  return null; // Reset codeStart
}

/**
 * Handle a character when in STRING state. Returns `true` if the string has ended.
 */
function parseStringChar(parserState, char) {
  const { currentToken } = parserState;

  if (parserState.escaped) {
    // Escaped char: just add it
    currentToken.value += char;
    parserState.escaped = false;
    return false;
  }

  if (char === '\\') {
    currentToken.value += char;
    parserState.escaped = true;
    return false;
  }

  // If we find the matching delimiter, end the string
  if (char === parserState.stringDelimiter) {
    currentToken.value += char;
    currentToken.end = parserState.index + 1;
    return true;
  }

  // Otherwise, just accumulate
  currentToken.value += char;
  return false;
}

/**
 * Handle a character when in REGEX state. Returns `true` if the regex has ended.
 * Exactly matching Nunjucks implementation.
 */
function parseRegexChar(parserState, char) {
  const { currentToken } = parserState;
  const prevChar = parserState.index > 0 ? parserState.line[parserState.index - 1] : '';

  // Check for the closing slash - only if previous character is not an escape
  // Exactly like Nunjucks: current() === '/' && previous() !== '\\'
  if (char === '/' && prevChar !== '\\') {
    currentToken.value += char;
    parserState.index++;

    // Collect flags (exactly matching Nunjucks' approach)
    const POSSIBLE_FLAGS = ['g', 'i', 'm', 'y', 's', 'u', 'd'];
    let regexFlags = '';
    // Track seen flags to prevent duplicates
    const seenFlags = new Set();

    while (parserState.index < parserState.line.length) {
      const flagChar = parserState.line[parserState.index];
      const isCurrentAFlag = POSSIBLE_FLAGS.includes(flagChar);

      if (isCurrentAFlag && !seenFlags.has(flagChar)) {
        // Only add if this flag hasn't been seen before
        seenFlags.add(flagChar);
        regexFlags += flagChar;
        currentToken.value += flagChar;
        parserState.index++;
      } else if (isCurrentAFlag && seenFlags.has(flagChar)) {
        // Flag is a duplicate - mark as malformed
        currentToken.isMalformed = true;
        regexFlags += flagChar;
        currentToken.value += flagChar;
        parserState.index++;
      } else {
        break;
      }
    }

    currentToken.flags = regexFlags;
    currentToken.end = parserState.index;
    return true;
  }

  // Just add the character to the regex
  currentToken.value += char;
  return false;
}

/**
 * Main parse function.
 */
function parseTemplateLine(line, inMultiLineComment = false, stringState = null) {
  const parserState = {
    line,
    index: 0,
    currentState: inMultiLineComment ? STATES.MULTI_LINE_COMMENT : STATES.NORMAL,
    currentToken: null,
    tokens: [],
    codeStart: inMultiLineComment ? null : 0,
    escaped: stringState ? stringState.escaped : false,
    stringDelimiter: stringState ? stringState.delimiter : '',
    seenFlags: []
  };

  if (stringState && stringState.escaped) {
    parserState.currentState = STATES.STRING;
    parserState.currentToken = {
      type: TOKEN_TYPES.STRING,
      subtype: (stringState.delimiter === '\'') ? TOKEN_SUBTYPES.SINGLE_QUOTED :
        (stringState.delimiter === '"') ? TOKEN_SUBTYPES.DOUBLE_QUOTED :
          TOKEN_SUBTYPES.TEMPLATE,
      start: 0,
      end: null,
      value: ''
    };
    parserState.codeStart = null;
  } else if (inMultiLineComment) {
    parserState.currentToken = {
      type: TOKEN_TYPES.COMMENT,
      subtype: TOKEN_SUBTYPES.MULTI_LINE,
      start: 0,
      end: null,
      value: ''
    };
  }

  for (; parserState.index < line.length; parserState.index++) {
    const char = line[parserState.index];
    const nextChar = (parserState.index < line.length - 1) ? line[parserState.index + 1] : '';

    switch (parserState.currentState) {
      case STATES.NORMAL:
        switch (char) {
          case '\'':
          case '"':
          case '`':
            parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index);
            parserState.currentState = STATES.STRING;
            parserState.currentToken = {
              type: TOKEN_TYPES.STRING,
              subtype: (char === '\'') ? TOKEN_SUBTYPES.SINGLE_QUOTED :
                (char === '"') ? TOKEN_SUBTYPES.DOUBLE_QUOTED :
                  TOKEN_SUBTYPES.TEMPLATE,
              start: parserState.index,
              end: null,
              value: char
            };
            parserState.stringDelimiter = char;
            break;

          case 'r':
            if (nextChar === '/' && isValidRegexContext(line, parserState.index) && isCompleteRegexPattern(line, parserState.index)) {
              parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index);
              parserState.currentState = STATES.REGEX;
              parserState.currentToken = {
                type: TOKEN_TYPES.REGEX,
                subtype: TOKEN_SUBTYPES.REGEX,
                start: parserState.index,
                end: null,
                value: 'r/',
                flags: '',
                incomplete: false,
                isMalformed: false
              };
              parserState.index++;
            } else if (parserState.codeStart === null) {
              parserState.codeStart = parserState.index;
            }
            break;

          case '/':
            if (nextChar === '/') {
              parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index);
              parserState.currentState = STATES.SINGLE_LINE_COMMENT;
              parserState.currentToken = {
                type: TOKEN_TYPES.COMMENT,
                subtype: TOKEN_SUBTYPES.SINGLE_LINE,
                start: parserState.index,
                end: null,
                value: '//'
              };
              parserState.index++;
            } else if (nextChar === '*') {
              parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index);
              parserState.currentState = STATES.MULTI_LINE_COMMENT;
              parserState.currentToken = {
                type: TOKEN_TYPES.COMMENT,
                subtype: TOKEN_SUBTYPES.MULTI_LINE,
                start: parserState.index,
                end: null,
                value: '/*'
              };
              parserState.index++;
            } else if (parserState.codeStart === null) {
              parserState.codeStart = parserState.index;
            }
            break;

          default:
            if (parserState.codeStart === null) {
              parserState.codeStart = parserState.index;
            }
            break;
        }
        break;

      case STATES.STRING: {
        const ended = parseStringChar(parserState, char);
        if (ended) {
          parserState.tokens.push(parserState.currentToken);
          parserState.currentToken = null;
          parserState.currentState = STATES.NORMAL;
          parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index + 1);
          parserState.codeStart = parserState.index + 1; // Always start a new CODE token
          parserState.escaped = false;
          parserState.stringDelimiter = '';
        }
        break;
      }

      case STATES.REGEX: {
        const ended = parseRegexChar(parserState, char);
        if (ended) {
          parserState.tokens.push(parserState.currentToken);
          parserState.currentToken = null;
          parserState.currentState = STATES.NORMAL;
          parserState.codeStart = finalizeCodeToken(parserState.tokens, line, parserState.codeStart, parserState.index);
          parserState.codeStart = parserState.index; // Always start a new CODE token
          parserState.index--; // Adjust for loop increment
        }
        break;
      }

      case STATES.SINGLE_LINE_COMMENT:
        parserState.currentToken.value += char;
        if (parserState.index === line.length - 1) {
          parserState.currentToken.end = parserState.index + 1;
          parserState.tokens.push(parserState.currentToken);
          parserState.currentToken = null;
          parserState.currentState = STATES.NORMAL;
        }
        break;

      case STATES.MULTI_LINE_COMMENT:
        parserState.currentToken.value += char;
        if (char === '/' && parserState.index > 0 && line[parserState.index - 1] === '*') {
          parserState.currentToken.end = parserState.index + 1;
          parserState.tokens.push(parserState.currentToken);
          parserState.currentToken = null;
          parserState.currentState = STATES.NORMAL;
          parserState.codeStart = parserState.index + 1;
        }
        break;
    }
  }

  // End of line: finalize open tokens
  if (parserState.currentToken) {
    parserState.currentToken.end = line.length;
    if (parserState.currentState === STATES.STRING || parserState.currentState === STATES.REGEX) {
      parserState.currentToken.incomplete = true;
      if (parserState.currentState === STATES.REGEX) {
        parserState.currentToken.isMalformed = true;
      }
    }
    parserState.tokens.push(parserState.currentToken);
    // Add trailing CODE token if STRING or REGEX ends the line (complete or incomplete)
    if (parserState.currentState === STATES.STRING || parserState.currentState === STATES.REGEX) {
      parserState.tokens.push({
        type: TOKEN_TYPES.CODE,
        start: line.length,
        end: line.length,
        value: ''
      });
    }
  } else if (parserState.codeStart !== null && parserState.tokens.length > 0) {
    // If no currentToken but codeStart is set and we have tokens (e.g., after a completed STRING/REGEX),
    // finalize the code and add a trailing empty CODE token if it ends the line
    finalizeCodeToken(parserState.tokens, line, parserState.codeStart, line.length);
    if (parserState.tokens[parserState.tokens.length - 1].end === line.length &&
        (parserState.tokens[parserState.tokens.length - 1].type === TOKEN_TYPES.STRING ||
         parserState.tokens[parserState.tokens.length - 1].type === TOKEN_TYPES.REGEX)) {
      parserState.tokens.push({
        type: TOKEN_TYPES.CODE,
        start: line.length,
        end: line.length,
        value: ''
      });
    }
  } else if (parserState.codeStart !== null) {
    // Finalize any trailing code
    finalizeCodeToken(parserState.tokens, line, parserState.codeStart, line.length);
  }

  return {
    tokens: parserState.tokens,
    inMultiLineComment: (parserState.currentState === STATES.MULTI_LINE_COMMENT),
    stringState: parserState.currentState === STATES.STRING ? {
      escaped: parserState.escaped,
      delimiter: parserState.stringDelimiter
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
  isCompleteRegexPattern
};
