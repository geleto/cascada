const { scriptToTemplate, getFirstWord, isCompleteWord, getBlockType,
  extractComments, filterOutComments, tokensToCode, willContinueToNextLine,
  continuesFromPrevious, generateOutput, processedLine: processLine, validateBlockStructure } = require('../nunjucks/src/script-convertor');
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

      it('should handle identifiers with $ sign', () => {
        expect(isCompleteWord('$var condition', 0, 4)).to.equal(true);
        expect(isCompleteWord('set $item = value', 4, 5)).to.equal(true);
        expect(isCompleteWord('my$var', 0, 2)).to.equal(false);
      });
    });

    describe('getBlockType', () => {
      it('should identify block types correctly', () => {
        expect(getBlockType('if')).to.equal('START');
        expect(getBlockType('for')).to.equal('START');
        expect(getBlockType('block')).to.equal('START');
        expect(getBlockType('macro')).to.equal('START');
        expect(getBlockType('else')).to.equal('MIDDLE');
        expect(getBlockType('elif')).to.equal('MIDDLE');
        expect(getBlockType('resume')).to.equal('MIDDLE');
        expect(getBlockType('except')).to.equal('MIDDLE');
        expect(getBlockType('endif')).to.equal('END');
        expect(getBlockType('endfor')).to.equal('END');
        expect(getBlockType('endblock')).to.equal('END');
        expect(getBlockType('endmacro')).to.equal('END');
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

      it('should handle comment content with extra whitespace', () => {
        const tokens = [
          { type: TOKEN_TYPES.COMMENT, value: '//   Indented comment  ' },
          { type: TOKEN_TYPES.COMMENT, value: '/*  Multi-line\n   comment  */' },
        ];

        const comments = extractComments(tokens);
        expect(comments[0].content).to.equal('Indented comment');
        expect(comments[1].content).to.equal('Multi-line\n   comment');
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

      it('should preserve whitespace in tokens', () => {
        const tokens = [
          { value: '  if  ' },
          { value: 'condition' },
          { value: '  ' },
        ];

        expect(tokensToCode(tokens)).to.equal('  if  condition  ');
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

      it('should identify continuation with operators at end of line', () => {
        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value &&' }],
          'value &&',
          'if'
        )).to.equal(true);

        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value ||' }],
          'value ||',
          'if'
        )).to.equal(true);

        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value ==' }],
          'value ==',
          'if'
        )).to.equal(true);
      });

      it('should identify continuation with keywords at end of line', () => {
        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value in ' }],
          'value in ',
          'if'
        )).to.equal(true);

        expect(willContinueToNextLine(
          [{ incomplete: false, value: 'value is ' }],
          'value is ',
          'if'
        )).to.equal(true);
      });
    });

    describe('continuesFromPrevious', () => {
      it('should detect continuation from previous line', () => {
        // Line starting with continuation character
        expect(continuesFromPrevious('))', true)).to.equal(true);

        // Line starting with continuation operator
        expect(continuesFromPrevious('&& condition', true)).to.equal(true);

        // Line starting with continuation keyword
        expect(continuesFromPrevious('and condition', true)).to.equal(true);

        // Normal line that isn't a continuation
        expect(continuesFromPrevious('print value', true)).to.equal(false);
      });

      it('should not identify reserved keywords as continuations', () => {
        expect(continuesFromPrevious('if condition', true)).to.equal(false);
        expect(continuesFromPrevious('for item in items', true)).to.equal(false);
        expect(continuesFromPrevious('print value', true)).to.equal(false);
      });
    });

    describe('processLine', () => {
      it('should correctly process a print statement', () => {
        const line = 'print "Hello"';
        const state = { inMultiLineComment: false, stringState: null };

        const result = processLine(line, state);

        expect(result.lineType).to.equal('PRINT');
        expect(result.codeContent).to.equal('print "Hello"');
        expect(result.continuesToNext).to.equal(false);
        expect(result.blockType).to.equal(null);
      });

      it('should correctly process a tag statement', () => {
        const line = 'if condition';
        const state = { inMultiLineComment: false, stringState: null };

        const result = processLine(line, state);

        expect(result.lineType).to.equal('TAG');
        expect(result.tagName).to.equal('if');
        expect(result.blockType).to.equal('START');
      });

      it('should correctly process code with comments', () => {
        const line = 'items.push(1) // Add item';
        const state = { inMultiLineComment: false, stringState: null };

        const result = processLine(line, state);

        expect(result.lineType).to.equal('CODE');
        expect(result.comments.length).to.equal(1);
        expect(result.comments[0]).to.equal('Add item');
      });

      it('should detect comment-only lines', () => {
        const line = '// Just a comment';
        const state = { inMultiLineComment: false, stringState: null };

        const result = processLine(line, state);

        expect(result.isCommentOnly).to.equal(true);
        expect(result.comments.length).to.equal(1);
      });

      it('should detect empty lines', () => {
        const line = '   ';
        const state = { inMultiLineComment: false, stringState: null };

        const result = processLine(line, state);

        expect(result.isEmpty).to.equal(true);
      });
    });

    describe('generateOutput', () => {
      it('should generate output for a print statement', () => {
        const processedLine = {
          indentation: '',
          lineType: 'PRINT',
          codeContent: 'print "Hello"',
          comments: [],
          isContinuation: false
        };

        const output = generateOutput(processedLine, false, 'PRINT');

        expect(output).to.equal('{{- print "Hello" -}}');
      });

      it('should generate output for a tag statement', () => {
        const processedLine = {
          indentation: '  ',
          lineType: 'TAG',
          codeContent: 'if condition',
          comments: [],
          isContinuation: false
        };

        const output = generateOutput(processedLine, false, 'TAG');

        expect(output).to.equal('  {%- if condition -%}');
      });

      it('should generate output with comments', () => {
        const processedLine = {
          indentation: '',
          lineType: 'CODE',
          codeContent: 'items.push(1)',
          comments: ['Add item'],
          isContinuation: false
        };

        const output = generateOutput(processedLine, false, 'CODE');

        expect(output).to.equal('{%- do items.push(1) -%}{#- Add item -#}');
      });

      it('should handle continuation lines', () => {
        const processedLine = {
          indentation: '  ',
          lineType: 'TAG',
          codeContent: '&& anotherCondition',
          comments: [],
          isContinuation: true
        };

        const output = generateOutput(processedLine, true, 'TAG');

        expect(output).to.equal('  && anotherCondition');
      });
    });

    describe('validateBlockStructure', () => {
      it('should validate correct block structure', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'if condition', isContinuation: false },
          { blockType: 'END', codeContent: 'endif', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(true);
        expect(result.error).to.equal(undefined);
      });

      it('should detect unclosed blocks', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'if condition', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(false);
        expect(result.error).to.contain('Unclosed');
      });

      it('should detect mismatched tags', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'if condition', isContinuation: false },
          { blockType: 'END', codeContent: 'endfor', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(false);
        expect(result.error).to.contain('Unexpected');
      });

      it('should validate correct middle tags', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'if condition', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'else', isContinuation: false },
          { blockType: 'END', codeContent: 'endif', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(true);
      });

      it('should detect invalid middle tags', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'for item in items', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'elif', isContinuation: false },
          { blockType: 'END', codeContent: 'endfor', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(false);
        expect(result.error).to.contain('not valid in');
      });

      it('should detect middle tags outside blocks', () => {
        const processedLines = [
          { blockType: 'MIDDLE', codeContent: 'else', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);

        expect(result.valid).to.equal(false);
        expect(result.error).to.contain('outside of any block');
      });

      it('should validate complex nested structures', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'if outer', isContinuation: false },
          { blockType: 'START', codeContent: 'for item in items', isContinuation: false },
          { blockType: 'START', codeContent: 'if inner', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'else', isContinuation: false },
          { blockType: 'END', codeContent: 'endif', isContinuation: false },
          { blockType: 'END', codeContent: 'endfor', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'else', isContinuation: false },
          { blockType: 'END', codeContent: 'endif', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);
        expect(result.valid).to.equal(true);
      });

      it('should detect invalid resume outside try block', () => {
        const processedLines = [
          { blockType: 'MIDDLE', codeContent: 'resume', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);
        expect(result.valid).to.equal(false);
        expect(result.error).to.contain('outside of any block');
      });

      it('should validate try/resume/except structure', () => {
        const processedLines = [
          { blockType: 'START', codeContent: 'try', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'resume', isContinuation: false },
          { blockType: 'MIDDLE', codeContent: 'except', isContinuation: false },
          { blockType: 'END', codeContent: 'endtry', isContinuation: false }
        ];

        const result = validateBlockStructure(processedLines);
        expect(result.valid).to.equal(true);
      });
    });
  });

  // Basic conversion tests
  describe('Basic Conversions', () => {
    it('should convert print statements', () => {
      const script = 'print "Hello, World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Hello, World!" -}}');
    });

    it('should convert tag statements', () => {
      const script = 'if condition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n{%- endif -%}');
    });

    it('should convert code statements to do tags', () => {
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
      expect(template).to.equal('{%- if condition -%}\n  {{- print "Indented" -}}\n{%- endif -%}');
    });

    it('should properly convert set statements', () => {
      const script = 'set x = 1';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- set x = 1 -%}');
    });

    it('should properly convert include statements', () => {
      const script = 'include "partial.html"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- include "partial.html" -%}');
    });

    it('should convert depends statements', () => {
      const script = 'depends var1, var2';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- depends var1, var2 -%}');
    });

    it('should convert while loops', () => {
      const script = 'while condition\n  print "Looping"\nendwhile';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- while condition -%}\n  {{- print "Looping" -}}\n{%- endwhile -%}');
    });
  });

  // Token type tests
  describe('Token Types', () => {
    it('should handle single-quoted strings', () => {
      const script = 'print \'Hello, World!\'';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print \'Hello, World!\' -}}');
    });

    it('should handle double-quoted strings', () => {
      const script = 'print "Hello, World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Hello, World!" -}}');
    });

    it('should handle template literals', () => {
      const script = 'print `Hello, World!`';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print `Hello, World!` -}}');
    });

    it('should handle single-line comments', () => {
      const script = 'print "Hello"// This is a comment';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Hello" -}}{#- This is a comment -#}');
    });

    it('should handle multi-line comments', () => {
      const script = 'print "Hello"/* This is a multi-line comment */';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Hello" -}}{#- This is a multi-line comment -#}');
    });

    it('should handle standalone comments', () => {
      const script = '// This is a standalone comment';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{#- This is a standalone comment -#}');
    });

    it('should handle regular expressions', () => {
      const script = 'if r/pattern/.test(value)\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if r/pattern/.test(value) -%}\n{%- endif -%}');
    });
  });

  // Block structure tests
  describe('Block Structure', () => {
    it('should validate correct block structure', () => {
      const script = 'if condition\n  for item in items\n  endfor\nendif';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.be.ok();
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
      expect(template).to.equal('{%- if condition1 -%}\n  {%- if condition2 -%}\n    {{- print "Nested" -}}\n  {%- endif -%}\n{%- endif -%}');
    });

    it('should validate middle tags', () => {
      const script = 'if condition\n  print "True"\nelse\n  print "False"\nendif';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.be.ok();
    });

    it('should detect invalid middle tags', () => {
      const script = 'for item in items\n  print item\nelif\n  print "Empty"\nendfor';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('not valid in');
    });

    it('should detect middle tags outside blocks', () => {
      const script = 'print "Before"\nelse\nprint "After"';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('outside of any block');
    });

    it('should handle try/resume/except blocks', () => {
      const script = 'try\n  print "Try block"\nresume\n  print "Resume block"\nexcept\n  print "Except block"\nendtry';
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.be.ok();
    });

    it('should validate complex nested block structures', () => {
      const script = `if outerCondition
  for item in items
    if innerCondition
      print "Inner if"
    else
      print "Inner else"
    endif
  endfor
else
  print "Outer else"
endif`;
      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.be.ok();
    });

    it('should detect invalid resume outside try block', () => {
      const script = 'print "Before"\nresume\nprint "After"';
      const { error } = scriptToTemplate(script);
      expect(error).to.contain('outside of any block');
    });
  });

  // Multi-line expression tests
  describe('Multi-line Expressions', () => {
    it('should handle expressions spanning multiple lines', () => {
      const script = 'print "Hello, " +\n      "World!"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Hello, " +\n      "World!" -}}');
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
      const script = 'if condition && // First condition\n   anotherCondition// Second condition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition && \n   anotherCondition -%}{#- First condition; Second condition -#}\n{%- endif -%}');
    });

    it('should handle empty lines within multi-line expressions', () => {
      const script = 'if condition &&\n\n   anotherCondition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition &&\n\n   anotherCondition -%}\n{%- endif -%}');
    });

    it('should handle comment between condition and continuation', () => {
      const script = `if condition
// Comment
&& anotherCondition
endif`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.contain('if condition');
      expect(template).to.contain('&& anotherCondition');
      expect(template).to.contain('{#');
      expect(template).to.contain('Comment');
    });

    it('should handle multiple comments in a multi-line expression', () => {
      const script = `if condition && // First part
  // Another comment
  secondCondition && // Second part
  // Final comment
  finalCondition
endif`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      // Check that all comments are collected
      expect(template).to.contain('First part');
      expect(template).to.contain('Another comment');
      expect(template).to.contain('Second part');
      expect(template).to.contain('Final comment');
    });

    it('should handle complex nested operations in multi-line expressions', () => {
      const script = `set result = calculate(
  first +
  second * (
    third /
    fourth
  )
)`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);
      expect(template).to.contain('set result = calculate(');
      expect(template).to.contain('first +');
      expect(template).to.contain('second * (');
      expect(template).to.contain('third /');
      expect(template).to.contain('fourth');
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
      expect(template).to.equal('{{- print "@#$%^&*" -}}');
    });

    it('should handle escape sequences in strings', () => {
      const script = 'print "Line 1\\nLine 2"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Line 1\\nLine 2" -}}');
    });

    it('should handle multi-line string literals', () => {
      const script = 'print "Line 1\\\nLine 2"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "Line 1\\\nLine 2" -}}');
    });

    it('should handle strings with embedded quotes', () => {
      const script = 'print "He said \\"Hello\\""';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "He said \\"Hello\\"" -}}');
    });

    it('should handle strings with multiple line continuations', () => {
      const script = 'print "First line \\\nSecond line \\\nThird line"';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{{- print "First line \\\nSecond line \\\nThird line" -}}');
    });

    it('should handle empty blocks', () => {
      const script = 'if condition\nendif';
      const { template } = scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n{%- endif -%}');
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
      expect(template).to.contain('{#- User authentication example -#}');
      expect(template).to.contain('{%- if user.isLoggedIn -%}');
      expect(template).to.contain('{{- print "Hello, " + user.name -}}');
      expect(template).to.contain('{%- do processedItems.push(item.process()) -%}');
      expect(template).to.contain('{%- else -%}');
      expect(template).to.contain('{{- print "Please log in" -}}');
      expect(template).to.contain('{%- endif -%}');
    });

    it('should handle complex mathematical expressions', () => {
      const script = `// Calculate total
total = price *
      (1 + taxRate) *
      (1 - discount)

print "Total: $" + total.toFixed(2)`;

      const { template } = scriptToTemplate(script);
      expect(template).to.contain('{%- do total = price *');
      expect(template).to.contain('(1 + taxRate) *');
      expect(template).to.contain('(1 - discount) -%}');
      expect(template).to.contain('{{- print "Total: $" + total.toFixed(2) -}}');
    });

    it('should handle complex block structure with mixed tags', () => {
      const script = `// Main template
for product in products
  if product.inStock
    // Format price with currency
    set formattedPrice = formatCurrency(product.price)

    print "<div class='product'>"
    print "  <h2>" + product.name + "</h2>"
    print "  <p>Price: " + formattedPrice + "</p>"

    // Check for discount
    if product.hasDiscount
      print "  <p class='discount'>On sale!</p>"
    endif

    print "</div>"
  else
    // Out of stock message
    print "<div class='product out-of-stock'>"
    print "  <h2>" + product.name + "</h2>"
    print "  <p>Currently unavailable</p>"
    print "</div>"
  endif
endfor`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);

      // Check for properly converted tags and nested structure
      expect(template).to.contain('{%- for product in products -%}');
      expect(template).to.contain('{%- if product.inStock -%}');
      expect(template).to.contain('{%- set formattedPrice = formatCurrency(product.price) -%}');
      expect(template).to.contain('{{- print "<div class=\'product\'>" -}}');
      expect(template).to.contain('{%- if product.hasDiscount -%}');
      expect(template).to.contain('{%- else -%}');
      expect(template).to.contain('{%- endif -%}');
      expect(template).to.contain('{%- endfor -%}');

      // Check for comments preservation
      expect(template).to.contain('{#- Main template -#}');
      expect(template).to.contain('{#- Format price with currency -#}');
      expect(template).to.contain('{#- Check for discount -#}');
      expect(template).to.contain('{#- Out of stock message -#}');
    });

    it('should convert try/resume/except blocks with error handling', () => {
      const script = `// Error handling example
try
  // Attempt operation
  set data = fetchData(userId)
  print "User data: " + data.name
resume askUser('Retry operation?')
  // Set warning message
  set warningMessage = 'Resuming operation (attempt ' + resume.count + ')'
  print warningMessage
except
  // Handle error
  print "Failed to fetch user data: " + error.message
  throwError('Operation failed permanently')
endtry`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);

      expect(template).to.contain('{%- try -%}');
      expect(template).to.contain('{%- set data = fetchData(userId) -%}');
      expect(template).to.contain('{{- print "User data: " + data.name -}}');
      expect(template).to.contain('{%- resume askUser(\'Retry operation?\') -%}');
      expect(template).to.contain('{%- set warningMessage = \'Resuming operation (attempt \' + resume.count + \')\' -%}');
      expect(template).to.contain('{%- except -%}');
      expect(template).to.contain('{%- do throwError(\'Operation failed permanently\') -%}');
      expect(template).to.contain('{%- endtry -%}');
    });

    it('should handle while loops with while iteration', () => {
      const script = `// Async iterator example
set stream = createAsyncStream()
while stream.hasNext()
  set chunk = stream.next()
  print "Processing chunk " + loop.index + ": " + chunk

  // Skip empty chunks
  if !chunk
    print 'Empty chunk'
  else
    // Process the chunk
    results.push(processChunk(chunk))
  endif
endwhile`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);

      expect(template).to.contain('{%- set stream = createAsyncStream() -%}');
      expect(template).to.contain('{%- while stream.hasNext() -%}');
      expect(template).to.contain('{%- set chunk = stream.next() -%}');
      expect(template).to.contain('{{- print "Processing chunk " + loop.index + ": " + chunk -}}');
      expect(template).to.contain('{%- if !chunk -%}');
      expect(template).to.contain('{{- print \'Empty chunk\' -}}');
      expect(template).to.contain('{%- else -%}');
      expect(template).to.contain('{%- do results.push(processChunk(chunk)) -%}');
      expect(template).to.contain('{%- endif -%}');
      expect(template).to.contain('{%- endwhile -%}');
    });

    it('should handle template composition with dependencies', () => {
      const script = `// Template with dependencies
depends frameVar1, frameVar2, frameVar3

extends "parentTemplate_" + dynamicPart + ".njk"

// Define block with content
block content
  print "<h1>" + frameVar1 + "</h1>"
  print "<h2>" + frameVar2 + "</h2>"
  set frameVar3 = "Updated Value"

  // Include partial with dependencies
  include includedTemplateName + ".njk" depends = var1, var2
endblock`;

      const { template, error } = scriptToTemplate(script);
      expect(error).to.equal(null);

      expect(template).to.contain('{%- depends frameVar1, frameVar2, frameVar3 -%}');
      expect(template).to.contain('{%- extends "parentTemplate_" + dynamicPart + ".njk" -%}');
      expect(template).to.contain('{%- block content -%}');
      expect(template).to.contain('{{- print "<h1>" + frameVar1 + "</h1>" -}}');
      expect(template).to.contain('{%- set frameVar3 = "Updated Value" -%}');
      expect(template).to.contain('{%- include includedTemplateName + ".njk" depends = var1, var2 -%}');
      expect(template).to.contain('{%- endblock -%}');
    });
  });
});
