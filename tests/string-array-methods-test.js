'use strict';

let expect;
let AsyncEnvironment;

if (typeof require !== 'undefined') {
  expect = require('expect.js');
  AsyncEnvironment = require('../src/environment').AsyncEnvironment;
} else {
  expect = window.expect;
  AsyncEnvironment = nunjucks.AsyncEnvironment;
}

describe.skip('Cascada Script: String and Array Methods', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('String Methods', function() {
    describe('Case Conversion', function() {
      it('should handle @data.toUpperCase', async () => {
        const script = `
          :data
          @data.text = "hello world"
          @data.text = @data.text.toUpperCase()
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
          @data.text = @data.text.toLowerCase()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });

      it('should throw error for non-string toUpperCase', async () => {
        const script = `
          :data
          @data.value = 123
          @data.value = @data.value.toUpperCase()
        `;
        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.contain('Target for \'toUpperCase\' must be a string');
        }
      });
    });

    describe('String Extraction', function() {
      it('should handle @data.slice', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.slice1 = @data.text.slice(0, 4)
          @data.slice2 = @data.text.slice(4)
          @data.slice3 = @data.text.slice(-6)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'JavaScript',
          slice1: 'Java',
          slice2: 'Script',
          slice3: 'Script'
        });
      });

      it('should handle @data.substring', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.sub1 = @data.text.substring(0, 4)
          @data.sub2 = @data.text.substring(4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'JavaScript',
          sub1: 'Java',
          sub2: 'Script'
        });
      });
    });

    describe('String Trimming', function() {
      it('should handle @data.trim', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.trimmed = @data.text.trim()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world  ',
          trimmed: 'hello world'
        });
      });

      it('should handle @data.trimStart', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.trimmed = @data.text.trimStart()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world  ',
          trimmed: 'hello world  '
        });
      });

      it('should handle @data.trimEnd', async () => {
        const script = `
          :data
          @data.text = "  hello world  "
          @data.trimmed = @data.text.trimEnd()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world  ',
          trimmed: '  hello world'
        });
      });
    });

    describe('String Replacement', function() {
      it('should handle @data.replace', async () => {
        const script = `
          :data
          @data.text = "apple banana apple"
          @data.replaced = @data.text.replace("apple", "orange")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'apple banana apple',
          replaced: 'orange banana apple'
        });
      });

      it('should handle @data.replaceAll', async () => {
        const script = `
          :data
          @data.text = "apple banana apple"
          @data.replaced = @data.text.replaceAll("apple", "orange")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'apple banana apple',
          replaced: 'orange banana orange'
        });
      });
    });

    describe('String Splitting', function() {
      it('should handle @data.split', async () => {
        const script = `
          :data
          @data.text = "one,two,three"
          @data.split = @data.text.split(",")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'one,two,three',
          split: ['one', 'two', 'three']
        });
      });

      it('should handle @data.split with space', async () => {
        const script = `
          :data
          @data.text = "hello world"
          @data.split = @data.text.split(" ")
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world',
          split: ['hello', 'world']
        });
      });
    });

    describe('Character Access', function() {
      it('should handle @data.charAt', async () => {
        const script = `
          :data
          @data.text = "JavaScript"
          @data.char0 = @data.text.charAt(0)
          @data.char4 = @data.text.charAt(4)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'JavaScript',
          char0: 'J',
          char4: 'S'
        });
      });
    });

    describe('String Repetition', function() {
      it('should handle @data.repeat', async () => {
        const script = `
          :data
          @data.text = "ha"
          @data.repeated = @data.text.repeat(3)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'ha',
          repeated: 'hahaha'
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
          @data.first = @data.items.at(0)
          @data.last = @data.items.at(-1)
          @data.middle = @data.items.at(2)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['a', 'b', 'c', 'd'],
          first: 'a',
          last: 'd',
          middle: 'c'
        });
      });
    });

    describe('Array Sorting', function() {
      it('should handle @data.sort', async () => {
        const script = `
          :data
          @data.items = ["banana", "apple", "cherry"]
          @data.sorted = @data.items.sort()
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['apple', 'banana', 'cherry'],
          sorted: ['apple', 'banana', 'cherry']
        });
      });

      it('should handle @data.sortWith custom function', async () => {
        const script = `
          :data
          @data.items = [3, 1, 4, 1, 5, 9]
          @data.sorted = @data.items.sortWith((a, b) => a - b)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: [1, 1, 3, 4, 5, 9],
          sorted: [1, 1, 3, 4, 5, 9]
        });
      });
    });

    describe('Array Slicing', function() {
      it('should handle @data.arraySlice', async () => {
        const script = `
          :data
          @data.items = ["a", "b", "c", "d", "e"]
          @data.slice1 = @data.items.arraySlice(1, 4)
          @data.slice2 = @data.items.arraySlice(2)
          @data.slice3 = @data.items.arraySlice(-3)
        `;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['a', 'b', 'c', 'd', 'e'],
          slice1: ['b', 'c', 'd'],
          slice2: ['c', 'd', 'e'],
          slice3: ['c', 'd', 'e']
        });
      });
    });
  });

  describe('Error Handling', function() {
    it('should throw error for string methods on non-strings', async () => {
      const script = `
        :data
        @data.value = 123
        @data.result = @data.value.toUpperCase()
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
        @data.result = @data.value.sort()
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
        @data.result = @data.undefined.toUpperCase()
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
    it('should handle string and array methods in combination', async () => {
      const script = `
        :data
        @data.text = "apple,banana,cherry,date"
        @data.items = @data.text.split(",")
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        text: 'apple,banana,cherry,date',
        items: ['apple', 'banana', 'cherry', 'date']
      });
    });

    it('should handle nested array operations', async () => {
      const script = `
        :data
        @data.users = [
          { name: "Alice", scores: [85, 90, 78] },
          { name: "Bob", scores: [92, 88, 95] },
          { name: "Charlie", scores: [76, 82, 80] }
        ]
      `;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        users: [
          { name: 'Alice', scores: [85, 90, 78] },
          { name: 'Bob', scores: [92, 88, 95] },
          { name: 'Charlie', scores: [76, 82, 80] }
        ]
      });
    });
  });
});
