const expect = require('expect.js');

// Extract the necessary functions and constants for easier use in tests
const {
  scriptToTemplate,
  getFirstWord,
  validateBlockStructure,
  parseLines,
  isStartOfContinuation,
  isContinuationOfExpression,
  findCommentOutsideString,
  determineBlockType,
  LINE_TYPE,
} = require('../nunjucks/src/script');

describe('Script to Template Converter', function() {

  describe('getFirstWord()', function() {
    it('should extract the first word from a string', function() {
      expect(getFirstWord('test string')).to.equal('test');
      expect(getFirstWord('  test  string  ')).to.equal('test');
      expect(getFirstWord('')).to.equal(null);
      expect(getFirstWord('   ')).to.equal(null);
    });
  });

  describe('findCommentOutsideString()', function() {
    it('should find comments in regular code', function() {
      expect(findCommentOutsideString('code // comment')).to.equal(5);
      expect(findCommentOutsideString('// comment')).to.equal(0);
      expect(findCommentOutsideString('code')).to.equal(-1);
    });

    it('should not find comments inside strings', function() {
      expect(findCommentOutsideString('var x = "// not a comment"')).to.equal(-1);
      expect(findCommentOutsideString('var x = "string" // comment')).to.equal(17);
      expect(findCommentOutsideString('var x = "escaped \\" // still in string"')).to.equal(-1);
    });
  });

  describe('isStartOfContinuation()', function() {
    it('should identify lines that end with operators', function() {
      expect(isStartOfContinuation('x = 1 +', 0, ['x = 1 +', 'y'])).to.be(true);
      expect(isStartOfContinuation('x = 1 -', 0, ['x = 1 -', 'y'])).to.be(true);
      expect(isStartOfContinuation('x = 1 *', 0, ['x = 1 *', 'y'])).to.be(true);
      expect(isStartOfContinuation('x = 1', 0, ['x = 1', 'y'])).to.be(false);
    });

    it('should identify lines with open brackets', function() {
      expect(isStartOfContinuation('if (x == 1 && (', 0, ['if (x == 1 && (', 'y > 2', ')'])).to.be(true);
      expect(isStartOfContinuation('if (x == 1 &&', 0, ['if (x == 1 &&', 'y > 2', ')'])).to.be(true);
      expect(isStartOfContinuation('if (x == 1)', 0, ['if (x == 1)', 'print "hello"'])).to.be(false);
    });

    it('should identify lines with open strings', function() {
      expect(isStartOfContinuation('x = "open string', 0, ['x = "open string', 'still in string"'])).to.be(true);
      expect(isStartOfContinuation('x = "closed string"', 0, ['x = "closed string"', 'y = 2'])).to.be(false);
    });
  });

  describe('isContinuationOfExpression()', function() {
    it('should identify lines that continue expressions', function() {
      expect(isContinuationOfExpression(') {}')).to.be(true);
      expect(isContinuationOfExpression('+ 5')).to.be(true);
      expect(isContinuationOfExpression('and x > 5')).to.be(true);
      expect(isContinuationOfExpression('x = 5')).to.be(false);
    });
  });

  describe('determineBlockType()', function() {
    it('should identify block start tags', function() {
      expect(determineBlockType('if')).to.equal(LINE_TYPE.BLOCK_START);
      expect(determineBlockType('for')).to.equal(LINE_TYPE.BLOCK_START);
      expect(determineBlockType('block')).to.equal(LINE_TYPE.BLOCK_START);
    });

    it('should identify block middle tags', function() {
      expect(determineBlockType('else')).to.equal(LINE_TYPE.BLOCK_MIDDLE);
      expect(determineBlockType('elif')).to.equal(LINE_TYPE.BLOCK_MIDDLE);
      expect(determineBlockType('resume')).to.equal(LINE_TYPE.BLOCK_MIDDLE);
      expect(determineBlockType('except')).to.equal(LINE_TYPE.BLOCK_MIDDLE);
    });

    it('should identify block end tags', function() {
      expect(determineBlockType('endif')).to.equal(LINE_TYPE.BLOCK_END);
      expect(determineBlockType('endfor')).to.equal(LINE_TYPE.BLOCK_END);
      expect(determineBlockType('endblock')).to.equal(LINE_TYPE.BLOCK_END);
    });

    it('should return null for non-block tags', function() {
      expect(determineBlockType('set')).to.equal(null);
      expect(determineBlockType('include')).to.equal(null);
      expect(determineBlockType('nonKeyword')).to.equal(null);
    });
  });

  describe('parseLines()', function() {
    it('should parse a simple script with various elements', function() {
      const input = [
        'if condition',
        '  print "Hello"',
        '  // Comment',
        '  someVar = 42',
        'endif'
      ];

      const result = parseLines(input);

      expect(result.length).to.equal(5);

      expect(result[0].type).to.equal(LINE_TYPE.TAG_START);
      expect(result[0].content).to.equal('if condition');
      expect(result[0].blockType).to.equal(LINE_TYPE.BLOCK_START);

      expect(result[1].type).to.equal(LINE_TYPE.PRINT_END);
      expect(result[1].content).to.equal('"Hello"');

      expect(result[2].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
      expect(result[2].content).to.equal('Comment');

      expect(result[3].type).to.equal(LINE_TYPE.CODE_STANDALONE);
      expect(result[3].content).to.equal('someVar = 42');

      expect(result[4].type).to.equal(LINE_TYPE.TAG_START);
      expect(result[4].content).to.equal('endif');
      expect(result[4].blockType).to.equal(LINE_TYPE.BLOCK_END);
    });

    it('should handle multi-line expressions', function() {
      const input = [
        'print "This is " +',
        '      "a multi-line " +',
        '      "string"'
      ];

      const result = parseLines(input);

      expect(result.length).to.equal(3);

      expect(result[0].type).to.equal(LINE_TYPE.PRINT_START);
      expect(result[0].content).to.equal('"This is " +');

      expect(result[1].type).to.equal(LINE_TYPE.PRINT_CONTINUATION);
      expect(result[1].content).to.equal('"a multi-line " +');

      expect(result[2].type).to.equal(LINE_TYPE.PRINT_END);
      expect(result[2].content).to.equal('"string"');
    });

    it('should handle inline comments', function() {
      const input = [
        'set x = 5 // Set x variable',
        'print x // Print x'
      ];

      const result = parseLines(input);

      expect(result.length).to.equal(2);

      expect(result[0].type).to.equal(LINE_TYPE.TAG_START);
      expect(result[0].content).to.equal('set x = 5');
      expect(result[0].inlineComment).to.equal('Set x variable');

      expect(result[1].type).to.equal(LINE_TYPE.PRINT_END);
      expect(result[1].content).to.equal('x');
      expect(result[1].inlineComment).to.equal('Print x');
    });

    it('should handle multi-line comments', function() {
      const input = [
        '/* This is a',
        ' * multi-line',
        ' * comment */',
        'print "After comment"'
      ];

      const result = parseLines(input);

      expect(result.length).to.equal(4);

      expect(result[0].type).to.equal(LINE_TYPE.COMMENT_MULTI_START);
      expect(result[0].content).to.equal('This is a');

      expect(result[1].type).to.equal(LINE_TYPE.COMMENT_MULTI_MIDDLE);
      expect(result[1].content).to.equal('multi-line');

      expect(result[2].type).to.equal(LINE_TYPE.COMMENT_MULTI_END);
      expect(result[2].content).to.equal('comment');

      expect(result[3].type).to.equal(LINE_TYPE.PRINT_END);
      expect(result[3].content).to.equal('"After comment"');
    });
  });

  describe('validateBlockStructure()', function() {
    it('should validate properly nested blocks', function() {
      const lines = [
        { content: 'if x > 0', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Positive"', type: LINE_TYPE.PRINT_END },
        { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "Non-positive"', type: LINE_TYPE.PRINT_END },
        { content: 'endif', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should reject improperly nested blocks', function() {
      const lines = [
        { content: 'if x > 0', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Positive"', type: LINE_TYPE.PRINT_END },
        { content: 'endfor', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('Unexpected \'endfor\'');
    });

    it('should detect unclosed blocks', function() {
      const lines = [
        { content: 'if x > 0', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Positive"', type: LINE_TYPE.PRINT_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('Unclosed \'if\'');
    });

    it('should validate else within if', function() {
      const lines = [
        { content: 'if x > 0', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Positive"', type: LINE_TYPE.PRINT_END },
        { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "Non-positive"', type: LINE_TYPE.PRINT_END },
        { content: 'endif', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should validate else within for', function() {
      const lines = [
        { content: 'for item in items', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print item', type: LINE_TYPE.PRINT_END },
        { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "No items"', type: LINE_TYPE.PRINT_END },
        { content: 'endfor', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should reject else outside of proper blocks', function() {
      const lines = [
        { content: 'block test', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Content"', type: LINE_TYPE.PRINT_END },
        { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "Else content"', type: LINE_TYPE.PRINT_END },
        { content: 'endblock', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('else');
    });
  });

  describe('scriptToTemplate()', function() {
    it('should convert simple scripts to templates', function() {
      const result = scriptToTemplate('print "Hello World"');
      expect(result.error).to.be(null);
      expect(result.template).to.equal('{{- "Hello World" -}}\n');
    });

    it('should handle if/else statements', function() {
      const script = 'if condition\n  print "True"\nelse\n  print "False"\nendif';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.equal(
        '{%- if condition -%}\n' +
        '  {{- "True" -}}\n' +
        '{%- else -%}\n' +
        '  {{- "False" -}}\n' +
        '{%- endif -%}\n'
      );
    });

    it('should convert comments properly', function() {
      const script = '// Single line comment\n/* Multi-line\n * comment */\nprint "After comments"';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.contain('{# Single line comment #}');
      expect(result.template).to.contain('{# Multi-line');
      expect(result.template).to.contain('comment #}');
      expect(result.template).to.contain('{{- "After comments" -}}');
    });

    it('should convert multi-line expressions', function() {
      const script = 'print "This is a long string " +\n       "that spans multiple lines " +\n       "for readability"';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.equal(
        '{{- "This is a long string " +\n' +
        '       "that spans multiple lines " +\n' +
        '       "for readability" -}}\n'
      );
    });

    it('should handle loops and complex structures', function() {
      const script = 'for item in items\n  print item\nendfor';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.equal(
        '{%- for item in items -%}\n' +
        '  {{- item -}}\n' +
        '{%- endfor -%}\n'
      );
    });

    it('should detect errors in block structure', function() {
      const script = 'if condition\n  print "True"\nendfor';
      const result = scriptToTemplate(script);

      expect(result.error).to.not.be(null);
      expect(result.error).to.contain('Unexpected \'endfor\'');
    });

    it('should handle inline comments', function() {
      const script = 'print "Hello" // Greeting';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.equal('{{- "Hello" -}} {# Greeting #}\n');
    });
  });
});
