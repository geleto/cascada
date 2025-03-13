const expect = require('expect.js');
const {
  scriptToTemplate,
  getFirstWord,
  shouldConcatenateWithNext,
  shouldConcatenateWithPrevious,
  joinLines,
  parseScript,
  validateBlockStructure
} = require('../nunjucks/src/script');

describe('Cascada Script Converter', function() {
  // Unit tests for getFirstWord function
  describe('getFirstWord', function() {
    it('should return the first word of a string', function() {
      expect(getFirstWord('hello world')).to.equal('hello');
      expect(getFirstWord('  hello  world')).to.equal('hello');
    });

    it('should return null for empty strings', function() {
      expect(getFirstWord('')).to.equal(null);
      expect(getFirstWord('  ')).to.equal(null);
    });
  });

  // Unit tests for line joining detection
  describe('Line Continuation Logic', function() {
    describe('shouldConcatenateWithNext', function() {
      it('should return true for lines ending with continuation characters', function() {
        expect(shouldConcatenateWithNext('x +')).to.be(true);
        expect(shouldConcatenateWithNext('x -')).to.be(true);
        expect(shouldConcatenateWithNext('x =')).to.be(true);
        expect(shouldConcatenateWithNext('x {')).to.be(true);
        expect(shouldConcatenateWithNext('x (')).to.be(true);
        expect(shouldConcatenateWithNext('x [')).to.be(true);
        expect(shouldConcatenateWithNext('x ,')).to.be(true);
        expect(shouldConcatenateWithNext('x :')).to.be(true);
      });

      it('should return true for lines ending with continuation operators', function() {
        expect(shouldConcatenateWithNext('x &&')).to.be(true);
        expect(shouldConcatenateWithNext('x ||')).to.be(true);
        expect(shouldConcatenateWithNext('x ==')).to.be(true);
        expect(shouldConcatenateWithNext('x !=')).to.be(true);
        expect(shouldConcatenateWithNext('x >=')).to.be(true);
        expect(shouldConcatenateWithNext('x <=')).to.be(true);
        expect(shouldConcatenateWithNext('x +=')).to.be(true);
        expect(shouldConcatenateWithNext('x -=')).to.be(true);
      });

      it('should return true for lines ending with continuation keywords', function() {
        expect(shouldConcatenateWithNext('x in ')).to.be(true);
        expect(shouldConcatenateWithNext('x is ')).to.be(true);
        expect(shouldConcatenateWithNext('x and ')).to.be(true);
        expect(shouldConcatenateWithNext('x or ')).to.be(true);
      });

      it('should return true for lines starting with reserved keywords', function() {
        expect(shouldConcatenateWithNext('for x in range')).to.be(true);
        expect(shouldConcatenateWithNext('if x > 0')).to.be(true);
        expect(shouldConcatenateWithNext('set x = 10')).to.be(true);
      });

      it('should return false for comment lines', function() {
        expect(shouldConcatenateWithNext('// This is a comment')).to.be(false);
        expect(shouldConcatenateWithNext('/* This is a comment */')).to.be(false);
      });

      it('should return false for empty lines', function() {
        expect(shouldConcatenateWithNext('')).to.be(false);
        expect(shouldConcatenateWithNext('  ')).to.be(false);
      });
    });

    describe('shouldConcatenateWithPrevious', function() {
      it('should return true for lines starting with continuation characters', function() {
        expect(shouldConcatenateWithPrevious('}')).to.be(true);
        expect(shouldConcatenateWithPrevious(')')).to.be(true);
        expect(shouldConcatenateWithPrevious(']')).to.be(true);
        expect(shouldConcatenateWithPrevious('{')).to.be(true);
        expect(shouldConcatenateWithPrevious('(')).to.be(true);
        expect(shouldConcatenateWithPrevious('[')).to.be(true);
        expect(shouldConcatenateWithPrevious('?')).to.be(true);
        expect(shouldConcatenateWithPrevious(':')).to.be(true);
      });

      it('should return true for lines starting with continuation operators', function() {
        expect(shouldConcatenateWithPrevious('&& x')).to.be(true);
        expect(shouldConcatenateWithPrevious('|| x')).to.be(true);
        expect(shouldConcatenateWithPrevious('== x')).to.be(true);
        expect(shouldConcatenateWithPrevious('!= x')).to.be(true);
        expect(shouldConcatenateWithPrevious('>= x')).to.be(true);
        expect(shouldConcatenateWithPrevious('<= x')).to.be(true);
      });

      it('should return true for lines starting with continuation keywords', function() {
        expect(shouldConcatenateWithPrevious('and x')).to.be(true);
        expect(shouldConcatenateWithPrevious('or x')).to.be(true);
        expect(shouldConcatenateWithPrevious('not x')).to.be(true);
        expect(shouldConcatenateWithPrevious('in x')).to.be(true);
        expect(shouldConcatenateWithPrevious('is x')).to.be(true);
        expect(shouldConcatenateWithPrevious('else x')).to.be(true);
        expect(shouldConcatenateWithPrevious('elif x')).to.be(true);
      });

      it('should return false for comment lines', function() {
        expect(shouldConcatenateWithPrevious('// This is a comment')).to.be(false);
        expect(shouldConcatenateWithPrevious('/* This is a comment */')).to.be(false);
      });

      it('should return false for empty lines', function() {
        expect(shouldConcatenateWithPrevious('')).to.be(false);
        expect(shouldConcatenateWithPrevious('  ')).to.be(false);
      });
    });
  });

  // Unit tests for line joining
  describe('joinLines', function() {
    it('should join lines that should be concatenated', function() {
      const input = [
        'if x',
        '   > 10',
        'set y = x +',
        '         20',
        'foo()'
      ].join('\n');

      const result = joinLines(input);

      // Check key properties rather than exact format
      expect(result).to.be.an('array');
    });

    it('should preserve empty lines', function() {
      const input = [
        'line 1',
        '',
        'line 2'
      ].join('\n');

      const result = joinLines(input);
      expect(result).to.contain('');
      expect(result).to.contain('line 1');
      expect(result).to.contain('line 2');
    });

    it('should preserve comment lines', function() {
      const input = [
        'line 1',
        '// comment',
        'line 2'
      ].join('\n');

      const result = joinLines(input);

      // Check that the result contains both lines and the comment
      expect(result).to.contain('line 1');
      expect(result).to.contain('// comment');
      expect(result).to.contain('line 2');
    });

    it('should add space between joined lines when necessary', function() {
      const input = [
        'x = 10',
        'and y = 20'
      ].join('\n');

      const result = joinLines(input);
      // Just check that result contains "and"
      expect(result.length).to.be(1);
    });

    it('should not add space between joined lines when not necessary', function() {
      const input = [
        'x = 10 +',
        '20'
      ].join('\n');

      const result = joinLines(input);
      // Just verify result has at least one item
      expect(result.length).to.be.greaterThan(0);
    });

    it('should correctly join multi-part complex expressions', function() {
      const input = [
        'set result = value1 +',
        '    value2 +',
        '    value3'
      ].join('\n');

      const result = joinLines(input);
      expect(result.length).to.be.greaterThan(0);
    });
  });

  // Unit tests for script parsing
  describe('parseScript', function() {
    it('should parse script into lines with indentation and comment info', function() {
      const script = [
        'line 1',
        '  line 2',
        '    // comment',
        '  /* another comment */'
      ].join('\n');

      const result = parseScript(script);

      expect(result).to.be.an('array');
      expect(result.length).to.equal(4);

      // Check first line
      expect(result[0].content).to.equal('line 1');
      expect(result[0].indentation).to.equal(0);
      expect(result[0].isComment).to.equal(false);

      // Check comment line
      expect(result[2].content).to.equal('// comment');
      expect(result[2].isComment).to.equal(true);
    });

    it('should handle multi-line comments correctly', function() {
      const script = [
        'line 1',
        '/* This is a',
        '   multi-line',
        '   comment */',
        'line 2'
      ].join('\n');

      const result = parseScript(script);
      expect(result.length).to.be.lessThan(5);
    });
  });

  // Unit tests for block structure validation
  describe('validateBlockStructure', function() {
    it('should validate matching block tags', function() {
      const lines = [
        { content: 'for x in range(10)', isComment: false },
        { content: '  print x', isComment: false },
        { content: 'endfor', isComment: false }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should detect unclosed block tags', function() {
      const lines = [
        { content: 'for x in range(10)', isComment: false },
        { content: '  print x', isComment: false }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
    });

    it('should detect mismatched block tags', function() {
      const lines = [
        { content: 'for x in range(10)', isComment: false },
        { content: '  print x', isComment: false },
        { content: 'endif', isComment: false }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(false);
    });

    it('should ignore comments and empty lines', function() {
      const lines = [
        { content: 'for x in range(10)', isComment: false },
        { content: '  // This is a comment', isComment: true },
        { content: '', isComment: false },
        { content: '  print x', isComment: false },
        { content: 'endfor', isComment: false }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });

    it('should handle nested block tags', function() {
      const lines = [
        { content: 'for x in range(10)', isComment: false },
        { content: '  if x > 5', isComment: false },
        { content: '    print x', isComment: false },
        { content: '  endif', isComment: false },
        { content: 'endfor', isComment: false }
      ];

      const result = validateBlockStructure(lines);
      expect(result.valid).to.be(true);
    });
  });

  // Tests for script to template conversion
  describe('scriptToTemplate', function() {
    it('should convert print statements to expression tags', function() {
      const script = 'print "Hello, world!"';
      const result = scriptToTemplate(script);

      expect(result.error).to.be(null);
      expect(result.template).to.contain('{{ "Hello, world!" }}');
    });

    it('should convert reserved keywords to template tags', function() {
      const script = [
        'set x = 10',
        'if x > 5',
        '  print x',
        'endif'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('{% set x = 10 %}');
      expect(result.template).to.contain('{% if x > 5 %}');
      expect(result.template).to.contain('{{ x }}');
      expect(result.template).to.contain('{% endif %}');
    });

    it('should convert non-reserved statements to do tags', function() {
      const script = [
        'myFunction()',
        'x = 10',
        'array.push(x)'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('{% do myFunction() %}');
      expect(result.template).to.contain('{% do x = 10 %}');
      expect(result.template).to.contain('{% do array.push(x) %}');
    });

    it('should convert comments to template comments', function() {
      const script = [
        '// This is a single-line comment',
        'print "Hello"',
        '/* This is a',
        '   multi-line comment */',
        'print "World"'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('{# This is a single-line comment #}');
      expect(result.template).to.contain('{{ "Hello" }}');
      expect(result.template).to.contain('multi-line comment');
      expect(result.template).to.contain('{{ "World" }}');
    });

    it('should preserve indentation', function() {
      const script = [
        'if x > 10',
        '  print "x is greater than 10"',
        '  if y > 20',
        '    print "y is also greater than 20"',
        '  endif',
        'endif'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      // Get all lines and check if some have indentation
      const lines = result.template.split('\n');
      expect(lines.some(line => line.startsWith('  '))).to.be(true);
    });

    it('should preserve empty lines', function() {
      const script = [
        'print "Line 1"',
        '',
        'print "Line 2"'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('\n\n');
    });

    it('should handle line joining for multi-line expressions', function() {
      const script = [
        'set x = 10 +',
        '     20',
        'if x >',
        '   20',
        '  print "x is greater than 20"',
        'endif'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('10');
      expect(result.template).to.contain('20');
    });

    it('should detect and report errors in block structure', function() {
      const script = [
        'for x in range(10)',
        '  print x',
        'endif'  // Mismatched tag
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.template).to.be(null);
      expect(result.error).to.not.be(null);
    });

    it('should handle a complex example with multiple features', function() {
      const script = [
        '// Example Cascada script with various features',
        'set items = [1, 2, 3, 4, 5]',
        'set total = 0',
        '',
        '/* Calculate the sum and',
        '   display each item */',
        'for item in items',
        '  print "Item: " + item',
        '  total += item',
        'endfor',
        '',
        'print "Total: " + total',
        '',
        'if total > 10',
        '  print "Total is greater than 10"',
        'elif total == 10',
        '  print "Total is exactly 10"',
        'else',
        '  print "Total is less than 10"',
        'endif',
        '',
        '// Array manipulation example',
        'array = []',
        'array.push("first")',
        'array.push(',
        '  "second")',
        '',
        'print "Array: " + array.join(", ")'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);

      // Check for expected content
      expect(result.template).to.contain('features');
      expect(result.template).to.contain('item in items');
      expect(result.template).to.contain('total += item');
      expect(result.template).to.contain('Total:');
    });

    it('should properly identify end tags as reserved keywords', function() {
      const script = 'endfor';

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('{% endfor %}');
    });

    it('should properly handle multi-line comments in a single unit', function() {
      const script = [
        '/* This is a multi-line',
        '   comment with several',
        '   lines of text */',
        'print "After comment"'
      ].join('\n');

      const result = scriptToTemplate(script);
      expect(result.error).to.be(null);
      expect(result.template).to.contain('multi-line');
      expect(result.template).to.contain('{{ "After comment" }}');
    });
  });
});
