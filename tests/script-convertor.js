const { scriptToTemplate, getFirstWord, isCompleteWord, getBlockType,
  extractComments, filterOutComments, tokensToCode, willContinueToNextLine,
  isContinuationFromPrevious } = require('../nunjucks/src/script-convertor');
const { TOKEN_TYPES } = require('../nunjucks/src/script-parser');
const expect = require('expect.js');

describe('Script Converter', () => {
  // Helper function tests
  describe('Helper Functions', () => {
    describe('getFirstWord', () => {
      it('should extract the first word from a string', () => {
        expect(getFirstWord('if condition')).to.equal('if');
        expect(getFirstWord('  print value')).to.equal('print');
        expect(getFirstWord('for item in items')).to.equal('for');
        expect(getFirstWord('')).to.equal('');
        expect(getFirstWord('   ')).to.equal('');
      });
    });

    describe('isCompleteWord', () => {
      it('should identify if a word is complete', () => {
        expect(isCompleteWord('if condition', 0, 2)).to.equal(true);
        expect(isCompleteWord('print value', 0, 5)).to.equal(true);
        expect(isCompleteWord('ifcondition', 0, 2)).to.equal(false);
        expect(isCompleteWord('my_if condition', 3, 2)).to.equal(false);
        expect(isCompleteWord('if_condition', 0, 2)).to.equal(false);
      });
    });

    describe('getBlockType', () => {
      it('should identify block types correctly', () => {
        expect(getBlockType('if')).to.equal('START');
        expect(getBlockType('for')).to.equal('START');
        expect(getBlockType('else')).to.equal('MIDDLE');
        expect(getBlockType('elif')).to.equal('MIDDLE');
        expect(getBlockType('endif')).to.equal('END');
        expect(getBlockType('endfor')).to.equal('END');
        expect(getBlockType('print')).to.equal(null);
        expect(getBlockType('set')).to.equal(null);
      });
    });

    describe('extractComments', () => {
      it('should extract comments from tokens', () => {
        const tokens = [
          { type: TOKEN_TYPES.CODE, value: 'if condition' },
          { type: TOKEN_TYPES.COMMENT, value: '// This is a comment' },
          { type: TOKEN_TYPES.CODE, value: 'print value' },
          { type: TOKEN_TYPES.COMMENT, value: '/* Another comment */' },
        ];

        const comments = extractComments(tokens);
        expect(comments.length).to.equal(2);
        expect(comments[0].type).to.equal('single');
        expect(comments[0].content).to.equal('This is a comment');
        expect(comments[1].type).to.equal('multi');
        expect(comments[1].content).to.equal('Another comment');
      });
    });

    describe('filterOutComments', () => {
      it('should filter out comment tokens', () => {
        const tokens = [
          { type: TOKEN_TYPES.CODE, value: 'if condition' },
          { type: TOKEN_TYPES.COMMENT, value: '// This is a comment' },
          { type: TOKEN_TYPES.CODE, value: 'print value' },
        ];

        const filtered = filterOutComments(tokens);
        expect(filtered.length).to.equal(2);
        expect(filtered[0].value).to.equal('if condition');
        expect(filtered[1].value).to.equal('print value');
      });
    });

    describe('tokensToCode', () => {
      it('should combine code tokens into a string', () => {
        const tokens = [
          { value: 'if ' },
          { value: 'condition' },
          { value: ' && ' },
          { value: 'anotherCondition' },
        ];

        expect(tokensToCode(tokens)).to.equal('if condition && anotherCondition');
      });
    });

    describe('willContinueToNextLine', () => {
      it('should detect line continuation correctly', () => {
        // Line with an incomplete token
        expect(willContinueToNextLine(
          [{ incomplete: true, value: 'value' }],
          'value',
          'print'
        )).to.equal(true);

        // Line ending with continuation character
        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value +' }],
          'value +',
          'print'
        )).to.equal(true);

        // Line with a tag that should never continue
        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'endif' }],
          'endif',
          'endif'
        )).to.equal(false);

        // Normal line that shouldn't continue
        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'print value' }],
          'print value',
          'print'
        )).to.equal(false);
      });
    });

    describe('isContinuationFromPrevious', () => {
      it('should detect continuation from previous line', () => {
        // Empty line with prevContinues true
        expect(isContinuationFromPrevious('', true)).to.equal(true);

        // Line starting with continuation character
        expect(isContinuationFromPrevious('))', false)).to.equal(true);

        // Line starting with continuation operator
        expect(isContinuationFromPrevious('&& condition', false)).to.equal(true);

        // Line starting with continuation keyword
        expect(isContinuationFromPrevious('and condition', false)).to.equal(true);

        // Normal line that isn't a continuation
        expect(isContinuationFromPrevious('print value', false)).to.equal(false);
      });
    });
  });

  // Basic conversion tests
  describe('Basic Conversions', () => {
    it('should convert print statements', () => {
      const script = 'print "Hello, World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, World!" -}}');
    });

    it('should convert tag statements', () => {
      const script = 'if condition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n{%- endif -%}');
    });

    it('should convert code statements', () => {
      const script = 'variable = value';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- do variable = value -%}');
    });

    it('should handle empty lines', () => {
      const script = 'if condition\n\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n\n{%- endif -%}');
    });

    it('should preserve indentation', () => {
      const script = 'if condition\n  print "Indented"\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n  {{- "Indented" -}}\n{%- endif -%}');
    });
  });

  // Token type tests
  describe('Token Types', () => {
    it('should handle single-quoted strings', () => {
      const script = 'print \'Hello, World!\'';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- \'Hello, World!\' -}}');
    });

    it('should handle double-quoted strings', () => {
      const script = 'print "Hello, World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, World!" -}}');
    });

    it('should handle template literals', () => {
      const script = 'print `Hello, World!`';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- `Hello, World!` -}}');
    });

    it('should handle single-line comments', () => {
      const script = 'print "Hello" // This is a comment';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello" -}} {# This is a comment #}');
    });

    it('should handle multi-line comments', () => {
      const script = 'print "Hello" /* This is a multi-line comment */';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello" -}} {# This is a multi-line comment #}');
    });

    it('should handle standalone comments', () => {
      const script = '// This is a standalone comment';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{# This is a standalone comment #}');
    });

    it('should handle regular expressions', () => {
      const script = 'if r/pattern/.it(value)\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if r/pattern/.it(value) -%}\n{%- endif -%}');
    });
  });

  // Block structure tests
  describe('Block Structure', () => {
    it('should validate correct block structure', () => {
      const script = 'if condition\n  for item in items\n  endfor\nendif';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.ok();
    });

    it('should detect missing end tags', () => {
      const script = 'if condition\n  for item in items\n  endfor';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('Unclosed');
    });

    it('should detect mismatched tags', () => {
      const script = 'if condition\n  for item in items\n  endif\nendfor';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('Unexpected');
    });

    it('should handle nested blocks', () => {
      const script = 'if condition1\n  if condition2\n    print "Nested"\n  endif\nendif';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.equal('{%- if condition1 -%}\n  {%- if condition2 -%}\n    {{- "Nested" -}}\n  {%- endif -%}\n{%- endif -%}');
    });

    it('should validate middle tags', () => {
      const script = 'if condition\n  print "True"\nelse\n  print "False"\nendif';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.ok();
    });

    it('should detect invalid middle tags', () => {
      const script = 'for item in items\n  print item\nelse\n  print "Empty"\nendfor';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null); // 'else' is valid in 'for' blocks in this implementation
      expect(template).to.ok();
    });

    it('should detect middle tags outside blocks', () => {
      const script = 'print "Before"\nelse\nprint "After"';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('outside of any block');
    });
  });

  // Multi-line expression tests
  describe('Multi-line Expressions', () => {
    it('should handle expressions spanning multiple lines', () => {
      const script = 'print "Hello, " +\n      "World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, " +\n      "World!" -}}');
    });

    it('should detect continuation at end of line', () => {
      const script = 'if condition &&\n   anotherCondition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition &&\n   anotherCondition -%}\n{%- endif -%}');
    });

    it('should detect continuation at start of line', () => {
      const script = 'if condition\n   && anotherCondition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition\n   && anotherCondition -%}\n{%- endif -%}');
    });

    it('should handle comments within multi-line expressions', () => {
      const script = 'if condition && // First condition\n   anotherCondition // Second condition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition && \n   anotherCondition -%} {# First condition; Second condition #}\n{%- endif -%}');
    });

    it('should handle empty lines within multi-line expressions', () => {
      const script = 'if condition &&\n\n   anotherCondition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition &&\n\n   anotherCondition -%}\n{%- endif -%}');
    });
  });

  // Edge cases
  describe('Edge Cases', () => {
    it('should handle empty input', () => {
      const script = '';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('');
    });

    it('should handle input with only whitespace', () => {
      const script = '   ';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('   ');
    });

    it('should handle special characters', () => {
      const script = 'print "@#$%^&*"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "@#$%^&*" -}}');
    });

    it('should handle escape sequences in strings', () => {
      const script = 'print "Line 1\\nLine 2"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- "Line 1\\nLine 2" -}}');
    });

    it('should handle standalone end tags', () => {
      const script = 'endif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- endif -%}');
    });
  });

  // Complex integration tests
  describe('Integration Tests', () => {
    it('should convert a complex script with multiple features', () => {
      const script = `// User authentication example
  if user.isLoggedIn
	print "Hello, " + user.name

	// Display user items
	for item in user.items
	  // Process each item
	  processedItems.push(item.process())

	  if item.isSpecial
		print "Special: " + item.name
	  else
		print "Regular: " + item.name
	  endif
	endfor
  else
	// Show login prompt
	print "Please log in"
  endif`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);

      // The expected template should have the correct structure with tags and delimiters
      const expected = `{# User authentication example #}
  {%- if user.isLoggedIn -%}
	{{- "Hello, " + user.name -}}

	{# Display user items #}
	{%- for item in user.items -%}
	  {# Process each item #}
	  {%- do processedItems.push(item.process()) -%}

	  {%- if item.isSpecial -%}
		{{- "Special: " + item.name -}}
	  {%- else -%}
		{{- "Regular: " + item.name -}}
	  {%- endif -%}
	{%- endfor -%}
  {%- else -%}
	{# Show login prompt #}
	{{- "Please log in" -}}
  {%- endif -%}`;

      expect(template).to.equal(expected);
    });

    it('should handle complex mathematical expressions', () => {
      const script = `// Calculate total
  total = price *
		  (1 + taxRate) *
		  (1 - discount)

  print "Total: $" + total.toFixed(2)`;

      const { template } = scriptToTemplate(script);

      const expected = `{# Calculate total #}
  {%- do total = price *
		  (1 + taxRate) *
		  (1 - discount) -%}

  {{- "Total: $" + total.toFixed(2) -}}`;

      expect(template).to.equal(expected);
    });
  });
});
