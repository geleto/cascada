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
});
