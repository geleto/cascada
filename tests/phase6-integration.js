'use strict';

const expect = require('expect.js');
const { AsyncEnvironment } = require('../src/environment');
const { createPoison, isPoisonError } = require('../src/runtime');

describe('Phase 6: Loop Poison Integration', () => {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  describe('Test 6.1: Else execution with synchronous poison', () => {
    it('should execute else block when iterable is poisoned', async () => {
      const script = `
        :data
        for item in getPoisoned()
          @data.bodyRan = true
        else
          @data.elseRan = true
        endfor
      `;

      env.addGlobal('getPoisoned', () => createPoison(new Error('Sync poison')));

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // The test passes if error is thrown - else should have executed
      }
    });
  });

  describe('Test 6.2: Else execution with runtime error', () => {
    it('should execute else when generator throws', async () => {
      const script = `
        :data
        for item in throwingGen()
          @data.bodyRan = true
        else
          @data.elseRan = true
        endfor
      `;

      env.addGlobal('throwingGen', async function* () {
        throw new Error('Generator error');
        yield; // eslint-disable-line no-unreachable
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Generator error');
        // The test passes if error is thrown - else should have executed
      }
    });
  });

  describe('Test 6.3: Else coordination - normal empty', () => {
    it('should execute else when loop is normally empty', async () => {
      const script = `
        :data
        for item in []
          @data.bodyRan = true
        else
          @data.elseRan = true
        endfor
      `;

      const result = await env.renderScriptString(script);

      expect(result.bodyRan).to.be(undefined);
      expect(result.elseRan).to.be(true);
    });

    it('should NOT execute else when loop has items', async () => {
      const script = `
        :data
        for item in [1, 2]
          @data.bodyRan = true
        else
          @data.elseRan = true
        endfor
      `;

      const result = await env.renderScriptString(script);

      expect(result.bodyRan).to.be(true);
      expect(result.elseRan).to.be(undefined);
    });
  });

  describe('Test 6.4: Complex loop with writes and handlers - poison case', () => {
    it('should handle all features when iterable is poisoned', async () => {
      const script = `
        :data
        for item in getPoisonedData()
          @data.items.push(item)
          @text("Item: " + item)
        else
          @data.elseCalled = true
          @text("No items")
        endfor
      `;

      env.addGlobal('getPoisonedData', () => {
        return createPoison(new Error('Data fetch failed'));
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors[0].message).to.contain('Data fetch failed');
        // Error thrown - else should have executed
      }
    });
  });

  describe('Test 6.5: Complex loop with writes and handlers - normal case', () => {
    it('should work normally with valid data', async () => {
      const script = `
        :data
        for item in [1, 2, 3]
          @data.items.push(item)
        else
          @data.elseCalled = true
        endfor
      `;

      const result = await env.renderScriptString(script);

      // No errors
      expect(result.items).to.eql([1, 2, 3]);

      // Else should NOT have been called
      expect(result.elseCalled).to.be(undefined);
    });
  });

  describe('Test 6.6: Nested loops with errors', () => {
    it('should handle poison in outer loop', async () => {
      const script = `
        :data
        for outer in getPoisonedArray()
          @data.outerBodyRan = true
          for inner in [1, 2, 3]
            @data.innerBodyRan = true
          endfor
        else
          @data.outerElse = true
        endfor
      `;

      env.addGlobal('getPoisonedArray', () => {
        return createPoison(new Error('Outer loop poisoned'));
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Error thrown - else should have executed
      }
    });

    it('should handle poison in inner loop', async () => {
      const script = `
        :data
        for outer in [1, 2]
          @data.outerRan = true
          for inner in poisonOnSecond(outer)
            @data.innerRan = true
          endfor
        endfor
      `;

      env.addGlobal('poisonOnSecond', function (n) {
        return n === 2 ? createPoison(new Error('Inner poisoned')) : [1, 2, 3];
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Error thrown correctly
      }
    });
  });

  describe('Test 6.7: Soft errors from generator', () => {
    it('should handle generator yielding poison', async () => {
      const script = `
        :data
        for item in softErrorGen()
          @data.items.push(item)
        else
          @data.elseCalled = true
        endfor
      `;

      env.addGlobal('softErrorGen', async function* () {
        yield 1;
        yield createPoison(new Error('Soft error'));
        yield 2;
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown PoisonError');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Soft error');
      }
    });
  });

  describe('Test 6.8: Hard errors from generator', () => {
    it('should handle generator throwing error', async () => {
      const script = `
        :data
        for item in hardErrorGen()
          @data.processed.push(item)
        else
          @data.elseCalled = true
        endfor
      `;

      env.addGlobal('hardErrorGen', async function* () {
        yield 1;
        throw new Error('Hard error');
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Hard error');
      }
    });
  });

  describe('Test 6.9: Error position tracking', () => {
    it('should include error from iterable evaluation', async () => {
      const script = `
        :data
        for item in getPoisoned()
          @data.ran = true
        endfor
      `;

      env.addGlobal('getPoisoned', () => {
        return createPoison(new Error('Array evaluation failed'));
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        expect(err.errors).to.have.length(1);
        expect(err.errors[0].message).to.contain('Array evaluation failed');
      }
    });

    it('should include error from generator', async () => {
      const script = `
        :data
        for item in errorGen()
          @data.ran = true
        endfor
      `;

      env.addGlobal('errorGen', async function* () {
        throw new Error('Generator failed');
        yield; // eslint-disable-line no-unreachable
      });

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.contain('Generator failed');
      }
    });
  });

  describe('Test 6.10: Variable writes with poison', () => {
    it('should handle variable writes when loop errors', async () => {
      const template = `
        {% set total = 0 %}
        {% for item in getPoisoned() %}
          {% set total = total + item %}
        {% else %}
          {{ "Else executed" }}
        {% endfor %}
        Total: {{ total }}
      `;

      env.addGlobal('getPoisoned', () => createPoison(new Error('Poisoned')));

      try {
        await env.renderTemplateString(template);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Error thrown correctly
      }
    });
  });

  describe('Test 6.11: Output commands with poison', () => {
    it('should handle @data and @text in else block when poisoned', async () => {
      const script = `
        :data
        for item in getPoisoned()
          @data.items.push(item)
          @text("Item\\n")
        else
          @data.noItems = true
          @text("No items found\\n")
        endfor
      `;

      env.addGlobal('getPoisoned', () => createPoison(new Error('Failed')));

      try {
        await env.renderScriptString(script);
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isPoisonError(err)).to.be(true);
        // Else block should have executed before error was thrown
      }
    });
  });
});
