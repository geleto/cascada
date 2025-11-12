'use strict';

let expect;
let AsyncEnvironment;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
}

describe('Cascada Script: @data String and Array Methods', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Auto-initialization of sub-properties', function() {
    it('should auto-initialize an array for push on an undefined path', async () => {
      const script = `
        :data
        @data.items.push(1)
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an array for concat on an undefined path', async () => {
      const script = `
        :data
        @data.items.concat([1, 2])
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1, 2] });
    });

    it('should auto-initialize an array for unshift on an undefined path', async () => {
      const script = `
        :data
        @data.items.unshift(1)
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an object for merge on an undefined path', async () => {
      const script = `
        :data
        @data.config.merge({ setting: 'on' })
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });

    it('should auto-initialize an object for deepMerge on an undefined path', async () => {
      const script = `
        :data
        @data.config.deepMerge({ setting: 'on' })
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });
  });

  describe('Root @data Modification', function() {
    it('should allow pushing to the root object after it is set to an array', async () => {
      const script = `
        :data
        @data = []
        @data.push(10)
        @data.push(20)
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql([10, 20]);
    });

    it('should throw an error when pushing to the default root object', async () => {
      const script = `
        :data
        @data.push(1)
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'push\' must be an array');
      }
    });

    it('should throw a parser error for compound assignment on root @data', async () => {
      const script = `
        :data
        @data = 100
        @data += 50
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown a parser error');
      } catch (error) {
        expect(error.message).to.contain('expected block end in output_command statement');
      }
    });

    it('should throw a parser error when adding to the default root object', async () => {
      const script = `
        :data
        @data += 1
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('expected block end in output_command statement');
      }
    });
  });

  describe('String Methods', function() {
    describe('Case Conversion', function() {
      it('should handle @data.toUpperCase', async () => {
        const script = `
          :data
          @data.text = "hello world"
          @data.text.toUpperCase()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'HELLO WORLD'
        });
      });

      it('should handle @data.toLowerCase', async () => {
        const script = `
          :data
          @data.text = "HELLO WORLD"
          @data.text.toLowerCase()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });
    });

    describe('String Extraction', function() {
      it('should handle @data.slice', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.text.slice(4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Script'
        });
      });

      it('should handle @data.substring', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.text.substring(0, 4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Java'
        });
      });
    });

    describe('String Trimming', function() {
      it('should handle @data.trim', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.text.trim()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });

      it('should handle @data.trimStart', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.text.trimStart()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world  '
        });
      });

      it('should handle @data.trimEnd', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.text.trimEnd()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world'
        });
      });
    });

    describe('String Replacement', function() {
      it('should handle @data.replace', async () => {
        const script = `
          :data
          @data.text = "apple banana apple"
          @data.text.replace("apple", "orange")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana apple'
        });
      });

      it('should handle @data.replaceAll', async () => {
        const script = `
          :data
          @data.text = "apple banana apple"
          @data.text.replaceAll("apple", "orange")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana orange'
        });
      });
    });

    describe('String Splitting', function() {
      it('should handle @data.split', async () => {
        const script = `
          :data
          @data.text = "one,two,three"
          @data.text.split(",")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: ['one', 'two', 'three']
        });
      });
    });

    describe('Character Access', function() {
      it('should handle @data.charAt', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.text.charAt(4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'S'
        });
      });
    });

    describe('String Repetition', function() {
      it('should handle @data.repeat', async () => {
        const script = `
          :data
          @data.text = "ha"
          @data.text.repeat(3)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hahaha'
        });
      });
    });
  });

  describe('Array Methods', function() {
    describe('Array Access', function() {
      it('should handle @data.at', async () => {
        const script = `
          :data
          @data.items = ["a", "b", "c", "d"]
          @data.items.at(-1)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: 'd'
        });
      });
    });

    describe('Array Sorting', function() {
      it('should handle @data.sort', async () => {
        const script = `
          :data
          @data.items = ["banana", "apple", "cherry"]
          @data.items.sort()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['apple', 'banana', 'cherry']
        });
      });

      it('should handle @data.sortWith with a custom function from context', async () => {
        const script = `
          :data
          @data.items = [3, 1, 4, 1, 5, 9]
          @data.items.sortWith(descendingSort)
        `;
        const context = {
          descendingSort: (a, b) => b - a
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          items: [9, 5, 4, 3, 1, 1]
        });
      });
    });

    describe('Array Slicing', function() {
      it('should handle @data.arraySlice', async () => {
        const script = `
          :data
          @data.items = ["a", "b", "c", "d", "e"]
          @data.items.arraySlice(1, 4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['b', 'c', 'd']
        });
      });
    });
  });

  describe('Error Handling', function() {
    it('should throw error for string methods on non-strings', async () => {
      const script = `
        :data
        @data.value = 123
        @data.value.toUpperCase()
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'toUpperCase\' must be a string');
      }
    });

    it('should throw error for array methods on non-arrays', async () => {
      const script = `
        :data
        @data.value = "hello"
        @data.value.sort()
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'sort\' must be an array');
      }
    });

    it('should throw error for undefined targets', async () => {
      const script = `
        :data
        @data.undefined.toUpperCase()
      `;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'toUpperCase\' cannot be undefined or null');
      }
    });
  });

  describe('Complex Scenarios', function() {
    it('should handle chained string and array methods', async () => {
      const script = `
        :data
        @data.text = "apple,banana,cherry,date"
        @data.text.split(",")
        @data.text.sort()
        @data.text.at(0)
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        text: 'apple'
      });
    });

    it('should handle methods on nested array elements', async () => {
      const script = `
        :data
        var users = [
          { name: "Alice", scores: [85, 90, 78] },
          { name: "Bob", scores: [92, 88, 95] }
        ]
        @data.users = users
        @data.users[0].scores.sort()
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { name: 'Alice', scores: [78, 85, 90] },
          { name: 'Bob', scores: [92, 88, 95] }
        ]
      });
    });
  });
});
