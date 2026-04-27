const scriptTranspiler = require('../src/script/script-transpiler');
const { TOKEN_TYPES } = require('../src/script/script-lexer');
const expect = require('expect.js');

const aliasOptions = {
  useCoreOutputAliases: true
};

const DECL_TAG = 'var';

describe('Script Transpiler', () => {
  // Helper function tests
  describe('Helper Functions', () => {
    describe('getFirstWord', () => {
      it('should extract the first word from a string', () => {
        expect(scriptTranspiler._getFirstWord('if condition')).to.equal('if');
        expect(scriptTranspiler._getFirstWord('  @test')).to.equal('@test');
        expect(scriptTranspiler._getFirstWord('for item in items')).to.equal('for');
        expect(scriptTranspiler._getFirstWord('')).to.equal('');
        expect(scriptTranspiler._getFirstWord('   ')).to.equal('');
      });
    });

    describe('isCompleteWord', () => {
      it('should identify if a word is complete', () => {
        expect(scriptTranspiler._isCompleteWord('if condition', 0, 2)).to.equal(true);
        expect(scriptTranspiler._isCompleteWord('@test', 0, 6)).to.equal(true);
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
        expect(scriptTranspiler._getBlockType('method')).to.equal('START');
        expect(scriptTranspiler._getBlockType('function')).to.equal('START');
        expect(scriptTranspiler._getBlockType('else')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('elif')).to.equal('MIDDLE');
        //expect(scriptTranspiler._getBlockType('resume')).to.equal('MIDDLE');
        //expect(scriptTranspiler._getBlockType('except')).to.equal('MIDDLE');
        expect(scriptTranspiler._getBlockType('endif')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endfor')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endblock')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endmethod')).to.equal('END');
        expect(scriptTranspiler._getBlockType('endfunction')).to.equal('END');
        expect(scriptTranspiler._getBlockType('@text')).to.equal(null);
      });
    });

    describe('extractComments', () => {
      it('should extract comments from tokens', () => {
        const tokens = [
          { type: TOKEN_TYPES.CODE, value: 'if condition' },
          { type: TOKEN_TYPES.COMMENT, value: '// This is a comment' },
          { type: TOKEN_TYPES.CODE, value: '@outText(value)' },
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
          { type: TOKEN_TYPES.CODE, value: '@outText(value)' },
        ];

        const filtered = scriptTranspiler._filterOutComments(tokens);
        expect(filtered.length).to.equal(2);
        expect(filtered[0].value).to.equal('if condition');
        expect(filtered[1].value).to.equal('@outText(value)');
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
          '@text'
        )).to.equal(true);

        // Line ending with continuation character
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'value +' }],
          'value +',
          '@text'
        )).to.equal(true);

        // Line with a tag that should never continue
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: 'endif' }],
          'endif',
          'endif'
        )).to.equal(false);

        // Normal line that shouldn't continue
        expect(scriptTranspiler._willContinueToNextLine(
          [{ incomplete: false, value: '@outText(value)' }],
          '@outText(value)',
          '@text'
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
        expect(scriptTranspiler._continuesFromPrevious('@outText(value)', true)).to.equal(false);
      });

      it('should not identify reserved keywords as continuations', () => {
        expect(scriptTranspiler._continuesFromPrevious('if condition', true)).to.equal(false);
        expect(scriptTranspiler._continuesFromPrevious('for item in items', true)).to.equal(false);
        expect(scriptTranspiler._continuesFromPrevious('@outText(value)', true)).to.equal(false);
      });
    });

    describe('processLine', () => {
      it('should correctly process a text statement', () => {
        scriptTranspiler.channelScopes = [scriptTranspiler._createChannelScope()];
        scriptTranspiler.declareChannel('outText', 'text');
        const line = 'outText(value)';
        const state = { inMultiLineComment: false, stringState: null };

        const result = scriptTranspiler._processLine(line, state, 0);

        expect(result.lineType).to.equal('TAG');
        expect(result.tagName).to.equal('command');
        expect(result.codeContent).to.equal('outText(value)');
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
    });

    describe('generateOutput', () => {
      it('should generate output for a text statement', () => {
        const processedLine = {
          indentation: '',
          lineType: 'TEXT',
          codeContent: '"Hello"',
          comments: [],
          isContinuation: false
        };

        const output = scriptTranspiler._generateOutput(processedLine, false, 'TEXT');

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

      it('should generate template macro tags for script functions', () => {
        const startLine = {
          indentation: '',
          lineType: 'TAG',
          tagName: 'function',
          codeContent: 'greet(name)',
          comments: [],
          isContinuation: false
        };
        const endLine = {
          indentation: '',
          lineType: 'TAG',
          tagName: 'endfunction',
          codeContent: '',
          comments: [],
          isContinuation: false
        };

        expect(scriptTranspiler._generateOutput(startLine, false, 'TAG')).to.equal('{%- macro greet(name) -%}');
        expect(scriptTranspiler._generateOutput(endLine, false, 'TAG')).to.equal('{%- endmacro -%}');
      });

      it('should reject template macro syntax in scripts', () => {
        expect(() => scriptTranspiler.scriptToTemplate('macro greet()\nendmacro')).to.throwException((err) => {
          expect(err.message).to.contain("'macro' is template syntax");
          expect(err.message).to.contain("Use 'function'");
        });
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
    });
  });

  // Basic conversion tests
  describe('Basic Conversions', () => {
    it('should convert text statements', () => {
      const script = 'text outText\noutText("Hello, World!")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Hello, World!") -%}');
    });

    it('should convert tag statements', () => {
      const script = 'text outText\nif condition\n  outText("Indented")\nendif\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- if condition -%}\n  {%- command outText("Indented") -%}\n{%- endif -%}\n{%- return { text: outText.snapshot() } -%}`);
    });

    it('should convert code statements to set tags', () => {
      const script = 'variable = value';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- set variable = value -%}');
    });

    it('should handle empty lines', () => {
      const script = 'if condition\n\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n\n{%- endif -%}');
    });

    it('should preserve indentation', () => {
      const script = 'text outText\nif condition\n  outText("Indented")\nendif\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- if condition -%}\n  {%- command outText("Indented") -%}\n{%- endif -%}\n{%- return { text: outText.snapshot() } -%}`);
    });

    it('should properly convert var declarations', () => {
      const script = 'var x = 1';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- ${DECL_TAG} x = 1 -%}`);
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
      const script = 'text outText\nwhile condition\n  outText("Looping")\nendwhile\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- while __return_is_unset__() and (condition) -%}\n  {%- command outText("Looping") -%}\n{%- endwhile -%}\n{%- return { text: outText.snapshot() } -%}`);
    });
  });

  // Token type tests
  describe('Token Types', () => {
    it('should handle single-quoted strings', () => {
      const script = 'text outText\noutText(\'Hello, World!\')';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText(\'Hello, World!\') -%}');
    });

    it('should handle double-quoted strings', () => {
      const script = 'text outText\noutText("Hello, World!")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Hello, World!") -%}');
    });

    it('should handle template literals', () => {
      const script = 'text outText\noutText(`Hello, World!`)';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText(`Hello, World!`) -%}');
    });

    it('should handle single-line comments', () => {
      const script = 'text outText\noutText("Hello")// This is a comment';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Hello") -%}{#- This is a comment -#}');
    });

    it('should handle multi-line comments', () => {
      const script = 'text outText\noutText("Hello")/* This is a multi-line comment */';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Hello") -%}{#- This is a multi-line comment -#}');
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
      const script = 'text outText\nif condition1\n  if condition2\n    outText("Nested")\n  endif\nendif\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- if condition1 -%}\n  {%- if condition2 -%}\n    {%- command outText("Nested") -%}\n  {%- endif -%}\n{%- endif -%}\n{%- return { text: outText.snapshot() } -%}`);
    });

    it('should validate middle tags', () => {
      const script = 'text outText\nif condition\n  outText("True")\nelse\n  outText("False")\nendif\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should detect invalid middle tags', () => {
      const script = 'text outText\nfor item in items\n  outText(item)\nelif\n  outText("Empty")\nendfor';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('not valid in');
      }
    });

    it('should detect middle tags outside blocks', () => {
      const script = 'text outText\noutText("Before")\nelse\noutText("After")';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('outside of any block');
      }
    });

    it('should validate complex nested block structures', () => {
      const script = `text outText
if outerCondition
  for item in items
    if innerCondition
      outText("Inner if")
    else
      outText("Inner else")
    endif
  endfor
else
  outText("Outer else")
endif
return { text: outText.snapshot() }`;
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be.ok();
    });

    it('should detect invalid resume outside try block', () => {
      const script = 'text outText\noutText("Before")\nresume\noutText("After")\nreturn { text: outText.snapshot() }';
      try {
        scriptTranspiler.scriptToTemplate(script);
      } catch (error) {
        expect(error.message).to.contain('outside of any block');
      }
    });

    it('should handle complex block structure with mixed tags', () => {
      const script = `// Main template
text outText
for product in products
  if product.inStock
    // Format price with currency
    var formattedPrice = formatCurrency(product.price)

    outText("<div class='product'>")
    outText("  <h2>" + product.name + "</h2>")
    outText("  <p>Price: " + formattedPrice + "</p>")

    // Check for discount
    if product.hasDiscount
      outText("  <p class='discount'>On sale!</p>")
    endif

    outText("</div>")
  else
    // Out of stock message
    outText("<div class='product out-of-stock'>")
    outText("  <h2>" + product.name + "</h2>")
    outText("  <p>Currently unavailable</p>")
    outText("</div>")
  endif
endfor
return { text: outText.snapshot() }`;

      const template = scriptTranspiler.scriptToTemplate(script);

      // Check for properly converted tags and nested structure
      expect(template).to.contain('{%- for product in products -%}');
      expect(template).to.contain('{%- if product.inStock -%}');
      expect(template).to.contain(`{%- ${DECL_TAG} formattedPrice = formatCurrency(product.price) -%}`);
      expect(template).to.contain('{%- command outText("<div class=\'product\'>") -%}');
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
  });

  // Multi-line expression tests
  describe('Multi-line Expressions', () => {
    it('should handle expressions spanning multiple lines', () => {
      const script = 'text outText\noutText("Hello, " +\n      "World!")\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- command outText("Hello, " +\n      "World!") -%}\n{%- return { text: outText.snapshot() } -%}`);
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
      const script = `var result = calculate(
  first +
  second * (
    third /
    fourth
  )
)`;

      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain(`${DECL_TAG} result = calculate(`);
      expect(template).to.contain('first +');
      expect(template).to.contain('second * (');
      expect(template).to.contain('third /');
      expect(template).to.contain('fourth');
    });
  });

  // Channel operation tests
  describe('Channel Operations', () => {
    it('should convert data set with explicit channel variable', () => {
      const script = 'data outData\noutData.user.name = "Alice"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- data outData -%}\n{%- command outData.set(["user", "name"], "Alice") -%}');
    });

    it('should convert data push with explicit channel variable', () => {
      const script = 'data outData\noutData.user.roles.push("admin")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- data outData -%}\n{%- command outData.push(["user", "roles"],"admin") -%}');
    });

    it('should convert root-level data operations', () => {
      const script = 'data outData\noutData.merge({ version: "1.1" })';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- data outData -%}\n{%- command outData.merge(null,{ version: "1.1" }) -%}');
    });

    it('should convert text output calls', () => {
      const script = 'text outText\noutText("Hello, World!")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Hello, World!") -%}');
    });

    it('should convert text channel assignment syntax to overwrite command', () => {
      const script = 'text outText\noutText = "Hello, World!"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText.set("Hello, World!") -%}');
    });

    it('should reject var channel callable assignment syntax', () => {
      const script = 'var result\nresult(42)';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException(/does not support callable assignment/);
    });

    it('should convert sequence declaration and calls', () => {
      const script = 'sequence db = makeDb()\nvar user = db.getUser(1)\nreturn user';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- sequence db = makeDb() -%}\n{%- ${DECL_TAG} user = db.getUser(1) -%}\n{%- return user -%}`);
    });

    it('should reject sequence property assignment syntax', () => {
      const script = 'sequence db = makeDb()\ndb.state = "x"';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException(/does not support property assignment/);
    });

    it('should preserve comments on output operations', () => {
      const script = 'data outData\noutData.user.name = "Alice" // Set user name';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- data outData -%}\n{%- command outData.set(["user", "name"], "Alice" ) -%}{#- Set user name -#}');
    });

    it('should handle indentation with output operations', () => {
      const script = 'data outData\n  outData.user.name = "Alice"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- data outData -%}\n  {%- command outData.set(["user", "name"], "Alice") -%}');
    });

    it('should throw error for invalid path segments', () => {
      const script = 'data outData\noutData.user..name = "Alice"';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException('Invalid path: empty path component (consecutive dots)');
    });

    it('should throw error for invalid command identifier', () => {
      const script = 'data outData\noutData.user.name.123invalid("Alice")';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException('is not a valid identifier');
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
      const script = 'text outText\noutText("@#$%^&*")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("@#$%^&*") -%}');
    });

    it('should handle escape sequences in strings', () => {
      const script = 'text outText\noutText("Line 1\\nLine 2")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("Line 1\\nLine 2") -%}');
    });

    it('should handle multi-line string literals', () => {
      const script = 'text outText\noutText("Line 1\\\nLine 2")\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- command outText("Line 1\\\nLine 2") -%}\n{%- return { text: outText.snapshot() } -%}`);
    });

    it('should handle strings with embedded quotes', () => {
      const script = 'text outText\noutText("He said \\"Hello\\"")';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- text outText -%}\n{%- command outText("He said \\"Hello\\"") -%}');
    });

    it('should handle strings with multiple line continuations', () => {
      const script = 'text outText\noutText("First line \\\nSecond line \\\nThird line")\nreturn { text: outText.snapshot() }';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- text outText -%}\n{%- command outText("First line \\\nSecond line \\\nThird line") -%}\n{%- return { text: outText.snapshot() } -%}`);
    });

    it('should handle empty blocks', () => {
      const script = 'if condition\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition -%}\n{%- endif -%}');
    });
  });

  // Variable handling tests
  describe('Variable Handling', () => {
    it('should route call declaration to call_assign var form', () => {
      const state = { inMultiLineComment: false, stringState: null };
      const result = scriptTranspiler._processLine('var x_call = call foo(bar)', state, 0);
      expect(result.lineType).to.equal('TAG');
      expect(result.tagName).to.equal('call_assign');
      expect(result.blockType).to.equal('START');
      expect(result.codeContent).to.equal(
        'var x_call = foo(bar)'
      );
    });

    it('should handle var declarations with assignment', () => {
      const script = 'var user = fetchUser(123)';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- ${DECL_TAG} user = fetchUser(123) -%}`);
    });

    it('should handle simple assignments', () => {
      const script = 'user = "new-value"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- set user = "new-value" -%}');
    });

    it('should handle complex assignments with expressions', () => {
      const script = 'total = (price + tax) * (1 - discount)';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- set total = (price + tax) * (1 - discount) -%}');
    });


    it('should not treat reserved keywords as assignments', () => {
      const script = 'if condition == true\nendif';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal('{%- if condition == true -%}\n{%- endif -%}');
    });

    it('should handle assignments with comments', () => {
      const script = 'var user = fetchUser(123) // Get user data';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.equal(`{%- ${DECL_TAG} user = fetchUser(123) -%}{#- Get user data -#}`);
    });

    it('should reject explicit value declarations', () => {
      const script = 'value x = 1';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException(/no longer supported/);
    });

  });

  // Complex integration tests
  describe('Integration Tests', () => {
    it('should convert a complete script with all features', () => {
      const script = `
        // A complete script example
        data outData
        text outText
        var user = { name: "Alice", role: "admin" }
        if user.role == "admin"
          outText("Hello, " + user.name)
          for item in user.items
            outText(item.name)
          endfor
        else
          outText("Access denied")
        endif

        return outData.snapshot()`;

      const result = scriptTranspiler.scriptToTemplate(script, aliasOptions);
      expect(result).to.equal(`
        {#- A complete script example -#}
        {%- data outData -%}
        {%- text outText -%}
        {%- ${DECL_TAG} user = { name: "Alice", role: "admin" } -%}
        {%- if user.role == "admin" -%}
          {%- command outText("Hello, " + user.name) -%}
          {%- for item in user.items -%}
            {%- command outText(item.name) -%}
          {%- endfor -%}
        {%- else -%}
          {%- command outText("Access denied") -%}
        {%- endif -%}

        {%- return outData.snapshot() -%}`);
    });

    it('should handle complex mathematical expressions', () => {
      const script = `// Calculate total
      text outText
      var total = price *
        (1 + taxRate) *
        (1 - discount)
      outText("Total: $" + total.toFixed(2))
      return { text: outText.snapshot() }`;

      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain(`{%- ${DECL_TAG} total = price *`);
      expect(template).to.contain('(1 + taxRate) *');
      expect(template).to.contain('(1 - discount) -%}');
      expect(template).to.contain('{%- command outText("Total: $" + total.toFixed(2)) -%}');
    });

    it('should handle complex block structure with mixed tags', () => {
      const script = `// Main template
text outText
for product in products
  if product.inStock
    // Format price with currency
    var formattedPrice = formatCurrency(product.price)

    outText("<div class='product'>")
    outText("  <h2>" + product.name + "</h2>")
    outText("  <p>Price: " + formattedPrice + "</p>")

    // Check for discount
    if product.hasDiscount
      outText("  <p class='discount'>On sale!</p>")
    endif

    outText("</div>")
  else
    // Out of stock message
    outText("<div class='product out-of-stock'>")
    outText("  <h2>" + product.name + "</h2>")
    outText("  <p>Currently unavailable</p>")
    outText("</div>")
  endif
endfor
return { text: outText.snapshot() }`;

      const template = scriptTranspiler.scriptToTemplate(script);

      // Check for properly converted tags and nested structure
      expect(template).to.contain('{%- for product in products -%}');
      expect(template).to.contain('{%- if product.inStock -%}');
      expect(template).to.contain(`{%- ${DECL_TAG} formattedPrice = formatCurrency(product.price) -%}`);
      expect(template).to.contain('{%- command outText("<div class=\'product\'>") -%}');
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

    it('should handle while loops with while iteration', () => {
      const script = `// Async iterator example
text outText
var stream = createAsyncStream()
while stream.hasNext()
  var chunk = stream.next()
  outText("Processing chunk " + loop.index + ": " + chunk)

  // Skip empty chunks
  if !chunk
    outText('Empty chunk')
  else
    // Process the chunk
    results.push(processChunk(chunk))
  endif
endwhile
return { text: outText.snapshot() }`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain(`{%- ${DECL_TAG} stream = createAsyncStream() -%}`);
      expect(template).to.contain('{%- while __return_is_unset__() and (stream.hasNext()) -%}');
      expect(template).to.contain(`{%- ${DECL_TAG} chunk = stream.next() -%}`);
      expect(template).to.contain('{%- command outText("Processing chunk " + loop.index + ": " + chunk) -%}');
      expect(template).to.contain('{%- if !chunk -%}');
      expect(template).to.contain('{%- command outText(\'Empty chunk\') -%}');
      expect(template).to.contain('{%- else -%}');
      expect(template).to.contain('{%- do results.push(processChunk(chunk)) -%}');
      expect(template).to.contain('{%- endif -%}');
      expect(template).to.contain('{%- endwhile -%}');
    });

    it('should handle template composition with dependencies', () => {
      const script = `// Template with dependencies
text outText
depends frameVar1, frameVar2, frameVar3

extends "parentTemplate_" + dynamicPart + ".njk"

// Define block with content
block content
  outText("<h1>" + frameVar1 + "</h1>")
  outText("<h2>" + frameVar2 + "</h2>")
  frameVar3 = "Updated Value"

  // Include partial with dependencies
  include includedTemplateName + ".njk" depends = var1, var2
endblock
return { text: outText.snapshot() }`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain('{%- depends frameVar1, frameVar2, frameVar3 -%}');
      expect(template).to.contain('{%- extends "parentTemplate_" + dynamicPart + ".njk" -%}');
      expect(template).to.contain('{%- block content -%}');
      expect(template).to.contain('{%- command outText("<h1>" + frameVar1 + "</h1>") -%}');
      expect(template).to.contain('{%- set frameVar3 = "Updated Value" -%}');
      expect(template).to.contain('{%- include includedTemplateName + ".njk" depends = var1, var2 -%}');
      expect(template).to.contain('{%- endblock -%}');
    });

    it('should transpile methods to template blocks', () => {
      const script = `method buildBody(title, user) with context
  text outText
  outText("Hello " + user.name + " from " + siteName + ": " + title)
endmethod`;

      const template = scriptTranspiler.scriptToTemplate(script);

      expect(template).to.contain('{%- block buildBody(title, user) with context -%}');
      expect(template).to.contain('{%- text outText -%}');
      expect(template).to.contain('{%- command outText("Hello " + user.name + " from " + siteName + ": " + title) -%}');
      expect(template).to.contain('{%- endblock -%}');
    });
  });
  describe('Syntax Validation', () => {
    it('should ignore an empty trailing statement after a semicolon', () => {
      const script = 'var x = 1;';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be(`{%- ${DECL_TAG} x = 1 -%}`);
    });

    it('should split statements when a semicolon is in the middle of code', () => {
      const script = 'var x = 1; var y = x + 2';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.be(`{%- ${DECL_TAG} x = 1 -%}{%- ${DECL_TAG} y = x + 2 -%}`);
    });

    it('should NOT throw an error if semicolon is in a string', () => {
      const script = 'var x = "value;"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain(`{%- ${DECL_TAG} x = "value;" -%}`);
    });

    it('should NOT throw an error if semicolon is in a string (middle)', () => {
      const script = 'var x = "val;ue"';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain(`{%- ${DECL_TAG} x = "val;ue" -%}`);
    });

    it('should NOT throw an error if semicolon is in a comment', () => {
      const script = 'var x = 1 // comment;';
      const template = scriptTranspiler.scriptToTemplate(script);
      expect(template).to.contain(`{%- ${DECL_TAG} x = 1 -%}{#- comment; -#}`);
    });

    it('should reject unsupported for-with-return syntax clearly', () => {
      const script = 'for item in items with return\n  return item\nendfor';
      expect(() => scriptTranspiler.scriptToTemplate(script)).to.throwException((err) => {
        expect(err.message).to.contain("'for ... with return' is not supported");
        expect(err.message).to.contain("use 'each'");
      });
    });
  });
});
