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

  describe('Auto-initialization of sub-properties', function () {
    it('should auto-initialize an array for push on an undefined path', async () => {
      const script = `
        data data
        data.items.push(1)
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an array for concat on an undefined path', async () => {
      const script = `
        data data
        data.items.concat([1, 2])
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1, 2] });
    });

    it('should auto-initialize an array for unshift on an undefined path', async () => {
      const script = `
        data data
        data.items.unshift(1)
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an object for merge on an undefined path', async () => {
      const script = `
        data data
        data.config.merge({ setting: 'on' })
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });

    it('should auto-initialize an object for deepMerge on an undefined path', async () => {
      const script = `
        data data
        data.config.deepMerge({ setting: 'on' })
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });
  });

  describe('Root @data Modification', function () {
    it('should allow pushing to the root object after it is set to an array', async () => {
      const script = `
        data data
        data = []
        data.push(10)
        data.push(20)
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql([10, 20]);
    });

    it('should throw an error when pushing to the default root object', async () => {
      const script = `
        data data
        data.push(1)
      
        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'push\' must be an array');
      }
    });

    it('should throw a parser error for compound assignment on root @data', async () => {
      const script = `
        data data
        data = 100
        data += 50
      
        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown a parser error');
      } catch (error) {
        expect(error.message).to.contain('Invalid variable name or path');
      }
    });

    it('should throw a parser error when adding to the default root object', async () => {
      const script = `
        data data
        data += 1
      
        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Invalid variable name or path');
      }
    });
  });

  describe('String Methods', function () {
    describe('Case Conversion', function () {
      it('should handle @data.toUpperCase', async () => {
        const script = `
          data data
          data.text = "hello world"
          data.text.toUpperCase()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'HELLO WORLD'
        });
      });

      it('should handle @data.toLowerCase', async () => {
        const script = `
          data data
          data.text = "HELLO WORLD"
          data.text.toLowerCase()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });
    });

    describe('String Extraction', function () {
      it('should handle @data.slice', async () => {
        const script = `
          data data
          data.text = "JavaScript"
          data.text.slice(4)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Script'
        });
      });

      it('should handle @data.substring', async () => {
        const script = `
          data data
          data.text = "JavaScript"
          data.text.substring(0, 4)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Java'
        });
      });
    });

    describe('String Trimming', function () {
      it('should handle @data.trim', async () => {
        const script = `
          data data
          data.text = "  hello world  "
          data.text.trim()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });

      it('should handle @data.trimStart', async () => {
        const script = `
          data data
          data.text = "  hello world  "
          data.text.trimStart()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world  '
        });
      });

      it('should handle @data.trimEnd', async () => {
        const script = `
          data data
          data.text = "  hello world  "
          data.text.trimEnd()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world'
        });
      });
    });

    describe('String Replacement', function () {
      it('should handle @data.replace', async () => {
        const script = `
          data data
          data.text = "apple banana apple"
          data.text.replace("apple", "orange")
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana apple'
        });
      });

      it('should handle @data.replaceAll', async () => {
        const script = `
          data data
          data.text = "apple banana apple"
          data.text.replaceAll("apple", "orange")
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana orange'
        });
      });
    });

    describe('String Splitting', function () {
      it('should handle @data.split', async () => {
        const script = `
          data data
          data.text = "one,two,three"
          data.text.split(",")
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: ['one', 'two', 'three']
        });
      });
    });

    describe('Character Access', function () {
      it('should handle @data.charAt', async () => {
        const script = `
          data data
          data.text = "JavaScript"
          data.text.charAt(4)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'S'
        });
      });
    });

    describe('String Repetition', function () {
      it('should handle @data.repeat', async () => {
        const script = `
          data data
          data.text = "ha"
          data.text.repeat(3)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hahaha'
        });
      });
    });
  });

  describe('Array Methods', function () {
    describe('Array Access', function () {
      it('should handle @data.at', async () => {
        const script = `
          data data
          data.items = ["a", "b", "c", "d"]
          data.items.at(-1)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: 'd'
        });
      });
    });

    describe('Array Sorting', function () {
      it('should handle @data.sort', async () => {
        const script = `
          data data
          data.items = ["banana", "apple", "cherry"]
          data.items.sort()
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['apple', 'banana', 'cherry']
        });
      });

      it('should handle @data.sortWith with a custom function from context', async () => {
        const script = `
          data data
          data.items = [3, 1, 4, 1, 5, 9]
          data.items.sortWith(descendingSort)
        
          return data.snapshot()`;
        const context = {
          descendingSort: (a, b) => b - a
        };
        const result = await env.renderScriptString(script, context);
        expect(result).to.eql({
          items: [9, 5, 4, 3, 1, 1]
        });
      });
    });

    describe('Array Slicing', function () {
      it('should handle @data.arraySlice', async () => {
        const script = `
          data data
          data.items = ["a", "b", "c", "d", "e"]
          data.items.arraySlice(1, 4)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['b', 'c', 'd']
        });
      });
    });
  });

  describe('Error Handling', function () {
    it('should throw error for string methods on non-strings', async () => {
      const script = `
        data data
        data.value = 123
        data.value.toUpperCase()
      
        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'toUpperCase\' must be a string');
      }
    });

    it('should throw error for array methods on non-arrays', async () => {
      const script = `
        data data
        data.value = "hello"
        data.value.sort()
      
        return data.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'sort\' must be an array');
      }
    });


  });

  describe('Number Methods', function () {
    describe('Min/Max', function () {
      it('should support min', async function () {
        const script = `
          data data
          data.val = 10
          data.val.min(5)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(5);
      });

      it('should support min with larger value', async function () {
        const script = `
          data data
          data.val = 3
          data.val.min(5)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(3);
      });

      it('should support max', async function () {
        const script = `
          data data
          data.val = 10
          data.val.max(20)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(20);
      });

      it('should support max with smaller value', async function () {
        const script = `
          data data
          data.val = 100
          data.val.max(20)
        
          return data.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(100);
      });
    });
  });

  describe('Complex Scenarios', function () {
    it('should handle chained string and array methods', async () => {
      const script = `
        data data
        data.text = "apple,banana,cherry,date"
        data.text.split(",")
        data.text.sort()
        data.text.at(0)
      
        return data.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        text: 'apple'
      });
    });

    it('should handle methods on nested array elements', async () => {
      const script = `
        data data
        var users = [
          { name: "Alice", scores: [85, 90, 78] },
          { name: "Bob", scores: [92, 88, 95] }
        ]
        data.users = users
        data.users[0].scores.sort()
      
        return data.snapshot()`;
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
