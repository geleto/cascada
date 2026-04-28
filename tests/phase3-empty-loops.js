'use strict';

import expect from 'expect.js';
import {AsyncEnvironment} from '../src/environment/environment.js';

describe('Phase 3: Empty Loop Handling', () => {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Test 3.1: Empty array with body writes', () => {
    it('should skip writes and execute else for empty array', async () => {
      const script = `
        var result = {}
        var count = 0
        for item in []
          count = count + 1
        else
          result.elseExecuted = true
        endfor
        result.finalCount = count

        return result`;

      const result = await env.renderScriptString(script, {});

      // Count should be 0 (not undefined/poison) - skip handled correctly
      expect(result.finalCount).to.be(0);
      expect(result.elseExecuted).to.be(true);
    });
  });

  describe('Test 3.2: Empty array without writes', () => {
    it('should execute else for simple empty loop', async () => {
      const script = `
        data result
        for item in []
          result.items.push(item)
        else
          result.empty = true
        endfor

        return result.snapshot()`;

      const result = await env.renderScriptString(script, {});

      expect(result.empty).to.be(true);
      expect(result.items).to.be(undefined);
    });
  });

  describe('Test 3.3: Empty object iteration', () => {
    it('should handle empty object with key/value iteration', async () => {
      const script = `
        var result = {}
        var total = 100
        for key, val in {}
          total = total + val
        else
          result.wasEmpty = true
        endfor
        result.total = total

        return result`;

      const result = await env.renderScriptString(script, {});

      expect(result.total).to.be(100);
      expect(result.wasEmpty).to.be(true);
    });
  });

  describe('Test 3.4: Non-empty array regression', () => {
    it('should not trigger skip path for non-empty loops', async () => {
      const script = `
        var result = {}
        var count = 0
        for item in [1, 2, 3]
          count = count + 1
        else
          result.elseExecuted = true
        endfor
        result.finalCount = count

        return result`;

      const result = await env.renderScriptString(script, {});

      expect(result.finalCount).to.be(3);
      expect(result.elseExecuted).to.be(undefined);
    });

    it('should handle complex nested structures', async () => {
      const script = `
        var result = {}
        var sum = 0
        for item in [10, 20, 30]
          sum = sum + item
        endfor
        result.sum = sum

        return result`;

      const result = await env.renderScriptString(script, {});

      expect(result.sum).to.be(60);
    });
  });
});

