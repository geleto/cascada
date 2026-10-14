
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';

describe('Cascada Script: @data String and Array Methods', function () {
  let env;

  // For each test, create a fresh environment.
  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Auto-initialization of sub-properties', function () {
    it('should auto-initialize an array for push on an undefined path', async () => {
      const script = `
        data outData
        outData.items.push(1)
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an array for concat on an undefined path', async () => {
      const script = `
        data outData
        outData.items.concat([1, 2])
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1, 2] });
    });

    it('should auto-initialize an array for unshift on an undefined path', async () => {
      const script = `
        data outData
        outData.items.unshift(1)
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ items: [1] });
    });

    it('should auto-initialize an object for merge on an undefined path', async () => {
      const script = `
        data outData
        outData.config.merge({ setting: 'on' })
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });

    it('should auto-initialize an object for deepMerge on an undefined path', async () => {
      const script = `
        data outData
        outData.config.deepMerge({ setting: 'on' })
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({ config: { setting: 'on' } });
    });
  });

  describe('Root @data Modification', function () {
    it('should allow pushing to the root object after it is set to an array', async () => {
      const script = `
        data outData
        outData = []
        outData.push(10)
        outData.push(20)
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql([10, 20]);
    });

    it('should throw an error when pushing to the default root object', async () => {
      const script = `
        data outData
        outData.push(1)
      
        return outData.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'push\' must be an array');
      }
    });

    it('should throw a parser error for compound assignment on root @data', async () => {
      const script = `
        data outData
        data = 100
        outData += 50
      
        return outData.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown a parser error');
      } catch (error) {
        expect(error.message).to.contain('Invalid variable name or path');
      }
    });

    it('should throw a parser error when adding to the default root object', async () => {
      const script = `
        data outData
        outData += 1
      
        return outData.snapshot()`;
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
      it('should handle @outData.toUpperCase', async () => {
        const script = `
          data outData
          outData.text = "hello world"
          outData.text.toUpperCase()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'HELLO WORLD'
        });
      });

      it('should handle @outData.toLowerCase', async () => {
        const script = `
          data outData
          outData.text = "HELLO WORLD"
          outData.text.toLowerCase()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });
    });

    describe('String Extraction', function () {
      it('should handle @outData.slice', async () => {
        const script = `
          data outData
          outData.text = "JavaScript"
          outData.text.slice(4)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Script'
        });
      });

      it('should handle @outData.substring', async () => {
        const script = `
          data outData
          outData.text = "JavaScript"
          outData.text.substring(0, 4)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'Java'
        });
      });
    });

    describe('String Trimming', function () {
      it('should handle @outData.trim', async () => {
        const script = `
          data outData
          outData.text = "  hello world  "
          outData.text.trim()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world'
        });
      });

      it('should handle @outData.trimStart', async () => {
        const script = `
          data outData
          outData.text = "  hello world  "
          outData.text.trimStart()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hello world  '
        });
      });

      it('should handle @outData.trimEnd', async () => {
        const script = `
          data outData
          outData.text = "  hello world  "
          outData.text.trimEnd()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: '  hello world'
        });
      });
    });

    describe('String Replacement', function () {
      it('should handle @outData.replace', async () => {
        const script = `
          data outData
          outData.text = "apple banana apple"
          outData.text.replace("apple", "orange")
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana apple'
        });
      });

      it('should handle @outData.replaceAll', async () => {
        const script = `
          data outData
          outData.text = "apple banana apple"
          outData.text.replaceAll("apple", "orange")
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'orange banana orange'
        });
      });
    });

    describe('String Splitting', function () {
      it('should handle @outData.split', async () => {
        const script = `
          data outData
          outData.text = "one,two,three"
          outData.text.split(",")
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: ['one', 'two', 'three']
        });
      });
    });

    describe('Character Access', function () {
      it('should handle @outData.charAt', async () => {
        const script = `
          data outData
          outData.text = "JavaScript"
          outData.text.charAt(4)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'S'
        });
      });
    });

    describe('String Repetition', function () {
      it('should handle @outData.repeat', async () => {
        const script = `
          data outData
          outData.text = "ha"
          outData.text.repeat(3)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          text: 'hahaha'
        });
      });
    });
  });

  describe('Array Methods', function () {
    describe('Array Access', function () {
      it('should handle @outData.at', async () => {
        const script = `
          data outData
          outData.items = ["a", "b", "c", "d"]
          outData.items.at(-1)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: 'd'
        });
      });
    });

    describe('Array Sorting', function () {
      it('should handle @outData.sort', async () => {
        const script = `
          data outData
          outData.items = ["banana", "apple", "cherry"]
          outData.items.sort()
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script);
        expect(result).to.eql({
          items: ['apple', 'banana', 'cherry']
        });
      });

      it('should handle @outData.sortWith with a custom function from context', async () => {
        const script = `
          data outData
          outData.items = [3, 1, 4, 1, 5, 9]
          outData.items.sortWith(descendingSort)
        
          return outData.snapshot()`;
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
      it('should handle @outData.arraySlice', async () => {
        const script = `
          data outData
          outData.items = ["a", "b", "c", "d", "e"]
          outData.items.arraySlice(1, 4)
        
          return outData.snapshot()`;
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
        data outData
        outData.value = 123
        outData.value.toUpperCase()
      
        return outData.snapshot()`;
      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Target for \'toUpperCase\' must be a string');
      }
    });

    it('should throw error for array methods on non-arrays', async () => {
      const script = `
        data outData
        outData.value = "hello"
        outData.value.sort()
      
        return outData.snapshot()`;
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
          data outData
          outData.val = 10
          outData.val.min(5)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(5);
      });

      it('should support min with larger value', async function () {
        const script = `
          data outData
          outData.val = 3
          outData.val.min(5)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(3);
      });

      it('should support max', async function () {
        const script = `
          data outData
          outData.val = 10
          outData.val.max(20)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(20);
      });

      it('should support max with smaller value', async function () {
        const script = `
          data outData
          outData.val = 100
          outData.val.max(20)
        
          return outData.snapshot()`;
        const result = await env.renderScriptString(script, {});
        expect(result.val).to.be(100);
      });
    });
  });

  describe('Complex Scenarios', function () {
    it('should handle chained string and array methods', async () => {
      const script = `
        data outData
        outData.text = "apple,banana,cherry,date"
        outData.text.split(",")
        outData.text.sort()
        outData.text.at(0)
      
        return outData.snapshot()`;
      const result = await env.renderScriptString(script);
      expect(result).to.eql({
        text: 'apple'
      });
    });

    it('should handle methods on nested array elements', async () => {
      const script = `
        data outData
        var users = [
          { name: "Alice", scores: [85, 90, 78] },
          { name: "Bob", scores: [92, 88, 95] }
        ]
        outData.users = users
        outData.users[0].scores.sort()
      
        return outData.snapshot()`;
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
