const expect = require('expect.js');
const {
  parseTemplateLine,
  TOKEN_TYPES,
  TOKEN_SUBTYPES,
  isValidRegexContext,
  hasCompleteRegexPattern
} = require('../src/script-lexer');

describe('Script Parser', function() {

  describe('Basic Parsing', function() {
    it('should handle empty lines', function() {
      const result = parseTemplateLine('');
      expect(result.tokens).to.have.length(0);
      expect(result.inMultiLineComment).to.be(false);
      expect(result.stringState).to.be(null);
    });

    it('should parse a simple code line', function() {
      const result = parseTemplateLine('@print user.name');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('@print user.name');
    });

    /*it('should handle whitespace', function() {
      const result = parseTemplateLine('  if user.isLoggedIn  ');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('  if user.isLoggedIn  ');
    });*/
  });

  describe('String Parsing', function() {
    it('should parse single-quoted strings', function() {
      const result = parseTemplateLine('@print \'Hello, World!\'');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.SINGLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(22);
      expect(result.tokens[1].value).to.equal('\'Hello, World!\'');
    });

    it('should parse double-quoted strings', function() {
      const result = parseTemplateLine('@print "Hello, World!"');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(22);
      expect(result.tokens[1].value).to.equal('"Hello, World!"');
    });

    it('should handle escaped quotes in strings', function() {
      const result = parseTemplateLine('@print "She said \\"Hello\\""');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(27);
      expect(result.tokens[1].value).to.equal('"She said \\"Hello\\""');
    });

    it('should handle string continuation at end of line', function() {
      const result = parseTemplateLine('@print "This string continues \\');

      // Should generate 2 tokens: CODE and incomplete STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(31);
      expect(result.tokens[1].value).to.equal('"This string continues \\');
      expect(result.tokens[1].incomplete).to.be(true);

      expect(result.stringState).not.to.be(null);
      expect(result.stringState.escaped).to.be(true);
      expect(result.stringState.delimiter).to.equal('"');
    });

    it('should continue a string from previous line', function() {
      const stringState = { escaped: true, delimiter: '"' };
      const result = parseTemplateLine('on the next line"', false, stringState);

      // Should generate 1 token: STRING
      expect(result.tokens).to.have.length(1);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(17);
      expect(result.tokens[0].value).to.equal('on the next line"');

      expect(result.stringState).to.be(null);
    });

    it('should parse multiple strings in a line', function() {
      const result = parseTemplateLine('@print "Hello" + \' World\'');

      // Should generate 4 tokens: CODE, STRING, CODE, STRING
      expect(result.tokens).to.have.length(4);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(14);
      expect(result.tokens[1].value).to.equal('"Hello"');

      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[2].start).to.equal(14);
      expect(result.tokens[2].end).to.equal(17);
      expect(result.tokens[2].value).to.equal(' + ');

      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[3].subtype).to.equal(TOKEN_SUBTYPES.SINGLE_QUOTED);
      expect(result.tokens[3].start).to.equal(17);
      expect(result.tokens[3].end).to.equal(25);
      expect(result.tokens[3].value).to.equal('\' World\'');
    });
  });

  describe('Comment Parsing', function() {
    it('should parse single-line comments', function() {
      const result = parseTemplateLine('@print user.name // Display username');
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
      const result = parseTemplateLine('@print /* In-line comment */ user.name');
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

      // Should generate 2 tokens: REGEX and CODE
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(8);
      expect(result.tokens[0].value).to.equal('r/\\d+/gi');
      expect(result.tokens[0].flags).to.equal('gi');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].start).to.equal(8);
      expect(result.tokens[1].end).to.equal(20);
      expect(result.tokens[1].value).to.equal('.test(value)');
    });

    it('should detect duplicate flags as malformed', function() {
      const result = parseTemplateLine('r/pattern/gg');

      // Should generate 1 token: REGEX (malformed)
      expect(result.tokens).to.have.length(1);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(12);
      expect(result.tokens[0].value).to.equal('r/pattern/gg');
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
      const script = '@print "hello" /* comment */ + r/pattern/g';

      const result = parseTemplateLine(script);

      // Should generate 6 tokens: CODE, STRING, CODE, COMMENT, CODE, REGEX
      expect(result.tokens).to.have.length(6);

      // CODE token before string
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      // STRING token
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(14);
      expect(result.tokens[1].value).to.equal('"hello"');

      // CODE token (space between string and comment)
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[2].start).to.equal(14);
      expect(result.tokens[2].end).to.equal(15);
      expect(result.tokens[2].value).to.equal(' ');

      // COMMENT token
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[3].start).to.equal(15);
      expect(result.tokens[3].end).to.equal(28);
      expect(result.tokens[3].value).to.equal('/* comment */');

      // CODE token (space and + between comment and regex)
      expect(result.tokens[4].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[4].start).to.equal(28);
      expect(result.tokens[4].end).to.equal(31);
      expect(result.tokens[4].value).to.equal(' + ');

      // REGEX token
      expect(result.tokens[5].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[5].start).to.equal(31);
      expect(result.tokens[5].end).to.equal(42);
      expect(result.tokens[5].value).to.equal('r/pattern/g');
      expect(result.tokens[5].flags).to.equal('g');
    });
  });

  describe('Complex Scenarios', function() {
    it('should handle multiple token types in one line', function() {
      const script = 'if user.role == "admin" // Check role';
      const result = parseTemplateLine(script);

      // Should generate 4 tokens: CODE, STRING, CODE, COMMENT
      expect(result.tokens).to.have.length(4);

      // CODE token before string
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(16);
      expect(result.tokens[0].value).to.equal('if user.role == ');

      // STRING token
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].start).to.equal(16);
      expect(result.tokens[1].end).to.equal(23);
      expect(result.tokens[1].value).to.equal('"admin"');

      // CODE token (space between string and comment)
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[2].start).to.equal(23);
      expect(result.tokens[2].end).to.equal(24);
      expect(result.tokens[2].value).to.equal(' ');

      // COMMENT token
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[3].start).to.equal(24);
      expect(result.tokens[3].end).to.equal(37);
      expect(result.tokens[3].value).to.equal('// Check role');
    });

    it('should parse template literals', function() {
      const result = parseTemplateLine('@print `User: ${user.name}`');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(27);
      expect(result.tokens[1].value).to.equal('`User: ${user.name}`');
    });

    it('should handle regex with escaped forward slashes', function() {
      const result = parseTemplateLine('var pattern = r/path\\/to\\/file/');

      // Should generate 2 tokens: CODE and REGEX
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(14);
      expect(result.tokens[0].value).to.equal('var pattern = ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.REGEX);
      expect(result.tokens[1].start).to.equal(14);
      expect(result.tokens[1].end).to.equal(31);
      expect(result.tokens[1].value).to.equal('r/path\\/to\\/file/');
      expect(result.tokens[1].flags).to.equal('');
    });

    it('should handle empty regex patterns', function() {
      const result = parseTemplateLine('var emptyPattern = r//');

      // Should generate 2 tokens: CODE and REGEX
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(19);
      expect(result.tokens[0].value).to.equal('var emptyPattern = ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.REGEX);
      expect(result.tokens[1].start).to.equal(19);
      expect(result.tokens[1].end).to.equal(22);
      expect(result.tokens[1].value).to.equal('r//');
      expect(result.tokens[1].flags).to.equal('');
    });

    it('should handle cascada script syntax examples', function() {
      const result = parseTemplateLine('if user.isLoggedIn');
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].value).to.equal('if user.isLoggedIn');
    });

    it('should handle cascada print statement', function() {
      const result = parseTemplateLine('@print "Hello, " + user.name');

      // Should generate 3 tokens: CODE, STRING, CODE
      expect(result.tokens).to.have.length(3);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(16);
      expect(result.tokens[1].value).to.equal('"Hello, "');

      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[2].start).to.equal(16);
      expect(result.tokens[2].end).to.equal(28);
      expect(result.tokens[2].value).to.equal(' + user.name');
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
        expect(isValidRegexContext('varr/pattern/', 3)).to.be(false); // 'r' at index 3 is preceded by 'a' (alphanumeric)
        expect(isValidRegexContext('_r/pattern/', 1)).to.be(false);  // 'r' at index 1 is preceded by '_' (alphanumeric)
        expect(isValidRegexContext('9r/pattern/', 1)).to.be(false);  // 'r' at index 1 is preceded by '9' (alphanumeric)
      });
    });

    describe('hasCompleteRegexPattern', function() {
      it('should return true for complete regex patterns', function() {
        expect(hasCompleteRegexPattern('r/pattern/', 0)).to.be(true);
        expect(hasCompleteRegexPattern('r/\\//g', 0)).to.be(true); // With escaped slash
      });

      it('should return false for incomplete regex patterns', function() {
        expect(hasCompleteRegexPattern('r/pattern', 0)).to.be(false);
        expect(hasCompleteRegexPattern('r/', 0)).to.be(false);
      });

      it('should return false if not starting with r/', function() {
        expect(hasCompleteRegexPattern('regex/pattern/', 0)).to.be(false);
      });
    });

    // Add indirect tests for non-exported helpers by testing their behavior
    describe('parseStringChar behavior', function() {
      it('should handle string escaping correctly', function() {
        // Test by creating a scenario that exercises parseStringChar
        const result = parseTemplateLine('@print "escaped \\"quotes\\" here"');

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
      const result = parseTemplateLine(script);

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
      const result1 = parseTemplateLine('@print "escaped \\');
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

      // Should generate 2 tokens: REGEX and CODE
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(9);
      expect(result.tokens[0].value).to.equal('r/^start/');
      expect(result.tokens[0].flags).to.equal('');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].start).to.equal(9);
      expect(result.tokens[1].end).to.equal(22);
      expect(result.tokens[1].value).to.equal(' && condition');
    });

    it('should handle incomplete regex at end of line', function() {
      const result = parseTemplateLine('var pattern = r/incomplete');

      // Should generate 1 token: CODE (since the regex is incomplete and not recognized)
      expect(result.tokens).to.have.length(1);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(26);
      expect(result.tokens[0].value).to.equal('var pattern = r/incomplete');
    });

    it('should handle strings with nested quotes', function() {
      const result = parseTemplateLine('@print "String with \'nested\' quotes"');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(36);
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
      const result = parseTemplateLine('@print "Double backslash: \\\\"');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(29);
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
      const result = parseTemplateLine('@print ""');

      // Should generate 2 tokens: CODE and STRING
      expect(result.tokens).to.have.length(2);

      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(7);
      expect(result.tokens[0].value).to.equal('@print ');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].start).to.equal(7);
      expect(result.tokens[1].end).to.equal(9);
      expect(result.tokens[1].value).to.equal('""');
    });

    it('should handle consecutive comment delimiters', function() {
      const result = parseTemplateLine('code /**/');
      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[1].value).to.equal('/**/');
    });
  });

  describe('Template Literals with Complex Expressions', function() {
    it('should handle template literals with nested expressions', function() {
      const result = parseTemplateLine('@print `User: ${user.info ? `${user.info.name}` : "Unknown"}`');

      // Should recognize the entire template literal as a single token
      expect(result.tokens).to.have.length(2); // CODE + STRING
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      expect(result.tokens[1].value).to.contain('`User: ${user.info ? `${user.info.name}` : "Unknown"}`');
    });

    it('should handle template literals with nested template literals', function() {
      const result = parseTemplateLine('@print `Outer ${`Inner ${value}`}`');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      expect(result.tokens[1].value).to.equal('`Outer ${`Inner ${value}`}`');
    });

    it('should handle escaped expressions in template literals', function() {
      const result = parseTemplateLine('@print `Not an expression: \\${escapedContent}`');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      expect(result.tokens[1].value).to.equal('`Not an expression: \\${escapedContent}`');
    });
  });

  describe('String Continuation Corner Cases', function() {
    it('should handle multiple escape characters at end of line', function() {
      const result = parseTemplateLine('@print "String with double escape at end \\\\');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].value).to.equal('"String with double escape at end \\\\');
      expect(result.tokens[1].incomplete).to.be(true);

      // The escaped backslash should result in no continuation
      expect(result.stringState).to.be(null);
    });

    it('should handle Unicode escapes split across lines', function() {
      // This test actually reveals a bug in the implementation
      // The implementation should handle Unicode escapes correctly across lines,
      // but it doesn't. The following test documents how it *should* work.

      const result = parseTemplateLine('@print "Unicode escape \\u00');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].incomplete).to.be(true);

      // Should not be escaped since \u is a Unicode escape sequence
      expect(result.stringState).not.to.be(null);
      expect(result.stringState.escaped).to.be(false);

      // Continuation should pick up the Unicode escape sequence as a STRING
      // This fails because the implementation incorrectly treats it as CODE
      const continuation = parseTemplateLine('7A"', false, result.stringState);
      expect(continuation.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(continuation.tokens[0].value).to.equal('7A"');
    });

    it('should handle strings that immediately continue', function() {
      const result1 = parseTemplateLine('@print "Line 1 \\');
      const result2 = parseTemplateLine('Line 2"', false, result1.stringState);

      expect(result1.tokens[1].incomplete).to.be(true);
      expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result2.tokens[0].value).to.equal('Line 2"');
      expect(result2.stringState).to.be(null); // String is closed
    });
  });

  describe('Complex Regex Patterns', function() {
    it('should parse complex URL regex patterns', function() {
      const script = 'validateUrl(r/^https?:\\/\\/([a-z0-9][-a-z0-9]*\\.)+[a-z]{2,}$/i)';
      const regexStart = script.indexOf('r/');
      const result = parseTemplateLine(script);

      expect(result.tokens).to.have.length(3); // CODE + REGEX + CODE
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[1].flags).to.equal('i');
      expect(result.tokens[1].start).to.equal(regexStart);
    });

    it('should handle regex containing string delimiters', function() {
      const result = parseTemplateLine('r/"quoted".*\'text\'/g.test(input)');

      expect(result.tokens).to.have.length(2); // REGEX + CODE
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].value).to.equal('r/"quoted".*\'text\'/g');
      expect(result.tokens[0].flags).to.equal('g');
    });

    it('should handle invalid regex patterns according to Nunjucks behavior', function() {
      const result = parseTemplateLine('r/[unclosed/g');

      // Nunjucks treats this as a REGEX token with body "[unclosed" and flag "g"
      // It doesn't validate the pattern structure, just looks for unescaped /
      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].flags).to.equal('g');
    });

    it('should handle all valid regex flags', function() {
      const result = parseTemplateLine('r/pattern/gimsuy');

      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].flags).to.equal('gimsuy');
      expect(result.tokens[0].isMalformed).to.be(false);
    });
  });

  describe('Nested Token Interactions', function() {
    it('should handle strings containing regex-like patterns', function() {
      const result = parseTemplateLine('@print "String with r/pattern/ inside"');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"String with r/pattern/ inside"');
      // The r/pattern/ shouldn't be detected as regex inside a string
    });

    it('should handle comments containing string-like patterns', function() {
      const result = parseTemplateLine('/* "This looks like a string" */');

      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[0].value).to.equal('/* "This looks like a string" */');
    });

    it('should handle comments containing regex-like patterns', function() {
      const result = parseTemplateLine('/* r/regex-like/g pattern */');

      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[0].value).to.equal('/* r/regex-like/g pattern */');
    });

    it('should handle strings containing template-like expressions', function() {
      const result = parseTemplateLine('@print "Text ${not.executed} more"');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.DOUBLE_QUOTED);
      expect(result.tokens[1].value).to.equal('"Text ${not.executed} more"');
    });
  });

  describe('Unicode and Special Characters', function() {
    it('should handle Unicode in strings', function() {
      const result = parseTemplateLine('@print "Unicode: 你好, 世界"');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"Unicode: 你好, 世界"');
    });

    it('should handle Unicode in regex patterns', function() {
      const result = parseTemplateLine('r/[\\u4e00-\\u9fa5]+/u.test(name)');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].flags).to.equal('u');
    });

    it('should handle control characters in strings', function() {
      const result = parseTemplateLine('@print "Tab: \\t Newline: \\n"');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].value).to.equal('"Tab: \\t Newline: \\n"');
    });
  });

  describe('Multi-line Comment Continuation', function() {
    it('should handle comments spanning three or more lines', function() {
      // First line
      const result1 = parseTemplateLine('/* This comment spans');
      expect(result1.inMultiLineComment).to.be(true);

      // Second line
      const result2 = parseTemplateLine('multiple lines', result1.inMultiLineComment);
      expect(result2.inMultiLineComment).to.be(true);

      // Third line
      const result3 = parseTemplateLine('and closes here */', result2.inMultiLineComment);
      expect(result3.inMultiLineComment).to.be(false);
      expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
    });

    it('should handle code after comment closes mid-line', function() {
      const result = parseTemplateLine('/* comment */ code');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].value).to.equal(' code');
    });
  });

  describe('Boundary Conditions', function() {
    it('should handle tokens that start at index 0 and end at line end', function() {
      const input = '"This string is the entire line"';
      const result = parseTemplateLine(input);

      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(input.length);
    });

    it('should handle empty strings at start of line', function() {
      const result = parseTemplateLine('""code');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[0].value).to.equal('""');
      expect(result.tokens[0].start).to.equal(0);
      expect(result.tokens[0].end).to.equal(2);

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].start).to.equal(2);
    });

    it('should handle empty strings at end of line', function() {
      const result = parseTemplateLine('code""');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[0].end).to.equal(4);

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].start).to.equal(4);
      expect(result.tokens[1].value).to.equal('""');
    });

    it('should handle adjacent tokens without whitespace', function() {
      const result = parseTemplateLine('@print"no space"/* comment */r/pattern/');

      expect(result.tokens).to.have.length(4);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[2].type).to.equal(TOKEN_TYPES.COMMENT);
      expect(result.tokens[3].type).to.equal(TOKEN_TYPES.REGEX);
    });
  });

  describe('Error Recovery and Malformed Input', function() {
    it('should handle unterminated strings', function() {
      const result = parseTemplateLine('@print "Unterminated string');

      expect(result.tokens).to.have.length(2);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[1].incomplete).to.be(true);
      expect(result.stringState).not.to.be(null);
    });

    it('should handle unterminated regex patterns', function() {
      // This tests a case where r/ is valid but no closing slash is found
      // In this case, it should be treated as code since hasCompleteRegexPattern should return false
      const result = parseTemplateLine('r/unterminated');

      expect(result.tokens).to.have.length(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
    });

    it('should handle invalid regex flags according to Nunjucks behavior', function() {
      const result = parseTemplateLine('r/pattern/z');

      // Nunjucks treats this as separate REGEX and CODE tokens
      // It only accepts g, i, m, y as valid flags
      expect(result.tokens).to.have.length(2);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
      expect(result.tokens[0].value).to.equal('r/pattern/');
      expect(result.tokens[0].flags).to.equal('');

      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE);
      expect(result.tokens[1].value).to.equal('z');
    });
  });

  describe('Contextual Regex Detection Edge Cases', function() {
    it('should detect regex after various operators', function() {
      const operators = ['=', '+', '(', '[', '{', ':', ',', ';', '!'];

      operators.forEach(op => {
        const script = `${op}r/test/`;
        const result = parseTemplateLine(script);

        // Be more specific about our expectations
        if (op === '') {
          // Special case for empty string (start of line)
          expect(result.tokens.length).to.equal(1);
          expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        } else {
          // For operators, we should have at least 2 tokens (CODE + REGEX)
          expect(result.tokens.length).to.be.greaterThan(1);
          // Find the regex token - it should exist
          const regexToken = result.tokens.find(t => t.type === TOKEN_TYPES.REGEX);
          expect(regexToken).not.to.be(undefined);
          expect(regexToken.value).to.equal('r/test/');
        }
      });
    });

    it('should not detect regex after identifiers or numbers', function() {
      const nonTriggers = ['var', 'func', '123', '_var', 'a'];

      nonTriggers.forEach(prefix => {
        const script = `${prefix}r/test/`;
        const result = parseTemplateLine(script);

        expect(result.tokens.length).to.be.greaterThan(0);
        const hasRegex = result.tokens.some(t => t.type === TOKEN_TYPES.REGEX);
        expect(hasRegex).to.be(false);
      });
    });

    it('should distinguish between division and regex in complex expressions', function() {
      const result = parseTemplateLine('(a+b)/2; filter(r/\\w+/);');

      // Find the tokens representing division vs regex
      const divisionIndex = result.tokens.findIndex(t =>
        t.type === TOKEN_TYPES.CODE && t.value.includes('/2'));

      const regexIndex = result.tokens.findIndex(t =>
        t.type === TOKEN_TYPES.REGEX);

      expect(divisionIndex).not.to.equal(-1);
      expect(regexIndex).not.to.equal(-1);
    });

    it('should handle regex after template literals', function() {
      const result = parseTemplateLine('`template`r/pattern/');

      expect(result.tokens.length).to.be.greaterThan(1);
      expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
    });
  });

  describe('Combined Complex Scenarios', function() {
    it('should handle interleaved strings, comments, and regex', function() {
      const script = '@print "string" /* comment */ + r/regex/g; x = 1/2; // End';
      const result = parseTemplateLine(script);

      // Be more specific about our expectations
      // Expected token sequence: CODE + STRING + CODE + COMMENT + CODE + REGEX + CODE + COMMENT
      expect(result.tokens.length).to.equal(8);

      const types = result.tokens.map(t => t.type);

      // Check specific token types in sequence
      expect(types[0]).to.equal(TOKEN_TYPES.CODE);    // '@print '
      expect(types[1]).to.equal(TOKEN_TYPES.STRING);  // '"string"'
      expect(types[2]).to.equal(TOKEN_TYPES.CODE);    // ' '
      expect(types[3]).to.equal(TOKEN_TYPES.COMMENT); // '/* comment */'
      expect(types[4]).to.equal(TOKEN_TYPES.CODE);    // ' + '
      expect(types[5]).to.equal(TOKEN_TYPES.REGEX);   // 'r/regex/g'
      expect(types[6]).to.equal(TOKEN_TYPES.CODE);    // '; x = 1/2; '
      expect(types[7]).to.equal(TOKEN_TYPES.COMMENT); // '// End'
    });

    it('should handle complex nesting with escaped characters', function() {
      const script = 'fn(`outer ${escaped ? "inner \\"quoted\\"" : r/\\w+/g}`);';
      const result = parseTemplateLine(script);

      // The main token should be the template literal
      const templateToken = result.tokens.find(t =>
        t.type === TOKEN_TYPES.STRING && t.subtype === TOKEN_SUBTYPES.TEMPLATE);

      expect(templateToken).not.to.be(undefined);
      expect(templateToken.value).to.contain('inner \\"quoted\\"');
      expect(templateToken.value).to.contain('r/\\w+/g');
    });

    it('should handle escaped backslashes at string boundaries', function() {
      const script = '@print "\\\\" + "\\\\";';
      const result = parseTemplateLine(script);

      expect(result.tokens.length).to.be.greaterThan(2);

      // Find the string tokens
      const stringTokens = result.tokens.filter(t => t.type === TOKEN_TYPES.STRING);
      expect(stringTokens).to.have.length(2);
      expect(stringTokens[0].value).to.equal('"\\\\"');
      expect(stringTokens[1].value).to.equal('"\\\\"');
    });
  });

  // New tests:
  describe('Improved Script Parser Tests', function() {

    describe('Backticks as Simple Strings', function() {
      it('should parse backticks as simple strings without interpolation', function() {
        const result = parseTemplateLine('@print `Simple backtick string without ${interpolation}`');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[0].value).to.equal('@print ');

        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
        expect(result.tokens[1].value).to.equal('`Simple backtick string without ${interpolation}`');

        // Verify the parser doesn't try to handle interpolation specially
        // by checking that the string value includes the entire content unchanged
      });

      it('should handle backtick strings with escape sequences', function() {
        const result = parseTemplateLine('@print `Escaped \\` backtick and \\${text}`');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].value).to.equal('`Escaped \\` backtick and \\${text}`');
      });

      it('should support multi-line continuation with backtick strings', function() {
        const result1 = parseTemplateLine('@print `Line 1 \\');
        expect(result1.stringState).not.to.be(null);
        expect(result1.stringState.delimiter).to.equal('`');

        const result2 = parseTemplateLine('Line 2`', false, result1.stringState);
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].value).to.equal('Line 2`');
      });
    });

    describe('String Continuation Edge Cases', function() {
      it('should handle strings with multiple backslashes at line end according to JavaScript rules', function() {
        // In JavaScript:
        // 1. Even number of backslashes: They escape each other in pairs, no line continuation
        // 2. Odd number of backslashes: The last one escapes the newline, continuing the string

        // Test with single backslash (represented by \\ in JavaScript string)
        // This should continue the string
        const result1 = parseTemplateLine('@print "String with single backslash \\');
        expect(result1.stringState).not.to.be(null);  // Should continue
        expect(result1.stringState.escaped).to.be(true);

        // Test with double backslash (represented by \\\\ in JavaScript string)
        // This should NOT continue the string
        const result2 = parseTemplateLine('@print "String with double backslash \\\\');
        expect(result2.stringState).to.be(null);  // Should NOT continue

        // Test with triple backslash (represented by \\\\\\ in JavaScript string)
        // This should continue the string
        const result3 = parseTemplateLine('@print "String with triple backslash \\\\\\');
        expect(result3.stringState).not.to.be(null);  // Should continue
        expect(result3.stringState.escaped).to.be(true);

        // Test with quadruple backslash (represented by \\\\\\\\ in JavaScript string)
        // This should NOT continue the string
        const result4 = parseTemplateLine('@print "String with quadruple backslash \\\\\\\\');
        expect(result4.stringState).to.be(null);  // Should NOT continue
      });
    });

    describe('Error Handling and Malformed Input', function() {
      it('should handle invalid regex patterns', function() {
        // Missing closing slash but still using r/ syntax
        const result = parseTemplateLine('var pattern = r/[unclosed');

        // Since there's no closing slash, it should be treated as code
        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      });

      it('should handle strings with unclosed quotes', function() {
        const result = parseTemplateLine('@print "Unclosed string');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].incomplete).to.be(true);
        expect(result.stringState).not.to.be(null);
      });

      it('should handle unexpected character sequences', function() {
        // Test unusual but valid code without string delimiters
        const result = parseTemplateLine('var x = !@#$%^&*()-_=+[]{}|;:,.<>?/');

        // Should be treated as a single code token
        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);

        // Test with backticks, which should be treated as string delimiters in JavaScript
        const result2 = parseTemplateLine('var x = !@#$%^&*()-_=+[]{}|;:,.<>?/`~');

        // Should be treated as code followed by a template string
        expect(result2.tokens).to.have.length(2);
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result2.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      });
    });

    describe('String State Tracking Across Lines', function() {
      it('should properly continue strings with escape characters', function() {
        // First line with escaped character at end
        const result1 = parseTemplateLine('var message = "First line with escape \\');

        expect(result1.tokens).to.have.length(2);
        expect(result1.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result1.tokens[1].incomplete).to.be(true);
        expect(result1.stringState).not.to.be(null);
        expect(result1.stringState.escaped).to.be(true);

        // Second line continuing from first
        const result2 = parseTemplateLine('Second line continuing"', false, result1.stringState);

        expect(result2.tokens).to.have.length(1);
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].value).to.equal('Second line continuing"');
        expect(result2.stringState).to.be(null);  // String is closed
      });

      it('should transition correctly between multiple continued lines', function() {
        // Test string continuation across 3 lines
        const line1 = parseTemplateLine('var x = "First line \\');
        const line2 = parseTemplateLine('Second line \\', false, line1.stringState);
        const line3 = parseTemplateLine('Third line"', false, line2.stringState);

        expect(line1.stringState).not.to.be(null);
        expect(line2.stringState).not.to.be(null);
        expect(line3.stringState).to.be(null);  // Final line closes string

        expect(line3.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(line3.tokens[0].value).to.equal('Third line"');
      });
    });

    describe('Token Position Accuracy', function() {
      it('should accurately track positions in complex input', function() {
        const input = 'code1 "string" /* comment */ r/regex/g code2';
        const result = parseTemplateLine(input);

        // Check positions of tokens
        expect(result.tokens).to.have.length(7);

        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[0].start).to.equal(0);
        expect(result.tokens[0].end).to.equal(6);

        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].start).to.equal(6);
        expect(result.tokens[1].end).to.equal(14);

        // Continue checking other tokens...
        expect(result.tokens[2].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[3].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[4].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[5].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[6].type).to.equal(TOKEN_TYPES.CODE);

        // Check that the end of the last token matches the input length
        expect(result.tokens[6].end).to.equal(input.length);
      });

      it('should handle tokens at line boundaries', function() {
        // String at beginning of line
        const result1 = parseTemplateLine('"String"code');
        expect(result1.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result1.tokens[0].start).to.equal(0);

        // String at end of line
        const result2 = parseTemplateLine('code"String"');
        expect(result2.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[1].end).to.equal(12);
      });
    });

    describe('Interaction Between Different Token Types', function() {
      it('should handle strings immediately followed by comments', function() {
        const result = parseTemplateLine('"String"/* Comment */');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
      });

      it('should handle comments immediately followed by regex', function() {
        const result = parseTemplateLine('/* Comment */r/regex/');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.REGEX);
      });

      it('should handle multiple token types without whitespace', function() {
        const result = parseTemplateLine('"String"/* Comment */r/regex/code');

        expect(result.tokens).to.have.length(4);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[2].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[3].type).to.equal(TOKEN_TYPES.CODE);
      });

      it('should handle regex followed by string without whitespace', function() {
        const result = parseTemplateLine('r/regex/"String"');

        expect(result.tokens).to.have.length(2);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.STRING);
      });
    });

    describe('Nunjucks Regex Support Compatibility', function() {
      it('should support only g, i, m, y flags for regex', function() {
        const result = parseTemplateLine('r/pattern/gimy');

        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].flags).to.equal('gimy');
      });

      it('should handle escaped forward slashes in regex patterns', function() {
        const result = parseTemplateLine('r/path\\/to\\/file/g');

        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].value).to.equal('r/path\\/to\\/file/g');
      });

      it('should handle empty regex patterns', function() {
        const result = parseTemplateLine('r//g');

        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].value).to.equal('r//g');
      });
    });
  });

  /**
 * Unit tests for indentation support in the template language parser
 */
  describe('Indentation Support', function () {
    describe('Indentation Extraction', function () {
      it('should extract no indentation from an empty line', function () {
        const result = parseTemplateLine('');
        expect(result.indentation).to.equal('');
      });

      it('should extract spaces as indentation', function () {
        const result = parseTemplateLine('    const x = 5;');
        expect(result.indentation).to.equal('    ');
      });

      it('should extract tabs as indentation', function () {
        const result = parseTemplateLine('\t\tconst x = 5;');
        expect(result.indentation).to.equal('\t\t');
      });

      it('should extract mixed spaces and tabs as indentation', function () {
        const result = parseTemplateLine('  \t  const x = 5;');
        expect(result.indentation).to.equal('  \t  ');
      });
    });

    describe('Token Positioning', function () {
      it('should position code tokens correctly with space indentation', function () {
        const result = parseTemplateLine('    const x = 5;');
        expect(result.tokens[0].start).to.equal(4);
        expect(result.tokens[0].value).to.equal('const x = 5;');
      });

      it('should position code tokens correctly with tab indentation', function () {
        const result = parseTemplateLine('\tconst x = 5;');
        expect(result.tokens[0].start).to.equal(1);
        expect(result.tokens[0].value).to.equal('const x = 5;');
      });

      it('should position string tokens correctly after indentation', function () {
        const result = parseTemplateLine('    "string";');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[0].start).to.equal(4);
      });

      it('should position regex tokens correctly after indentation', function () {
        const result = parseTemplateLine('    r/pattern/g;');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].start).to.equal(4);
      });

      it('should position comment tokens correctly after indentation', function () {
        const result = parseTemplateLine('    // Comment');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[0].start).to.equal(4);
      });
    });

    describe('Continuation with Indentation', function () {
      it('should handle string continuation with indentation', function () {
        // First line with a string that continues to next line
        const result1 = parseTemplateLine('    const str = "Line 1 \\');
        expect(result1.indentation).to.equal('    ');
        expect(result1.stringState).not.to.be(null);

        // Second line continues the string with different indentation
        const result2 = parseTemplateLine('      Line 2";', false, result1.stringState);
        expect(result2.indentation).to.equal('      ');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].start).to.equal(6); // After indentation
      });

      it('should handle multi-line comment continuation with indentation', function () {
        // First line with a multi-line comment
        const result1 = parseTemplateLine('    /* Start of comment');
        expect(result1.indentation).to.equal('    ');
        expect(result1.inMultiLineComment).to.be(true);

        // Second line continues the comment with different indentation
        const result2 = parseTemplateLine('      End of comment */', result1.inMultiLineComment);
        expect(result2.indentation).to.equal('      ');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result2.tokens[0].start).to.equal(6); // After indentation
      });

      it('should preserve indentation in the result object', function () {
        const result = parseTemplateLine('    const x = 5;');
        expect(result).to.have.property('indentation'); // Fixed: use property check instead of contain
        expect(result.indentation).to.equal('    ');
      });
    });

    describe('Edge Cases', function () {
      it('should handle empty lines', function () {
        const result = parseTemplateLine('');
        expect(result.indentation).to.equal('');
        expect(result.tokens).to.have.length(0);
      });

      it('should handle lines with only indentation', function () {
        const result = parseTemplateLine('    ');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[0].start).to.equal(4);
        expect(result.tokens[0].end).to.equal(4);
        expect(result.tokens[0].value).to.equal('');
      });

      it('should handle lines with only tabs as indentation', function () {
        const result = parseTemplateLine('\t\t');
        expect(result.indentation).to.equal('\t\t');
        expect(result.tokens).to.have.length(1);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result.tokens[0].start).to.equal(2);
        expect(result.tokens[0].end).to.equal(2);
        expect(result.tokens[0].value).to.equal('');
      });
    });

    describe('Backslash and Unicode Escapes', function () {
      it('should handle Unicode escapes split across lines with indentation', function () {
        // First line with Unicode escape at the end
        const result1 = parseTemplateLine('    const str = "Unicode \\u00');
        expect(result1.indentation).to.equal('    ');
        expect(result1.stringState).not.to.be(null);
        expect(result1.stringState.escaped).to.be(false);

        // Second line continues the Unicode escape
        const result2 = parseTemplateLine('      7A";', false, result1.stringState);
        expect(result2.indentation).to.equal('      ');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].start).to.equal(6); // After indentation
      });

      it('should handle single backslash at line end with indentation (string continues)', function () {
        const result = parseTemplateLine('    const str = "String with \\');
        expect(result.indentation).to.equal('    ');
        expect(result.stringState).not.to.be(null);
        expect(result.stringState.escaped).to.be(true);
      });

      it('should handle double backslash at line end with indentation (string does not continue)', function () {
        const result = parseTemplateLine('    const str = "String with \\\\');
        expect(result.indentation).to.equal('    ');
        expect(result.stringState).to.be(null);
      });

      it('should handle triple backslash at line end with indentation (string continues)', function () {
        const result = parseTemplateLine('    const str = "String with \\\\\\');
        expect(result.indentation).to.equal('    ');
        expect(result.stringState).not.to.be(null);
        expect(result.stringState.escaped).to.be(true);
      });
    });

    describe('Template Literals with Indentation', function () {
      it('should handle template literals with expressions and indentation', function () {
        // This test needs modification because our parser might be treating template literals differently
        // Let's test for the backtick at the start position after indentation
        const result = parseTemplateLine('    `Value: ${x}`;');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
        expect(result.tokens[0].start).to.equal(4);
      });

      it('should handle multi-line template literals with indentation', function () {
        // Direct template literal without assignment
        const result1 = parseTemplateLine('    `Line 1');
        expect(result1.indentation).to.equal('    ');
        expect(result1.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result1.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
        expect(result1.tokens[0].start).to.equal(4);
        expect(result1.tokens[0].incomplete).to.be(true);

        // Template literal continues with different indentation
        const result2 = parseTemplateLine('      Line 2`;', false, result1.stringState);
        expect(result2.indentation).to.equal('      ');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].start).to.equal(6);
      });
    });

    describe('Mixed Scenarios', function () {
      it('should handle a line with multiple token types and indentation', function () {
        const result = parseTemplateLine('    const x = "string"; // Comment');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens.length).to.be.greaterThan(1);
        expect(result.tokens[0].start).to.equal(4); // First token starts after indentation
      });

      it('should handle indentation with both single and multi-line comments', function () {
        // Modified to account for space between comments being tokenized
        const result = parseTemplateLine('    /* multi-line *//* single-line */');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens).to.have.length(2);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
        expect(result.tokens[0].start).to.equal(4);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[1].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
      });

      it('should handle multi-line comment followed by a single-line comment with space', function () {
        // Add a specific test for the case with space between comments
        const result = parseTemplateLine('    /* multi-line */ // single-line');
        expect(result.indentation).to.equal('    ');
        // It's valid to have 3 tokens: multi-line comment, space as code, single-line comment
        expect(result.tokens).to.have.length(3);
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.MULTI_LINE);
        expect(result.tokens[1].type).to.equal(TOKEN_TYPES.CODE); // Space between comments
        expect(result.tokens[2].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result.tokens[2].subtype).to.equal(TOKEN_SUBTYPES.SINGLE_LINE);
      });

      it('should preserve indentation when constructing string continuation state', function () {
        const result1 = parseTemplateLine('    "string continues \\');
        const result2 = parseTemplateLine('\t\twith different indentation";', false, result1.stringState);

        expect(result1.indentation).to.equal('    ');
        expect(result2.indentation).to.equal('\t\t');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result2.tokens[0].start).to.equal(2); // After tab indentation
      });
    });
  });

  /**
 * Additional tests for comprehensive indentation support coverage
 */
  describe('Advanced Indentation Support', function () {
    describe('Non-Standard Whitespace', function () {
      it('should handle carriage return in indentation', function() {
        const result = parseTemplateLine('\r    const x = 5;');
        // The implementation treats \r as a character before indentation
        // so indentation starts after \r
        expect(result.indentation).to.equal('');
        expect(result.tokens[0].start).to.equal(0);
      });

      it('should handle lines with zero indentation', function() {
        const result = parseTemplateLine('const x = 5;');
        expect(result.indentation).to.equal('');
        expect(result.tokens[0].start).to.equal(0);
        expect(result.tokens[0].value).to.equal('const x = 5;');
      });

      it('should handle very large indentation', function() {
        const largeIndent = ' '.repeat(100);
        const result = parseTemplateLine(largeIndent + 'x = 5;');
        expect(result.indentation).to.equal(largeIndent);
        expect(result.tokens[0].start).to.equal(100);
      });
    });

    describe('Nested Structures with Indentation', function () {
      it('should handle nested code blocks with varied indentation', function () {
        // First line
        const result1 = parseTemplateLine('if (condition) {');
        expect(result1.indentation).to.equal('');

        // Second line (indented)
        const result2 = parseTemplateLine('    if (nestedCondition) {');
        expect(result2.indentation).to.equal('    ');

        // Third line (double indentation)
        const result3 = parseTemplateLine('        const x = 5;');
        expect(result3.indentation).to.equal('        ');
      });

      it('should handle nested string continuations with varying indentation', function () {
        // First level string with continuation
        const result1 = parseTemplateLine('const str = "First level \\');
        expect(result1.stringState).not.to.be(null);

        // Second level with different indentation
        const result2 = parseTemplateLine('    continued with more indentation \\', false, result1.stringState);
        expect(result2.indentation).to.equal('    ');
        expect(result2.stringState).not.to.be(null);

        // Third level with different indentation
        const result3 = parseTemplateLine('  and then less indentation";', false, result2.stringState);
        expect(result3.indentation).to.equal('  ');
        expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      });
    });

    describe('Complex Template Literals', function () {
      it('should handle template literals with nested expressions', function () {
        const result = parseTemplateLine('    `Value: ${x > 5 ? `nested ${y}` : "not nested"}`;');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[0].subtype).to.equal(TOKEN_SUBTYPES.TEMPLATE);
      });

      it('should handle template literals with multiple expressions and indentation', function () {
        const result = parseTemplateLine('    `${a} + ${b} = ${a + b}`;');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result.tokens[0].start).to.equal(4);
      });

      it('should handle multi-line template literal with expressions and varying indentation', function () {
        // First line
        const result1 = parseTemplateLine('    `Start of template ${');
        expect(result1.indentation).to.equal('    ');
        expect(result1.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
        expect(result1.tokens[0].incomplete).to.be(true);
        expect(result1.stringState).not.to.be(null);

        // Second line with different indentation
        const result2 = parseTemplateLine('        x > 5 ? "larger" : "smaller"', false, result1.stringState);
        expect(result2.indentation).to.equal('        ');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);

        // Third line closes the template
        const result3 = parseTemplateLine('    } end of template`;', false, result2.stringState);
        expect(result3.indentation).to.equal('    ');
        expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      });
    });

    describe('Mixed Indentation Types', function () {
      it('should handle inconsistent indentation across continuous tokens', function () {
        // Start with spaces
        const result1 = parseTemplateLine('    /* Start of comment');
        expect(result1.indentation).to.equal('    ');
        expect(result1.inMultiLineComment).to.be(true);

        // Continue with tabs
        const result2 = parseTemplateLine('\t\tmiddle of comment', result1.inMultiLineComment);
        expect(result2.indentation).to.equal('\t\t');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result2.tokens[0].start).to.equal(2);

        // Finish with mixed indentation
        const result3 = parseTemplateLine('  \t  end of comment */', result2.inMultiLineComment);
        expect(result3.indentation).to.equal('  \t  ');
        expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);
        expect(result3.tokens[0].start).to.equal(5);
      });
    });

    describe('Comment-Specific Indentation Behavior', function () {
      it('should ignore comment nestline with varying indentation', function() {
        // First line - start outer comment
        const result1 = parseTemplateLine('    /* Outer comment');
        expect(result1.indentation).to.equal('    ');
        expect(result1.inMultiLineComment).to.be(true);

        // Second line - with "inner" comment syntax
        const result2 = parseTemplateLine('        /* Nested comment-like syntax */', result1.inMultiLineComment);
        expect(result2.indentation).to.equal('        ');
        // The current implementation treats this as COMMENT, not CODE
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.COMMENT);

        // Third line - end outer comment
        const result3 = parseTemplateLine('    Outer comment end */', result2.inMultiLineComment);
        expect(result3.indentation).to.equal('    ');
        expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
        expect(result3.inMultiLineComment).to.be(false);
      });
    });

    describe('Regex-Specific Indentation Behavior', function () {
      it('should handle regex with flags after indentation', function() {
        const result = parseTemplateLine('    r/pattern/gi;');
        expect(result.indentation).to.equal('    ');
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.REGEX);
        expect(result.tokens[0].flags).to.equal('gi');
      });

      it('should treat incomplete regex pattern as code', function() {
        const result = parseTemplateLine('    r/pattern');
        expect(result.indentation).to.equal('    ');
        // It should be a CODE token, not REGEX
        expect(result.tokens[0].type).to.equal(TOKEN_TYPES.CODE);
      });
    });

    describe('Multi-Line Token Sequences', function () {
      it('should handle long sequences of continued lines with varying indentation', function () {
        // Setup a multi-line sequence with alternating indentation
        const lines = [
          '/* Start a comment',              // Line 1 - no indent
          '   with some indentation',        // Line 2 - 3 spaces
          '     even more indentation',      // Line 3 - 5 spaces
          ' less indentation',               // Line 4 - 1 space
          '\tswitch to tabs',                // Line 5 - 1 tab
          ' back to spaces */'               // Line 6 - 1 space
        ];

        // Process the sequence
        let inComment = false;
        let results = [];

        for (let i = 0; i < lines.length; i++) {
          const result = parseTemplateLine(lines[i], inComment);
          results.push(result);
          inComment = result.inMultiLineComment;

          // Verify indentation extraction
          const expectedIndentation = i === 0 ? '' :
            i === 1 ? '   ' :
              i === 2 ? '     ' :
                i === 3 ? ' ' :
                  i === 4 ? '\t' : ' ';

          expect(result.indentation).to.equal(expectedIndentation);

          // Verify token is positioned correctly after indentation
          expect(result.tokens[0].start).to.equal(expectedIndentation.length);
        }

        // Verify final result is not in comment state
        expect(results[results.length - 1].inMultiLineComment).to.be(false);
      });
    });

    describe('Pathological Edge Cases', function () {
      it('should handle string with escape at end of indentation', function() {
        // This is a strange edge case: indentation with a backslash at the end
        // followed by a string on the next line
        const result1 = parseTemplateLine('    \\');
        expect(result1.indentation).to.equal('    ');
        // The backslash should be treated as regular code
        expect(result1.tokens[0].type).to.equal(TOKEN_TYPES.CODE);

        const result2 = parseTemplateLine('"This is a new string"');
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      });

      it('should handle indentation-only lines between tokens', function() {
        // Start a string
        const result1 = parseTemplateLine('const str = "Start string \\');
        expect(result1.stringState).not.to.be(null);

        // Line with only indentation
        const result2 = parseTemplateLine('    ', false, result1.stringState);
        expect(result2.indentation).to.equal('    ');
        // The implementation treats this as a STRING token when in string continuation
        expect(result2.tokens[0].type).to.equal(TOKEN_TYPES.STRING);

        // Complete the string
        const result3 = parseTemplateLine('end string"', false, result2.stringState);
        expect(result3.tokens[0].type).to.equal(TOKEN_TYPES.STRING);
      });

      it('should handle extreme changes in indentation', function() {
        // Start with no indentation
        const result1 = parseTemplateLine('/* Comment');
        expect(result1.indentation).to.equal('');
        expect(result1.inMultiLineComment).to.be(true);

        // Jump to very large indentation
        const largeIndent = ' '.repeat(100);
        const result2 = parseTemplateLine(largeIndent + 'still in comment', result1.inMultiLineComment);
        expect(result2.indentation).to.equal(largeIndent);
        expect(result2.tokens[0].start).to.equal(100);

        // Back to small indentation
        const result3 = parseTemplateLine(' end comment */', result2.inMultiLineComment);
        expect(result3.indentation).to.equal(' ');
        expect(result3.tokens[0].start).to.equal(1);
      });
    });
  });

});
