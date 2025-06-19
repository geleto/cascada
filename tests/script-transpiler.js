const scriptTranspiler = require('../src/script-transpiler');
const { TOKEN_TYPES } = require('../src/script-lexer');
const expect = require('expect.js');

describe('Script Converter', () => {
  // Helper function tests
  describe('Helper Functions', () => {
    describe('getFirstWord', () => {
      it('should extract the first word from a string', () => {
        expect(scriptTranspiler._getFirstWord('if condition')).to.equal('if');
        expect(scriptTranspiler._getFirstWord('  @print value')).to.equal('@print');
        expect(scriptTranspiler._getFirstWord('for item in items')).to.equal('for');
        expect(scriptTranspiler._getFirstWord('')).to.equal('');
        expect(scriptTranspiler._getFirstWord('   ')).to.equal('');
      });
    });

    describe('isCompleteWord', () => {
      it('should identify if a word is complete', () => {
        expect(scriptTranspiler._isCompleteWord('if condition', 0, 2)).to.equal(true);
        expect(scriptTranspiler._isCompleteWord('@print value', 0, 6)).to.equal(true);
        expect(scriptTranspiler._isCompleteWord('ifcondition', 0, 2)).to.equal(false);
        expect(scriptTranspiler._isCompleteWord('my_if condition', 3, 2)).to.equal(false);
        expect(scriptTranspiler._isCompleteWord('if_condition', 0, 2)).to.equal(false);
      });

      it('should handle identifiers with $ sign', () => {
        expect(scriptTranspiler._isCompleteWord('$var condition', 0, 4)).to.equal(true);
        expect(scriptTranspiler._isCompleteWord('set $item = value', 4, 5)).to.equal(true);
        expect(scriptTranspiler._isCompleteWord('my$var', 0, 2)).to.equal(false);
      });
    });

    describe('getBlockType', () => {
      it('should identify block types correctly', () => {
        expect(scriptTranspiler._getBlockType('if')).to.equal('START');
        expect(scriptTranspiler._getBlockType('for')).to.equal('START');
        expect(scriptTranspiler._getBlockType('block')).to.equal('START');
        expect(scriptTranspiler._getBlockType('macro')).to.equal('START');
        expect(scriptTranspiler._getBlockType('else')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('elif')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('resume')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('except')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('endif')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endfor')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endblock')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endmacro')).to.equal('END');
        expect(scriptTranspiler._getBlockType('@print')).to.equal(null);
        expect(scriptTranspiler._getBlockType('set', 'x')).to.equal('START');
        expect(scriptTranspiler._getBlockType('set', 'x = 1')).to.equal(null);
      });
    });

    describe('extractComments', () => {
      it('should extract comments from tokens', () => {
        const tokens = [
          { type: TOKEN_TYPES.CODE, value: 'if condition' },
          { type: TOKEN_TYPES.COMMENT, value: '// This is a comment' },
          { type: TOKEN_TYPES.CODE, value: '@print value' },
          { type: TOKEN_TYPES.COMMENT, value: '/* Another comment */' },
        ];

        const comments = scriptTranspiler._extractComments(tokens);
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

        const comments = scriptTranspiler._extractComments(tokens);
        expect(comments[0].content).to.equal('Indented comment');
        expect(comments[1].content).to.equal('Multi-line\n   comment');
      });
    });

    describe('filterOutComments', () => {
      it('should filter out comment tokens', () => {
        const tokens = [
          { type: TOKEN_TYPES.CODE, value: 'if condition' },
          { type: TOKEN_TYPES.COMMENT, value: '// This is a comment' },
          { type: TOKEN_TYPES.CODE, value: '@print value' },
        ];

        const filtered = scriptTranspiler._filterOutComments(tokens);
        expect(filtered.length).to.equal(2);
        expect(filtered[0].value).to.equal('if condition');
        expect(filtered[1].value).to.equal('@print value');
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

        expect(scriptTranspiler._tokensToCode(tokens)).to.equal('if condition && anotherCondition');
      });

      it('should preserve whitespace in tokens', () => {
        const tokens = [
          { value: '  if  ' },
          { value: 'condition' },
          { value: '  ' },
        ];

        expect(scriptTranspiler._tokensToCode(tokens)).to.equal('  if  condition  ');
      });
    });

    describe('willContinueToNextLine', () => {
      it('should detect line continuation correctly', () => {
        // Line with an incomplete token
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: true, value: 'value' }],
          'value',
          '@print'
        )).to.equal(true);

        // Line ending with continuation character
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value +' }],
          'value +',
          '@print'
        )).to.equal(true);

        // Line with a tag that should never continue
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'endif' }],
          'endif',
          'endif'
        )).to.equal(false);

        // Normal line that shouldn't continue
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: '@print value' }],
          '@print value',
          '@print'
        )).to.equal(false);
      });

      it('should identify continuation with operators at end of line', () => {
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value &&' }],
          'value &&',
          'if'
        )).to.equal(true);

        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value ||' }],
          'value ||',
          'if'
        )).to.equal(true);

        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value ==' }],
          'value ==',
          'if'
        )).to.equal(true);
      });

      it('should identify continuation with keywords at end of line', () => {
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value in ' }],
          'value in ',
          'if'
        )).to.equal(true);

        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value is ' }],
          'value is ',
          'if'
        )).to.equal(true);
      });
    });

    describe('continuesFromPrevious', () => {
      it('should detect continuation from previous line', () => {
        // Line starting with continuation character
        expect(scriptTranspiler._continuesFromPrevious('))', true)).to.equal(true);

        // Line starting with continuation operator
        expect(scriptTranspiler._continuesFromPrevious('&& condition', true)).to.equal(true);

        // Line starting with continuation keyword
        expect(scriptTranspiler._continuesFromPrevious('and condition', true)).to.equal(true);

        // Normal line that isn't a continuation
        expect(scriptTranspiler._continuesFromPrevious('@print value', true)).to.equal(false);
      });

      it('should not identify reserved keywords as continuations', () => {
        expect(scriptTranspiler._continuesFromPrevious('if condition', true)).to.equal(false);
        expect(scriptTranspiler._continuesFromPrevious('for item in items', true)).to.equal(false);
        expect(scriptTranspiler._continuesFromPrevious('@print value', true)).to.equal(false);
      });
    });

    describe('processLine', () => {
      it('should correctly process a print statement', () => {
        const line = '@print "Hello"';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.lineType).to.equal('PRINT');
        expect(result.codeContent).to.equal('"Hello"');
        expect(result.continuesToNext).to.equal(false);
        expect(result.blockType).to.equal(null);
      });

      it('should correctly process a tag statement', () => {
        const line = 'if condition';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.lineType).to.equal('TAG');
        expect(result.tagName).to.equal('if');
        expect(result.blockType).to.equal('START');
      });

      it('should correctly process code with comments', () => {
        const line = 'items.push(1) // Add item';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.lineType).to.equal('CODE');
        expect(result.comments.length).to.equal(1);
        expect(result.comments[0]).to.equal('Add item');
      });

      it('should detect comment-only lines', () => {
        const line = '// Just a comment';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.isCommentOnly).to.equal(true);
        expect(result.comments.length).to.equal(1);
      });

      it('should detect empty lines', () => {
        const line = '   ';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.isEmpty).to.equal(true);
      });

      it('should convert :data directive to option focus tag', () => {
        const line = ':data';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state);

        expect(result.lineType).to.equal('TAG');
        expect(result.tagName).to.equal('option');
        expect(result.codeContent).to.equal('focus="data"');
        expect(result.blockType).to.equal(null);
      });
    });

    describe('generateOutput', () => {
      it('should generate output for a print statement', () => {
        const processedLine = {
          indentation: '',
          lineType: 'PRINT',
          codeContent: '"Hello"',
          comments: [],
          isContinuation: false
        };

        const output = scriptTranspiler._generateOutput(processedLine, false, 'PRINT');

        expect(output).to.equal('{{- "Hello" -}}');
      });

      it('should generate output for a tag statement', () => {
        const processedLine = {
          indentation: '  ',
          lineType: 'TAG',
          tagName: 'if',
          codeContent: 'condition',
          comments: [],
          isContinuation: false
        };

        const output = scriptTranspiler._generateOutput(processedLine, false, 'TAG');

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

        const output = scriptTranspiler._generateOutput(processedLine, false, 'CODE');

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

        const output = scriptTranspiler._generateOutput(processedLine, true, 'TAG');

        expect(output).to.equal('  && anotherCondition');
      });
    });

    describe('validateBlockStructure', () => {
      it('should validate correct block structure', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'if', codeContent: 'condition', isContinuation: false },
          { blockType: 'END', tagName: 'endif', codeContent: '', isContinuation: false }
        ];

        scriptTranspiler._validateBlockStructure(processedLines);
      });

      it('should detect unclosed blocks', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'if', codeContent: 'condition', isContinuation: false }
        ];

        try {
          scriptTranspiler._validateBlockStructure(processedLines);
        } catch (error) {
          expect(error.message).to.contain('Unclosed');
        }
      });

      it('should detect mismatched tags', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'if', codeContent: 'condition', isContinuation: false },
          { blockType: 'END', tagName: 'endfor', codeContent: '', isContinuation: false }
        ];

        try {
          scriptTranspiler._validateBlockStructure(processedLines);
        } catch (error) {
          expect(error.message).to.contain('Unexpected');
        }
      });

      it('should validate correct middle tags', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'if', codeContent: 'condition', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'else', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endif', codeContent: '', isContinuation: false }
        ];

        scriptTranspiler._validateBlockStructure(processedLines);
      });

      it('should detect invalid middle tags', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'for', codeContent: 'item in items', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'elif', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endfor', codeContent: '', isContinuation: false }
        ];

        try {
          scriptTranspiler._validateBlockStructure(processedLines);
        } catch (error) {
          expect(error.message).to.contain('not valid in');
        }
      });

      it('should detect middle tags outside blocks', () => {
        const processedLines = [
          { blockType: 'MIDDLE', tagName: 'else', codeContent: '', isContinuation: false }
        ];

        try {
          scriptTranspiler._validateBlockStructure(processedLines);
        } catch (error) {
          expect(error.message).to.contain('outside of any block');
        }
      });

      it('should validate complex nested structures', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'if', codeContent: 'outer', isContinuation: false },
          { blockType: 'START', tagName: 'for', codeContent: 'item in items', isContinuation: false },
          { blockType: 'START', tagName: 'if', codeContent: 'inner', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'else', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endif', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endfor', codeContent: '', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'else', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endif', codeContent: '', isContinuation: false }
        ];

        scriptTranspiler._validateBlockStructure(processedLines);
      });

      it('should detect invalid resume outside try block', () => {
        const processedLines = [
          { blockType: 'MIDDLE', tagName: 'resume', codeContent: '', isContinuation: false }
        ];

        try {
          scriptTranspiler._validateBlockStructure(processedLines);
        } catch (error) {
          expect(error.message).to.contain('outside of any block');
        }
      });

      it('should validate try/resume/except structure', () => {
        const processedLines = [
          { blockType: 'START', tagName: 'try', codeContent: '', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'resume', codeContent: '', isContinuation: false },
          { blockType: 'MIDDLE', tagName: 'except', codeContent: '', isContinuation: false },
          { blockType: 'END', tagName: 'endtry', codeContent: '', isContinuation: false }
        ];

        scriptTranspiler._validateBlockStructure(processedLines);
      });
    });
  });

  // Basic conversion tests
  describe('Basic Conversions', () => {
    it('should convert print statements', () => {
      const script = '@print "Hello, World!"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, World!" -}}');
    });

    it('should convert tag statements', () => {
      const script = 'if condition\n  @print "Indented"\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n  {{- "Indented" -}}\n{%- endif -%}');
    });

    it('should convert code statements to do tags', () => {
      const script = 'variable = value';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- do variable = value -%}');
    });

    it('should handle empty lines', () => {
      const script = 'if condition\n\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n\n{%- endif -%}');
    });

    it('should preserve indentation', () => {
      const script = 'if condition\n  @print "Indented"\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n  {{- "Indented" -}}\n{%- endif -%}');
    });

    it('should properly convert set statements', () => {
      const script = 'set x = 1';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- set x = 1 -%}');
    });

    it('should properly convert include statements', () => {
      const script = 'include "partial.html"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- include "partial.html" -%}');
    });

    it('should convert depends statements', () => {
      const script = 'depends var1, var2';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- depends var1, var2 -%}');
    });

    it('should convert while loops', () => {
      const script = 'while condition\n  @print "Looping"\nendwhile';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- while condition -%}\n  {{- "Looping" -}}\n{%- endwhile -%}');
    });
  });

  // Token type tests
  describe('Token Types', () => {
    it('should handle single-quoted strings', () => {
      const script = '@print \'Hello, World!\'';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- \'Hello, World!\' -}}');
    });

    it('should handle double-quoted strings', () => {
      const script = '@print "Hello, World!"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, World!" -}}');
    });

    it('should handle template literals', () => {
      const script = '@print `Hello, World!`';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- `Hello, World!` -}}');
    });

    it('should handle single-line comments', () => {
      const script = '@print "Hello"// This is a comment';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello" -}}{#- This is a comment -#}');
    });

    it('should handle multi-line comments', () => {
      const script = '@print "Hello"/* This is a multi-line comment */';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello" -}}{#- This is a multi-line comment -#}');
    });

    it('should handle standalone comments', () => {
      const script = '// This is a standalone comment';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{#- This is a standalone comment -#}');
    });

    it('should handle regular expressions', () => {
      const script = 'if r/pattern/.test(value)\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if r/pattern/.test(value) -%}\n{%- endif -%}');
    });
  });

  // Block structure tests
  describe('Block Structure', () => {
    it('should validate correct block structure', () => {
      const script = 'if condition\n  for item in items\n  endfor\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should detect missing end tags', () => {
      const script = 'if condition\n  for item in items\n  endfor';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('Unclosed');
      }
    });

    it('should detect mismatched tags', () => {
      const script = 'if condition\n  for item in items\n  endif\nendfor';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('Unexpected');
      }
    });

    it('should handle nested blocks', () => {
      const script = 'if condition1\n  if condition2\n    @print "Nested"\n  endif\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition1 -%}\n  {%- if condition2 -%}\n    {{- "Nested" -}}\n  {%- endif -%}\n{%- endif -%}');
    });

    it('should validate middle tags', () => {
      const script = 'if condition\n  @print "True"\nelse\n  @print "False"\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should detect invalid middle tags', () => {
      const script = 'for item in items\n  @print item\nelif\n  @print "Empty"\nendfor';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('not valid in');
      }
    });

    it('should detect middle tags outside blocks', () => {
      const script = '@print "Before"\nelse\n@print "After"';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('outside of any block');
      }
    });

    it('should handle try/resume/except blocks', () => {
      const script = 'try\n  @print "Try block"\nresume\n  @print "Resume block"\nexcept\n  @print "Except block"\nendtry';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should validate complex nested block structures', () => {
      const script = `if outerCondition
  for item in items
    if innerCondition
      @print "Inner if"
    else
      @print "Inner else"
    endif
  endfor
else
  @print "Outer else"
endif`;
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should detect invalid resume outside try block', () => {
      const script = '@print "Before"\nresume\n@print "After"';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('outside of any block');
      }
    });
  });

  // Multi-line expression tests
  describe('Multi-line Expressions', () => {
    it('should handle expressions spanning multiple lines', () => {
      const script = '@print "Hello, " +\n      "World!"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Hello, " +\n      "World!" -}}');
    });

    it('should detect continuation at end of line', () => {
      const script = 'if condition &&\n   anotherCondition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition &&\n   anotherCondition -%}\n{%- endif -%}');
    });

    it('should detect continuation at start of line', () => {
      const script = 'if condition\n   && anotherCondition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition\n   && anotherCondition -%}\n{%- endif -%}');
    });

    it('should handle comments within multi-line expressions', () => {
      const script = 'if condition && // First condition\n   anotherCondition// Second condition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition && \n   anotherCondition -%}{#- First condition; Second condition -#}\n{%- endif -%}');
    });

    it('should handle empty lines within multi-line expressions', () => {
      const script = 'if condition &&\n\n   anotherCondition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition &&\n\n   anotherCondition -%}\n{%- endif -%}');
    });

    it('should handle comment between condition and continuation', () => {
      const script = `if condition
// Comment
&& anotherCondition
endif`;

      const template = scriptTranspiler.scriptToTemplate(script);
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

      const template = scriptTranspiler.scriptToTemplate(script);
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

      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain('set result = calculate(');
      expect(template).to.contain('first +');
      expect(template).to.contain('second * (');
      expect(template).to.contain('third /');
      expect(template).to.contain('fourth');
    });
  });

  // @ Command conversion tests
  describe('@ Command Conversions', () => {
    describe('Statement-Style Commands', () => {
      it('should convert simple command with path and string value', () => {
        const script = '@put user.name \'Alice\'';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command put user.name \'Alice\' -%}');
      });

      it('should convert command with path and numeric value', () => {
        const script = '@put user.age 30';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command put user.age 30 -%}');
      });

      it('should convert command with complex path', () => {
        const script = '@put user.settings.theme \'dark\'';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command put user.settings.theme \'dark\' -%}');
      });

      it('should convert command with object literal argument', () => {
        const script = '@push users { id: 1, name: \'Bob\' }';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command push users { id: 1, name: \'Bob\' } -%}');
      });

      it('should convert command with no argument', () => {
        const script = '@pop user.roles';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command pop user.roles -%}');
      });

      it('should handle command with extra whitespace', () => {
        const script = '  @put  user.name   \'Alice\'  ';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('  {%- statement_command put  user.name   \'Alice\'   -%}');
      });

      it('should convert command that looks like function but has no parentheses', () => {
        const script = '@turtle.forward 50';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command turtle.forward 50 -%}');
      });
    });

    describe('Function-Style Commands', () => {
      it('should convert simple function call with dot in name', () => {
        const script = '@turtle.forward(50)';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command turtle.forward(50) -%}');
      });

      it('should convert call with complex expression as argument', () => {
        const script = '@turtle.turn(getAngle() * 2)';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command turtle.turn(getAngle() * 2) -%}');
      });

      it('should handle call with extra whitespace around parentheses', () => {
        const script = '@turtle.forward ( 50 )';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command turtle.forward ( 50 ) -%}');
      });

      it('should convert function call with multiple arguments', () => {
        const script = '@move.to(x + 10, y - 5, z)';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command move.to(x + 10, y - 5, z) -%}');
      });

      it('should convert function call with nested function calls', () => {
        const script = '@calc.process(getValue(a), transform(b, c))';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command calc.process(getValue(a), transform(b, c)) -%}');
      });
    });

    describe('@ Commands with Comments', () => {
      it('should handle statement command with trailing comment', () => {
        const script = '@put user.name \'Alice\' // Set user name';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command put user.name \'Alice\'  -%}{#- Set user name -#}');
      });

      it('should handle function command with trailing comment', () => {
        const script = '@turtle.forward(50) // Move turtle forward';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command turtle.forward(50)  -%}{#- Move turtle forward -#}');
      });

      it('should handle command with multi-line comment', () => {
        const script = '@put user.status \'active\' /* Update user status to active */';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command put user.status \'active\'  -%}{#- Update user status to active -#}');
      });
    });

    describe('@ Commands Edge Cases', () => {
      it('should handle @ command with indentation', () => {
        const script = '  @put user.name \'Alice\'';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('  {%- statement_command put user.name \'Alice\' -%}');
      });

      it('should handle @ command with empty function call', () => {
        const script = '@reset()';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- function_command reset() -%}');
      });

      it('should handle @ command with string containing spaces', () => {
        const script = '@set message "Hello World with spaces"';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command set message "Hello World with spaces" -%}');
      });

      it('should handle @ command with boolean values', () => {
        const script = '@toggle user.active true';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command toggle user.active true -%}');
      });

      it('should handle @ command with array notation', () => {
        const script = '@update items[0].status \'completed\'';
        const template = scriptTranspiler.scriptToTemplate(script);
        expect(template).to.equal('{%- statement_command update items[0].status \'completed\' -%}');
      });
    });
  });

  // Edge cases
  describe('Edge Cases', () => {
    it('should handle empty input', () => {
      const script = '';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('');
    });

    it('should handle input with only whitespace', () => {
      const script = '   ';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('   ');
    });

    it('should handle special characters', () => {
      const script = '@print "@#$%^&*"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "@#$%^&*" -}}');
    });

    it('should handle escape sequences in strings', () => {
      const script = '@print "Line 1\\nLine 2"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Line 1\\nLine 2" -}}');
    });

    it('should handle multi-line string literals', () => {
      const script = '@print "Line 1\\\nLine 2"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "Line 1\\\nLine 2" -}}');
    });

    it('should handle strings with embedded quotes', () => {
      const script = '@print "He said \\"Hello\\""';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "He said \\"Hello\\"" -}}');
    });

    it('should handle strings with multiple line continuations', () => {
      const script = '@print "First line \\\nSecond line \\\nThird line"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{{- "First line \\\nSecond line \\\nThird line" -}}');
    });

    it('should handle empty blocks', () => {
      const script = 'if condition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n{%- endif -%}');
    });
  });

  // Complex integration tests
  describe('Integration Tests', () => {
    it('should convert a complete script with all features', () => {
      const script = `
        // A complete script example
        :data
        set user = { name: "Alice", role: "admin" }
        if user.role == "admin"
          @print "Hello, " + user.name
          for item in user.items
            @print item.name
          endfor
        else
          @print "Access denied"
        endif
      `;

      const result = scriptTranspiler.scriptToTemplate(script);
      expect(result).to.equal(`
        {#- A complete script example -#}
        {%- option focus="data" -%}
        {%- set user = { name: "Alice", role: "admin" } -%}
        {%- if user.role == "admin" -%}
          {{- "Hello, " + user.name -}}
          {%- for item in user.items -%}
            {{- item.name -}}
          {%- endfor -%}
        {%- else -%}
          {{- "Access denied" -}}
        {%- endif -%}
      `);
    });

    it('should handle complex mathematical expressions', () => {
      const script = `// Calculate total
total = price *
      (1 + taxRate) *
      (1 - discount)

@print "Total: $" + total.toFixed(2)`;

      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain('{%- do total = price *');
      expect(template).to.contain('(1 + taxRate) *');
      expect(template).to.contain('(1 - discount) -%}');
      expect(template).to.contain('{{- "Total: $" + total.toFixed(2) -}}');
    });

    it('should handle complex block structure with mixed tags', () => {
      const script = `// Main template
for product in products
  if product.inStock
    // Format price with currency
    set formattedPrice = formatCurrency(product.price)

    @print "<div class='product'>"
    @print "  <h2>" + product.name + "</h2>"
    @print "  <p>Price: " + formattedPrice + "</p>"

    // Check for discount
    if product.hasDiscount
      @print "  <p class='discount'>On sale!</p>"
    endif

    @print "</div>"
  else
    // Out of stock message
    @print "<div class='product out-of-stock'>"
    @print "  <h2>" + product.name + "</h2>"
    @print "  <p>Currently unavailable</p>"
    @print "</div>"
  endif
endfor`;

      const template = scriptTranspiler.scriptToTemplate(script);

      // Check for properly converted tags and nested structure
      expect(template).to.contain('{%- for product in products -%}');
      expect(template).to.contain('{%- if product.inStock -%}');
      expect(template).to.contain('{%- set formattedPrice = formatCurrency(product.price) -%}');
      expect(template).to.contain('{{- "<div class=\'product\'>" -}}');
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
  @print "User data: " + data.name
resume askUser('Retry operation?')
  // Set warning message
  set warningMessage = 'Resuming operation (attempt ' + resume.count + ')'
  @print warningMessage
except
  // Handle error
  @print "Failed to fetch user data: " + error.message
  throwError('Operation failed permanently')
endtry`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain('{%- try -%}');
      expect(template).to.contain('{%- set data = fetchData(userId) -%}');
      expect(template).to.contain('{{- "User data: " + data.name -}}');
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
  @print "Processing chunk " + loop.index + ": " + chunk

  // Skip empty chunks
  if !chunk
    @print 'Empty chunk'
  else
    // Process the chunk
    results.push(processChunk(chunk))
  endif
endwhile`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain('{%- set stream = createAsyncStream() -%}');
      expect(template).to.contain('{%- while stream.hasNext() -%}');
      expect(template).to.contain('{%- set chunk = stream.next() -%}');
      expect(template).to.contain('{{- "Processing chunk " + loop.index + ": " + chunk -}}');
      expect(template).to.contain('{%- if !chunk -%}');
      expect(template).to.contain('{{- \'Empty chunk\' -}}');
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
  @print "<h1>" + frameVar1 + "</h1>"
  @print "<h2>" + frameVar2 + "</h2>"
  set frameVar3 = "Updated Value"

  // Include partial with dependencies
  include includedTemplateName + ".njk" depends = var1, var2
endblock`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain('{%- depends frameVar1, frameVar2, frameVar3 -%}');
      expect(template).to.contain('{%- extends "parentTemplate_" + dynamicPart + ".njk" -%}');
      expect(template).to.contain('{%- block content -%}');
      expect(template).to.contain('{{- "<h1>" + frameVar1 + "</h1>" -}}');
      expect(template).to.contain('{%- set frameVar3 = "Updated Value" -%}');
      expect(template).to.contain('{%- include includedTemplateName + ".njk" depends = var1, var2 -%}');
      expect(template).to.contain('{%- endblock -%}');
    });
  });
});
