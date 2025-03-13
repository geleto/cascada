/**
 * Cascada Script Processor
 *
 * This module processes Cascada script files and converts them to Nunjucks/Cascada template files.
 * It handles line joining and the conversion between script and template syntax.
 *
 * Key features:
 * - Use 'print' keyword for explicit output
 * - 'do' keyword is implicit for lines without a reserved keyword
 * - Automatic line joining for expressions that span multiple lines
 * - Conversion from script syntax to template syntax
 * - Comment handling, including single-line (//) and multi-line (/* * /) comments
 * - Error detection for mismatched block tags
 * - Support for all Cascada tags
 *
 * Note: While indentation may be used for readability, it is not required for
 * determining block structure since explicit end tags are used.
 * Avoid using reserved keywords (e.g., 'print', 'for', 'if') as variable or function names.
 */

const CONTINUATION_END_CHARS = '{([,?:-+=|&.!*/%^<>~';
const CONTINUATION_END_OPERATORS = ['&&', '||', '==', '!=', '>=', '<=', '+=', '-=', '*=', '/=', '//', '**', '===', '!=='];
const CONTINUATION_END_KEYWORDS = ['in ', 'is ', 'and ', 'or '];

const CONTINUATION_START_CHARS = '})]{([?:-+=|&.!*/%^<>~';
const CONTINUATION_START_OPERATORS = ['&&', '||', '==', '!=', '>=', '<='];
const CONTINUATION_START_KEYWORDS = ['and', 'or', 'not', 'in', 'is', 'else', 'elif'];

const BLOCK_TAGS = [
  'for', 'if', 'block', 'macro', 'filter', 'call', 'raw', 'verbatim', 'while', 'try'
];

const LINE_TAGS = [
  'set', 'include', 'extends', 'from', 'import', 'depends', 'do', 'resume', 'except', 'print'
];

const BLOCK_TAG_PAIRS = {
  'for': 'endfor', 'if': 'endif', 'block': 'endblock', 'macro': 'endmacro', 'filter': 'endfilter', 'call': 'endcall',
  'raw': 'endraw', 'verbatim': 'endverbatim', 'while': 'endwhile', 'try': 'endtry'
};

// Create a set with all reserved keywords, including end tags
const RESERVED_KEYWORDS = new Set([...BLOCK_TAGS, ...LINE_TAGS]);

// Add all end tags to reserved keywords
Object.values(BLOCK_TAG_PAIRS).forEach(endTag => {
  RESERVED_KEYWORDS.add(endTag);
});

const getFirstWord = (s) => s.trimStart().split(/\s+/)[0] || null;

function shouldConcatenateWithNext(line) {
  if (!line.trim()) return false;
  if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*')) return false;

  const trimmed = line.trim();

  // Check if line ends with any of the continuation characters
  const lastChar = trimmed.slice(-1);
  if (CONTINUATION_END_CHARS.includes(lastChar)) {
    return true;
  }

  // Check if line ends with any of the continuation operators
  for (const op of CONTINUATION_END_OPERATORS) {
    if (trimmed.endsWith(op)) {
      return true;
    }
  }

  // Check if line ends with any of the continuation keywords
  for (const keyword of CONTINUATION_END_KEYWORDS) {
    const lineWithSpace = trimmed + ' '; // Add space to match keywords like "in "
    if (lineWithSpace.endsWith(keyword)) {
      return true;
    }
  }

  // Check if the first word is a reserved keyword
  return RESERVED_KEYWORDS.has(getFirstWord(trimmed));
}

function shouldConcatenateWithPrevious(line) {
  if (!line.trim()) return false;
  if (line.trimStart().startsWith('//') || line.trimStart().startsWith('/*')) return false;

  const trimmed = line.trimStart();
  const firstChar = trimmed[0];

  // Check if line starts with any of the continuation characters
  if (CONTINUATION_START_CHARS.includes(firstChar)) {
    return true;
  }

  // Check if line starts with any of the continuation operators
  for (const op of CONTINUATION_START_OPERATORS) {
    if (trimmed.startsWith(op)) {
      return true;
    }
  }

  // Check if the first word is a continuation keyword
  const firstWord = getFirstWord(trimmed);
  return CONTINUATION_START_KEYWORDS.includes(firstWord);
}

function joinLines(lines) {
  // Convert string to array of lines if necessary
  if (typeof lines === 'string') {
    lines = lines.split('\n');
  }

  const result = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines or comments - add them as is
    if (!line.trim() || line.trimStart().startsWith('//') || line.trimStart().startsWith('/*')) {
      if (current !== null) {
        result.push(current);
        current = null;
      }
      result.push(line);
      continue;
    }

    // Start a new line or continue the current one
    if (current === null) {
      current = line;
    } else {
      // Determine if we need a space between lines
      const lastChar = current.trimEnd().slice(-1);
      const firstChar = line.trimStart()[0];

      // Special handling for operators
      const isOperator = ['+', '-', '*', '/', '<', '>', '=', '&', '|', '!'].includes(firstChar);
      const needsSpace = !(CONTINUATION_END_CHARS.includes(lastChar) && !isOperator) &&
                        !(CONTINUATION_START_CHARS.includes(firstChar) && !isOperator);

      current += (needsSpace ? ' ' : '') + line.trimStart();
    }

    // Check if we should continue with the next line
    if (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.trim() &&
          !nextLine.trimStart().startsWith('//') &&
          !nextLine.trimStart().startsWith('/*')) {

        const shouldContinue = shouldConcatenateWithNext(current) ||
                               shouldConcatenateWithPrevious(nextLine);

        if (shouldContinue) {
          continue; // Don't add to result yet, keep going
        }
      }
    }

    // Add the current line to the result and reset
    if (current !== null) {
      result.push(current);
      current = null;
    }
  }

  // Add any remaining current line
  if (current !== null) {
    result.push(current);
  }

  return result;
}

