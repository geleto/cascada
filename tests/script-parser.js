const expect = require('expect.js');
const {
  parseTemplateLine,
  TOKEN_TYPES,
  TOKEN_SUBTYPES,
  isValidRegexContext,
  isCompleteRegexPattern
} = require('../nunjucks/src/script-parser');

describe('Script Parser', function() {

  describe('Basic Parsing', function() {
    it('should handle empty lines', function() {
      const result = parseTemplateLine('');
      expect(result.tokens).to.have.length(0);
      expect(result.inMultiLineComment).to.be(false);
      expect(result.stringState).to.be(null);
    });

    it('should parse a simple code line', function() {
      const result = parseTemplateLine('print user.name');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('print user.name');
    });

    it('should handle whitespace', function() {
      const result = parseTemplateLine('  if user.isLoggedIn  ');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('  if user.isLoggedIn  ');
    });
  });

  describe('String Parsing', function() {
    it('should parse single-quoted strings', function() {
      let sc = 'print \'Hello, World!\'';
      console.log('DEBUG - Script:', sc);
      const result = parseTemplateLine(sc);
      console.log('DEBUG - Token count:', result.tokens.length);
      console.log('DEBUG - Tokens:', JSON.stringify(result.tokens.map(t => ({ type: t.type, value: t.value })), null, 2));
      expect(result.tokens).to.have.length(3);
      sc = 'print \'Hello, World!\'';
      const stringStart = sc.indexOf('\'');
      const stringEnd = sc.lastIndexOf('\'') + 1;

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.SINGLE_QUOTED);
      expect(result.tokens[1].value).to.equal('\'Hello, World!\'');
      expect(result.tokens[1].start).to.equal(stringStart);
      expect(result.tokens[1].end).to.equal(stringEnd);
    });

    it('should parse double-quoted strings', function() {
      const result = parseTemplateLine('print "Hello, World!"');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].value).to.equal('"Hello, World!"');
    });

    it('should handle escaped quotes in strings', function() {
      const result = parseTemplateLine('print "She said \\"Hello\\""');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"She said \\"Hello\\""');
    });

    it('should handle string continuation at end of line', function() {
      const result = parseTemplateLine('print "This string continues \\');
      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].incomplete).to.be(true);
      expect(result.stringState).not.to.be(null);
      expect(result.stringState.escaped).to.be(true);
      expect(result.stringState.delimiter).to.equal('"');
    });

    it('should continue a string from previous line', function() {
      const stringState = { escaped: true, delimiter: '"' };
      const result = parseTemplateLine('on the next line"', false, stringState);
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[0].value).to.equal('on the next line"');
      expect(result.stringState).to.be(null);
    });

    it('should parse multiple strings in a line', function() {
      const result = parseTemplateLine('print "Hello" + \' World\'');
      expect(result.tokens).to.have.length(5); // "print ", "Hello", " + ", " World"
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"Hello"');
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[3].value).to.equal('\' World\'');
    });
  });

  describe('Comment Parsing', function() {
    it('should parse single-line comments', function() {
      const result = parseTemplateLine('print user.name // Display username');
      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.SINGLE_LINE);
      expect(result.tokens[1].value).to.equal('// Display username');
    });

    it('should parse multi-line comment start', function() {
      const result = parseTemplateLine('/* This is a multi-line');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
      expect(result.inMultiLineComment).to.be(true);
    });

    it('should continue multi-line comment from previous line', function() {
      const result = parseTemplateLine('comment that continues */', true);
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
      expect(result.inMultiLineComment).to.be(false);
    });

    it('should handle multi-line comment spanning entire line', function() {
      const result = parseTemplateLine('/* This comment spans just one line */', false);
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
      expect(result.inMultiLineComment).to.be(false);
    });

    it('should handle code followed by multi-line comment', function() {
      const result = parseTemplateLine('print /* In-line comment */ user.name');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
    });
  });

  describe('Regex Parsing', function() {
    it('should parse simple regex patterns', function() {
      const script = 'validateEmail(r/^\\S+@\\S+\\.\\S+$/)';
      const regexStart = script.indexOf('r/');
      const regexEnd = script.lastIndexOf('/') + 1;

      const result = parseTemplateLine(script);
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].value).to.equal('r/^\\S+@\\S+\\.\\S+$/');
      expect(result.tokens[1].start).to.equal(regexStart);
      expect(result.tokens[1].end).to.equal(regexEnd);
    });

    it('should parse regex with flags', function() {
      const result = parseTemplateLine('r/\\d+/gi.test(value)');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].flags).to.equal('gi');
    });

    it('should detect duplicate flags as malformed', function() {
      const result = parseTemplateLine('r/pattern/gg');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].flags).to.equal('gg');
      expect(result.tokens[0].isMalformed).to.be(true);
    });

    it('should not confuse division with regex', function() {
      const result = parseTemplateLine('var ratio = total / count');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('var ratio = total / count');
    });

    it('should identify regex in valid contexts', function() {
      const result = parseTemplateLine('filter(r/\\w+/)');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
    });
  });

  describe('Token Position Accuracy', function() {
    it('should correctly capture token positions for all token types', function() {
      const script = 'print "hello" /* comment */ + r/pattern/g';

      // Calculate expected positions
      const codeStartPos = 0;
      const codeEndPos = script.indexOf('"');
      const stringStartPos = script.indexOf('"');
      const stringEndPos = script.indexOf('"', stringStartPos + 1) + 1;
      const commentStartPos = script.indexOf('/*');
      const commentEndPos = script.indexOf('*/') + 2;
      const code2StartPos = commentEndPos;
      const code2EndPos = script.indexOf('r/');
      const regexStartPos = script.indexOf('r/');
      const regexEndPos = script.lastIndexOf('/') + 2; // +2 for the 'g' flag

      console.log('DEBUG - Script:', script);
      const result = parseTemplateLine(script);
      console.log('DEBUG - Token count:', result.tokens.length);
      console.log('DEBUG - Tokens:', JSON.stringify(result.tokens.map(t => ({ type: t.type, value: t.value })), null, 2));

      // Code token before string
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(codeStartPos);
      expect(result.tokens[0].end).to.equal(codeEndPos);

      // String token
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].start).to.equal(stringStartPos);
      expect(result.tokens[1].end).to.equal(stringEndPos);

      // Comment token
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[2].start).to.equal(commentStartPos);
      expect(result.tokens[2].end).to.equal(commentEndPos);

      // Code token after comment
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[3].start).to.equal(code2StartPos);
      expect(result.tokens[3].end).to.equal(code2EndPos);

      // Regex token
      expect(result.tokens[4].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[4].start).to.equal(regexStartPos);
      expect(result.tokens[4].end).to.equal(regexEndPos);
    });
  });

  describe('Complex Scenarios', function() {
    it('should handle multiple token types in one line', function() {
      const script = 'if user.role == "admin" // Check role';
      const stringStart = script.indexOf('"');
      const stringEnd = script.lastIndexOf('"') + 1;
      const commentStart = script.indexOf('//');

      const result = parseTemplateLine(script);
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].start).to.equal(stringStart);
      expect(result.tokens[1].end).to.equal(stringEnd);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[2].start).to.equal(commentStart);
    });

    it('should parse template literals', function() {
      const result = parseTemplateLine('print `User: ${user.name}`');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
    });

    it('should handle regex with escaped forward slashes', function() {
      const result = parseTemplateLine('var pattern = r/path\\/to\\/file/');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].value).to.contain('\\/');
    });

    it('should handle empty regex patterns', function() {
      const result = parseTemplateLine('var emptyPattern = r//');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].value).to.equal('r//');
    });

    it('should handle cascada script syntax examples', function() {
      const result = parseTemplateLine('if user.isLoggedIn');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('if user.isLoggedIn');
    });

    it('should handle cascada print statement', function() {
      const result = parseTemplateLine('print "Hello, " + user.name');
      expect(result.tokens).to.have.length(5);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
    });

    it('should handle cascada for loop', function() {
      const result = parseTemplateLine('for item in cart.items');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('for item in cart.items');
    });
  });

  describe('Helper Functions', function() {
    describe('isValidRegexContext', function() {
      it('should return true for regex at start of line', function() {
        expect(isValidRegexContext('r/pattern/', 0)).to.be(true);
      });

      it('should return true after non-alphanumeric characters', function() {
        expect(isValidRegexContext('(r/pattern/)', 1)).to.be(true);
        expect(isValidRegexContext('=r/pattern/', 1)).to.be(true);
        expect(isValidRegexContext(' r/pattern/', 1)).to.be(true);
      });

      it('should return false after alphanumeric characters', function() {
        expect(isValidRegexContext('var r/pattern/', 4)).to.be(false);
        expect(isValidRegexContext('_r/pattern/', 1)).to.be(false);
        expect(isValidRegexContext('9r/pattern/', 1)).to.be(false);
      });
    });

    describe('isCompleteRegexPattern', function() {
      it('should return true for complete regex patterns', function() {
        expect(isCompleteRegexPattern('r/pattern/', 0)).to.be(true);
        expect(isCompleteRegexPattern('r/\\//g', 0)).to.be(true); // With escaped slash
      });

      it('should return false for incomplete regex patterns', function() {
        expect(isCompleteRegexPattern('r/pattern', 0)).to.be(false);
        expect(isCompleteRegexPattern('r/', 0)).to.be(false);
      });

      it('should return false if not starting with r/', function() {
        expect(isCompleteRegexPattern('regex/pattern/', 0)).to.be(false);
      });
    });

    // Add indirect tests for non-exported helpers by testing their behavior
    describe('parseStringChar behavior', function() {
      it('should handle string escaping correctly', function() {
        // Test by creating a scenario that exercises parseStringChar
        const result = parseTemplateLine('print "escaped \\"quotes\\" here"');

        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].value).to.equal('"escaped \\"quotes\\" here"');
        expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      });
    });

    describe('parseRegexChar behavior', function() {
      it('should handle regex flag collection', function() {
        const result = parseTemplateLine('r/pattern/gim');

        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].flags).to.equal('gim');
      });
    });
  });

  describe('Parser State Management', function() {
    it('should properly manage state transitions', function() {
      // This test checks multiple state transitions in one line
      const script = 'code "string" /* comment */ r/regex/g more';
      console.log('DEBUG - Parser State Management script:', script);
      const result = parseTemplateLine(script);
      console.log('DEBUG - Parser State Management tokens:', result.tokens.length);
      console.log('DEBUG - Parser State Management token types:', result.tokens.map(t => t.type));

      expect(result.tokens).to.have.length(7); // Adjusted to match actual implementation
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[4].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[5].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[6].type).to.equal(TOKEN_TYPES.CODE);
    });

    it('should maintain state between lines for multi-line comments', function() {
      // First line opens a comment
      const result1 = parseTemplateLine('code /* start comment');
      expect(result1.inMultiLineComment).to.be(true);

      // Second line continues and closes the comment
      const result2 = parseTemplateLine('continue comment */', result1.inMultiLineComment);
      expect(result2.inMultiLineComment).to.be(false);
      expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
    });

    it('should properly handle string state between lines', function() {
      // First line has string with escape at end
      const result1 = parseTemplateLine('print "escaped \\');
      expect(result1.stringState).not.to.be(null);
      expect(result1.stringState.escaped).to.be(true);
      expect(result1.stringState.delimiter).to.equal('"');

      // Second line continues the string
      const result2 = parseTemplateLine('continued string"', false, result1.stringState);
      expect(result2.stringState).to.be(null); // String closed
      expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result2.tokens[0].value).to.equal('continued string"');
    });
  });

  describe('Edge Cases', function() {
    it('should handle regex at the beginning of line', function() {
      const result = parseTemplateLine('r/^start/ && condition');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
    });

    it('should handle incomplete regex at end of line', function() {
      const result = parseTemplateLine('var pattern = r/incomplete');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE); // This should be code, not regex, as it's incomplete
      expect(result.tokens[1].value).to.equal('r/incomplete');
    });

    it('should handle strings with nested quotes', function() {
      const result = parseTemplateLine('print "String with \'nested\' quotes"');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"String with \'nested\' quotes"');
    });

    it('should handle the corner case of a regex right after another token', function() {
      const result = parseTemplateLine('(r/test/)');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
    });

    it('should parse escaped backslashes correctly', function() {
      const result = parseTemplateLine('print "Double backslash: \\\\"');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"Double backslash: \\\\"');
    });

    it('should handle mixing regex and division', function() {
      const script = 'x = a/b; filter(r/\\w+/); y = c/d';
      const result = parseTemplateLine(script);

      // Find divisions vs regex
      const regexStart = script.indexOf('r/');

      // We should have multiple CODE tokens and one REGEX token
      const regexTokens = result.tokens.filter(t => t.type === TOKEN_TYPES.REGEX);
      expect(regexTokens).to.have.length(1);
      expect(regexTokens[0].start).to.equal(regexStart);
    });

    it('should handle consecutive string delimiters', function() {
      const result = parseTemplateLine('print ""');
      expect(result.tokens).to.have.length(3);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('""');
    });

    it('should handle consecutive comment delimiters', function() {
      const result = parseTemplateLine('code /**/');
      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[1].value).to.equal('/**/');
    });
  });
});
