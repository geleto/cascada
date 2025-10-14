'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../src/environment');
const { isPoisonError } = require('../src/runtime');

describe('Phase 3: Empty Loop Handling', () => {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Test 3.1: Empty array with body writes', () => {
    it('should skip writes and execute else for empty array', async () => {
      const script = `
        :data
        var count = 0
        for item in []
          count = count + 1
        else
          @data.elseExecuted = true
        endfor
        @data.finalCount = count
      `;

      const result = await env.renderScriptString(script, {});

      // Count should be 0 (not undefined/poison) - skip handled correctly
      expect(result.finalCount).to.be(0);
      expect(result.elseExecuted).to.be(true);
    });
  });

  describe('Test 3.2: Empty array without writes', () => {
    it('should execute else for simple empty loop', async () => {
      const script = `
        :data
        for item in []
          @data.items.push(item)
        else
          @data.empty = true
        endfor
      `;

      const result = await env.renderScriptString(script, {});

      expect(result.empty).to.be(true);
      expect(result.items).to.be(undefined);
    });
  });

  describe('Test 3.3: Empty object iteration', () => {
    it('should handle empty object with key/value iteration', async () => {
      const script = `
        :data
        var total = 100
        for key, val in {}
          total = total + val
        else
          @data.wasEmpty = true
        endfor
        @data.total = total
      `;

      const result = await env.renderScriptString(script, {});

      expect(result.total).to.be(100);
      expect(result.wasEmpty).to.be(true);
    });
  });

  describe('Test 3.4: Non-empty array regression', () => {
    it('should not trigger skip path for non-empty loops', async () => {
      const script = `
        :data
        var count = 0
        for item in [1, 2, 3]
          count = count + 1
        else
          @data.elseExecuted = true
        endfor
        @data.finalCount = count
      `;

      const result = await env.renderScriptString(script, {});

      expect(result.finalCount).to.be(3);
      expect(result.elseExecuted).to.be(undefined);
    });

    it('should handle complex nested structures', async () => {
      const script = `
        :data
        var sum = 0
        for item in [10, 20, 30]
          sum = sum + item
        endfor
        @data.sum = sum
      `;

      const result = await env.renderScriptString(script, {});

      expect(result.sum).to.be(60);
    });
  });
});