function parseScript(scriptStr) {
  const lines = scriptStr.split('\n');
  const result = [];

  // For detecting multi-line comments
  let inMultiLineComment = false;
  let commentBuffer = '';
  let commentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.indexOf(trimmed);

    if (inMultiLineComment) {
      // Inside a multi-line comment, look for the end
      const endPos = line.indexOf('*/');

      if (endPos !== -1) {
        // End of comment found
        commentBuffer += ' ' + line.substring(0, endPos).trim();

        // Add the complete comment
        result.push({
          content: `/*${commentBuffer}*/`,
          indentation: commentIndent,
          isComment: true
        });

        // Process any remaining content after the comment
        const remaining = line.substring(endPos + 2).trim();
        if (remaining) {
          result.push({
            content: remaining,
            indentation: indent,
            isComment: false
          });
        }

        inMultiLineComment = false;
        commentBuffer = '';
      } else {
        // Continue collecting comment
        commentBuffer += ' ' + trimmed;
      }
    } else if (trimmed.startsWith('/*')) {
      // Start of a multi-line comment
      const endPos = line.indexOf('*/', 2);

      if (endPos !== -1) {
        // Single-line /* ... */ comment
        result.push({
          content: trimmed,
          indentation: indent,
          isComment: true
        });
      } else {
        // Beginning of a multi-line comment
        inMultiLineComment = true;
        commentIndent = indent;
        commentBuffer = trimmed.substring(2); // Remove the /*
      }
    } else {
      // Regular line or single-line comment
      result.push({
        content: trimmed,
        indentation: indent,
        isComment: trimmed.startsWith('//')
      });
    }
  }

  // Handle any unclosed multi-line comment
  if (inMultiLineComment) {
    result.push({
      content: `/*${commentBuffer}`,
      indentation: commentIndent,
      isComment: true
    });
  }

  return result;
}

function validateBlockStructure(lines) {
  const stack = [];

  // First create a separate array for non-comments
  const contentLines = lines.filter(({ content, isComment }) => content && !isComment);

  // Check if this is a special case with only a single standalone end tag
  // In template mode, this is valid (e.g., {% endfor %})
  if (contentLines.length === 1) {
    const word = getFirstWord(contentLines[0].content);
    if (Object.values(BLOCK_TAG_PAIRS).includes(word) &&
        contentLines[0].content.trim() === word) {
      return { valid: true };
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const { content, isComment } = lines[i];
    if (isComment || !content) continue;

    const word = getFirstWord(content);
    if (!word) continue;

    if (BLOCK_TAG_PAIRS[word]) {
      stack.push({ tag: word, line: i + 1 });
    } else if (Object.values(BLOCK_TAG_PAIRS).includes(word)) {
      if (!stack.length) {
        return { valid: false, error: `Line ${i + 1}: Unexpected '${word}'` };
      }

      const topTag = stack[stack.length - 1].tag;
      if (BLOCK_TAG_PAIRS[topTag] !== word) {
        return { valid: false, error: `Line ${i + 1}: Unexpected '${word}', was expecting '${BLOCK_TAG_PAIRS[topTag]}'` };
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

function convertComment(comment) {
  // Extract the content of the comment
  let content = '';

  if (comment.startsWith('//')) {
    content = comment.substring(2).trim();
  } else if (comment.startsWith('/*') && comment.endsWith('*/')) {
    content = comment.substring(2, comment.length - 2).trim();
  } else if (comment.startsWith('/*')) {
    content = comment.substring(2).trim();
  } else {
    return comment;
  }

  // Normalize whitespace in the content
  content = content.replace(/\s+/g, ' ').trim();

  return `{# ${content} #}`;
}

function scriptToTemplate(scriptStr) {
  // Handle special case of standalone end tag
  const trimmed = scriptStr.trim();
  let firstWord = getFirstWord(trimmed);

  if (Object.values(BLOCK_TAG_PAIRS).includes(firstWord) && trimmed === firstWord) {
    return {
      template: `{% ${firstWord} %}\n`,
      error: null
    };
  }

  // First process the script to handle multi-line comments
  const parsedLines = parseScript(scriptStr);

  // Validate the block structure BEFORE attempting to generate a template
  const { valid, error } = validateBlockStructure(parsedLines);
  if (!valid) {
    return { template: null, error };
  }

  // Convert parsed lines to template lines
  const templateLines = [];

  for (const { content, indentation, isComment } of parsedLines) {
    if (!content.trim()) {
      templateLines.push('');
      continue;
    }

    if (isComment) {
      templateLines.push(' '.repeat(indentation) + convertComment(content));
      continue;
    }

    firstWord = getFirstWord(content);

    if (firstWord === 'print') {
      templateLines.push(' '.repeat(indentation) + `{{ ${content.substring(5).trim()} }}`);
    } else if (RESERVED_KEYWORDS.has(firstWord)) {
      templateLines.push(' '.repeat(indentation) + `{% ${content} %}`);
    } else {
      templateLines.push(' '.repeat(indentation) + `{% do ${content} %}`);
    }
  }

  // Join the template with newlines
  const template = templateLines.join('\n') + '\n';

  return { template, error: null };
}

module.exports = {
  scriptToTemplate,
  getFirstWord,
  shouldConcatenateWithNext,
  shouldConcatenateWithPrevious,
  joinLines,
  parseScript,
  validateBlockStructure
};
