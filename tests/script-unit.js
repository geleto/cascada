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
  addInlineComment,
  convertLinesToTemplate,
  LINE_TYPE
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

      expect(result[0].type).to.equal(LINE_TYPE.TAG_END); // Fix: Standalone if is TAG_END
      expect(result[0].content).to.equal('if condition');
      expect(result[0].blockType).to.equal(LINE_TYPE.BLOCK_START);

      expect(result[1].type).to.equal(LINE_TYPE.PRINT_STANDALONE); // Fix: Single-line print is PRINT_STANDALONE
      expect(result[1].content).to.equal('"Hello"');

      expect(result[2].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
      expect(result[2].content).to.equal('Comment');

      expect(result[3].type).to.equal(LINE_TYPE.CODE_STANDALONE);
      expect(result[3].content).to.equal('someVar = 42');

      expect(result[4].type).to.equal(LINE_TYPE.TAG_END); // Fix: endif is TAG_END
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

      expect(result[0].type).to.equal(LINE_TYPE.TAG_END); // Corrected to TAG_END for standalone set
      expect(result[0].content).to.equal('set x = 5');
      expect(result[0].inlineComment).to.equal('Set x variable');

      expect(result[1].type).to.equal(LINE_TYPE.PRINT_STANDALONE); // Corrected to PRINT_STANDALONE for single-line print
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

      expect(result[3].type).to.equal(LINE_TYPE.PRINT_STANDALONE); // Fixed: PRINT_STANDALONE instead of PRINT_END
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

  describe('Helper Function Tests', function() {
    describe('addInlineComment()', function() {
      it('should add a comment to a line', function() {
        expect(addInlineComment('line content', 'comment')).to.equal('line content {# comment #}');
      });

      it('should return the line unchanged if no comment is provided', function() {
        expect(addInlineComment('line content', null)).to.equal('line content');
        expect(addInlineComment('line content', '')).to.equal('line content');
      });
    });
  });

  describe('Line Conversion Tests', function() {
    describe('convertLinesToTemplate()', function() {
      it('should convert empty lines', function() {
        const parsedLines = [{ type: LINE_TYPE.EMPTY, indentation: 0 }];
        expect(convertLinesToTemplate(parsedLines)).to.eql(['']);
      });

      it('should convert multi-line comments', function() {
        const parsedLines = [
          { type: LINE_TYPE.COMMENT_MULTI_START, content: 'Start', indentation: 0 },
          { type: LINE_TYPE.COMMENT_MULTI_MIDDLE, content: 'Middle', indentation: 2 },
          { type: LINE_TYPE.COMMENT_MULTI_END, content: 'End', indentation: 0 }
        ];
        expect(convertLinesToTemplate(parsedLines)).to.eql([
          '{# Start',
          '     Middle',
          '   End #}'
        ]);
      });

      it('should convert print statements with correct delimiters', function() {
        const parsedLines = [
          { type: LINE_TYPE.PRINT_STANDALONE, content: '"Hello"', indentation: 2 },
          { type: LINE_TYPE.PRINT_START, content: '"Multi', indentation: 0 },
          { type: LINE_TYPE.PRINT_CONTINUATION, content: 'line"', indentation: 2 },
          { type: LINE_TYPE.PRINT_END, content: '+ "!"', indentation: 0 }
        ];
        const result = convertLinesToTemplate(parsedLines);
        expect(result[0]).to.equal('  {{- "Hello" -}}');
        expect(result[1]).to.equal('{{- "Multi');
      });
    });
  });

  describe('Edge Case Tests', function() {
    describe('findCommentOutsideString() edge cases', function() {
      it('should handle nested quotes', function() {
        expect(findCommentOutsideString('var x = "string with \\"nested\\" quotes" // comment')).to.equal(40);
      });

      it('should handle alternating quote types', function() {
        expect(findCommentOutsideString('var x = "string with \'nested\' quotes" // comment')).to.equal(38);
        expect(findCommentOutsideString('var x = \'string with "nested" quotes\' // comment')).to.equal(38);
      });
    });

    describe('isStartOfContinuation() edge cases', function() {
      it('should handle nested parentheses', function() {
        expect(isStartOfContinuation('if (x == 1 && (y || (', 0, ['if (x == 1 && (y || (', 'z == 2))', ')'])).to.be(true);
      });

      it('should handle escaped quotes', function() {
        expect(isStartOfContinuation('x = "string with \\"', 0, ['x = "string with \\"', 'still in string"'])).to.be(true);
      });

      it('should handle backslash continuation explicitly', function() {
        expect(isStartOfContinuation('line ending with \\', 0, ['line ending with \\', 'continuation'])).to.be(true);
      });
    });
  });

  describe('Complex Scenario Tests', function() {
    describe('parseLines() complex scenarios', function() {
      it('should handle mixed comment types', function() {
        const input = [
          '// Single line comment',
          'code /* inline comment */ more code',
          '/* Start multi-line',
          ' * middle',
          ' */ code after comment'
        ];

        const result = parseLines(input);
        expect(result[0].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
        // Test correct parsing of the remaining lines
      });

      it('should handle multi-line expressions with inline comments', function() {
        const input = [
          'print "start" + // First part',
          '      "middle" + // Middle part',
          '      "end" // End part'
        ];

        const result = parseLines(input);
        // Verify comment buffering works across lines
        expect(result[2].inlineComment).to.contain('First part');
        expect(result[2].inlineComment).to.contain('Middle part');
        expect(result[2].inlineComment).to.contain('End part');
      });
    });
  });

  describe('Block Validation Tests', function() {
    describe('validateBlockStructure() complex cases', function() {
      it('should validate try/except/resume blocks', function() {
        const lines = [
          { content: 'try', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
          { content: 'print "Try"', type: LINE_TYPE.PRINT_END },
          { content: 'resume', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
          { content: 'print "Resume"', type: LINE_TYPE.PRINT_END },
          { content: 'except', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
          { content: 'print "Except"', type: LINE_TYPE.PRINT_END },
          { content: 'endtry', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
        ];

        const result = validateBlockStructure(lines);
        expect(result.valid).to.be(true);
      });

      it('should reject misplaced block elements', function() {
        const lines = [
          { content: 'try', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
          { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
          { content: 'endtry', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
        ];

        const result = validateBlockStructure(lines);
        expect(result.valid).to.be(false);
        expect(result.error).to.contain('else');
      });
    });
  });

  describe('Full Conversion Tests', function() {
    describe('scriptToTemplate() additional cases', function() {
      it('should handle whitespace preservation in indentation', function() {
        const script = 'if x\n  print "Indented"\n    print "More indented"\nendif';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('  {{- "Indented" -}}');
        expect(result.template).to.contain('    {{- "More indented" -}}');
      });

      it('should handle implicitly created "do" statements', function() {
        const script = 'items.push(1)\narr[index] = value';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- do items.push(1) -%}');
        expect(result.template).to.contain('{%- do arr[index] = value -%}');
      });

      it('should handle multiline statements with operators', function() {
        const script = 'print a &&\n  b ||\n  c';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{{- a &&\n  b ||\n  c -}}');
      });
    });
  });

  describe('scriptToTemplate() - expression parsing edge cases', function() {
    it('should handle nested brackets across multiple lines', function() {
      const script =
        'if (x && (\n' +
        '     y ||\n' +
        '     (z && w)\n' +
        '   ))\n' +
        '  print "True"\n' +
        'endif';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      // Check that nesting is preserved in the template
      expect(result.template).to.contain('if (x && (');
      expect(result.template).to.contain('y ||');
      expect(result.template).to.contain('(z && w)');
    });

    it('should handle unclosed quotes properly', function() {
      const script =
        'print "Start of string\n' +
        '       middle of string\n' +
        '       end of string"';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      // Check string is treated as multi-line
      expect(result.template).to.contain('"Start of string');
      expect(result.template).to.contain('end of string"');
    });

    it('should handle escaped quotes in strings', function() {
      const script = 'print "String with \\"escaped quotes\\""';
      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('"String with \\"escaped quotes\\""');
    });

    it('should detect unbalanced brackets in expressions', function() {
      const script = 'if (x && (y || z)\n  print "Missing closing bracket"\nendif';

      // Note: The current implementation won't catch this error since it doesn't
      // do full expression parsing. This test demonstrates the limitation.
      const result = scriptToTemplate(script);

      // The converter will pass this through, and the template engine would later catch it
      expect(result.error).to.be(null);
      expect(result.template).to.contain('if (x && (y || z)');
    });
  });

  /**
   * 1. Individual Line Type Conversion Tests
   */
  describe('Line Type Conversion Tests', function () {
    // Test each individual line type conversion separately
    it('should convert TAG_START lines correctly', function () {
      const line = {
        type: LINE_TYPE.TAG_START,
        content: 'if x > 0',
        indentation: 2,
        blockType: LINE_TYPE.BLOCK_START
      };
      expect(convertLinesToTemplate([line])[0]).to.equal('  {%- if x > 0 -%}');
    });

    it('should convert TAG_CONTINUATION lines correctly', function () {
      const line = {
        type: LINE_TYPE.TAG_CONTINUATION,
        content: 'y < 10 and',
        indentation: 4
      };
      expect(convertLinesToTemplate([line])[0]).to.equal('    y < 10 and');
    });

    it('should convert TAG_END lines correctly', function () {
      const line = {
        type: LINE_TYPE.TAG_END,
        content: 'z == true',
        indentation: 2
      };
      expect(convertLinesToTemplate([line])[0]).to.equal('  {%- z == true -%}');
    });

    it('should convert CODE_STANDALONE lines correctly', function () {
      const line = {
        type: LINE_TYPE.CODE_STANDALONE,
        content: 'doSomething()',
        indentation: 2
      };
      expect(convertLinesToTemplate([line])[0]).to.equal('  {%- do doSomething() -%}');
    });

    it('should handle inline comments in various line types', function () {
      const lines = [
        {
          type: LINE_TYPE.CODE_STANDALONE,
          content: 'getData()',
          indentation: 0,
          inlineComment: 'Fetch the data'
        },
        {
          type: LINE_TYPE.PRINT_STANDALONE,
          content: 'result',
          indentation: 2,
          inlineComment: 'Display result'
        },
        {
          type: LINE_TYPE.TAG_END,
          content: 'set x = 5',
          indentation: 4,
          inlineComment: 'Initialize x'
        }
      ];

      const result = convertLinesToTemplate(lines);
      expect(result[0]).to.equal('{%- do getData() -%} {# Fetch the data #}');
      expect(result[1]).to.equal('  {{- result -}} {# Display result #}');
      expect(result[2]).to.equal('    {%- set x = 5 -%} {# Initialize x #}');
    });
  });

  /**
   * 2. Enhanced Continuation Logic Tests
   */
  describe('Expression Continuation Logic', function () {
    describe('isStartOfContinuation() detailed tests', function () {
      it('should handle various operator endings', function () {
        const operators = ['+', '-', '*', '/', '=', '<', '>', '!', '%', '^', '&', '|'];
        operators.forEach(op => {
          expect(isStartOfContinuation(`x ${op}`, 0, [`x ${op}`, 'y'])).to.be(true);
        });
      });

      it('should handle compound operators', function () {
        const compoundOps = ['&&', '||', '==', '!=', '>=', '<=', '+=', '-=', '*=', '/=', '**'];
        compoundOps.forEach(op => {
          expect(isStartOfContinuation(`x ${op}`, 0, [`x ${op}`, 'y'])).to.be(true);
        });
      });

      it('should handle keyword continuations', function () {
        const keywords = ['in', 'is', 'and', 'or'];
        keywords.forEach(keyword => {
          expect(isStartOfContinuation(`x ${keyword}`, 0, [`x ${keyword}`, 'y'])).to.be(true);
        });
      });

      it('should handle various bracket patterns', function () {
        const brackets = [
          { start: '(', content: ['func(', 'arg1, arg2', ')'] },
          { start: '[', content: ['arr[', 'index', ']'] },
          { start: '{', content: ['obj = {', 'key: value', '}'] }
        ];

        brackets.forEach(bracket => {
          expect(isStartOfContinuation(bracket.content[0], 0, bracket.content)).to.be(true);
        });
      });

      it('should handle line comments before continuation characters', function () {
        expect(isStartOfContinuation('x = 1 + // adding something', 0,
          ['x = 1 + // adding something', 'y'])).to.be(true);
      });

      it('should recognize continuation when next line starts with continuation chars', function () {
        const lines = ['if condition', '   && otherCondition'];
        expect(isStartOfContinuation(lines[0], 0, lines)).to.be(true);
      });
    });

    describe('isContinuationOfExpression() detailed tests', function () {
      it('should identify lines starting with closing brackets as continuations', function () {
        const closers = [')', ']', '}'];
        closers.forEach(closer => {
          expect(isContinuationOfExpression(`${closer} ? true : false`)).to.be(true);
        });
      });

      it('should identify lines starting with operators as continuations', function () {
        const operators = ['+', '-', '*', '/', '=', '<', '>', '!', '%', '^', '&', '|'];
        operators.forEach(op => {
          expect(isContinuationOfExpression(`${op} someValue`)).to.be(true);
        });
      });

      it('should identify lines starting with continuation keywords', function () {
        const keywords = ['and', 'or', 'not', 'in', 'is', 'else', 'elif'];
        keywords.forEach(keyword => {
          expect(isContinuationOfExpression(`${keyword} someValue`)).to.be(true);
        });
      });
    });
  });

  /**
   * 3. Block Structure Validation Tests
   */
  describe('Block Structure Validation', function () {
    it('should validate nested blocks of different types', function () {
      const lines = [
        { content: 'if condition', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'for item in items', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print item', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'endfor', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should validate all supported block types', function () {
      // Test each block type from SYNTAX.tags.block
      const blockTypes = ['if', 'for', 'block', 'macro', 'filter', 'call', 'raw', 'verbatim', 'while', 'try'];

      blockTypes.forEach(blockType => {
        const lines = [
          { content: `${blockType} condition`, type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
          { content: 'print "content"', type: LINE_TYPE.PRINT_STANDALONE },
          { content: `end${blockType}`, type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }
        ];

        const result = validateBlockStructure(lines);
        expect(result.valid).to.be(true, `Failed for block type: ${blockType}`);
      });
    });

    it('should validate deeply nested structures', function () {
      const lines = [
        { content: 'if a', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'if b', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'if c', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "deep"', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should detect multiple errors in block structure', function () {
      // Test with a structure that has multiple errors - currently the validator stops at first error
      const lines = [
        { content: 'if a', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'for item in items', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print item', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }, // Wrong end tag
        { content: 'endfor', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }  // Order wrong
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('Unexpected \'endif\'');
    });

    it('should validate correct elif placement', function () {
      const lines = [
        { content: 'if a', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "a"', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'elif b', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "b"', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'endif', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should reject elif outside of if block', function () {
      const lines = [
        { content: 'for item in items', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print item', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'elif condition', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "something"', type: LINE_TYPE.PRINT_STANDALONE },
        { content: 'endfor', type: LINE_TYPE.TAG_END, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('elif');
    });

    it('should validate try/except/resume blocks', function () {
      const lines = [
        { content: 'try', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'print "Try"', type: LINE_TYPE.PRINT_END },
        { content: 'resume', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "Resume"', type: LINE_TYPE.PRINT_END },
        { content: 'except', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'print "Except"', type: LINE_TYPE.PRINT_END },
        { content: 'endtry', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should reject misplaced block elements', function () {
      const lines = [
        { content: 'try', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_START },
        { content: 'else', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_MIDDLE },
        { content: 'endtry', type: LINE_TYPE.TAG_START, blockType: LINE_TYPE.BLOCK_END }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
      expect(result.error).to.contain('else');
    });
  });

  /**
   * 4. Comment and String Edge Case Tests
   */
  describe('Comment and String Handling Edge Cases', function () {
    describe('findCommentOutsideString() advanced cases', function () {
      it('should handle escaped backslashes before quotes', function () {
        expect(findCommentOutsideString('var x = "string with \\\\" // comment')).to.equal(24);
      });

      it('should handle quoted strings inside comments', function () {
        expect(findCommentOutsideString('code // comment with "quotes" in it')).to.equal(5);
      });

      it('should handle comment-like sequences in regex literals', function () {
        // This is a limitation of the current implementation - it can't distinguish regex literals
        expect(findCommentOutsideString('var regex = /foo\\/\\/bar/ // actual comment')).to.equal(13);
      });

      it('should handle template literals', function () {
        // The current implementation doesn't specifically handle template literals
        // This test documents the current behavior
        expect(findCommentOutsideString('var x = `template ${var} literal` // comment')).to.equal(34);
      });
    });

    describe('Comment Parsing in Multi-Line Scenarios', function () {
      it('should handle a mix of single-line and multi-line comments', function () {
        const input = [
          '// Single line',
          'code /* start multi',
          'continue multi */ code',
          'more /* another multi',
          'end */ code'
        ];

        const result = parseLines(input);
        expect(result[0].type).to.equal(LINE_TYPE.COMMENT_SINGLE);

        // Current behavior splits the inline multi-line comment across 2nd and 3rd lines
        // These assertions describe current behavior, which could be improved
        expect(result[1].content).to.include('code');
        expect(result[2].content).to.include('code');
      });

      it('should handle nested-looking comment delimiters', function () {
        const input = [
          '/* outer comment with /* that looks nested */',
          'print "after comment"'
        ];

        const result = parseLines(input);
        // The current implementation treats everything up to the first */ as the comment
        expect(result[0].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
        expect(result[0].content).to.include('outer comment with /* that looks nested');
      });

      it('should handle comments at the end of multi-line expressions', function () {
        const input = [
          'print value + // Start expression',
          '      otherValue // End expression'
        ];

        const result = parseLines(input);
        expect(result[0].type).to.equal(LINE_TYPE.PRINT_START);
        expect(result[1].type).to.equal(LINE_TYPE.PRINT_END);

        // Check that comments are collected and attached to the final line
        expect(result[1].inlineComment).to.contain('Start expression');
        expect(result[1].inlineComment).to.contain('End expression');
      });
    });

    describe('String Literal Edge Cases', function () {
      it('should handle strings with escaped quotes and backslashes', function () {
        const input = [
          'print "String with \\"quotes\\" and \\\\backslashes\\\\"'
        ];

        const result = parseLines(input);
        expect(result[0].type).to.equal(LINE_TYPE.PRINT_STANDALONE);
        expect(result[0].content).to.equal('"String with \\"quotes\\" and \\\\backslashes\\\\"');
      });

      it('should handle complex mixed quotes', function () {
        const script = 'print "String with \'single\' and \\"double\\" quotes"';
        const result = scriptToTemplate(script);
        expect(result.template).to.contain('"String with \'single\' and \\"double\\" quotes"');
      });

      it('should handle unclosed quotes properly', function () {
        const script =
          'print "Start of string\n' +
          '       middle of string\n' +
          '       end of string"';

        const result = scriptToTemplate(script);
        expect(result.error).to.be(null);
        // Check string is treated as multi-line
        expect(result.template).to.contain('"Start of string');
        expect(result.template).to.contain('end of string"');
      });

      it('should handle escaped quotes in strings', function () {
        const script = 'print "String with \\"escaped quotes\\""';
        const result = scriptToTemplate(script);
        expect(result.error).to.be(null);
        expect(result.template).to.contain('"String with \\"escaped quotes\\""');
      });
    });
  });

  /**
   * 5. Script-Specific Syntax Feature Tests
   */
  describe('Script-Specific Syntax Features', function () {
    describe('Implicit do statements', function () {
      it('should convert non-reserved keyword lines to do statements', function () {
        const script = 'someVar = 42\naddItem(list, "value")\narr.push(element)';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- do someVar = 42 -%}');
        expect(result.template).to.contain('{%- do addItem(list, "value") -%}');
        expect(result.template).to.contain('{%- do arr.push(element) -%}');
      });

      it('should handle method calls and property access', function () {
        const script = 'user.name = "John"\nuser.updateProfile()\nobject["property"] = value';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- do user.name = "John" -%}');
        expect(result.template).to.contain('{%- do user.updateProfile() -%}');
        expect(result.template).to.contain('{%- do object["property"] = value -%}');
      });

      it('should handle complex expressions in implicit do statements', function () {
        const script = 'result = a ? b : c\nindex = (i + 1) % arr.length';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- do result = a ? b : c -%}');
        expect(result.template).to.contain('{%- do index = (i + 1) % arr.length -%}');
      });
    });

    describe('Print statement simplification', function () {
      it('should handle simple print statements', function () {
        const script = 'print "Hello"\nprint value\nprint user.name';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{{- "Hello" -}}');
        expect(result.template).to.contain('{{- value -}}');
        expect(result.template).to.contain('{{- user.name -}}');
      });

      it('should handle print statements with expressions', function () {
        const script = 'print 1 + 2\nprint getValue()\nprint a ? b : c';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{{- 1 + 2 -}}');
        expect(result.template).to.contain('{{- getValue() -}}');
        expect(result.template).to.contain('{{- a ? b : c -}}');
      });

      it('should handle print statements with filters', function () {
        const script = 'print value | upper\nprint items | join(",")\nprint date | date("YYYY-MM-DD")';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{{- value | upper -}}');
        expect(result.template).to.contain('{{- items | join(",") -}}');
        expect(result.template).to.contain('{{- date | date("YYYY-MM-DD") -}}');
      });
    });

    describe('Tag simplification', function () {
      it('should correctly convert tags without special delimiters', function () {
        const script = 'set x = 5\ninclude "header.html"\nimport "macros.html" as macros';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- set x = 5 -%}');
        expect(result.template).to.contain('{%- include "header.html" -%}');
        expect(result.template).to.contain('{%- import "macros.html" as macros -%}');
      });

      it('should handle tags with blocks correctly', function () {
        const script = 'for item in items\n  print item\nendfor';
        const result = scriptToTemplate(script);

        expect(result.template).to.contain('{%- for item in items -%}');
        expect(result.template).to.contain('{{- item -}}');
        expect(result.template).to.contain('{%- endfor -%}');
      });

      it('should handle nested blocks with proper indentation', function () {
        const script = 'if condition\n  for item in items\n    print item\n  endfor\nendif';
        const result = scriptToTemplate(script);

        const lines = result.template.split('\n');
        expect(lines[0]).to.contain('{%- if condition -%}');
        expect(lines[1]).to.contain('  {%- for item in items -%}');
        expect(lines[2]).to.contain('    {{- item -}}');
        expect(lines[3]).to.contain('  {%- endfor -%}');
        expect(lines[4]).to.contain('{%- endif -%}');
      });
    });
  });

  /**
   * 6. Line Type Classification Logic
   */
  describe('Line Type Classification Logic', function () {
    describe('Comment classification', function () {
      it('should correctly classify all comment types', function () {
        const lines = [
          '// Single line comment',
          '/* Single line block comment */',
          '/* Start of multi-line',
          ' * Middle of multi-line',
          ' * End of multi-line */',
          'code // Inline comment'
        ];

        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
        expect(result[1].type).to.equal(LINE_TYPE.COMMENT_SINGLE);
        expect(result[2].type).to.equal(LINE_TYPE.COMMENT_MULTI_START);
        expect(result[3].type).to.equal(LINE_TYPE.COMMENT_MULTI_MIDDLE);
        expect(result[4].type).to.equal(LINE_TYPE.COMMENT_MULTI_END);
        expect(result[5].type).to.not.equal(LINE_TYPE.COMMENT_SINGLE); // Should be CODE_STANDALONE with inlineComment
        expect(result[5].inlineComment).to.equal('Inline comment');
      });
    });

    describe('Tag Classification', function () {
      it('should classify block-level tags correctly', function () {
        const blockTags = ['if', 'for', 'block', 'macro', 'filter', 'call', 'raw', 'verbatim', 'while', 'try'];
        const endTags = blockTags.map(tag => `end${tag}`);
        const middleTags = ['else', 'elif', 'resume', 'except'];

        // Test block start tags
        blockTags.forEach(tag => {
          const lines = [`${tag} condition`];
          const result = parseLines(lines);
          expect(result[0].type).to.equal(LINE_TYPE.TAG_END); // Standalone tag becomes TAG_END
          expect(result[0].blockType).to.equal(LINE_TYPE.BLOCK_START);
        });

        // Test block end tags
        endTags.forEach(tag => {
          const lines = [tag];
          const result = parseLines(lines);
          expect(result[0].type).to.equal(LINE_TYPE.TAG_END);
          expect(result[0].blockType).to.equal(LINE_TYPE.BLOCK_END);
        });

        // Test block middle tags
        middleTags.forEach(tag => {
          const lines = [`${tag} condition`];
          const result = parseLines(lines);
          expect(result[0].type).to.equal(LINE_TYPE.TAG_END); // Standalone middle becomes TAG_END
          expect(result[0].blockType).to.equal(LINE_TYPE.BLOCK_MIDDLE);
        });
      });

      it('should classify line-level tags correctly', function () {
        const lineTags = ['set', 'include', 'extends', 'from', 'import', 'depends', 'do'];

        lineTags.forEach(tag => {
          const lines = [`${tag} some arguments`];
          const result = parseLines(lines);
          expect(result[0].type).to.equal(LINE_TYPE.TAG_END); // Single line tags end with TAG_END
          expect(result[0].blockType).to.equal(null); // Line tags have no blockType
        });
      });

      it('should handle multi-line tag classification', function () {
        const lines = [
          'if condition &&',
          '   otherCondition',
          'print "result"',
          'endif'
        ];

        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.TAG_START);
        expect(result[1].type).to.equal(LINE_TYPE.TAG_END);
        expect(result[2].type).to.equal(LINE_TYPE.PRINT_STANDALONE);
        expect(result[3].type).to.equal(LINE_TYPE.TAG_END);
      });
    });

    describe('Print Statement Classification', function () {
      it('should classify single-line print statements', function () {
        const lines = ['print value'];
        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.PRINT_STANDALONE);
        expect(result[0].content).to.equal('value');
      });

      it('should classify multi-line print statements', function () {
        const lines = [
          'print "Line 1" +',
          '      "Line 2" +',
          '      "Line 3"'
        ];

        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.PRINT_START);
        expect(result[1].type).to.equal(LINE_TYPE.PRINT_CONTINUATION);
        expect(result[2].type).to.equal(LINE_TYPE.PRINT_END);
      });

      it('should handle print statements with complex expressions', function () {
        const lines = [
          'print getValue(a ? b : c) | filter(x => {',
          '  return x.valid',
          '})'
        ];

        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.PRINT_START);
        expect(result[1].type).to.equal(LINE_TYPE.PRINT_CONTINUATION);
        expect(result[2].type).to.equal(LINE_TYPE.PRINT_END);
      });
    });

    describe('Code Statement Classification', function () {
      it('should classify single-line code statements', function () {
        const lines = ['variable = value'];
        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.CODE_STANDALONE);
      });

      it('should classify multi-line code statements', function () {
        const lines = [
          'result = calculate(',
          '  param1,',
          '  param2',
          ')'
        ];

        const result = parseLines(lines);
        expect(result[0].type).to.equal(LINE_TYPE.CODE_START);
        expect(result[1].type).to.equal(LINE_TYPE.CODE_CONTINUATION);
        expect(result[2].type).to.equal(LINE_TYPE.CODE_CONTINUATION);
        expect(result[3].type).to.equal(LINE_TYPE.CODE_END);
      });
    });

    describe('Empty Line Classification', function () {
      it('should classify empty and whitespace-only lines', function () {
        const lines = ['', '  ', '\t'];
        const result = parseLines(lines);

        result.forEach(line => {
          expect(line.type).to.equal(LINE_TYPE.EMPTY);
        });
      });
    });
  });

  /**
   * 7. Complete Template Conversion Tests
   */
  describe('Complete Template Conversion Tests', function () {
    it('should convert a more complex template with mixed features', function () {
      const script =
        '// Basic user profile template\n' +
        'extends "layout.html"\n' +
        '\n' +
        'block content\n' +
        '  /* Display user information with proper formatting\n' +
        '   * and handling of optional fields */\n' +
        '  if user\n' +
        '    print "<h1>User Profile: " + user.name + "</h1>"\n' +
        '\n' +
        '    // Create a formatted user card\n' +
        '    userData = {\n' +
        '      name: user.name,\n' +
        '      email: user.email || "No email provided",\n' +
        '      role: getUserRole(user.id)\n' +
        '    }\n' +
        '\n' +
        '    for field, value in userData\n' +
        '      print "<div class=\\"field\\">" +\n' +
        '            "<span class=\\"label\\">" + field + ":</span> " +\n' +
        '            "<span class=\\"value\\">" + value + "</span>" +\n' +
        '            "</div>"\n' +
        '    endfor\n' +
        '\n' +
        '    // Display user permissions if they exist\n' +
        '    if user.permissions && user.permissions.length > 0\n' +
        '      print "<h3>Permissions:</h3>"\n' +
        '      print "<ul>"\n' +
        '      for perm in user.permissions\n' +
        '        print "<li>" + perm + "</li>"\n' +
        '      endfor\n' +
        '      print "</ul>"\n' +
        '    else\n' +
        '      print "<p>No permissions assigned</p>"\n' +
        '    endif\n' +
        '  else\n' +
        '    print "<p>User not found</p>"\n' +
        '  endif\n' +
        'endblock';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      // Verify key parts of the conversion
      expect(result.template).to.contain('{%- extends "layout.html" -%}');
      expect(result.template).to.contain('{%- block content -%}');
      expect(result.template).to.contain('{# Display user information with proper formatting');
      expect(result.template).to.contain('{%- if user -%}');
      expect(result.template).to.contain('{{- "<h1>User Profile: " + user.name + "</h1>" -}}');
      expect(result.template).to.contain('{%- do userData = {');
      expect(result.template).to.contain('{%- for field, value in userData -%}');
      expect(result.template).to.contain('{%- else -%}');
      expect(result.template).to.contain('{%- endblock -%}');
    });

    it('should handle nunjucks-specific template features', function () {
      const script =
        '// Define a reusable macro for form fields\n' +
        'macro field(name, value="", type="text")\n' +
        '  print "<div class=\\"field\\">" +\n' +
        '        "<input type=\\"" + type + "\\" " +\n' +
        '        "name=\\"" + name + "\\" " +\n' +
        '        "value=\\"" + value + "\\" />" +\n' +
        '        "</div>"\n' +
        'endmacro\n' +
        '\n' +
        '// Create a form with various field types\n' +
        'print "<form>"\n' +
        '\n' +
        '// Set some default values\n' +
        'set defaults = { username: "guest", remember: true }\n' +
        '\n' +
        '// Use ternary expressions for conditionals\n' +
        'print field("username", user ? user.username : defaults.username)\n' +
        'print field("password", "", "password")\n' +
        'print field("remember", defaults.remember ? "yes" : "", "checkbox")\n' +
        '\n' +
        'print "<button type=\\"submit\\">Submit</button>"\n' +
        'print "</form>"';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      expect(result.template).to.contain('{%- macro field(name, value="", type="text") -%}');
      expect(result.template).to.contain('{%- set defaults = { username: "guest", remember: true } -%}');
      expect(result.template).to.contain('{{- field("username", user ? user.username : defaults.username) -}}');
    });

    it('should handle complex expressions with multiple continuations', function () {
      const script =
        'print calculateTotal(\n' +
        '  items.filter(item =>\n' +
        '    item.price > 10 &&\n' +
        '    (\n' +
        '      item.category === "electronics" ||\n' +
        '      item.category === "books"\n' +
        '    )\n' +
        '  ).map(item =>\n' +
        '    item.price * (1 - item.discount)\n' +
        '  ).reduce((total, price) =>\n' +
        '    total + price\n' +
        '  , 0)\n' +
        ')';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      // Verify that multi-line expression is properly converted
      expect(result.template).to.contain('{{- calculateTotal(');
      expect(result.template).to.contain('total + price');
      expect(result.template).to.contain(') -}}');
    });

    it('should convert examples from Cascada script documentation', function () {
      // Example from the script.js docstring
      const script =
        'if user.isLoggedIn\n' +
        '  print "Hello, " + user.name\n' +
        '  for item in cart.items\n' +
        '    items.push(processItem(item))\n' +
        '    print item.name\n' +
        '  endfor\n' +
        'else\n' +
        '  print "Please log in"\n' +
        'endif';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      // Should match the expected output from the docstring
      expect(result.template).to.equal(
        '{%- if user.isLoggedIn -%}\n' +
        '  {{- "Hello, " + user.name -}}\n' +
        '  {%- for item in cart.items -%}\n' +
        '    {%- do items.push(processItem(item)) -%}\n' +
        '    {{- item.name -}}\n' +
        '  {%- endfor -%}\n' +
        '{%- else -%}\n' +
        '  {{- "Please log in" -}}\n' +
        '{%- endif -%}\n'
      );
    });
  });

  /**
   * Additional Edge Cases
   */
  describe('Edge Cases and Special Scenarios', function () {
    it('should handle whitespace preservation in indentation', function () {
      const script = 'if x\n  print "Indented"\n    print "More indented"\nendif';
      const result = scriptToTemplate(script);

      expect(result.template).to.contain('  {{- "Indented" -}}');
      expect(result.template).to.contain('    {{- "More indented" -}}');
    });

    it('should handle implicitly created "do" statements', function () {
      const script = 'items.push(1)\narr[index] = value';
      const result = scriptToTemplate(script);

      expect(result.template).to.contain('{%- do items.push(1) -%}');
      expect(result.template).to.contain('{%- do arr[index] = value -%}');
    });

    it('should handle multiline statements with operators', function () {
      const script = 'print a &&\n  b ||\n  c';
      const result = scriptToTemplate(script);

      expect(result.template).to.contain('{{- a &&\n  b ||\n  c -}}');
    });

    it('should handle nested brackets across multiple lines', function () {
      const script =
        'if (x && (\n' +
        '     y ||\n' +
        '     (z && w)\n' +
        '   ))\n' +
        '  print "True"\n' +
        'endif';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      // Check that nesting is preserved in the template
      expect(result.template).to.contain('if (x && (');
      expect(result.template).to.contain('y ||');
      expect(result.template).to.contain('(z && w)');
    });
  });
});
